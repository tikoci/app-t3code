// Contract for the RouterOS pairing help (#18): one command, three places.
// The browser panel, the container log line and the README must give the
// same RouterOS command, and the Dockerfile must wire the helper in with its
// build-time guards. Browser behavior was verified against the real T3
// client (docs/research/2026-11-08/pairing-help.md); this test keeps the
// pieces from drifting apart.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

	test("the Dockerfile copies the helper and guards the index.html insertion", () => {
		const dockerfile = read("Dockerfile");
		expect(dockerfile).toContain("COPY client/routeros-pairing.js /opt/t3code/client/routeros-pairing.js");
		expect(dockerfile).toContain(`grep -c '</head>'`);
		expect(dockerfile).toContain("grep -lq 'pairing-token' /opt/t3code/client/assets/*.js");
		expect(dockerfile).toContain(`grep -c 'src="/routeros-pairing.js"'`);
	});
});
