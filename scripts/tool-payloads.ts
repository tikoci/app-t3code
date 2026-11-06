// Persistent tool-group payloads under the /data home (issue #5, slices 2-3).
//
// A payload is one group's tools installed from a lock shipped in the image,
// into a versioned directory keyed by the lock and the runtime it was built
// for. Two deliveries share everything below except how a payload is built:
// `npm` (a package-lock.json, `npm ci`) and `deb` (a Debian closure pinned
// from the image's apt metadata, see deb-payloads.ts).
//
//   $T3CODE_TOOLS_HOME/                      (default ~/.local/share/t3code-tools)
//     bin/<command>                          -> ../groups/<g>/current/<npm: node_modules/.bin | deb: bin>/<command>
//     groups/<g>/<payloadId>/                payload files + manifest.json
//     groups/<g>/current                     -> <payloadId> (swapped atomically)
//     groups/<g>/.staging-<payloadId>-<pid>  in-progress install (removed on recovery)
//     groups/<g>/.cache-debs/                verified .deb downloads (deb; kept across interruptions)
//     state.json                             last installer result per group
//     install.lock                           held by the one background installer
//     install.log                            installer log (capped)
//
// Rules: activation never touches the network and runs at every start, so a
// replaced container with the same home gets compatible tools back offline.
// A changed lock or runtime (security refresh, Node ABI change) yields a
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
import {
	DEB_CACHE_DIR,
	DEB_LOCK_FILE,
	type DebCompat,
	type DebLock,
	debCompat,
	debLockBytes,
	imageCommand,
	installDebPayload,
	readDebLock,
	SNAPSHOT_BASE,
	sha256File,
} from "./deb-payloads.ts";
import type { GroupDef } from "./tool-groups.ts";

export const PAYLOAD_SCHEMA = 1;
const MiB = 1024 * 1024;
/** Free space kept for projects and VMs on top of a group's own budget. */
export const DISK_RESERVE_BYTES = 256 * MiB;
const LOG_CAP_BYTES = 1 * MiB;

/** Runtime an npm payload must match. */
export type Compat = {
	platform: string;
	arch: string;
	/** Node's module ABI (process.versions.modules); a Node major bump changes it. */
	nodeAbi: string;
	node: string;
};

/** Payload deliveries handled here (GroupDef.delivery). */
export type PayloadDelivery = "npm" | "deb";
export const isPayloadGroup = (group: GroupDef): boolean => group.delivery === "npm" || group.delivery === "deb";

/** A runtime identity recorded in the manifest (Compat or DebCompat). */
export type RuntimeId = Readonly<Record<string, string>>;

export interface PayloadEnv {
	/** Persistent root under the home volume. */
	root: string;
	/** Directory holding <group>/package.json and package-lock.json (shipped in the image). */
	specDir: string;
	/** Runtime an npm payload must match. Null when Node is unusable. */
	compat: () => Compat | null;
	/** Runtime a deb payload must match. Null when dpkg or os-release is unusable. */
	debCompat: () => DebCompat | null;
	/** Command prefix for npm. */
	npm: readonly string[];
	/** Command prefix for dpkg-deb. */
	dpkgDeb: readonly string[];
	fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
	snapshotBase: string;
	/** Waits between snapshot.debian.org lookups that fail with 5xx (default 5 s, 20 s). */
	snapshotRetryMs?: readonly number[];
	/** Image filesystem root: deb payloads never shadow its commands. */
	imageRoot: string;
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
		debCompat,
		npm: ["npm"],
		dpkgDeb: ["dpkg-deb"],
		fetch: (url, init) => fetch(url, init),
		snapshotBase: SNAPSHOT_BASE,
		imageRoot: "/",
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

/** Commands a group must provide (its command checks). */
export function groupBins(group: GroupDef): string[] {
	return group.checks.filter((check) => check.kind === "command").map((check) => check.name);
}

const groupDir = (env: PayloadEnv, group: string) => join(env.root, "groups", group);
const binDir = (env: PayloadEnv) => join(env.root, "bin");
const currentLink = (env: PayloadEnv, group: string) => join(groupDir(env, group), "current");
/** Where a command lives inside a payload directory. */
const binRel = (group: GroupDef, bin: string) => (group.delivery === "deb" ? join("bin", bin) : join("node_modules", ".bin", bin));
const shimTarget = (group: GroupDef, bin: string) => join("..", "groups", group.name, "current", binRel(group, bin));
/** Shims of a group point into its own directory. */
const shimPrefix = (group: string) => `${join("..", "groups", group)}/`;

export interface Desired {
	id: string;
	lockSha256: string;
	compat: RuntimeId;
	/** npm: direct dependencies and ranges; deb: every pinned package and version. */
	packages: Record<string, string>;
	/** deb only. */
	debLock?: DebLock;
}

const idHash = (parts: readonly (string | number)[]) => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);

