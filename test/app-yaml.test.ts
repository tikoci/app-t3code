import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "js-yaml";

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
