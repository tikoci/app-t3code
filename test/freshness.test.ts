// Offline half of the freshness checks (scripts/freshness.ts). The README
// share link is checked here against the real files; the network checks
// (pinned T3 release, newest stable, harness catalog) run in CI and on a
// schedule, so this file only tests their parsing and decisions on fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkShareLink,
	checkTools,
	checkUpstream,
	compareVersions,
	DRIVERS_PATH,
	diffCatalog,
	main,
	parseBuiltInDrivers,
	type Release,
	releaseProblems,
	renderShareLink,
	rewriteShareLink,
	shareLinks,
	stableTagVersions,
	stableVersion,
	TOOL_PINS,
	toolPinReport,
	toolPinVersion,
	UPSTREAM_REPO,
	versionArg,
} from "../scripts/freshness.ts";
import { HARNESSES } from "../lib/harnesses.ts";
import { CORE_CHECKS } from "../lib/tool-catalog.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

// The shape of upstream's apps/server/src/provider/builtInDrivers.ts at v0.1.7.
const DRIVERS_V017 = `import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
export type BuiltInDriversEnv = CodexDriverEnv | ClaudeDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  FxDriver,
  OpenCodeDriver,
  AntigravityDriver,
  KiroDriver,
  PiDriver,
  MuseDriver,
  AcpRegistryDriver,
];

export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  ClaudeDriver,
];
`;

function release(tag: string, overrides: Partial<Release> = {}): Release {
	const version = tag.replace(/^v/, "");
	return {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [`t3-${version}-linux-x64.tar.gz`, `t3-${version}-linux-arm64.tar.gz`, "SHA256SUMS"].map((name) => ({ name })),
		...overrides,
	};
}

describe("README share link", () => {
	test("embeds app/t3code.tikapp.yaml exactly (fix: make share-link)", () => {
		const links = shareLinks(read("README.md"));
		expect(links).toHaveLength(1);
		const yaml = read("app/t3code.tikapp.yaml");
		expect(new URL(links[0] as string).searchParams.get("yaml")).toBe(yaml);
		expect(links[0]).toBe(renderShareLink(yaml));
		expect(checkShareLink().ok).toBe(true);
	});

	test("rewriting replaces the Markdown link, not a bare copy of its URL elsewhere", () => {
		const stale = renderShareLink("name: old\n");
		const fresh = renderShareLink("name: new\n");
		const readme = `Old link, quoted: ${stale}\n\n[See in /app YAML Editor](${stale}) to inspect\n`;
		const out = rewriteShareLink(readme, fresh);
		expect(shareLinks(out)).toEqual([fresh]);
		expect(out).toStartWith(`Old link, quoted: ${stale}\n`);
	});

	test("the rendered link round-trips any YAML, including # + & and non-ASCII", () => {
		const yaml = "# a + b & c — d\nname: x\n";
		expect(new URL(renderShareLink(yaml)).searchParams.get("yaml")).toBe(yaml);
		expect(new URL(renderShareLink(yaml)).searchParams.get("version")).toBe("latest");
	});
});