function desiredNpm(group: GroupDef, env: PayloadEnv): Desired | { error: string } {
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
	const id = `${compat.arch}-abi${compat.nodeAbi}-${idHash([PAYLOAD_SCHEMA, group.name, lockSha256, compat.platform, compat.arch, compat.nodeAbi])}`;
	return { id, lockSha256, compat, packages: pkg.dependencies ?? {} };
}

function desiredDeb(group: GroupDef, env: PayloadEnv): Desired | { error: string } {
	const path = join(env.specDir, group.name, DEB_LOCK_FILE);
	let text: string;
	let lock: DebLock;
	try {
		text = readFileSync(path, "utf8");
		lock = readDebLock(path);
	} catch (error) {
		return { error: `no Debian lock for ${group.name} in this image (${path}): ${error instanceof Error ? error.message : String(error)}` };
	}
	const compat = env.debCompat();
	if (!compat) return { error: "dpkg or /etc/os-release is not usable, so the payload runtime cannot be determined" };
	if (lock.arch !== compat.arch || lock.distro !== compat.distro) {
		return { error: `the ${group.name} lock is for ${lock.arch} ${lock.distro}, this runtime is ${compat.arch} ${compat.distro}` };
	}
	const lockSha256 = createHash("sha256").update(text).digest("hex");
	const codename = compat.distro.split("-").pop() ?? compat.distro;
	const id = `${compat.arch}-${codename}-${idHash([PAYLOAD_SCHEMA, group.name, lockSha256, compat.platform, compat.arch, compat.distro])}`;
	return { id, lockSha256, compat, packages: Object.fromEntries(lock.packages.map((p) => [p.name, p.version])), debLock: lock };
}

/** The payload this image wants for a group, or an error explaining why none can be computed. */
export function desiredPayload(group: GroupDef, env: PayloadEnv): Desired | { error: string } {
	return group.delivery === "deb" ? desiredDeb(group, env) : desiredNpm(group, env);
}

/** The runtime a group's payloads must match, or null if it is unusable. */
const runtimeOf = (group: GroupDef, env: PayloadEnv): RuntimeId | null => (group.delivery === "deb" ? env.debCompat() : env.compat());
/** Runtime keys a payload must match to be used at all; others (Node ABI) only make it stale. */
const HARD_KEYS: Record<PayloadDelivery, readonly string[]> = { npm: ["platform", "arch"], deb: ["platform", "arch", "distro"] };

export interface Manifest {
	schemaVersion: number;
	group: string;
	payloadId: string;
	/** Absent in npm manifests written before slice 3. */
	delivery?: PayloadDelivery;
	lockSha256: string;
	compat: RuntimeId;
	packages: Record<string, string>;
	/** Commands linked onto PATH. Absent in older npm manifests: the group's command checks. */
	commands?: string[];
	/** First line of `<bin> --version`, captured when the payload was verified. */
	versions: Record<string, string>;
	installedAt: string;
	durationMs: number;
	/** deb only: what was extracted and how it is wired. */
	deb?: {
		debs: Record<string, { version: string; sha256: string; source: string }>;
		libDirs: string[];
		skippedCommands: string[];
		shadows: string[];
		downloadedBytes: number;
	};
}

