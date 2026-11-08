// Contract for the RouterOS pairing help (#18): one command, three places.
// The browser panel, the container log line and the README must give the
// same RouterOS command, and the Dockerfile must wire the helper in with its
// build-time guards. Browser behavior was verified against the real T3
// client (docs/research/2026-11-08/pairing-help.md); this test keeps the
// pieces from drifting apart.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const helper = read("client/routeros-pairing.js");
const commandMatch = helper.match(/const COMMAND = '([^']+)';/);
const COMMAND = commandMatch?.[1] ?? "";

describe("RouterOS pairing help", () => {
	test("the helper declares one RouterOS command that runs t3-pairing-link", () => {
		expect(COMMAND).toBe(':put [/container/shell app-t3code cmd="t3-pairing-link" as-value]');
	});

	test("the README and the container log line give the same command", () => {
		expect(read("README.md")).toContain(COMMAND);
		expect(read("docker-entrypoint.sh")).toContain(COMMAND);
	});

	test("the helper anchors on #pairing-token and never writes HTML", () => {
		expect(helper).toContain('getElementById("pairing-token")');
		expect(helper).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
	});

	test("the helper parses as a script", () => {
		expect(() => new Function(helper)).not.toThrow();
	});

	test("the Dockerfile installs the helper through the guarded script", () => {
		const dockerfile = read("Dockerfile");
		expect(dockerfile).toContain("COPY client/routeros-pairing.js scripts/install-pairing-help.sh /tmp/pairing-help/");
		expect(dockerfile).toContain(
			"sh /tmp/pairing-help/install-pairing-help.sh /opt/t3code/client /tmp/pairing-help/routeros-pairing.js",
		);
	});
});

// The install script runs against fixture clients shaped like the release's.
describe("install-pairing-help.sh", () => {
	const TAG = '<script defer src="/routeros-pairing.js"></script>';
	const INDEX = '<!doctype html>\n<html>\n  <head>\n    <title>T3 Code</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';
	const BUNDLE = 'const x={id:"pairing-token"};';

	function fixture(index: string, bundle: string | null) {
		const client = mkdtempSync(join(tmpdir(), "pairing-help-"));
		writeFileSync(join(client, "index.html"), index);
		if (bundle !== null) {
			mkdirSync(join(client, "assets"));
			writeFileSync(join(client, "assets", "a-1.js"), "const unrelated=1;");
			writeFileSync(join(client, "assets", "main-2.js"), bundle);
		}
		return client;
	}

	function install(client: string) {
		const run = Bun.spawnSync(
			["sh", join(ROOT, "scripts/install-pairing-help.sh"), client, join(ROOT, "client/routeros-pairing.js")],
			{ stderr: "pipe" },
		);
		return { exitCode: run.exitCode, stderr: run.stderr.toString() };
	}

	test("inserts the tag once before </head> and copies the helper", () => {
		const client = fixture(INDEX, BUNDLE);
		expect(install(client).exitCode).toBe(0);
		const index = readFileSync(join(client, "index.html"), "utf8");
		expect(index.split(TAG).length - 1).toBe(1);
		expect(index).toContain(`  ${TAG}\n  </head>`);
		expect(readFileSync(join(client, "routeros-pairing.js"), "utf8")).toBe(helper);
	});

	test("fails on two </head> on one line (counts occurrences, not lines)", () => {
		const client = fixture("<html><head></head></head><body></body></html>", BUNDLE);
		const run = install(client);
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("exactly one </head>");
		expect(existsSync(join(client, "routeros-pairing.js"))).toBe(false);
	});

	test("fails when the bundle no longer has #pairing-token", () => {
		const run = install(fixture(INDEX, "const renamed=1;"));
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("#pairing-token");
	});

	test("fails when the client has no assets", () => {
		expect(install(fixture(INDEX, null)).exitCode).not.toBe(0);
	});

	test("refuses an index that already loads the helper", () => {
		const client = fixture(INDEX, BUNDLE);
		expect(install(client).exitCode).toBe(0);
		const run = install(client);
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("already loads");
	});
});
