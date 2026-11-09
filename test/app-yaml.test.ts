import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "js-yaml";
import {
	BROWSER_LIBRARIES,
	buildStatus,
	CORE_CHECKS,
	DEFAULT_TOOL_GROUPS,
	formatStatus,
	GROUP_NAMES,
	GROUPS,
	groupStatus,
	NETWORK_PACKAGE_ASSIGNMENT,
	type Probe,
	parseToolGroups,
} from "../scripts/tool-groups.ts";

const APP_DIR = join(import.meta.dir, "..", "app");
const YAML_PATH = join(APP_DIR, "t3code.tikapp.yaml");
const STORE_PATH = join(APP_DIR, "t3code.tikappstore.yaml");

const VALID_CATEGORIES = new Set([
	"productivity",
	"storage",
	"networking",
	"development",
	"communication",
	"file-management",
	"search",
	"video",
	"media",
	"media-management",
	"home-automation",
	"monitoring",
	"database",
	"automation",
	"ai",
	"messaging",
	"radio",
	"security",
	"business",
]);

function loadYaml(path: string): unknown {
	return YAML.load(readFileSync(path, "utf8"));
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(value).toBeTypeOf("object");
	return value as Record<string, unknown>;
}

/** Accept old OCI-style, new colon-style, or long-form port entries. */
function portMapsWebUi(ports: unknown): boolean {
	if (!Array.isArray(ports)) return false;
	return ports.some((entry) => {
		if (typeof entry === "string") {
			// Must mention host 3773, container 3773, a web label, and tcp.
			return (
				entry.includes("3773") &&
				entry.toLowerCase().includes("web") &&
				entry.toLowerCase().includes("tcp")
			);
		}
		if (entry !== null && typeof entry === "object") {
			const rec = entry as Record<string, unknown>;
			const target = rec["target"];
			const published = rec["published"];
			const name = rec["name"];
			const protocol = rec["protocol"];
			return (
				(target === 3773 || target === "3773") &&
				(published === 3773 || published === "3773") &&
				(name === "web" || (typeof name === "string" && name.includes("web"))) &&
				(protocol === undefined ||
					protocol === "tcp" ||
					(typeof protocol === "string" && protocol.toLowerCase() === "tcp"))
			);
		}
		return false;
	});
}

function envHas(env: unknown, key: string, value: string): boolean {
	if (Array.isArray(env)) {
		return env.some((item) => typeof item === "string" && item === `${key}=${value}`);
	}
	if (env !== null && typeof env === "object") {
		const rec = env as Record<string, unknown>;
		const found = rec[key];
		return found === value || found === Number(value);
	}
	return false;
}

describe("t3code.tikapp.yaml", () => {
	test("parses and has the required service shape", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		expect(doc["name"]).toBe("t3code");
		expect(typeof doc["descr"]).toBe("string");

		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		expect(typeof svc["image"]).toBe("string");

		// No docker-compose-isms RouterOS ignores or rejects.
		for (const banned of ["version", "deploy", "resources"]) {
			expect(doc[banned]).toBeUndefined();
		}
	});

	test("image is our fully-qualified GHCR build, pinned (never :latest)", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		const image = svc["image"] as string;
		expect(image.startsWith("ghcr.io/tikoci/app-t3code:")).toBe(true);
		expect(image.endsWith(":latest")).toBe(false);
	});

	test("web UI is exposed on 3773/tcp with the web label", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		expect(portMapsWebUi(svc["ports"])).toBe(true);
	});

	test("server env pins host, port, and disables telemetry", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		expect(envHas(svc["environment"], "T3CODE_HOST", "0.0.0.0")).toBe(true);
		expect(envHas(svc["environment"], "T3CODE_PORT", "3773")).toBe(true);
		expect(envHas(svc["environment"], "T3CODE_TELEMETRY_ENABLED", "false")).toBe(true);
		expect(envHas(svc["environment"], "HOME", "/data")).toBe(true);
		expect(envHas(svc["environment"], "T3CODE_HOME", "/data/.t3")).toBe(true);
	});

	test("persists /data on a named volume and restarts with the router", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		const volumes = svc["volumes"];
		expect(Array.isArray(volumes)).toBe(true);
		expect(
			(volumes as unknown[]).some(
				(v) => typeof v === "string" && v.endsWith(":/data"),
			),
		).toBe(true);
		expect(svc["restart"]).toBe("unless-stopped");

		const topVolumes = asRecord(doc["volumes"]);
		// Renaming the volume would select an empty home on an upgrade.
		expect(volumes).toEqual(["t3code-data:/data"]);
		expect(topVolumes["t3code-data"]).toEqual({});
	});

	test("README editor snapshot decodes to the complete published YAML", () => {
		const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
		const link = readme.match(/\[See in \/app YAML Editor\]\((https:[^)]+)\)/)?.[1];
		expect(link).toBeDefined();
		expect(new URL(link as string).searchParams.get("yaml")).toBe(
			readFileSync(YAML_PATH, "utf8"),
		);
	});

	test("category is a valid /app store category", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		if (doc["category"] !== undefined) {
			expect(VALID_CATEGORIES.has(doc["category"] as string)).toBe(true);
		}
	});
});