describe("harness catalog", () => {
	test("parses BUILT_IN_DRIVERS only, in order", () => {
		expect(parseBuiltInDrivers(DRIVERS_V017)).toEqual(Object.keys(HARNESSES));
	});

	test("fails loudly when upstream changes the shape", () => {
		expect(() => parseBuiltInDrivers("export const DRIVERS = [CodexDriver];")).toThrow(/no BUILT_IN_DRIVERS/);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [...extraDrivers, CodexDriver];")).toThrow(/entry, not a plain name|is empty/);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [];")).toThrow(/entry, not a plain name|is empty/);
	});

	// Shapes that once parsed to the old list while upstream's real catalog changed (Codex review of #33).
	test("rejects anything that changes the array after its literal", () => {
		const live = DRIVERS_V017.replace("  AcpRegistryDriver,\n];", "  AcpRegistryDriver,\n].concat(NewDriver);");
		expect(live).toContain(".concat(NewDriver)");
		expect(() => parseBuiltInDrivers(live)).toThrow(/plain array literal/);
		const filtered = DRIVERS_V017.replace("  AcpRegistryDriver,\n];", "  AcpRegistryDriver,\n].filter(enabled);");
		expect(() => parseBuiltInDrivers(filtered)).toThrow(/plain array literal/);
		expect(() => parseBuiltInDrivers(`${DRIVERS_V017}\nBUILT_IN_DRIVERS.push(NewDriver);\n`)).toThrow(/occurs 2 times/);
	});

	test("ignores a commented-out declaration and reads the live one", () => {
		const old = "// export const BUILT_IN_DRIVERS = [CodexDriver, ClaudeDriver];\n/* export const BUILT_IN_DRIVERS = [OldDriver]; */\n";
		expect(parseBuiltInDrivers(old + DRIVERS_V017)).toEqual(Object.keys(HARNESSES));
		const live = "export const BUILT_IN_DRIVERS: X = [\n  CodexDriver, // the default\n  NewDriver,\n];\n";
		expect(parseBuiltInDrivers(old + live)).toEqual(["CodexDriver", "NewDriver"]);
	});

	// A regex comment strip read `/*` inside a line comment as a block comment and
	// lost NewDriver, which JavaScript keeps (Codex re-check of #33).
	test("comment markers inside comments or strings can't hide a live driver", () => {
		const tricky = DRIVERS_V017.replace("  AcpRegistryDriver,\n];", "  AcpRegistryDriver,\n  // To disable a driver, surround it with /*\n  NewDriver,\n  // */\n];");
		expect(parseBuiltInDrivers(tricky)).toEqual([...Object.keys(HARNESSES), "NewDriver"]);
		expect(diffCatalog(parseBuiltInDrivers(tricky))).toEqual({ added: ["NewDriver"], removed: [] });
		const inString = "const note = '/* not a comment';\nexport const BUILT_IN_DRIVERS = [CodexDriver, NewDriver];\nconst end = '*/';\n";
		expect(parseBuiltInDrivers(inString)).toEqual(["CodexDriver", "NewDriver"]);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [CodexDriver, `x` as any];")).toThrow(/entry, not a plain name|is empty/);
	});

	// Codex re-check of #33 at 007885b: both passed with the old 11 names.
	test("a declaration inside a string can't stand in for the live one", () => {
		const decoy = `const old = ${JSON.stringify(DRIVERS_V017)};\nexport const DRIVERS = [CodexDriver, NewDriver];\n`;
		expect(() => parseBuiltInDrivers(decoy)).toThrow(/no BUILT_IN_DRIVERS/);
		const template = `const old = \`${DRIVERS_V017.replaceAll("`", "")}\`;\nexport const BUILT_IN_DRIVERS = [CodexDriver, NewDriver];\n`;
		expect(parseBuiltInDrivers(template)).toEqual(["CodexDriver", "NewDriver"]);
	});

	test("rejects a driver listed twice", () => {
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [CodexDriver, NewDriver, CodexDriver];")).toThrow(/CodexDriver more than once/);
	});

	test("rejects holes, spreads, assertions and non-exported or nested declarations", () => {
		for (const array of ["[, CodexDriver]", "[CodexDriver,, ClaudeDriver]", "[CodexDriver, ClaudeDriver,,]"]) {
			expect(() => parseBuiltInDrivers(`export const BUILT_IN_DRIVERS = ${array};`)).toThrow(/OmittedExpression entry/);
		}
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [...more];")).toThrow(/SpreadElement entry/);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [CodexDriver] as const;")).toThrow(/plain array literal/);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [CodexDriver] satisfies X;")).toThrow(/plain array literal/);
		expect(() => parseBuiltInDrivers("const BUILT_IN_DRIVERS = [CodexDriver];")).toThrow(/top-level `export const`/);
		expect(() => parseBuiltInDrivers("export let BUILT_IN_DRIVERS = [CodexDriver];")).toThrow(/top-level `export const`/);
		expect(() => parseBuiltInDrivers("function f() { const BUILT_IN_DRIVERS = [CodexDriver]; }")).toThrow(/top-level `export const`/);
		expect(() => parseBuiltInDrivers("export const BUILT_IN_DRIVERS = [CodexDriver")).toThrow(/syntax error/);
	});

	test("reports drivers added and removed upstream", () => {
		// v0.1.6 had no Kiro; v0.1.7 added it. This check would have flagged the bump.
		expect(diffCatalog(["CodexDriver", "ClaudeDriver"], ["CodexDriver", "ClaudeDriver"])).toEqual({ added: [], removed: [] });
		expect(diffCatalog(["CodexDriver", "KiroDriver"], ["CodexDriver", "MuseDriver"])).toEqual({ added: ["KiroDriver"], removed: ["MuseDriver"] });
	});

	test("no provider CLI is a core check: T3CODE_PROVIDERS installs them into the home", () => {
		const core = new Set(CORE_CHECKS.filter((c) => c.kind === "command").map((c) => c.name));
		for (const harness of Object.values(HARNESSES)) expect({ cli: harness.cli, core: core.has(harness.cli ?? "") }).toEqual({ cli: harness.cli, core: false });
	});

	test("every harness CLI we deliver or document is in the README provider table", () => {
		const readme = read("README.md");
		for (const harness of Object.values(HARNESSES)) {
			if (harness.cli) expect(readme).toContain(`(\`${harness.cli}\`) |`);
		}
	});
});