/** Commands a payload links onto PATH. */
export function payloadBins(group: GroupDef, manifest: Manifest | null): string[] {
	return manifest?.commands ?? groupBins(group);
}

export interface Verification {
	ok: boolean;
	missing: string[];
	manifest: Manifest | null;
	error?: string;
}

/**
 * Check a payload directory's real files, not just a marker. With `compat`,
 * a payload built for another platform, CPU or Debian release (a home moved
 * between amd64 and arm64 routers) is rejected; a Node ABI difference alone
 * is not, so a stale payload keeps serving while its refresh installs.
 */
export function verifyPayload(dir: string, group: GroupDef, expectedId?: string, compat?: RuntimeId | null, imageRoot?: string): Verification {
	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	} catch {
		return { ok: false, missing: [], manifest: null, error: "no manifest (incomplete or interrupted install)" };
	}
	if (manifest.schemaVersion !== PAYLOAD_SCHEMA || manifest.group !== group.name || (manifest.delivery ?? "npm") !== group.delivery) {
		return { ok: false, missing: [], manifest, error: "manifest is for another schema, group or delivery" };
	}
	if (expectedId && manifest.payloadId !== expectedId) {
		return { ok: false, missing: [], manifest, error: `manifest id ${manifest.payloadId} does not match ${expectedId}` };
	}
	// null: the runtime is unusable here (no Node for npm tools, no dpkg for deb ones).
	if (compat === null) return { ok: false, missing: [], manifest, error: `${group.delivery === "deb" ? "dpkg" : "node"} is not usable in this runtime` };
	if (compat) {
		const keys = HARD_KEYS[group.delivery as PayloadDelivery] ?? HARD_KEYS.npm;
		const differs = keys.filter((key) => manifest.compat?.[key] !== compat[key]);
		if (differs.length) {
			const show = (c: RuntimeId | undefined) => keys.map((key) => c?.[key]).join("-");
			return { ok: false, missing: [], manifest, error: `built for ${show(manifest.compat)}, this runtime is ${show(compat)}` };
		}
	}
	// Every linked command must be present, and every required one in the
	// payload or (deb only) provided by the image itself.
	const linked = payloadBins(group, manifest);
	const missing = [
		...linked.filter((bin) => !existsSync(join(dir, binRel(group, bin)))),
		...groupBins(group).filter((bin) => !linked.includes(bin) && !(group.delivery === "deb" && imageRoot !== undefined && imageCommand(imageRoot, bin))),
	];
	return { ok: missing.length === 0, missing, manifest, ...(missing.length ? { error: "payload files missing" } : {}) };
}

/**
 * A deb payload left active from an older image (stale) must still load its
 * libraries against this image before it is linked. Payloads built from this
 * image's own lock skip the probe.
 */
