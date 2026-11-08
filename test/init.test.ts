/** bin/t3code-init, the image's PID 1 (#25): signal forwarding and exit status. */
import { afterEach, describe, expect, test } from "bun:test";

const init = new URL("../bin/t3code-init", import.meta.url).pathname;
const groups: number[] = [];

// Each init runs in its own process group, so a broken init can't leave its
// child looping after the test.
afterEach(() => {
	for (const pid of groups.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
});

// The init needs bash 5.1+ (`wait -p`; INT/QUIT reset for background jobs):
// Debian's 5.2 in the image and CI's runner. macOS's /bin/bash 3.2 has
// neither (checked 2026-11-08), so the suite skips there.
const bashVersion = Bun.spawnSync(["bash", "-c", "echo $BASH_VERSION"]).stdout.toString();
const [major = 0, minor = 0] = bashVersion.split(".").map(Number);
const modernBash = major > 5 || (major === 5 && minor >= 1);

describe.skipIf(!modernBash)("t3code-init", () => {
	/**
	 * Start the init around `script` (run by sh). The init installs its traps
	 * before it starts the child, so once the script prints a line (after its own
	 * traps), both are ready for signals.
	 */
	async function start(script: string) {
		const proc = Bun.spawn(["bash", init, "sh", "-c", script], {
			detached: true,
			stdout: "pipe",
			stderr: "inherit",
		});
		groups.push(proc.pid);
		const reader = proc.stdout.getReader();
		const line = async () => new TextDecoder().decode((await reader.read()).value);
		expect(await line()).toStartWith("up");
		return { proc, line };
	}

	const loop = "while :; do sleep 0.1; done";

	test("passes the child's exit status through", async () => {
		const { proc } = await start("echo up; exit 7");
		expect(await proc.exited).toBe(7);
	});

	test("has a TERM handler of its own, the bit RouterOS checks in SigCgt", async () => {
		// An init that did not catch TERM would die of it (143) before the child's
		// trap ran; a forwarded TERM lets the child exit on its own terms.
		const { proc } = await start(`trap 'exit 0' TERM; echo up; ${loop}`);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
	});

	test("forwards other signals and keeps waiting for the child", async () => {
		const { proc, line } = await start(`trap 'echo hup' HUP; trap 'exit 3' TERM; echo up; ${loop}`);
		proc.kill("SIGHUP");
		expect(await line()).toContain("hup");
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(3);
	});

	test("a child that dies of the signal reports 128+n", async () => {
		const { proc } = await start(`echo up; ${loop}`);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(143);
	});

	// bash starts background jobs with INT and QUIT ignored; the init resets them
	// for its child.
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGQUIT", 131],
	] as const) {
		test(`a child with default handlers dies of a forwarded ${signal}`, async () => {
			const { proc } = await start(`echo up; ${loop}`);
			proc.kill(signal);
			expect(await proc.exited).toBe(code);
		});
	}
});
