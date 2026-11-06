// Persistent tool-group payloads under the /data home (issue #5, slice 2).
//
// A payload is one group's tools installed from a lockfile shipped in the
// image, into a versioned directory keyed by the lockfile and the runtime it
// was built for:
//
//   $T3CODE_TOOLS_HOME/                      (default ~/.local/share/t3code-tools)
//     bin/<command>                          -> ../groups/<g>/current/node_modules/.bin/<command>
//     groups/<g>/<payloadId>/                package.json, package-lock.json, node_modules, manifest.json
//     groups/<g>/current                     -> <payloadId> (swapped atomically)
//     groups/<g>/.staging-<payloadId>-<pid>  in-progress install (removed on recovery)
//     state.json                             last installer result per group
//     install.lock                           held by the one background installer
//     install.log                            installer log (capped)
//
// Rules: activation never touches the network and runs at every start, so a
// replaced container with the same home gets compatible tools back offline.
// A changed lockfile or runtime (security refresh, Node ABI change) yields a
// new payload id; the previous payload stays active until the new one is
// verified. Deselecting a group removes its shims only; `prune` deletes data.
// Nothing here may block T3 startup: callers run install in the background.
import {
	closeSync,
	existsSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type { GroupDef } from "./tool-groups.ts";

export const PAYLOAD_SCHEMA = 1;
const MiB = 1024 * 1024;
/** Free space kept for projects and VMs on top of a group's own budget. */
export const DISK_RESERVE_BYTES = 256 * MiB;
const LOG_CAP_BYTES = 1 * MiB;

export interface Compat {
	platform: string;
	arch: string;
	/** Node's module ABI (process.versions.modules); a Node major bump changes it. */
	nodeAbi: string;
	node: string;
}

export interface PayloadEnv {
	/** Persistent root under the home volume. */
	root: string;
	/** Directory holding <group>/package.json and package-lock.json (shipped in the image). */
	specDir: string;
	/** Runtime the payload must match. Null when Node is unusable. */
	compat: () => Compat | null;
	/** Command prefix for npm. */
	npm: readonly string[];
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	/** Free bytes available to the payload root. */
	freeBytes: (path: string) => number;
	/** Delays between attempts; attempts = backoff.length + 1. */
	backoffMs: readonly number[];
	/** Per-attempt install timeout. */
	installTimeoutMs: number;
}

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env["T3CODE_TOOLS_HOME"] || join(env["HOME"] || "/data", ".local/share/t3code-tools");
}

let cachedCompat: Compat | null | undefined;
/** Ask the image's Node (not Bun, which runs this module) for its ABI. */
export function nodeCompat(): Compat | null {
	if (cachedCompat !== undefined) return cachedCompat;
	try {
		const proc = Bun.spawnSync(["node", "-p", "[process.platform, process.arch, process.versions.modules, process.version].join(' ')"], { timeout: 10_000 });
		const [platform, arch, nodeAbi, node] = proc.stdout.toString().trim().split(" ");
		cachedCompat = proc.exitCode === 0 && platform && arch && nodeAbi && node ? { platform, arch, nodeAbi, node } : null;
	} catch {
		cachedCompat = null;
	}
	return cachedCompat;
}

export function defaultPayloadEnv(specDir: string, env: NodeJS.ProcessEnv = process.env): PayloadEnv {
	const root = defaultRoot(env);
	return {
		root,
		specDir,
		compat: nodeCompat,
		npm: ["npm"],
		sleep: (ms) => Bun.sleep(ms),
		log: (line) => appendLog(join(root, "install.log"), line),
		freeBytes: (path) => {
			const fs = statfsSync(path);
			return Number(fs.bavail) * Number(fs.bsize);
		},
		backoffMs: [15_000, 60_000],
		installTimeoutMs: 30 * 60_000,
	};
}

function appendLog(path: string, line: string) {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		if (existsSync(path) && statSync(path).size > LOG_CAP_BYTES) renameSync(path, `${path}.1`);
		const fd = openSync(path, "a");
		writeSync(fd, `${new Date().toISOString()} ${line}\n`);
		closeSync(fd);
	} catch {
		// Logging must never break installation or startup.
	}
	console.error(`t3code-tools: ${line}`);
}

/** Commands a payload group exposes on PATH (its command checks). */
export function groupBins(group: GroupDef): string[] {
	return group.checks.filter((check) => check.kind === "command").map((check) => check.name);
}

