/**
 * docker-entrypoint.sh run for real, with the background installers swapped
 * for missing files, so only its own setup and the `exec` are exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			ENTRYPOINT.replaceAll("/usr/local/bin/install-claude-code", join(dir, "absent")).replaceAll("/usr/local/bin/t3code-tools", join(dir, "absent")),
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
});
