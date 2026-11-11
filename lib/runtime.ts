// Primitives both installers share: tool-group payloads (tool-payloads.ts)
// and provider CLIs (providers.ts). Each keeps its own lifecycle; this file
// holds only what both already need: the app's home and state directory,
// disk and retry budgets, process identity, stopping an orphaned child, the
// kernel lock, starting an install in the background, and the help rule every
// t3app area shares. Nothing here knows about groups or providers.
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
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

/**
 * A runtime probe (Node's ABI, dpkg's architecture) that keeps an answer for
 * good but a failure only for `retryMs`. Under load, a probe can miss its
 * timeout, and a failure kept for the whole run would outlast every retry
 * round (#53). The default is shorter than the first back-off.
 */
export function cachedProbe<T>(probe: () => T | null, retryMs = 10_000, now: () => number = Date.now): () => T | null {
	let value: T | null = null;
	let failedAt = Number.NEGATIVE_INFINITY;
	return () => {
		if (value !== null) return value;
		if (now() - failedAt < retryMs) return null;
		value = probe();
		if (value === null) failedAt = now();
		return value;
	};
}

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

/** Rotate a background log once it passes this, as the entrypoint's `background` helper does. */
export const LOG_ROTATE_BYTES = MiB;

/**
 * Start an install in its own session and return its pid at once. RouterOS
 * drops a /container/shell reply after about 60 s, so a long operation
 * answers with what it started and leaves progress to `t3app status`.
 * Output is appended to `log` (the same file the entrypoint's background
 * run of that installer uses, rotated the same way at 1 MiB), after a line
 * naming what started; nothing is left attached to the caller's terminal,
 * so the child outlives it.
 */
export function startInBackground(name: string, argv: readonly string[], log: string, env: NodeJS.ProcessEnv = process.env): number {
	mkdirSync(dirname(log), { recursive: true });
	if (existsSync(log) && statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.1`);
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

/** A running install as `startOnce` reports it: the one it started, or whatever `busy` found. */
export interface Running extends ProcessId {
	startedAt: string;
	/** What holds the installer's lock, when `busy` knows (install, prune). */
	command?: string;
}

export type Launch = { started: true; pid: number } | { started: false; running: Running };

/**
 * Start a background install unless one is running, atomically: the check,
 * the spawn and the record of what was spawned happen under a kernel lock on
 * `<log>.launch`, which also holds that record. So two callers at once never
 * both start one, including in the moment before a child takes the
 * installer's own lock. `busy` reports runs this launcher didn't start (the
 * entrypoint's, or one holding the installer lock).
 */
export function startOnce(name: string, argv: readonly string[], log: string, busy: () => Running | null): Launch {
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(`${log}.launch`, "a+");
	try {
		if (!kernelFlock(fd, LOCK_EX)) throw new Error(`cannot lock ${log}.launch`);
		let last: Running | null = null;
		try {
			last = JSON.parse(readFileSync(`${log}.launch`, "utf8")) as Running;
		} catch {
			// Empty or unreadable: nothing launched yet.
		}
		if (last && isSameProcess(last)) return { started: false, running: last };
		const other = busy();
		if (other) return { started: false, running: other };
		const pid = startInBackground(name, argv, log);
		const record: Running = { pid, startTicks: processStartTicks(pid), startedAt: new Date().toISOString(), command: "install" };
		ftruncateSync(fd, 0);
		writeSync(fd, JSON.stringify(record), 0);
		return { started: true, pid };
	} finally {
		closeSync(fd); // drops the lock
	}
}

/**
 * Who holds the kernel lock on an installer's lock file, for a launcher's
 * `busy` check: an installer takes the lock before it writes its record, and
 * the providers installer may stop an orphaned step in between, so the
 * record alone can miss a run that has started. Tries the lock without
 * waiting and lets go at once; an installer trying it at that same instant
 * finds it busy, which it already handles (--keep-trying waits a round).
 * The holder's pid is whatever its record names so far (0 if none yet;
 * `pidLabel` prints that as "unknown").
 */
export function lockHolder(path: string): Running | null {
	if (!existsSync(path)) return null;
	const fd = openSync(path, "r");
	try {
		if (kernelFlock(fd, LOCK_EX | LOCK_NB)) return null;
	} finally {
		closeSync(fd); // drops the lock if the try took it
	}
	let pid = 0;
	let command: string | undefined;
	try {
		const text = readFileSync(path, "utf8");
		const record = text.trimStart().startsWith("{") ? (JSON.parse(text) as Partial<Running>) : { pid: Number.parseInt(text, 10) };
		pid = Number.isInteger(record.pid) ? (record.pid as number) : 0;
		command = record.command;
	} catch {
		// A record mid-write: the lock is what counts.
	}
	return { pid, startTicks: null, startedAt: statSync(path).mtime.toISOString(), ...(command ? { command } : {}) };
}

/** A pid for operator output: "unknown" when a lock holder has not named itself yet. */
export const pidLabel = (id: { pid: number }): string => (id.pid > 0 ? String(id.pid) : "unknown");

const isHelpFlag = (arg: string | undefined) => arg === "--help" || arg === "-h";

/**
 * The t3app help rule (AGENTS.md "CLI conventions"): `help`, `--help` or
 * `-h` alone, or `<command> --help` for a known command, is a help request
 * ("help", exit 0). Any of them with anything else ("help extra",
 * "install now --help", "bogus --help") is a usage error ("usage", exit 2).
 * null: not about help at all.
 */
export function helpRequest(command: string, rest: readonly string[], commands: readonly string[]): "help" | "usage" | null {
	if (command !== "help" && !isHelpFlag(command) && !rest.some(isHelpFlag)) return null;
	if (rest.length === 0) return "help";
	return rest.length === 1 && isHelpFlag(rest[0]) && commands.includes(command) ? "help" : "usage";
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