function stillRuns(dir: string, group: GroupDef): boolean {
	if (group.delivery !== "deb") return true;
	// Every required command the payload provides: each binary has its own
	// library set (tshark's is the largest, but tcpdump's and nfdump's differ).
	for (const bin of groupBins(group)) {
		const path = join(dir, binRel(group, bin));
		if (!existsSync(path)) continue; // provided by the image instead
		try {
			const proc = Bun.spawnSync([path, ...versionArgs(group, bin)], { cwd: dir, timeout: 10_000, stdout: "ignore", stderr: "ignore" });
			if (proc.exitCode !== 0) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Arguments that make a command print its version and exit 0. */
export function versionArgs(group: GroupDef, bin: string): string[] {
	return [...(group.versionArgs?.[bin] ?? ["--version"])];
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
	/** Where each required command resolves: its shim, or (deb) the image's own copy; null if neither. */
	commandPaths: Record<string, string | null>;
}

/** Directory entries, or none if it does not exist. */
function readdirOrEmpty(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Point a group's shims at its current payload: exactly `bins`, never another
 * group's shim, and (deb) never a command the image now provides itself; a
 * payload kept from an older image may predate that command in the image.
 */
function linkShims(env: PayloadEnv, group: GroupDef, bins: readonly string[]) {
	const dir = binDir(env);
	const want = new Set(group.delivery === "deb" ? bins.filter((bin) => !imageCommand(env.imageRoot, bin)) : bins);
	for (const name of readdirOrEmpty(dir)) {
		if (!want.has(name) && readLink(join(dir, name))?.startsWith(shimPrefix(group.name))) removeLink(join(dir, name));
	}
	for (const bin of want) {
		const target = readLink(join(dir, bin));
		if (target?.startsWith(`${join("..", "groups")}/`) && !target.startsWith(shimPrefix(group.name))) {
			env.log(`${group.name}: not linking ${bin}; another group provides it (${target})`);
			continue;
		}
		swapLink(join(dir, bin), shimTarget(group, bin));
	}
}

/** Remove every shim that points into this group's directory. */
function unlinkShims(env: PayloadEnv, group: GroupDef) {
	const dir = binDir(env);
	for (const name of readdirOrEmpty(dir)) {
		if (readLink(join(dir, name))?.startsWith(shimPrefix(group.name))) removeLink(join(dir, name));
	}
}

export function payloadInfo(group: GroupDef, env: PayloadEnv): PayloadInfo {
	const desired = desiredPayload(group, env);
	const current = readLink(currentLink(env, group.name));
	const activeCheck = current ? verifyPayload(join(groupDir(env, group.name), current), group, current, runtimeOf(group, env), env.imageRoot) : null;
	const active = activeCheck?.ok ? current : null;
	const owned = (bin: string) => (group.delivery === "deb" ? imageCommand(env.imageRoot, bin) : null);
	const shimOk = (bin: string) => readLink(join(binDir(env), bin)) === shimTarget(group, bin) && existsSync(join(binDir(env), bin));
	const linked = active !== null && payloadBins(group, activeCheck?.manifest ?? null).every((bin) => owned(bin) !== null || shimOk(bin));
	const commandPaths = Object.fromEntries(groupBins(group).map((bin) => [bin, owned(bin) ?? (shimOk(bin) ? join(binDir(env), bin) : null)]));
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
		commandPaths,
	};
}

/**
 * Startup activation under the shared kernel lock, never waiting for it: if
 * an installer or prune holds the lock, skip (the holder activates when it
 * finishes) and return null. Otherwise relink and return the groups that
 * still need the installer.
 */
export async function activateIfIdle(groups: readonly GroupDef[], selected: readonly string[], env: PayloadEnv): Promise<string[] | null> {
	if (!(await acquireLock(env, "init"))) return null;
	try {
		return activate(groups, selected, env);
	} finally {
		releaseLock(env);
	}
}

/**
 * Fast, offline, idempotent: point selected groups at their best verified
 * payload (the desired one if present, else keep the current one) and link
 * their shims; unlink shims of deselected groups. Returns the selected groups
 * that still need the installer. Mutates links: callers hold the install lock
 * (installGroups, prunePayloads, activateIfIdle).
 */
export function activate(groups: readonly GroupDef[], selected: readonly string[], env: PayloadEnv): string[] {
	const needInstall: string[] = [];
	mkdirSync(binDir(env), { recursive: true });
	for (const group of groups) {
		if (!selected.includes(group.name)) {
			unlinkShims(env, group);
			continue;
		}
		const desired = desiredPayload(group, env);
		const dir = groupDir(env, group.name);
		const wanted = "id" in desired ? desired.id : null;
		if ("id" in desired && verifyPayload(join(dir, desired.id), group, desired.id, desired.compat, env.imageRoot).ok) {
			swapLink(currentLink(env, group.name), desired.id);
		} else {
			needInstall.push(group.name);
		}
		const current = readLink(currentLink(env, group.name));
		const check = current ? verifyPayload(join(dir, current), group, current, runtimeOf(group, env), env.imageRoot) : null;
		if (current && check?.ok && (current === wanted || stillRuns(join(dir, current), group))) {
			linkShims(env, group, payloadBins(group, check.manifest));
		} else {
			// Nothing usable here (built for another CPU or release, or a stale
			// native payload that no longer loads): no shims to it.
			unlinkShims(env, group);
		}
	}
	return needInstall;
}

function cleanStaging(env: PayloadEnv, group: string) {
	const dir = groupDir(env, group);
	for (const name of readdirOrEmpty(dir)) {
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

/** npm: `npm ci` from the lockfile shipped in the image. */
async function buildNpm(group: GroupDef, env: PayloadEnv, staging: string, cache: string) {
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
}

/** deb: verified downloads extracted as this user, with per-command wrappers. */
async function buildDeb(group: GroupDef, desired: Desired, env: PayloadEnv, staging: string, cache: string): Promise<Pick<Manifest, "commands" | "deb">> {
	const lock = desired.debLock as DebLock;
	const result = await installDebPayload(
		group.name,
		lock,
		staging,
		cache,
		{
			fetch: env.fetch,
			dpkgDeb: env.dpkgDeb,
			snapshotBase: env.snapshotBase,
			imageRoot: env.imageRoot,
			log: env.log,
			...(env.snapshotRetryMs ? { snapshotRetryMs: env.snapshotRetryMs } : {}),
		},
		AbortSignal.timeout(env.installTimeoutMs),
	);
	// A required command the image itself provides is satisfied by the image.
	const missing = groupBins(group).filter((bin) => !result.commands.includes(bin) && !imageCommand(env.imageRoot, bin));
	if (missing.length) throw new Error(`neither the payload nor the image provides ${missing.join(", ")}`);
	if (result.downloadedBytes) env.log(`${group.name}: downloaded ${(result.downloadedBytes / MiB).toFixed(1)} MiB in ${lock.packages.length} packages, all SHA256-verified`);
	const { debs, libDirs, skippedCommands, shadows, downloadedBytes } = result;
	return { commands: result.commands, deb: { debs, libDirs, skippedCommands, shadows, downloadedBytes } };
}

async function installOnce(group: GroupDef, desired: Desired, env: PayloadEnv, staging: string, cache: string): Promise<Manifest> {
	const started = Date.now();
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	let built: Pick<Manifest, "commands" | "deb">;
	if (group.delivery === "deb") built = await buildDeb(group, desired, env, staging, cache);
	else {
		await buildNpm(group, env, staging, cache);
		built = { commands: groupBins(group) };
	}
	const versions: Record<string, string> = {};
	for (const bin of groupBins(group)) {
		// cwd is the staging dir: markdownlint-cli2 treats --version as a glob.
		const inPayload = join(staging, binRel(group, bin));
		const path = existsSync(inPayload) ? inPayload : ((group.delivery === "deb" ? imageCommand(env.imageRoot, bin) : null) ?? inPayload);
		const probe = await run([path, ...versionArgs(group, bin)], staging, 60_000);
		// Some tools (nfdump) print their own path; keep the manifest free of staging paths.
		const first = (probe.out.split("\n").find((line) => line.trim()) ?? "").replaceAll(`${join(staging, "root", "usr", "bin")}/`, "").replaceAll(`${staging}/`, "");
		if (probe.code !== 0) throw new Error(`${bin} ${versionArgs(group, bin).join(" ")} exited ${probe.code}: ${first}`);
		versions[bin] = first.trim();
	}
	if (group.smoke) {
		// A functional check of the real tools before the payload is trusted.
		const input = join(staging, ".smoke-input");
		writeFileSync(input, Buffer.from(group.smoke.inputBase64 ?? "", "base64"));
		const args = group.smoke.args.map((arg) => (arg === "{input}" ? input : arg));
		const smokeBin = join(staging, binRel(group, group.smoke.command));
		const smokePath = existsSync(smokeBin) ? smokeBin : ((group.delivery === "deb" ? imageCommand(env.imageRoot, group.smoke.command) : null) ?? smokeBin);
		const probe = await run([smokePath, ...args], staging, 60_000);
		rmSync(input, { force: true });
		if (probe.code !== 0 || !probe.out.includes(group.smoke.expect)) {
			throw new Error(`smoke test ${group.smoke.command} ${group.smoke.args.join(" ")} failed (exit ${probe.code}): ${probe.out.split("\n").slice(-3).join(" | ")}`);
		}
	}
	const manifest: Manifest = {
		schemaVersion: PAYLOAD_SCHEMA,
		group: group.name,
		payloadId: desired.id,
		delivery: group.delivery as PayloadDelivery,
		lockSha256: desired.lockSha256,
		compat: desired.compat,
		packages: desired.packages,
		...built,
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

/** Bytes an install needs free: payload plus downloads (npm cache or .debs). */
/**
 * Bytes an install needs free: payload plus downloads (npm cache or .debs)
 * plus the reserve. For deb, a .deb already in the cache that still matches
 * its pinned size and SHA256 needs no new download, so it is not counted.
 */
async function installBudget(group: GroupDef, desired: Desired, cache: string): Promise<number> {
	if (!desired.debLock) return (group.approxBytes ?? 0) * 2 + DISK_RESERVE_BYTES;
	let cached = 0;
	for (const pkg of desired.debLock.packages) {
		const path = join(cache, `${pkg.sha256}.deb`);
		try {
			if (statSync(path).size === pkg.size && (await sha256File(path)) === pkg.sha256) cached += pkg.size;
		} catch {
			// not cached
		}
	}
	return debLockBytes(desired.debLock) - cached + DISK_RESERVE_BYTES;
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
			// Verified .debs survive an interrupted run (slow links); npm's cache does not.
			const cache = group.delivery === "deb" ? join(dir, DEB_CACHE_DIR) : join(dir, `.staging-cache-${process.pid}`);
			const budget = await installBudget(group, desired, cache);
			const free = env.freeBytes(env.root);
			if (free < budget) {
				const error = `low disk: ${Math.floor(free / MiB)} MiB free, ${Math.ceil(budget / MiB)} MiB needed (payload, downloads and reserve)`;
				record("failed", 0, { error, permanent: true });
				env.log(`${name}: ${error}; not installing`);
				continue;
			}
			const attempts = env.backoffMs.length + 1;
			let ready = false;
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
					ready = true;
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
			if (ready || group.delivery !== "deb") rmSync(cache, { recursive: true, force: true });
		}
	} finally {
		releaseLock(env);
	}
	return { locked: true, results };
}

/** Delete payloads no selected group is using, plus interrupted installs and kept downloads. */
export async function prunePayloads(groups: readonly GroupDef[], selected: readonly string[], env: PayloadEnv): Promise<string[]> {
	if (!(await acquireLock(env, "prune"))) throw new Error("the installer is running; try again when it finishes");
	const removed: string[] = [];
	try {
		activate(groups, selected, env);
		for (const group of groups) {
			cleanStaging(env, group.name);
			const cache = join(groupDir(env, group.name), DEB_CACHE_DIR);
			if (existsSync(cache)) {
				rmSync(cache, { recursive: true, force: true });
				removed.push(`${group.name}/${DEB_CACHE_DIR}`);
			}
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
