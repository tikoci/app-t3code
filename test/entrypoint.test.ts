/**
 * docker-entrypoint.sh run for real, with the background installers swapped
 * for missing files (or a stub), so only its own setup and the `exec` are
 * exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
			ENTRYPOINT.replaceAll("/usr/local/bin/t3app", join(dir, "absent")),
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

	test("no provider CLI or Claude installer is started outside t3app providers", () => {
		expect(ENTRYPOINT.split("\n").filter((line) => !line.trim().startsWith("#") && line.includes("install-claude-code"))).toEqual([]);
		expect(ENTRYPOINT).toContain("background providers /usr/local/bin/t3app providers install --keep-trying");
		expect(ENTRYPOINT).toContain("background tool-groups /usr/local/bin/t3app tools install --keep-trying");
		expect(ENTRYPOINT).toContain("timeout 40 /usr/local/bin/t3app init");
	});
});

/**
 * The entrypoint's `background` log helper, run for real, with a fake t3app.
 * Every background installer logs into /data/.local/state/t3code (#13).
 */
describe("background install logs", () => {
	let dir: string;
	let entrypoint: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
		const fake = join(dir, "fake-installer");
		writeFileSync(fake, '#!/bin/sh\necho "fake installer ran: $*"\n');
		chmodSync(fake, 0o755);
		entrypoint = join(dir, "entrypoint.sh");
		writeFileSync(entrypoint, ENTRYPOINT.replaceAll("/usr/local/bin/t3app", fake));
		mkdirSync(join(dir, "home"));
	});
	afterEach(() => {
		chmodSync(dir, 0o755);
		Bun.spawnSync(["chmod", "-R", "u+w", dir]);
		rmSync(dir, { recursive: true, force: true });
	});

	async function start() {
		const proc = Bun.spawn(["bash", entrypoint, "sh", "-c", "echo server started"], {
			env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	}
	const log = () => join(dir, "home/.local/state/t3code/providers.log");

	test("each start appends to the persistent log", async () => {
		for (let i = 0; i < 2; i++) {
			const { code, out, err } = await start();
			expect(code, err).toBe(0);
			expect(out).toContain("server started");
		}
		for (let i = 0; i < 100 && (readFileSync(log(), "utf8").match(/fake installer ran/g) ?? []).length < 2; i++) await Bun.sleep(20);
		expect(readFileSync(log(), "utf8").match(/fake installer ran: providers install --keep-trying/g)).toHaveLength(2);
	});

	test("a log over 1 MiB is rotated once", async () => {
		mkdirSync(join(dir, "home/.local/state/t3code"), { recursive: true });
		writeFileSync(log(), "x".repeat(1048577));
		expect((await start()).code).toBe(0);
		expect(statSync(`${log()}.1`).size).toBe(1048577);
		for (let i = 0; i < 100 && !readFileSync(log(), "utf8").includes("fake installer ran"); i++) await Bun.sleep(20);
		expect(readFileSync(log(), "utf8")).toStartWith("fake installer ran");
	});

	test.skipIf(process.getuid?.() === 0)("an unwritable state directory never stops the server", async () => {
		mkdirSync(join(dir, "home/.local/state"), { recursive: true });
		chmodSync(join(dir, "home/.local/state"), 0o555);
		const { code, out, err } = await start();
		expect(code, err).toBe(0);
		expect(out).toContain("server started");
		expect(err).toContain("cannot write");
		// stderr closes only once the background installer has exited too.
		expect(err).toContain("fake installer ran: providers install --keep-trying");
	});

	test.skipIf(process.getuid?.() === 0)("a read-only log falls back to the container log; the installer still runs", async () => {
		mkdirSync(join(dir, "home/.local/state/t3code"), { recursive: true });
		writeFileSync(log(), "earlier run\n", { mode: 0o444 });
		const { code, out, err } = await start();
		expect(code, err).toBe(0);
		expect(out).toContain("server started");
		expect(err).toContain("cannot write");
		expect(err).toContain("fake installer ran: providers install --keep-trying");
		expect(readFileSync(log(), "utf8")).toBe("earlier run\n");
	});
});