describe("releases", () => {
	test("stable versions come from vX.Y.Z tag refs only, newest first", () => {
		const refs = ["v0.1.9", "v0.1.10", "v0.1.11-nightly.20261201.1", "v0.2.0-rc1", "0.3.0", "v0.1.7"].map((t) => ({ ref: `refs/tags/${t}` }));
		expect(stableTagVersions(refs)).toEqual(["0.1.10", "0.1.9", "0.1.7"]);
	});

	test("--version picks the version to check; package.json is the default", () => {
		const pkg = (JSON.parse(read("package.json")) as { version: string }).version;
		expect(versionArg([])).toBe(pkg);
		expect(versionArg(["--version", "0.1.6"])).toBe("0.1.6");
		expect(versionArg(["--version=0.1.8"])).toBe("0.1.8");
		expect(() => versionArg(["--version"])).toThrow(/needs a T3 version/);
		expect(() => versionArg(["--version", "latest"])).toThrow(/needs a T3 version/);
	});

	test("only plain vX.Y.Z tags are stable", () => {
		expect(stableVersion("v0.1.7")).toBe("0.1.7");
		expect(stableVersion("v0.1.8-nightly.20261108.4380")).toBeUndefined();
		expect(stableVersion("0.1.7")).toBeUndefined();
	});

	test("compares stable versions numerically and refuses anything else", () => {
		expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
		expect(() => compareVersions("0.1.7-nightly.20261108.4380", "0.1.8")).toThrow(/not a stable/);
		expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
		expect(compareVersions("0.1.7", "0.1.7")).toBe(0);
		expect(compareVersions("0.1.6", "0.1.7")).toBe(-1);
	});

	test("a pin must be a published stable release with both Linux archives and SHA256SUMS", () => {
		expect(releaseProblems(release("v0.1.7"), "0.1.7")).toEqual([]);
		expect(releaseProblems(release("v0.1.8-nightly.20261108.4380", { prerelease: true }), "0.1.8-nightly.20261108.4380")).toEqual([
			"is a prerelease",
			"has tag v0.1.8-nightly.20261108.4380, not a stable vX.Y.Z",
		]);
		const noArm = release("v0.1.7", { assets: [{ name: "t3-0.1.7-linux-x64.tar.gz" }] });
		expect(releaseProblems(noArm, "0.1.7")).toEqual(["has no t3-0.1.7-linux-arm64.tar.gz", "has no SHA256SUMS"]);
		expect(releaseProblems(release("v0.1.7", { draft: true }), "0.1.7")).toEqual(["is a draft"]);
	});
});

describe("newest stable (mocked GitHub)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/** Upstream with these tags; `releases` maps a tag to its release (absent = 404). */
	function upstream(tags: string[], releases: Record<string, Partial<Release>>) {
		// Matched on exact host and path, so a request anywhere else fails the test.
		const api = `/repos/${UPSTREAM_REPO}`;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.github.com") {
				if (url.pathname === `${api}/git/matching-refs/tags/v`) return Response.json(tags.map((t) => ({ ref: `refs/tags/${t}` })));
				const tag = url.pathname.startsWith(`${api}/releases/tags/`) ? url.pathname.slice(`${api}/releases/tags/`.length) : undefined;
				if (tag) return releases[tag] ? Response.json(release(tag, releases[tag])) : new Response("", { status: 404 });
			}
			if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith(`/${DRIVERS_PATH}`)) return new Response(DRIVERS_V017);
			throw new Error(`unexpected ${url}`);
		}) as typeof fetch;
	}

	test("a newer published stable fails, whatever GitHub marks latest", async () => {
		upstream(["v0.1.7", "v0.1.8", "v0.1.9"], { "v0.1.8": {}, "v0.1.9": {} });
		const report = await checkUpstream("0.1.7");
		expect(report.ok).toBe(false);
		expect(report.lines[0]).toStartWith("T3 Code 0.1.9 is out; T3CODE_VER is 0.1.7.");
	});

	test("a newer tag without a published release, or a prerelease one, is only a note", async () => {
		upstream(["v0.1.7", "v0.1.8", "v0.1.9"], { "v0.1.8": { prerelease: true } });
		const report = await checkUpstream("0.1.7");
		expect(report).toEqual({
			ok: true,
			lines: [
				"T3CODE_VER 0.1.7 is the newest stable T3 Code",
				"  note: v0.1.9 is tagged but has no published release yet",
				"  note: v0.1.8 is a prerelease",
			],
		});
	});

	test("a nightly pin or a pin ahead of upstream fails", async () => {
		upstream(["v0.1.7"], { "v0.1.7": {} });
		expect((await checkUpstream("0.1.8-nightly.20261108.4380")).lines[0]).toContain("is not a stable X.Y.Z");
		expect((await checkUpstream("0.1.8")).lines[0]).toContain("ahead of upstream's newest stable tag v0.1.7");
	});
});

