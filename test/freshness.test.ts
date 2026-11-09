// Offline half of the freshness checks (scripts/freshness.ts). The README
// share link is checked here against the real files; the network checks
// (pinned T3 release, newest stable, harness catalog) run in CI and on a
// schedule, so this file only tests their parsing and decisions on fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkShareLink,
	compareVersions,
	diffCatalog,
	parseBuiltInDrivers,
	type Release,
	releaseProblems,
	renderShareLink,
	shareLinks,
	stableVersion,
	versionArg,
} from "../scripts/freshness.ts";
import { HARNESSES } from "../scripts/harnesses.ts";
import { CORE_CHECKS } from "../scripts/tool-groups.ts";

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

	test("every harness the image bakes in is a core check", () => {
		const core = new Set(CORE_CHECKS.filter((c) => c.kind === "command").map((c) => c.name));
		const baked = Object.values(HARNESSES).filter((h) => h.delivery === "image");
		expect(baked.length).toBeGreaterThan(0);
		for (const harness of baked) expect({ cli: harness.cli, core: core.has(harness.cli ?? "") }).toEqual({ cli: harness.cli, core: true });
	});

	test("every harness CLI we deliver or document is in the README provider table", () => {
		const readme = read("README.md");
		for (const harness of Object.values(HARNESSES)) {
			if (harness.cli) expect(readme).toContain(`(\`${harness.cli}\`) |`);
		}
	});
});

describe("releases", () => {
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

	test("compares versions numerically", () => {
		expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
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
