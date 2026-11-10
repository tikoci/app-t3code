// Primitives both installers share: tool-group payloads (tool-payloads.ts)
// and provider CLIs (providers.ts). Each keeps its own lifecycle; this file
// holds only what both already need: the app's home and state directory,
// disk and retry budgets, process identity, stopping an orphaned child, the
// kernel lock and starting an install in the background. Nothing here knows
// about groups or providers.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

export const MiB = 1024 * 1024;

/** The app's home: the image's `ENV HOME` and node's passwd home. */
export const APP_HOME = "/data";

/**
 * The home an install belongs to. Root always means the app's home: a root
 * shell (RouterOS /container/shell, `docker exec -u 0`) may carry
 * HOME=/root, and the payloads and provider CLIs are the app's, not root's.
 */
export function appHome(env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): string {
	return uid === 0 ? APP_HOME : env["HOME"] || APP_HOME;
}

/** Where installer state, the provider lock and the background logs live: persistent, in the home. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): string {
	return join(appHome(env, uid), ".local", "state", "t3code");
}

/** Free space kept for projects and VMs on top of an install's own budget. */
export const DISK_RESERVE_BYTES = 256 * MiB;

/** An install from a terminal: three attempts within about 75 s. */
export const INTERACTIVE_BACKOFF_MS: readonly number[] = [15_000, 60_000];

/**
 * `install --keep-trying` (the entrypoint's background runs): a router often
 * starts the container before its uplink or DNS is up, so keep retrying for
 * about a day: 15 s, 1, 5, 15 and 30 min, then hourly. Verified .debs are
 * kept between attempts, so a retry downloads only what is missing.
 */
export const KEEP_TRYING_BACKOFF_MS: readonly number[] = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, ...Array<number>(23).fill(60 * 60_000)];

export interface ProcessId {
	pid: number;
	/** Kernel start time (/proc/<pid>/stat field 22): pid + start time identify a process even when pids are recycled. */
	startTicks: string | null;
}

/** An install step's process; `processGroup` when it leads its own group (setsid), so stopping it stops everything it started. */
export type Child = ProcessId & { processGroup?: boolean };

/** Start time of a process in clock ticks since boot, or null if it does not exist. */
export function processStartTicks(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the parenthesised command name; starttime is field 22.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

/** Whether pid still names the same process (not a recycled pid). */
export function isSameProcess(id: ProcessId | undefined): boolean {
	if (!id || !Number.isInteger(id.pid) || id.pid <= 0) return false;
	const ticks = processStartTicks(id.pid);
	if (ticks !== null) return ticks === id.startTicks;
	// No /proc (not Linux): fall back to pid existence.
	if (existsSync("/proc/self/stat")) return false;
	try {
		process.kill(id.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGKILL a child and everything it started, if it is still the same process. */
export function stopChild(child: Child): boolean {
	if (!isSameProcess(child)) return false;
	try {
		process.kill(child.processGroup ? -child.pid : child.pid, "SIGKILL");
	} catch {
		return false;
	}
	return true;
}

/** Wait up to about 5 s for a stopped child to be gone. */
export async function waitGone(child: Child): Promise<void> {
	for (let i = 0; i < 100 && isSameProcess(child); i++) await Bun.sleep(50);
}

/**
 * Start an install in its own session and return its pid at once. RouterOS
 * drops a /container/shell reply after about 60 s, so a long operation
 * answers with what it started and leaves progress to `t3app status`.
 * Output is appended to `log` (the same file the entrypoint's background
 * run of that installer uses), after a line naming what started; nothing is
 * left attached to the caller's terminal, so the child outlives it.
 */
export function startInBackground(name: string, argv: readonly string[], log: string, env: NodeJS.ProcessEnv = process.env): number {
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	try {
		const proc = Bun.spawn([...argv], { detached: true, env, stdin: "ignore", stdout: fd, stderr: fd });
		writeSync(fd, `${new Date().toISOString()} t3app: ${name} started in the background (pid ${proc.pid})\n`);
		proc.unref();
		return proc.pid;
	} finally {
		closeSync(fd);
	}
}

export const LOCK_EX = 2;
export const LOCK_NB = 4;
let flockFn: ((fd: number, op: number) => number) | null | undefined;
/** flock(2) via libc. The kernel drops the lock when the holder dies, so there is no stale-lock recovery to race. */
export function kernelFlock(fd: number, op: number): boolean {
	if (flockFn === undefined) {
		try {
			const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
			const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			flockFn = (f, o) => symbols.flock(f, o) as number;
		} catch {
			flockFn = null;
		}
	}
	if (flockFn === null) throw new Error("flock(2) is unavailable; cannot take the install lock");
	return flockFn(fd, op) === 0;
}