describe("release sync", () => {
	test("YAML stability tag tracks package.json major.minor", () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
		) as { version: string };
		const minor = pkg.version.split(".").slice(0, 2).join(".");
		const doc = asRecord(loadYaml(YAML_PATH));
		const services = asRecord(doc["services"]);
		const svc = asRecord(services["t3code"]);
		expect(svc["image"]).toBe(`ghcr.io/tikoci/app-t3code:${minor}`);
	});

	test("every T3CODE_VER pin matches package.json version", () => {
		const root = join(import.meta.dir, "..");
		const read = (path: string) => readFileSync(join(root, path), "utf8");
		const { version } = JSON.parse(read("package.json")) as { version: string };
		// The `t3code_ver` dispatch input's own default, then its `|| '…'` fallback.
		const inputDefault = /^ {6}t3code_ver:\n(?: {8}.*\n)*? {8}default: "([^"]*)"$/gm;
		const fallback = /inputs\.t3code_ver \|\| '([^']*)'/g;
		const pins: Array<[string, RegExp]> = [
			["Dockerfile", /^ARG T3CODE_VER=(\S+)$/gm],
			["Makefile", /^T3CODE_VER \?= (\S+)$/gm],
			[".github/workflows/ci.yml", inputDefault],
			[".github/workflows/ci.yml", fallback],
			[".github/workflows/integration.yml", inputDefault],
			[".github/workflows/integration.yml", fallback],
			["README.md", /`ghcr\.io\/tikoci\/app-t3code:([^`]+)` — exact release/g],
		];
		for (const [file, pattern] of pins) {
			const found = [...read(file).matchAll(pattern)].map((m) => m[1]);
			expect({ file, pattern: pattern.source, found }).toEqual({
				file,
				pattern: pattern.source,
				found: [version],
			});
		}
	});
});

describe("t3code.tikappstore.yaml", () => {
	test("is a YAML array carrying the same t3code document", () => {
		const store = loadYaml(STORE_PATH);
		expect(Array.isArray(store)).toBe(true);
		const docs = store as unknown[];
		expect(docs.length).toBeGreaterThan(0);
		const names = docs.map((d) => (d as Record<string, unknown>)["name"]);
		expect(names).toContain("t3code");
		expect(docs.find((d) => asRecord(d)["name"] === "t3code")).toEqual(
			loadYaml(YAML_PATH),
		);
	});
});

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/** `ENV KEY=value` / `ENV KEY="value"` defaults from the Dockerfile. */
function dockerfileEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const match of DOCKERFILE.matchAll(/^ENV (\w+)=(?:"([^"]*)"|(\S+))$/gm)) {
		env[match[1] as string] = (match[2] ?? match[3]) as string;
	}
	return env;
}

describe("T3CODE_TOOL_GROUPS selector", () => {
	test("accepts space, + and comma separators, case-insensitively", () => {
		for (const raw of ["capture labs", "capture+labs", "capture,labs", " LABS ,  Capture+", "labs capture capture"]) {
			const selection = parseToolGroups(raw);
			expect(selection.selected).toEqual(["capture", "labs"]);
			expect(selection.warnings).toEqual([]);
		}
	});

	test("unset and empty select the explicit default list; none means core only", () => {
		for (const raw of [undefined, null, "", "  "]) {
			const selection = parseToolGroups(raw);
			expect(selection.selected).toEqual(["capture", "labs", "vpn", "routing", "dev"]);
			expect(selection.defaulted).toBe(true);
			expect(selection.warnings).toEqual([]);
		}
		expect(parseToolGroups(undefined).raw).toBeNull();
		for (const raw of ["none", "NONE", " none "]) {
			expect(parseToolGroups(raw).selected).toEqual([]);
			expect(parseToolGroups(raw).defaulted).toBe(false);
			expect(parseToolGroups(raw).warnings).toEqual([]);
		}
		// Operators shorten the list by removing names.
		expect(parseToolGroups("capture vpn routing").selected).toEqual(["capture", "vpn", "routing"]);
	});

	test("the default is an explicit list of every current group, not `all`", () => {
		expect(DEFAULT_TOOL_GROUPS).not.toContain("all");
		expect(DEFAULT_TOOL_GROUPS.split(" ")).toEqual(["capture", "labs", "vpn", "routing", "dev"]);
		// A new group must be added to the default deliberately (or left out of it).
		expect([...GROUP_NAMES].sort()).toEqual(DEFAULT_TOOL_GROUPS.split(" ").sort());
		expect(parseToolGroups(DEFAULT_TOOL_GROUPS).defaulted).toBe(false);
		expect(parseToolGroups(DEFAULT_TOOL_GROUPS).selected).toEqual(parseToolGroups(undefined).selected);
	});

	test("all selects every group in definition order", () => {
		expect(parseToolGroups("all").selected).toEqual([...GROUP_NAMES]);
		expect(parseToolGroups("vpn all").selected).toEqual([...GROUP_NAMES]);
	});

	test("unknown names warn and are ignored, never thrown", () => {
		const selection = parseToolGroups("capture bogus+bogus;x");
		expect(selection.selected).toEqual(["capture"]);
		expect(selection.unknown).toEqual(["bogus", "bogus;x"]);
		expect(selection.warnings).toHaveLength(2);
		expect(selection.warnings[0]).toContain('unknown group "bogus" ignored');
		const mixed = parseToolGroups("none vpn");
		expect(mixed.selected).toEqual(["vpn"]);
		expect(mixed.warnings[0]).toContain('"none" combined');
	});

	test("status reports every group with a truthful state", () => {
		const nothing: Probe = { which: () => null, exists: () => false, library: () => null };
		const everything: Probe = { which: (c) => `/usr/bin/${c}`, exists: () => true, library: (l) => `/lib/${l}` };
		const missing = buildStatus("all", nothing, "/nonexistent", null);
		expect(missing.core.state).toBe("degraded");
		expect(missing.buildInventory.present).toBe(false);
		for (const group of missing.groups) {
			expect(group.selected).toBe(true);
			const expected: Record<string, string> = { npm: "pending", deb: "pending", none: "not-implemented" };
			expect(group.state as string).toBe(expected[group.delivery] as string);
		}
		// Core covers the browser libraries; provider CLIs are T3CODE_PROVIDERS (#13), reported beside core.
		expect(missing.core.missing).toEqual(expect.arrayContaining(["uv", "uvx", "sqlite3", "gh", "fc-list", ...BROWSER_LIBRARIES]));
		expect(missing.core.missing).not.toContain("codex");
		expect(missing.providers.find((p) => p.token === "codex")).toMatchObject({ selected: true, path: null });
		expect(buildStatus("none", everything, "/nonexistent", null).providers.find((p) => p.token === "codex")?.path).toBe("/usr/bin/codex");
		const present = buildStatus("none", everything, "/nonexistent", null);
		expect(present.core.state).toBe("ready");
		expect(Object.fromEntries(present.groups.map((g) => [g.name, g.state]))).toEqual({
			capture: "not-selected",
			labs: "not-selected",
			vpn: "not-selected",
			routing: "not-selected",
			dev: "not-selected",
		});
		const defaulted = buildStatus(undefined, everything, "/nonexistent", null);
		expect(defaulted.selector.defaulted).toBe(true);
		expect(defaulted.groups.map((g) => g.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
		expect(formatStatus(defaulted)).toStartWith("T3CODE_TOOL_GROUPS=(unset) (default) -> capture labs vpn routing dev\n");
		// A group without an installer never claims ready, even if its tools happen to exist.
		const labs = GROUPS.find((g) => g.name === "labs");
		if (!labs) throw new Error("labs group missing");
		expect(groupStatus({ ...labs, name: "future", delivery: "none" }, true, everything).state).toBe("not-implemented");
		// Payload groups never claim ready from PATH either: only their payload counts.
		expect(buildStatus("capture", everything, "/nonexistent", null).groups.find((g) => g.name === "capture")?.state).toBe("pending");
		expect(buildStatus("labs", everything, "/nonexistent", null).groups.find((g) => g.name === "labs")?.state).toBe("pending");
	});
});

describe("tool groups: docs and image contract", () => {
	test("README documents the selector with spaces and every group", () => {
		expect(README).toContain('`T3CODE_TOOL_GROUPS`');
		expect(README).toContain('`"capture labs"`');
		for (const name of GROUP_NAMES) expect(README).toContain(`| \`${name}\` |`);
		expect(README).toContain("t3code-tools status --json");
	});

	test("README carries the tested replace-one-key script for app and service t3code", () => {
		expect(README).toContain(`\`\`\`routeros
:local app "t3code"; :local key "t3code:T3CODE_TOOL_GROUPS="; :local val "capture labs"
:local keep ({}); :foreach e in=[/app/get $app environment] do={ :if ([:find $e $key] != 0) do={ :set keep ($keep, $e) } }
/app/set $app environment=($keep, ($key . $val))
\`\`\``);
		const doc = asRecord(loadYaml(YAML_PATH));
		expect(Object.keys(asRecord(doc["services"]))).toEqual(["t3code"]);
	});

	test("YAML description stays a product description; the selection lives in environment", () => {
		const descr = asRecord(loadYaml(YAML_PATH))["descr"] as string;
		expect(descr).not.toContain("T3CODE_TOOL_GROUPS");
		// "browser" and "dev" are ordinary words; the distinctive names and "group" are not.
		for (const word of ["group", "capture", "labs", "vpn", "routing", "agents-extra"]) {
			expect(descr.toLowerCase()).not.toContain(word);
		}
	});

	test("YAML, store YAML, image ENV and README ship the same explicit default", () => {
		const svc = asRecord(asRecord(asRecord(loadYaml(YAML_PATH))["services"])["t3code"]);
		expect(asRecord(svc["environment"])["T3CODE_TOOL_GROUPS"]).toBe(DEFAULT_TOOL_GROUPS);
		const store = (loadYaml(STORE_PATH) as Record<string, unknown>[]).find((d) => d["name"] === "t3code");
		expect(asRecord(asRecord(asRecord(store?.["services"])["t3code"])["environment"])["T3CODE_TOOL_GROUPS"]).toBe(DEFAULT_TOOL_GROUPS);
		expect(dockerfileEnv()["T3CODE_TOOL_GROUPS"]).toBe(DEFAULT_TOOL_GROUPS);
		expect(README).toContain(`| \`T3CODE_TOOL_GROUPS\` | \`${DEFAULT_TOOL_GROUPS}\``);
	});

	test("browser and agents-extra are retired as groups; their contents stay core", () => {
		expect(GROUP_NAMES).toEqual(["capture", "labs", "vpn", "routing", "dev"]);
		for (const retired of ["browser", "agents-extra"]) {
			expect(README).not.toContain(`| \`${retired}\` |`);
			const selection = parseToolGroups(retired);
			expect(selection.unknown).toEqual([retired]);
		}
		// T3's browser keeps its native libraries in the image's first apt layer.
		for (const pkg of ["fontconfig", "fonts-liberation", "libasound2t64", "libatk-bridge2.0-0t64", "libgbm1", "libnss3", "libxkbcommon0", "libxrandr2"]) {
			expect(DOCKERFILE).toMatch(new RegExp(`^\\s+${pkg.replace(/[.+]/g, "\\$&")} (?:\\\\|&&)`, "m"));
		}
		const coreLibraries = CORE_CHECKS.filter((c) => c.kind === "library").map((c) => c.name);
		expect(coreLibraries).toEqual([...BROWSER_LIBRARIES]);
	});

	test("Muse is not bundled; uv, uvx, sqlite3 and zstd are core bootstrap tools", () => {
		expect(DOCKERFILE).not.toContain("dev.meta.ai/install.sh");
		expect(DOCKERFILE).not.toMatch(/\/usr\/local\/bin\/muse/);
		expect(CORE_CHECKS.map((c) => c.name)).not.toContain("muse");
		expect(DOCKERFILE).toMatch(/^FROM ghcr\.io\/astral-sh\/uv:\$\{UV_VER\} AS uv$/m);
		expect(DOCKERFILE).toMatch(/^ARG UV_VER=\d+\.\d+\.\d+$/m);
		expect(DOCKERFILE).toContain("COPY --from=uv /uv /uvx /usr/local/bin/");
		expect(DOCKERFILE).toMatch(/^\s+sqlite3 \\$/m);
		// bin/install-claude-code downloads Claude's .zst build when zstd is present.
		expect(DOCKERFILE).toMatch(/^\s+zstd && \\$/m);
		expect(dockerfileEnv()["UV_PYTHON_DOWNLOADS"]).toBe("manual");
		for (const name of ["uv", "uvx", "sqlite3", "zstd"]) expect(CORE_CHECKS.map((c) => c.name)).toContain(name);
	});

	test("gh is core: a pinned GitHub CLI release, checked against its checksums file", () => {
		expect(DOCKERFILE).toMatch(/^ARG GH_VER=\d+\.\d+\.\d+$/m);
		expect(DOCKERFILE).toContain('url="https://github.com/cli/cli/releases/download/v${GH_VER}"');
		// The archive the checksum line names is the one extracted and installed.
		expect(DOCKERFILE).toContain('name="gh_${GH_VER}_linux_${TARGETARCH}"');
		expect(DOCKERFILE).toContain('grep -E "[[:space:]]${name}\\.tar\\.gz$" "gh_${GH_VER}_checksums.txt" | sha256sum -c -');
		expect(DOCKERFILE).toContain('tar -xzof "${name}.tar.gz"');
		expect(DOCKERFILE).toContain('install -m 0755 "${name}/bin/gh" /usr/local/bin/gh');
		expect(CORE_CHECKS.map((c) => c.name)).toContain("gh");
	});

	test("every YAML env value is also an image ENV default (environment= replaces the list)", () => {
		const doc = asRecord(loadYaml(YAML_PATH));
		const svc = asRecord(asRecord(doc["services"])["t3code"]);
		const env = asRecord(svc["environment"]);
		const defaults = dockerfileEnv();
		for (const [key, value] of Object.entries(env)) {
			expect({ key, value: defaults[key] }).toEqual({ key, value: String(value) });
		}
	});

	test("every network package is assigned once; core ones are installed, group ones are not", () => {
		const research = readFileSync(join(ROOT, "scripts", "research-package-costs.ts"), "utf8");
		const networkBundle = research.match(/"network-extension": \[([^\]]+)\]/)?.[1] ?? "";
		const baseBundle = research.match(/"network-tools": \[([^\]]+)\]/)?.[1] ?? "";
		const researched = [...`${networkBundle},${baseBundle}`.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
		researched.push("nmap", "ike-scan", "openvpn", "sstp-client", "ppp", "xl2tpd", "pppoe", "nfdump", "bird2", "lldpd", "ndisc6", "arping");
		expect(researched.length).toBeGreaterThan(25);
		for (const name of researched) expect(Object.keys(NETWORK_PACKAGE_ASSIGNMENT)).toContain(name);

		const places = new Set(["core", "lab-guest", ...GROUP_NAMES]);
		for (const [name, place] of Object.entries(NETWORK_PACKAGE_ASSIGNMENT)) {
			expect({ name, ok: places.has(place) || place.startsWith("not-shipped: ") }).toEqual({ name, ok: true });
			if (GROUP_NAMES.includes(place)) {
				expect(GROUPS.find((g) => g.name === place)?.packages).toContain(name);
			}
			const installed = new RegExp(`^\\s+${name.replace(/[.+]/g, "\\$&")} \\\\$|^\\s+${name.replace(/[.+]/g, "\\$&")} &&`, "m");
			expect({ name, installed: installed.test(DOCKERFILE) }).toEqual({ name, installed: place === "core" });
			if (place === "core" || GROUP_NAMES.includes(place)) expect(README).toContain(`\`${name}\``);
			else expect(README.toLowerCase()).toContain(name.split(" ")[0] as string);
		}
	});
});