const groupDir = (env: PayloadEnv, group: string) => join(env.root, "groups", group);
const binDir = (env: PayloadEnv) => join(env.root, "bin");
const currentLink = (env: PayloadEnv, group: string) => join(groupDir(env, group), "current");
const shimTarget = (group: string, bin: string) => join("..", "groups", group, "current", "node_modules", ".bin", bin);

export interface Desired {
	id: string;
	lockSha256: string;
	compat: Compat;
	packages: Record<string, string>;
}

/** The payload this image wants for a group, or an error explaining why none can be computed. */
export function desiredPayload(group: GroupDef, env: PayloadEnv): Desired | { error: string } {
	const dir = join(env.specDir, group.name);
	let lock: string;
	let pkg: { dependencies?: Record<string, string> };
	try {
		lock = readFileSync(join(dir, "package-lock.json"), "utf8");
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch (error) {
		return { error: `payload spec missing in ${dir}: ${String(error)}` };
	}
	const compat = env.compat();
	if (!compat) return { error: "node is not usable, so the payload runtime cannot be determined" };
	const lockSha256 = createHash("sha256").update(lock).digest("hex");
	const key = [PAYLOAD_SCHEMA, group.name, lockSha256, compat.platform, compat.arch, compat.nodeAbi].join("\n");
	const id = `${compat.arch}-abi${compat.nodeAbi}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
	return { id, lockSha256, compat, packages: pkg.dependencies ?? {} };
}

export interface Manifest {
	schemaVersion: number;
	group: string;
	payloadId: string;
	lockSha256: string;
	compat: Compat;
	packages: Record<string, string>;
	/** First line of `<bin> --version`, captured when the payload was verified. */
	versions: Record<string, string>;
	installedAt: string;
	durationMs: number;
}

export interface Verification {
	ok: boolean;
	missing: string[];
	manifest: Manifest | null;
	error?: string;
}

/**
 * Check a payload directory's real files, not just a marker. With `compat`,
 * a payload built for another platform or CPU (a home moved between amd64
 * and arm64 routers) is rejected; a Node ABI difference alone is not, so a
 * stale payload keeps serving while its refresh installs.
 */
export function verifyPayload(dir: string, group: GroupDef, expectedId?: string, compat?: Compat | null): Verification {
	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	} catch {
		return { ok: false, missing: [], manifest: null, error: "no manifest (incomplete or interrupted install)" };
	}
	if (manifest.schemaVersion !== PAYLOAD_SCHEMA || manifest.group !== group.name) {
		return { ok: false, missing: [], manifest, error: "manifest is for another schema or group" };
	}
	if (expectedId && manifest.payloadId !== expectedId) {
		return { ok: false, missing: [], manifest, error: `manifest id ${manifest.payloadId} does not match ${expectedId}` };
	}
	if (compat && (manifest.compat?.platform !== compat.platform || manifest.compat?.arch !== compat.arch)) {
		return { ok: false, missing: [], manifest, error: `built for ${manifest.compat?.platform}-${manifest.compat?.arch}, this runtime is ${compat.platform}-${compat.arch}` };
	}
	const missing = groupBins(group).filter((bin) => !existsSync(join(dir, "node_modules", ".bin", bin)));
	return { ok: missing.length === 0, missing, manifest, ...(missing.length ? { error: "payload files missing" } : {}) };
}

function readLink(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

/** Replace a symlink atomically (rename over the old one). */
function swapLink(path: string, target: string) {
	if (readLink(path) === target) return;
	const tmp = `${path}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(target, tmp);
	renameSync(tmp, path);
}

function removeLink(path: string) {
	try {
		if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
	} catch {
		// Absent already.
	}
}

export function listPayloads(env: PayloadEnv, group: string): string[] {
	try {
		return readdirSync(groupDir(env, group)).filter((name) => !name.startsWith(".") && name !== "current" && !name.startsWith("current."));
	} catch {
		return [];
	}
}

export interface StateRecord {
	state: "installing" | "ready" | "failed";
	payloadId: string;
	attempt: number;
	updatedAt: string;
	error?: string;
	/** True when the error will not clear by retrying (e.g. low disk). */
	permanent?: boolean;
}

export function readState(env: PayloadEnv): Record<string, StateRecord> {
	try {
		return JSON.parse(readFileSync(join(env.root, "state.json"), "utf8")).groups ?? {};
	} catch {
		return {};
	}
}

function writeState(env: PayloadEnv, group: string, record: StateRecord) {
	const groups = readState(env);
	groups[group] = record;
	mkdirSync(env.root, { recursive: true });
	const path = join(env.root, "state.json");
	writeFileSync(`${path}.tmp`, `${JSON.stringify({ schemaVersion: PAYLOAD_SCHEMA, groups }, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

export interface ProcessId {
	pid: number;
	/** Kernel start time (/proc/<pid>/stat field 22): pid + start time identify a process even when pids are recycled. */
	startTicks: string | null;
}

/** Owner record kept in install.lock. Exclusion itself is the kernel flock on that file. */
export interface LockInfo extends ProcessId {
	command: string;
	startedAt: string;
	/** The npm child the holder is running, so a successor can stop it if the holder died first. */
	child?: ProcessId;
}

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
function isSameProcess(id: ProcessId | undefined): boolean {
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

function readLockInfo(path: string): LockInfo | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
	} catch {
		return null;
	}
}

/**
 * The live installer or pruner, if one holds the lock. Status only: the
 * record is advisory and may outlive a holder that died, so liveness is
 * checked by pid + start time. Exclusion uses the kernel lock.
 */
export function liveInstaller(env: PayloadEnv): LockInfo | null {
	const info = readLockInfo(join(env.root, "install.lock"));
	return info && isSameProcess(info) ? info : null;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
let flockFn: ((fd: number, op: number) => number) | null | undefined;
/** flock(2) via libc. The kernel drops the lock when the holder dies, so there is no stale-lock recovery to race. */
function kernelFlock(fd: number, op: number): boolean {
	if (flockFn === undefined) {
		try {
			const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
			const { symbols } = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			flockFn = (f, o) => symbols.flock(f, o) as number;
		} catch {
			flockFn = null;
		}
	}
	if (flockFn === null) throw new Error("flock(2) is unavailable; cannot lock the payload root");
	return flockFn(fd, op) === 0;
}

/** Open lock fds by payload root (closed on release, or by the kernel on exit). */
const heldLocks = new Map<string, number>();

function writeLockInfo(fd: number, info: LockInfo) {
	ftruncateSync(fd, 0);
	writeSync(fd, JSON.stringify(info), 0);
}

/** Stop an npm child orphaned by a holder that died, before its staging is reclaimed. */
async function stopOrphan(env: PayloadEnv, previous: LockInfo | null) {
	const child = previous?.child;
	if (!child || !isSameProcess(child)) return;
	env.log(`stopping npm (pid ${child.pid}) left running by an interrupted ${previous?.command ?? "installer"}`);
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {
		return;
	}
	for (let i = 0; i < 100 && isSameProcess(child); i++) await Bun.sleep(50);
}

async function acquireLock(env: PayloadEnv, command: string): Promise<boolean> {
	mkdirSync(env.root, { recursive: true });
	const path = join(env.root, "install.lock");
	// The file is never unlinked: removing it would let a waiter lock an
	// orphaned inode while a newcomer locks a new file.
	const fd = openSync(path, "a+");
	if (!kernelFlock(fd, LOCK_EX | LOCK_NB)) {
		closeSync(fd);
		return false;
	}
	const previous = readLockInfo(path);
	writeLockInfo(fd, { pid: process.pid, startTicks: processStartTicks(process.pid), command, startedAt: new Date().toISOString() });
	heldLocks.set(env.root, fd);
	await stopOrphan(env, previous);
	return true;
}

/** Record (or clear) the npm child in the lock's owner record. */
function setLockChild(env: PayloadEnv, child: number | null) {
	const fd = heldLocks.get(env.root);
	const info = readLockInfo(join(env.root, "install.lock"));
	if (fd === undefined || !info) return;
	if (child === null) delete info.child;
	else info.child = { pid: child, startTicks: processStartTicks(child) };
	writeLockInfo(fd, info);
}

function releaseLock(env: PayloadEnv) {
	const fd = heldLocks.get(env.root);
	if (fd === undefined) return;
	heldLocks.delete(env.root);
	ftruncateSync(fd, 0);
	closeSync(fd); // closing the last fd drops the flock
}

export interface PayloadInfo {
	root: string;
	desired: string | null;
	desiredError?: string;
	/** Payload the `current` link points at, if it verifies. */
	active: string | null;
	activeVersions: Record<string, string> | null;
	/** Active payload differs from what this image wants; a refresh is due. */
	stale: boolean;
	/** Shims on PATH point at the active payload. */
	linked: boolean;
	installed: string[];
	installer: LockInfo | null;
	last: StateRecord | null;
	log: string;
}

export function payloadInfo(group: GroupDef, env: PayloadEnv): PayloadInfo {
	const desired = desiredPayload(group, env);
	const current = readLink(currentLink(env, group.name));
	const activeCheck = current ? verifyPayload(join(groupDir(env, group.name), current), group, current, env.compat()) : null;
	const active = activeCheck?.ok ? current : null;
	const linked = active !== null && groupBins(group).every((bin) => readLink(join(binDir(env), bin)) === shimTarget(group.name, bin) && existsSync(join(binDir(env), bin)));
	return {
		root: env.root,
		desired: "id" in desired ? desired.id : null,
		...("error" in desired ? { desiredError: desired.error } : {}),
		active,
		activeVersions: activeCheck?.ok ? (activeCheck.manifest?.versions ?? null) : null,
		stale: active !== null && "id" in desired && active !== desired.id,
		linked,
		installed: listPayloads(env, group.name),
		installer: liveInstaller(env),
		last: readState(env)[group.name] ?? null,
		log: join(env.root, "install.log"),
	};
}

/**
 * Fast, offline, idempotent: point selected groups at their best verified
 * payload (the desired one if present, else keep the current one) and link
 * their shims; unlink shims of deselected groups. Returns the selected groups
 * that still need the installer.
 */
export function activate(groups: readonly GroupDef[], selected: readonly string[], env: PayloadEnv): string[] {
	const needInstall: string[] = [];
	mkdirSync(binDir(env), { recursive: true });
	for (const group of groups) {
		const bins = groupBins(group);
		if (!selected.includes(group.name)) {
			for (const bin of bins) if (readLink(join(binDir(env), bin)) === shimTarget(group.name, bin)) removeLink(join(binDir(env), bin));
			continue;
		}
		const desired = desiredPayload(group, env);
		const dir = groupDir(env, group.name);
		if ("id" in desired && verifyPayload(join(dir, desired.id), group, desired.id).ok) {
			swapLink(currentLink(env, group.name), desired.id);
		} else {
			needInstall.push(group.name);
		}
		const current = readLink(currentLink(env, group.name));
		if (current && verifyPayload(join(dir, current), group, current, env.compat()).ok) {
			for (const bin of bins) swapLink(join(binDir(env), bin), shimTarget(group.name, bin));
		} else {
			// Nothing usable here (e.g. built for another CPU): no shims to it.
			for (const bin of bins) if (readLink(join(binDir(env), bin)) === shimTarget(group.name, bin)) removeLink(join(binDir(env), bin));
		}
	}
	return needInstall;
}

function cleanStaging(env: PayloadEnv, group: string) {
	const dir = groupDir(env, group);
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.startsWith(".staging-") || name.startsWith("current.tmp-")) {
			env.log(`${group}: removing interrupted install ${name}`);
			rmSync(join(dir, name), { recursive: true, force: true });
		}
	}
}

async function run(cmd: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number) => void): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
		env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
	});
	onSpawn?.(proc.pid);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code: proc.signalCode ? -1 : code, out: `${out}${err}`.trim() };
}

async function installOnce(group: GroupDef, desired: Desired, env: PayloadEnv, staging: string, cache: string): Promise<Manifest> {
	const started = Date.now();
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	for (const file of ["package.json", "package-lock.json"]) {
		writeFileSync(join(staging, file), readFileSync(join(env.specDir, group.name, file)));
	}
	// --ignore-scripts: the packages ship prebuilt binaries; lifecycle scripts
	// are not needed and should not run from a background installer.
	const npm = await run(
		[...env.npm, "ci", "--prefix", staging, "--cache", cache, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=warn", "--fetch-retries=2"],
		staging,
		env.installTimeoutMs,
		(pid) => setLockChild(env, pid),
	);
	setLockChild(env, null);
	if (npm.code !== 0) throw new Error(`npm ci exited ${npm.code === -1 ? "on timeout" : npm.code}: ${npm.out.split("\n").slice(-5).join(" | ")}`);
	const versions: Record<string, string> = {};
	for (const bin of groupBins(group)) {
		// cwd is the staging dir: markdownlint-cli2 treats --version as a glob.
		const probe = await run([join(staging, "node_modules", ".bin", bin), "--version"], staging, 60_000);
		const first = probe.out.split("\n").find((line) => line.trim()) ?? "";
		if (probe.code !== 0) throw new Error(`${bin} --version exited ${probe.code}: ${first}`);
		versions[bin] = first.trim();
	}
	const manifest: Manifest = {
		schemaVersion: PAYLOAD_SCHEMA,
		group: group.name,
		payloadId: desired.id,
		lockSha256: desired.lockSha256,
		compat: desired.compat,
		packages: desired.packages,
		versions,
		installedAt: new Date().toISOString(),
		durationMs: Date.now() - started,
	};
	// Written last: a payload without a manifest is never trusted.
	writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

/** Keep the active payload and the one before it; delete older ones. */
function pruneOld(env: PayloadEnv, group: string, keep: readonly (string | null)[]) {
	for (const id of listPayloads(env, group)) {
		if (keep.includes(id)) continue;
		env.log(`${group}: removing old payload ${id}`);
		rmSync(join(groupDir(env, group), id), { recursive: true, force: true });
	}
}

export interface InstallResult {
	locked: boolean;
	results: Record<string, StateRecord>;
}

/**
 * Background installer: sequentially install the desired payload of every
 * selected group that lacks one, with a disk budget and bounded retries, then
 * activate it. `onChange` runs after each state transition.
 */
export async function installGroups(
	groups: readonly GroupDef[],
	selected: readonly string[],
	env: PayloadEnv,
	onChange: () => void = () => {},
): Promise<InstallResult> {
	const results: Record<string, StateRecord> = {};
	if (!(await acquireLock(env, "install"))) {
		env.log("another installer or prune is running; leaving it to finish");
		return { locked: false, results };
	}
	try {
		// Interrupted installs of every group, selected or not.
		for (const group of groups) cleanStaging(env, group.name);
		const todo = activate(groups, selected, env);
		for (const name of todo) {
			const group = groups.find((g) => g.name === name) as GroupDef;
			const desired = desiredPayload(group, env);
			const record = (state: StateRecord["state"], attempt: number, extra: Partial<StateRecord> = {}) => {
				const rec: StateRecord = { state, payloadId: "id" in desired ? desired.id : "", attempt, updatedAt: new Date().toISOString(), ...extra };
				results[name] = rec;
				writeState(env, name, rec);
				onChange();
			};
			if ("error" in desired) {
				record("failed", 0, { error: desired.error, permanent: true });
				env.log(`${name}: ${desired.error}`);
				continue;
			}
			const dir = groupDir(env, name);
			mkdirSync(dir, { recursive: true });
			const staging = join(dir, `.staging-${desired.id}-${process.pid}`);
			const cache = join(dir, `.staging-cache-${process.pid}`);
			const budget = (group.approxBytes ?? 0) * 2 + DISK_RESERVE_BYTES;
			const free = env.freeBytes(env.root);
			if (free < budget) {
				const error = `low disk: ${Math.floor(free / MiB)} MiB free, ${Math.ceil(budget / MiB)} MiB needed (payload, download cache and reserve)`;
				record("failed", 0, { error, permanent: true });
				env.log(`${name}: ${error}; not installing`);
				continue;
			}
			const attempts = env.backoffMs.length + 1;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				record("installing", attempt);
				env.log(`${name}: installing payload ${desired.id} (attempt ${attempt}/${attempts})`);
				try {
					const manifest = await installOnce(group, desired, env, staging, cache);
					const target = join(dir, desired.id);
					rmSync(target, { recursive: true, force: true });
					renameSync(staging, target);
					const previous = readLink(currentLink(env, name));
					activate([group], [name], env);
					pruneOld(env, name, [desired.id, previous]);
					record("ready", attempt);
					env.log(`${name}: ready in ${Math.round(manifest.durationMs / 1000)}s (${Object.values(manifest.versions).join("; ")})`);
					break;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					rmSync(staging, { recursive: true, force: true });
					const last = attempt === attempts;
					record(last ? "failed" : "installing", attempt, { error: message });
					env.log(`${name}: attempt ${attempt} failed: ${message}`);
					if (!last) await env.sleep(env.backoffMs[attempt - 1] as number);
				}
			}
			rmSync(cache, { recursive: true, force: true });
		}
	} finally {
		releaseLock(env);
	}
	return { locked: true, results };
}

/** Delete payloads no selected group is using, plus interrupted installs. */
export async function prunePayloads(groups: readonly GroupDef[], selected: readonly string[], env: PayloadEnv): Promise<string[]> {
	if (!(await acquireLock(env, "prune"))) throw new Error("the installer is running; try again when it finishes");
	const removed: string[] = [];
	try {
		activate(groups, selected, env);
		for (const group of groups) {
			cleanStaging(env, group.name);
			const keep = selected.includes(group.name) ? readLink(currentLink(env, group.name)) : null;
			for (const id of listPayloads(env, group.name)) {
				if (id === keep) continue;
				rmSync(join(groupDir(env, group.name), id), { recursive: true, force: true });
				removed.push(`${group.name}/${id}`);
			}
			if (!keep) removeLink(currentLink(env, group.name));
		}
	} finally {
		releaseLock(env);
	}
	return removed;
}