describe("tool pins", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("every pin is set by exactly one line of its file", () => {
		for (const pin of TOOL_PINS) expect(toolPinVersion(pin, read(pin.file))).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("a second line setting a pin is an error, not a silent pick", () => {
		const gh = TOOL_PINS.find((p) => p.name === "gh");
		if (!gh) throw new Error("no gh pin");
		expect(() => toolPinVersion(gh, "ARG GH_VER=2.1.0\nARG GH_VER=2.2.0\n")).toThrow("2 lines set the gh pin");
		expect(() => toolPinVersion(gh, "")).toThrow("0 lines set the gh pin");
	});

	test("the latest tag must be the pin with the repo's tag prefix", () => {
		const bun = TOOL_PINS.find((p) => p.name === "Bun");
		if (!bun) throw new Error("no Bun pin");
		expect(toolPinReport(bun, "1.4.4", "bun-v1.4.4").ok).toBe(true);
		const stale = toolPinReport(bun, "1.4.4", "bun-v1.4.5");
		expect(stale.ok).toBe(false);
		expect(stale.lines[0]).toStartWith("Bun: oven-sh/bun's latest release is bun-v1.4.5; Dockerfile pins 1.4.4. Bump BUN_VER");
	});

	test("checkTools asks releases/latest for each repo and lists only the stale pins", async () => {
		const asked: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			const repo = url.pathname.match(/^\/repos\/(.+)\/releases\/latest$/)?.[1];
			const pin = TOOL_PINS.find((p) => p.repo === repo);
			if (url.hostname !== "api.github.com" || !pin) throw new Error(`unexpected ${url}`);
			asked.push(pin.repo);
			const pinned = toolPinVersion(pin, read(pin.file));
			return Response.json({ tag_name: `${pin.tagPrefix}${pin.name === "uv" ? "9.9.9" : pinned}` });
		}) as typeof fetch;
		const report = await checkTools();
		expect(asked).toEqual(TOOL_PINS.map((p) => p.repo));
		expect(report.ok).toBe(false);
		expect(report.lines).toHaveLength(1);
		expect(report.lines[0]).toStartWith("uv: astral-sh/uv's latest release is 9.9.9;");
	});

	test("a lookup that fails is reported for that pin, and the others are still checked", async () => {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			const repo = url.pathname.match(/^\/repos\/(.+)\/releases\/latest$/)?.[1];
			const pin = TOOL_PINS.find((p) => p.repo === repo);
			if (!pin) throw new Error(`unexpected ${url}`);
			if (pin.name === "gh") return new Response("", { status: 404 });
			return Response.json({ tag_name: `${pin.tagPrefix}${pin.name === "actionlint" ? "9.9.9" : toolPinVersion(pin, read(pin.file))}` });
		}) as typeof fetch;
		const report = await checkTools();
		expect(report.ok).toBe(false);
		expect(report.lines).toHaveLength(2);
		expect(report.lines[0]).toStartWith("gh: not checked: https://api.github.com/repos/cli/cli/releases/latest: HTTP 404");
		expect(report.lines[1]).toStartWith("actionlint: rhysd/actionlint's latest release is v9.9.9;");
	});
});

describe("CLI", () => {
	test("inherited property names are usage errors, not commands", async () => {
		for (const command of ["constructor", "__proto__", "toString", ""]) expect(await main([command])).toBe(2);
	});
});
