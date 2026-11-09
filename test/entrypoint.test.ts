/**
 * docker-entrypoint.sh run for real, with the background installers swapped
 * for missing files (or a stub), so only its own setup and the `exec` are
 * exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = readFileSync(join(import.meta.dir, "..", "docker-entrypoint.sh"), "utf8");

describe("entrypoint", () => {
	let dir: string;
	let entrypoint: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
		entrypoint = join(dir, "entrypoint.sh");
		writeFileSync(
			entrypoint,
			ENTRYPOINT.replaceAll("/usr/local/bin/t3code-providers", join(dir, "t3code-providers")).replaceAll("/usr/local/bin/t3code-tools", join(dir, "absent")),
		);
		mkdirSync(join(dir, "home"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	// RouterOS starts PID 1 with umask 0000 (7.25, /proc/1/status).
	test("the server starts with umask 022 even when the container's is 000", async () => {
		const proc = Bun.spawn(["sh", "-c", 'umask 000; exec bash "$0" sh -c umask', entrypoint], {
			env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect(code, err).toBe(0);
		expect(out.trim().split("\n").at(-1)).toBe("0022");
	});

	test("no provider CLI or Claude installer is started outside t3code-providers", () => {
		expect(ENTRYPOINT.split("\n").filter((line) => !line.trim().startsWith("#") && line.includes("install-claude-code"))).toEqual([]);
		expect(ENTRYPOINT).toContain("background providers /usr/local/bin/t3code-providers install --keep-trying");
		expect(ENTRYPOINT).toContain("background tool-groups /usr/local/bin/t3code-tools install --keep-trying");
	});

	// One persistent log directory for every background installer (#13).
	test("background installs log into the home, appending across starts", async () => {
		const stub = join(dir, "t3code-providers");
		writeFileSync(stub, '#!/bin/sh\necho "providers $*"\n');
		chmodSync(stub, 0o755);
		const log = join(dir, "home", ".local", "state", "t3code", "providers.log");
		for (let i = 0; i < 2; i++) {
			const proc = Bun.spawn(["bash", entrypoint, "true"], { env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
			const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
			expect(code, err).toBe(0);
			for (let t = 0; t < 100 && !(existsSync(log) && readFileSync(log, "utf8").split("install").length > i + 1); t++) await Bun.sleep(20);
		}
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.filter((line) => line === "providers install --keep-trying").length).toBe(2);
	});
});
