import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "js-yaml";
import {
	buildStatus,
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

	test("unset, empty and none mean core only", () => {
		for (const raw of [undefined, null, "", "  ", "none", "NONE"]) {
			expect(parseToolGroups(raw).selected).toEqual([]);
			expect(parseToolGroups(raw).warnings).toEqual([]);
		}
		expect(parseToolGroups(undefined).raw).toBeNull();
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
			const expected: Record<string, string> = { image: "failed", npm: "pending", deb: "pending", none: "not-implemented" };
			expect(group.state as string).toBe(expected[group.delivery] as string);
		}
		const present = buildStatus("labs", everything, "/nonexistent", null);
		expect(present.core.state).toBe("ready");
		expect(Object.fromEntries(present.groups.map((g) => [g.name, g.state]))).toEqual({
			capture: "not-selected",
			labs: "ready",
			vpn: "not-selected",
			routing: "not-selected",
			dev: "not-selected",
			browser: "not-selected",
			"agents-extra": "not-selected",
		});
		// A group without an installer never claims ready, even if its tools happen to exist.
		const labs = GROUPS.find((g) => g.name === "labs");
		if (!labs) throw new Error("labs group missing");
		expect(groupStatus({ ...labs, name: "future", delivery: "none" }, true, everything).state).toBe("not-implemented");
		// Payload groups never claim ready from PATH either: only their payload counts.
		expect(buildStatus("capture", everything, "/nonexistent", null).groups.find((g) => g.name === "capture")?.state).toBe("pending");
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

	test("YAML description does not advertise unimplemented group controls", () => {
		const descr = asRecord(loadYaml(YAML_PATH))["descr"] as string;
		expect(descr).not.toContain("T3CODE_TOOL_GROUPS");
		// "browser" and "dev" are ordinary words; the distinctive names and "group" are not.
		for (const word of ["group", "capture", "labs", "vpn", "routing", "agents-extra"]) {
			expect(descr.toLowerCase()).not.toContain(word);
		}
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
