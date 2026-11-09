/** bin/t3code-init, the image's PID 1 (#25): signal forwarding and exit status. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
	// A child with default signal handlers, whatever /bin/sh is. A shell can't
	// be that child: bash (5.2 and 5.3) ignores QUIT in its own process while it
	// runs a script, so where /bin/sh is bash (Arch) a looping `sh -c` never dies
	// of QUIT, while Debian's dash does. `exec` swaps the shell for sleep, which
	// inherits only what the init gave the shell: if the init failed to reset
	// INT/QUIT, sleep would still ignore them and these tests would hang.
	const idle = "exec sleep 300";

	/**
	 * Wait until the init's child has exec'd `name`. "up" comes from the shell
	 * before its exec, and a signal sent in between reaches the shell, which
	 * bash would ignore (QUIT) instead of dying. Same pid throughout: the init's
	 * subshell execs sh, which execs sleep.
	 */
	async function childBecomes(init: number, name: string) {
		const deadline = Date.now() + 2000;
		const comm = (pid: string) => {
			try {
				return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			} catch {
				return "";
			}
		};
		while (Date.now() < deadline) {
			const kids = readFileSync(`/proc/${init}/task/${init}/children`, "utf8").split(/\s+/).filter(Boolean);
			if (kids.some((pid) => comm(pid) === name)) return;
			await Bun.sleep(10);
		}
		throw new Error(`the init's child never became ${name}`);
	}

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
		const { proc } = await start(`echo up; ${idle}`);
		await childBecomes(proc.pid, "sleep");
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
			const { proc } = await start(`echo up; ${idle}`);
			await childBecomes(proc.pid, "sleep");
			proc.kill(signal);
			expect(await proc.exited).toBe(code);
		});
	}
});
