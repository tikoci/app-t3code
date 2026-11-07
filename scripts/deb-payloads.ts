// Debian-package payloads for native tool groups (issue #5: slice 3 added
// capture, slice 4 vpn and routing).
//
// A deb payload is the dependency closure of a group's Debian packages, minus
// what the image already has, extracted as the unprivileged user into the
// home. No root, no maintainer scripts, no global LD_LIBRARY_PATH and no
// overlay of /usr or /lib:
//
//   groups/<g>/<payloadId>/root/...       dpkg-deb -x of every pinned package
//   groups/<g>/<payloadId>/bin/<command>  wrapper: payload library dirs for that
//                                         process tree only, then exec root/usr/bin/<command>
//   groups/<g>/.cache-debs/<sha256>.deb   verified downloads, kept across
//                                         interrupted runs, removed on success and by prune
//
// Most tools find their data relative to the binary (Wireshark, nmap) or take
// paths as arguments (BIRD, lldpcli). A tool that only knows compiled-in
// paths gets a WrapperRule: variables for its wrapper alone (strongSwan's
// STRONGSWAN_CONF) and, for a compiled-in plugin directory, the plugins
// preloaded so the loader finds them by symbol.
//
// Pins come from the image's own apt metadata at build time (`t3code-tools
// deb-lock`, run in the Dockerfile right after `apt-get update`): package,
// version, architecture, size and SHA256 from the signed indexes apt
// verified, so the lock changes exactly when Debian (or the image) does. At
// runtime every file must match its pinned size and SHA256, and its control
// fields must name the pinned package, version and architecture, before it is
// extracted. A superseded version that left deb.debian.org is fetched from
// snapshot.debian.org and checked the same way.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";

export const DEB_LOCK_SCHEMA = 1;
export const DEB_LOCK_FILE = "debs.lock.json";
export const DEB_CACHE_DIR = ".cache-debs";
export const SNAPSHOT_BASE = "https://snapshot.debian.org";

export interface DebLockPackage {
	name: string;
	version: string;
	architecture: string;
	/** .deb size in bytes. */
	size: number;
	/** Unpacked size in bytes (Installed-Size, rounded up to KiB by Debian). */
	installedSize: number;
	sha256: string;
	/** Pool path from the Packages index, e.g. pool/main/t/tcpdump/tcpdump_4.99.5-2_amd64.deb. */
	filename: string;
	/** Download URLs in order of preference (https first). */
	uris: string[];
}

export interface DebLock {
	schemaVersion: number;
	group: string;
	/** The group's packages, as given to apt. */
	roots: string[];
	/** dpkg architecture (amd64, arm64). */
	arch: string;
	/** `<ID>-<VERSION_CODENAME>` from /etc/os-release, e.g. debian-trixie. */
	distro: string;
	packages: DebLockPackage[];
	/**
	 * Image dependencies apt wanted to upgrade for this group. Root-package
	 * upgrades are rejected at lock generation. Dependencies are never extracted: a
	 * payload copy would shadow the image's library (a lagging libc6, say). If
	 * a tool truly needs the newer version, its version probe fails and the
	 * payload is never activated; the fix is an image rebuild.
	 */
	imageUpgrades?: { name: string; installed: string; candidate: string }[];
}

export interface DebCompat {
	[key: string]: string;
	platform: string;
	arch: string;
	distro: string;
}

/** `<ID>-<VERSION_CODENAME>` of an os-release file, or null. */
export function osReleaseDistro(text: string): string | null {
	const field = (key: string) => text.match(new RegExp(`^${key}="?([^"\\n]*)"?$`, "m"))?.[1]?.trim();
	const id = field("ID");
	const codename = field("VERSION_CODENAME");
	return id && codename ? `${id}-${codename}` : null;
}

let cachedDebCompat: DebCompat | null | undefined;
/** The runtime a deb payload must match: dpkg architecture and Debian release. */
export function debCompat(): DebCompat | null {
	if (cachedDebCompat !== undefined) return cachedDebCompat;
	try {
		const distro = osReleaseDistro(readFileSync("/etc/os-release", "utf8"));
		const proc = Bun.spawnSync(["dpkg", "--print-architecture"], { timeout: 10_000 });
		const arch = proc.stdout.toString().trim();
		cachedDebCompat = proc.exitCode === 0 && arch && distro ? { platform: process.platform, arch, distro } : null;
	} catch {
		cachedDebCompat = null;
	}
	return cachedDebCompat;
}

// ---- build time: resolve the lock from apt metadata ----------------------

export interface AptInst {
	name: string;
	version: string;
	architecture: string;
	/** Set when the image already has this package and apt would upgrade it. */
	installed?: string;
}

/** `Inst name [installed] (version origin… [arch])` lines of `apt-get install -s`. */
export function parseAptSimulation(text: string): AptInst[] {
	const out: AptInst[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^Inst (\S+) (?:\[([^\]]*)\] )?\((\S+) .*\[([^\]]+)\]\)/);
		if (!match) continue;
		const inst: AptInst = { name: match[1] as string, version: match[3] as string, architecture: match[4] as string };
		if (match[2]) inst.installed = match[2];
		out.push(inst);
	}
	return out;
}

/** `'URI' file size hash` lines of `apt-get install --print-uris`, keyed by decoded pool basename. */
export function parsePrintUris(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = line.match(/^'([^']+)'\s/);
		if (!match) continue;
		const uri = match[1] as string;
		out.set(decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1)), uri);
	}
	return out;
}

/** RFC 822 stanzas of `apt-cache show`. */
export function parseStanzas(text: string): Record<string, string>[] {
	return text
		.split(/\n\s*\n/)
		.map((block) => {
			const fields: Record<string, string> = {};
			let last = "";
			for (const line of block.split("\n")) {
				if (/^\s/.test(line) && last) fields[last] += `\n${line.trim()}`;
				else {
					const i = line.indexOf(":");
					if (i > 0) {
						last = line.slice(0, i);
						fields[last] = line.slice(i + 1).trim();
					}
				}
			}
			return fields;
		})
		.filter((fields) => fields["Package"]);
}

/** Prefer https for deb.debian.org; keep the original URI as a fallback (files are hash-checked either way). */
export function preferHttps(uri: string): string[] {
	const https = uri.replace(/^http:\/\/deb\.debian\.org\//, "https://deb.debian.org/");
	return https === uri ? [uri] : [https, uri];
}

export type Exec = (cmd: string[]) => string;

/**
 * Resolve the closure of `roots` that the image lacks, from the image's apt
 * indexes (run `apt-get update` first). Deterministic: no timestamps, sorted.
 */
export function resolveDebLock(group: string, roots: readonly string[], exec: Exec, osRelease: string): DebLock {
	const args = ["--no-install-recommends", ...roots];
	const simulated = parseAptSimulation(exec(["apt-get", "install", "-s", ...args]));
	// Image commands win over payload commands. An old root can still pass
	// --version, so reject its upgrade here rather than certify a lock that
	// leaves the old tool in use after a supposed security refresh.
	const outdatedRoots = simulated.filter((p) => p.installed !== undefined && roots.includes(p.name));
	if (outdatedRoots.length) {
		const versions = outdatedRoots.map((p) => `${p.name} ${p.installed} -> ${p.version}`).join(", ");
		throw new Error(`${group}: outdated root packages in the image (${versions}); update the image packages before generating the Debian lock`);
	}
	// Only what the image lacks: an upgrade of an image package is recorded, not extracted.
	const closure = simulated.filter((p) => p.installed === undefined);
	// Sorted like packages: the lock bytes (and so the payload id) must not depend on apt's order.
	const imageUpgrades = simulated
		.filter((p) => p.installed !== undefined)
		.map((p) => ({ name: p.name, installed: p.installed as string, candidate: p.version }))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (closure.length === 0) throw new Error(`${group}: apt resolves nothing to install for ${roots.join(" ")} (already in the image?)`);
	const uris = parsePrintUris(exec(["apt-get", "install", "--print-uris", "-qq", ...args]));
	const stanzas = parseStanzas(exec(["apt-cache", "show", "--no-all-versions", ...closure.map((p) => `${p.name}=${p.version}`)]));
	const arch = exec(["dpkg", "--print-architecture"]).trim();
	const distro = osReleaseDistro(osRelease);
	if (!distro) throw new Error("cannot read ID and VERSION_CODENAME from os-release");
	const packages = closure.map((pkg): DebLockPackage => {
		const stanza = stanzas.find((s) => s["Package"] === pkg.name && s["Version"] === pkg.version && s["Architecture"] === pkg.architecture);
		if (!stanza) throw new Error(`${pkg.name}=${pkg.version}: no apt-cache record`);
		const filename = stanza["Filename"] ?? "";
		const sha256 = stanza["SHA256"] ?? "";
		const uri = uris.get(basename(filename));
		if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${pkg.name}=${pkg.version}: no SHA256 in the apt index`);
		if (!uri) throw new Error(`${pkg.name}=${pkg.version}: no download URI from apt`);
		return {
			name: pkg.name,
			version: pkg.version,
			architecture: pkg.architecture,
			size: Number(stanza["Size"]),
			installedSize: Number(stanza["Installed-Size"] ?? 0) * 1024,
			sha256,
			filename,
			uris: preferHttps(uri),
		};
	});
	packages.sort((a, b) => a.name.localeCompare(b.name));
	return { schemaVersion: DEB_LOCK_SCHEMA, group, roots: [...roots], arch, distro, packages, ...(imageUpgrades.length ? { imageUpgrades } : {}) };
}

// ---- runtime: download, verify, extract, wrap ----------------------------

export interface DebIo {
	fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
	/** Command prefix for dpkg-deb. */
	dpkgDeb: readonly string[];
	snapshotBase: string;
	/** Waits before retrying a snapshot.debian.org lookup that failed with 5xx (it times out on cold queries). */
	snapshotRetryMs?: readonly number[];
	/** Root of the image filesystem, to keep payload commands and libraries from shadowing the image's. */
	imageRoot: string;
	log: (line: string) => void;
	/** Record the running dpkg-deb child for interrupted-installer recovery; clear after it exits. */
	onChild?: (pid: number | null) => void;
	/** Whether these library file names load together under LD_PRELOAD with this library path (default: run /bin/true). */
	canPreload?: PreloadCheck;
}

/**
 * `libraries` are file names without a directory: ld.so looks them up on
 * `libraryPath`, exactly as the wrapper's LD_PRELOAD does. (ld.so splits
 * LD_PRELOAD on spaces and colons with no escape, so absolute paths under a
 * home containing a space would break.)
 */
export type PreloadCheck = (libraries: readonly string[], libraryPath: string) => boolean;

/** Preload `libraries` into /bin/true: true only if ld.so loads them all silently. */
export const preloadLoads: PreloadCheck = (libraries, libraryPath) => {
	try {
		const proc = Bun.spawnSync(["/bin/true"], {
			env: { PATH: "/usr/bin:/bin", LD_LIBRARY_PATH: libraryPath, LD_PRELOAD: libraries.join(":") },
			stdout: "ignore",
			stderr: "pipe",
			timeout: 10_000,
		});
		return proc.exitCode === 0 && proc.stderr.toString().trim() === "";
	} catch {
		return false;
	}
};

/** SHA256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
	return hash.digest("hex");
}

/**
 * Stream a URL to `path`, refusing to write more than `limit` bytes: a
 * mirror serving the wrong (or an endless) file cannot fill the volume.
 */
async function fetchTo(url: string, path: string, limit: number, io: DebIo, signal?: AbortSignal) {
	const response = await io.fetch(url, signal ? { signal } : {});
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (declared > limit) {
		await response.body?.cancel();
		throw new Error(`${url}: ${declared} bytes, pinned ${limit}`);
	}
	const writer = Bun.file(path).writer();
	let written = 0;
	try {
		if (response.body) {
			for await (const chunk of response.body) {
				written += chunk.byteLength;
				if (written > limit) throw new Error(`${url}: more than the pinned ${limit} bytes`);
				writer.write(chunk);
			}
		}
	} catch (error) {
		await response.body?.cancel().catch(() => {});
		throw error;
	} finally {
		await writer.end();
	}
}

/** snapshot.debian.org keeps every version Debian ever published, keyed by SHA1. */
async function snapshotUrl(pkg: DebLockPackage, io: DebIo, signal?: AbortSignal): Promise<string> {
	const api = `${io.snapshotBase}/mr/binary/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/binfiles?fileinfo=1`;
	const waits = io.snapshotRetryMs ?? [5_000, 20_000];
	let response = await io.fetch(api, signal ? { signal } : {});
	// The API answers 504 while it computes a cold query, then serves it from cache.
	for (let i = 0; response.status >= 500 && i < waits.length; i++) {
		await Bun.sleep(waits[i] as number);
		if (signal?.aborted) break;
		response = await io.fetch(api, signal ? { signal } : {});
	}
	if (!response.ok) throw new Error(`${api}: HTTP ${response.status}`);
	const body = (await response.json()) as { fileinfo?: Record<string, { name: string; archive_name: string }[]> };
	const want = basename(pkg.filename);
	for (const [sha1, entries] of Object.entries(body.fileinfo ?? {})) {
		if (entries.some((e) => e.name === want && ["debian", "debian-security"].includes(e.archive_name))) return `${io.snapshotBase}/file/${sha1}`;
	}
	throw new Error(`snapshot.debian.org has no ${want}`);
}

/** Null when a downloaded file matches its pin, else what differs. */
async function checkFile(path: string, pkg: DebLockPackage): Promise<string | null> {
	const size = statSync(path).size;
	if (size !== pkg.size) return `size ${size}, pinned ${pkg.size}`;
	const sha = await sha256File(path);
	return sha === pkg.sha256 ? null : `sha256 ${sha}, pinned ${pkg.sha256}`;
}

/** A verified copy of one pinned package in the cache (reused if already verified). */
export async function fetchDeb(pkg: DebLockPackage, cache: string, io: DebIo, signal?: AbortSignal): Promise<{ path: string; source: string }> {
	const path = join(cache, `${pkg.sha256}.deb`);
	if (existsSync(path) && (await checkFile(path, pkg)) === null) return { path, source: "cache" };
	mkdirSync(cache, { recursive: true });
	const part = `${path}.part`;
	const errors: string[] = [];
	const attempt = async (url: string) => {
		rmSync(part, { force: true });
		await fetchTo(url, part, pkg.size, io, signal);
		const mismatch = await checkFile(part, pkg);
		if (mismatch) throw new Error(`${url}: ${mismatch}`);
		renameSync(part, path);
	};
	for (const url of pkg.uris) {
		try {
			await attempt(url);
			return { path, source: url };
		} catch (error) {
			if (signal?.aborted) throw error;
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		const url = await snapshotUrl(pkg, io, signal);
		await attempt(url);
		io.log(`${pkg.name} ${pkg.version}: fetched from ${url} (mirror: ${errors.join("; ")})`);
		return { path, source: url };
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		rmSync(part, { force: true });
	}
	throw new Error(`${pkg.name} ${pkg.version}: ${errors.join("; ")}`);
}

/** Run a command, collecting its output. */
async function exec(cmd: string[], signal?: AbortSignal, onChild?: DebIo["onChild"]): Promise<{ code: number; out: string; err: string }> {
	// dpkg-deb can spawn tar/decompressors: recovery must stop their whole
	// process group before reclaiming files, not only the dpkg-deb parent.
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", detached: true, ...(signal ? { signal } : {}) });
	const stopGroup = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			// The process group has already exited.
		}
	};
	// Kill helpers at abort time too: inherited output pipes must close before
	// the output readers below can finish.
	signal?.addEventListener("abort", stopGroup, { once: true });
	if (signal?.aborted) stopGroup();
	try {
		onChild?.(proc.pid);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	} finally {
		// An abort can terminate dpkg-deb before its helpers. Do not leave a
		// writer behind after clearing the lock's child record.
		signal?.removeEventListener("abort", stopGroup);
		stopGroup();
		onChild?.(null);
	}
}

/** The control fields must name the pinned package; a hash match alone could be a mislabeled lock. */
export async function checkControl(path: string, pkg: DebLockPackage, io: DebIo, signal?: AbortSignal) {
	const res = await exec([...io.dpkgDeb, "-f", path, "Package", "Version", "Architecture"], signal, io.onChild);
	if (res.code !== 0) throw new Error(`dpkg-deb -f ${basename(path)} exited ${res.code}: ${res.err.trim()}`);
	const fields = parseStanzas(res.out)[0] ?? {};
	const got = `${fields["Package"]}=${fields["Version"]} [${fields["Architecture"]}]`;
	const want = `${pkg.name}=${pkg.version} [${pkg.architecture}]`;
	if (got !== want) throw new Error(`${basename(path)} contains ${got}, pinned ${want}`);
}

/** Depth-first walk that does not follow symlinked directories. */
function walk(dir: string, visit: (path: string, isDir: boolean) => void) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = lstatSync(path);
		visit(path, st.isDirectory());
		if (st.isDirectory()) walk(path, visit);
	}
}

const BIN_DIRS = ["usr/bin", "usr/sbin", "bin", "sbin"];
// opt/bun/bin: the image's Bun globals (quickchr, centrs), on PATH after the
// payload shims; labs requires quickchr from there.
const IMAGE_BIN_DIRS = ["usr/local/bin", "usr/local/sbin", ...BIN_DIRS, "opt/bun/bin"];

/** The image's own executable of this name, if any: an image command always wins over a payload's. */
export function imageCommand(imageRoot: string, name: string): string | null {
	for (const dir of IMAGE_BIN_DIRS) {
		const path = join(imageRoot, dir, name);
		try {
			const st = statSync(path);
			if (st.isFile() && st.mode & 0o111) return path;
		} catch {
			// not here
		}
	}
	return null;
}

/**
 * Extra wiring for some of a payload's commands, for tools that resolve files
 * through paths compiled into them rather than relative to the binary.
 */
export interface WrapperRule {
	/** Commands the rule applies to. Commands without a wrapper (absent, or provided by the image) are ignored; a rule with none is never resolved. */
	commands: readonly string[];
	/**
	 * Defaults for these commands only: a variable the caller already set wins.
	 * `{root}` is the payload's extracted root and `{multiarch}` the lock's
	 * Debian multiarch triplet (both here and in `args` and `preload`);
	 * everything else is literal.
	 */
	env?: Readonly<Record<string, string>>;
	/** Arguments placed before the caller's (`{root}` and `{multiarch}` expand); for most tools a later repeat of an option wins, so the caller can still override. */
	args?: readonly string[];
	/**
	 * LD_PRELOAD for these commands: `libraries` (relative to root), then every
	 * `.so` in `pluginDir` that loads against them alone, as checked at install
	 * time. For plugin loaders that look a plugin's entry symbol up in the
	 * process before searching their compiled-in directory (strongSwan).
	 */
	preload?: { libraries: readonly string[]; pluginDir: string };
}

export interface DebPayloadLayout {
	/** Commands exposed through wrappers (and shims). */
	commands: string[];
	/** Payload commands not exposed because the image has a command of that name. */
	skippedCommands: string[];
	/** Library directories (relative to root/) on each wrapper's library path. */
	libDirs: string[];
	/** Payload library files that the image also has (the payload's copy wins for payload processes only). */
	shadows: string[];
	/** Commands with extra wiring from a WrapperRule: variable defaults, leading arguments (`{root}` unexpanded), libraries preloaded (relative to root). */
	wired?: Record<string, { env: string[]; args?: string[]; preload: string[] }>;
}

/** Extra wiring for one wrapper: variable defaults and leading arguments (with `{root}`), and libraries to preload (relative to root). */
export interface WrapperExtras {
	env?: Readonly<Record<string, string>>;
	args?: readonly string[];
	preload?: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** A wrapper variable's value as shell words: literal text single-quoted, only `{root}` expanded. */
export function shellValue(value: string): string {
	const parts = value.split("{root}");
	return parts.map((part, i) => (i === 0 ? "" : '"$p/root"') + (part ? shellQuote(part) : "")).join("") || "''";
}

/** The `sh` wrapper for one payload command: payload libraries for this process tree only, then exec. */
export function wrapperScript(group: string, payloadRelTarget: string, libDirs: readonly string[], extras: WrapperExtras = {}): string {
	const lines = [
		"#!/bin/sh",
		`# Generated by t3code-tools for the ${group} payload. Runs ${payloadRelTarget.replace(/^root\//, "/")}`,
		"# with the payload's own libraries: LD_LIBRARY_PATH is set for this process",
		"# and its children only, never globally, and the payload's library dirs",
		"# hold only libraries the image lacks.",
		'p=$(readlink -f -- "$0") || exit 127',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
		'p="${p%/bin/*}"',
	];
	if (libDirs.length) {
		lines.push(`LD_LIBRARY_PATH="${libDirs.map((d) => `$p/root/${d}`).join(":")}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`, "export LD_LIBRARY_PATH");
	}
	for (const [name, value] of Object.entries(extras.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		if (!ENV_NAME.test(name)) throw new Error(`wrapper variable name ${JSON.stringify(name)} is not a shell variable name`);
		// A default: the caller's own setting (even an empty one) wins.
		lines.push(`[ -n "\${${name}+x}" ] || ${name}=${shellValue(value)}`, `export ${name}`);
	}
	if (extras.preload?.length) {
		// File names only, found on the LD_LIBRARY_PATH above: ld.so splits
		// LD_PRELOAD on spaces, so absolute paths would break under a home
		// path containing one.
		lines.push(`LD_PRELOAD="${extras.preload.map((l) => basename(l)).join(":")}\${LD_PRELOAD:+:$LD_PRELOAD}"`, "export LD_PRELOAD");
	}
	const args = (extras.args ?? []).map((arg) => ` ${shellValue(arg)}`).join("");
	lines.push(`exec "$p/${payloadRelTarget}"${args} "$@"`, "");
	return lines.join("\n");
}

/**
 * Resolve a preload rule against an extracted root: its libraries, then each
 * plugin that loads against them alone, then a check that the whole set loads
 * together. Paths are relative to root, sorted for a stable result.
 */
export function resolvePreload(root: string, rule: NonNullable<WrapperRule["preload"]>, libDirs: readonly string[], canPreload: PreloadCheck): string[] {
	const abs = (rel: string) => join(root, rel);
	const libraryPath = libDirs.map(abs).join(":");
	// Preloads are named by file name, so each must be the first file of that
	// name on the wrapper's library path.
	const reachable = (rel: string) => libDirs.find((dir) => existsSync(join(root, dir, basename(rel)))) === dirname(rel);
	for (const lib of rule.libraries) {
		if (!existsSync(abs(lib))) throw new Error(`preload library ${lib} is not in the payload`);
		if (!reachable(lib)) throw new Error(`preload library ${lib} is not first on the payload's library path`);
	}
	const dir = abs(rule.pluginDir);
	const plugins = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".so")).sort() : [];
	const base = rule.libraries.map((lib) => basename(lib));
	const chosen = plugins
		.map((name) => join(rule.pluginDir, name))
		.filter((rel) => reachable(rel) && canPreload([...base, basename(rel)], libraryPath));
	if (chosen.length === 0) throw new Error(`no plugin in ${rule.pluginDir} loads against ${rule.libraries.join(", ")}`);
	const all = [...rule.libraries, ...chosen];
	if (!canPreload(all.map((lib) => basename(lib)), libraryPath)) throw new Error(`the ${all.length} preload libraries from ${rule.pluginDir} do not load together`);
	return all;
}

/** Find the payload's commands and library dirs and write one wrapper per command into <staging>/bin. */
export function layoutDebPayload(
	group: string,
	staging: string,
	imageRoot: string,
	rules: readonly WrapperRule[] = [],
	canPreload: PreloadCheck = preloadLoads,
): DebPayloadLayout {
	const root = join(staging, "root");
	const libDirs = new Set<string>();
	const shadows: string[] = [];
	walk(root, (path, isDir) => {
		const name = basename(path);
		if (isDir || !/^lib.+\.so(\.|$)/.test(name)) return;
		const rel = relative(root, path);
		libDirs.add(dirname(rel));
		// Debian merged /usr: the image's /lib is /usr/lib.
		const imagePaths = [join(imageRoot, rel), join(imageRoot, rel.replace(/^usr\//, ""))];
		if (imagePaths.some((p) => existsSync(p))) shadows.push(rel);
	});
	const sortedLibDirs = [...libDirs].sort();
	// LD_LIBRARY_PATH has no escape for its separators.
	if (sortedLibDirs.length && /[:;]/.test(root)) throw new Error(`the payload path ${root} contains ':' or ';', which LD_LIBRARY_PATH cannot carry`);
	// Pass 1: the commands that get wrappers (an image command of the same name wins).
	const skippedCommands: string[] = [];
	const targets = new Map<string, string>();
	for (const dir of BIN_DIRS) {
		const abs = join(root, dir);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs).sort()) {
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(join(abs, name)); // follows symlinks inside the payload
			} catch {
				continue;
			}
			if (!st.isFile() || !(st.mode & 0o111) || targets.has(name) || skippedCommands.includes(name)) continue;
			if (imageCommand(imageRoot, name)) skippedCommands.push(name);
			else targets.set(name, join("root", dir, name));
		}
	}
	// Pass 2: rules for wrapped commands only. A rule none of whose commands
	// is wrapped is never resolved, so an image that provides the tool (and
	// its libraries) instead cannot fail the payload. A preload rule is
	// resolved once; a command that several rules preload into is checked
	// again with its merged, deduplicated set.
	const extras = new Map<string, WrapperExtras>();
	const preloadSources = new Map<string, number>();
	for (const rule of rules) {
		const commands = rule.commands.filter((command) => targets.has(command));
		if (commands.length === 0) continue;
		const preload = rule.preload ? resolvePreload(root, rule.preload, sortedLibDirs, canPreload) : undefined;
		for (const command of commands) {
			const prev = extras.get(command) ?? {};
			const merged = [...new Set([...(prev.preload ?? []), ...(preload ?? [])])];
			const args = [...(prev.args ?? []), ...(rule.args ?? [])];
			extras.set(command, { env: { ...prev.env, ...rule.env }, ...(args.length ? { args } : {}), ...(merged.length ? { preload: merged } : {}) });
			if (preload) preloadSources.set(command, (preloadSources.get(command) ?? 0) + 1);
		}
	}
	for (const [command, count] of preloadSources) {
		const set = extras.get(command)?.preload ?? [];
		if (count > 1 && !canPreload(set.map((lib) => basename(lib)), sortedLibDirs.map((dir) => join(root, dir)).join(":"))) {
			throw new Error(`${command}: its ${set.length} merged preload libraries do not load together`);
		}
	}
	mkdirSync(join(staging, "bin"), { recursive: true });
	const commands: string[] = [];
	const wired: NonNullable<DebPayloadLayout["wired"]> = {};
	for (const [name, target] of targets) {
		const wrapper = join(staging, "bin", name);
		const extra = extras.get(name);
		writeFileSync(wrapper, wrapperScript(group, target, sortedLibDirs, extra));
		chmodSync(wrapper, 0o755);
		commands.push(name);
		if (extra) wired[name] = { env: Object.keys(extra.env ?? {}).sort(), ...(extra.args?.length ? { args: [...extra.args] } : {}), preload: [...(extra.preload ?? [])] };
	}
	return {
		commands: commands.sort(),
		skippedCommands: skippedCommands.sort(),
		libDirs: sortedLibDirs,
		shadows: shadows.sort(),
		...(Object.keys(wired).length ? { wired } : {}),
	};
}

export interface DebInstallResult extends DebPayloadLayout {
	debs: Record<string, { version: string; sha256: string; source: string }>;
	downloadedBytes: number;
	/** Paths (relative to root) removed after extraction, and the bytes they held. */
	pruned: string[];
	prunedBytes: number;
}

/** Bytes under a path, not following symlinks (a symlink counts as itself). */
function treeBytes(path: string): number {
	const st = lstatSync(path);
	if (!st.isDirectory()) return st.size;
	let sum = 0;
	walk(path, (child, isDir) => {
		if (!isDir) sum += lstatSync(child).size;
	});
	return sum;
}

/**
 * Remove files a group never uses from an extracted root (labs: the
 * secure-boot AAVMF images, 64 MiB each). Paths are relative to root and
 * normalized; one that is absent is skipped (a later Debian build may drop
 * it), one that would leave root is refused.
 */
export function pruneExtracted(root: string, paths: readonly string[]): { pruned: string[]; prunedBytes: number } {
	const pruned: string[] = [];
	let prunedBytes = 0;
	for (const rel of paths) {
		if (rel === "" || isAbsolute(rel) || normalize(rel) !== rel || rel === ".." || rel.startsWith("../")) {
			throw new Error(`prune path ${JSON.stringify(rel)} must be a normalized path inside the payload root`);
		}
		const path = join(root, rel);
		let bytes: number;
		try {
			bytes = treeBytes(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // not in this build
			throw error;
		}
		// A symlinked directory on the way (an absolute link in a package) must not lead the delete out of the payload.
		const realRoot = realpathSync(root);
		const parent = realpathSync(dirname(path));
		if (parent !== realRoot && !parent.startsWith(`${realRoot}/`)) throw new Error(`prune path ${rel} resolves outside the payload root (${parent})`);
		rmSync(path, { recursive: true, force: true });
		prunedBytes += bytes;
		pruned.push(rel);
	}
	return { pruned, prunedBytes };
}

/**
 * Debian architecture to multiarch triplet (`dpkg-architecture
 * -qDEB_HOST_MULTIARCH`), for the architectures Debian trixie releases.
 */
export const DEB_MULTIARCH: Readonly<Record<string, string>> = {
	amd64: "x86_64-linux-gnu",
	arm64: "aarch64-linux-gnu",
	armel: "arm-linux-gnueabi",
	armhf: "arm-linux-gnueabihf",
	i386: "i386-linux-gnu",
	ppc64el: "powerpc64le-linux-gnu",
	riscv64: "riscv64-linux-gnu",
	s390x: "s390x-linux-gnu",
};

/**
 * Expand `{multiarch}` in wrapper rules for a lock's Debian architecture, so
 * library paths follow the packages, not the architecture the installer runs as.
 */
export function expandMultiarch(rules: readonly WrapperRule[], arch: string): WrapperRule[] {
	const uses = (text: string) => text.includes("{multiarch}");
	const triplet = DEB_MULTIARCH[arch];
	const sub = (text: string) => {
		if (!uses(text)) return text;
		if (!triplet) throw new Error(`no multiarch triplet is known for the Debian architecture ${JSON.stringify(arch)}`);
		return text.replaceAll("{multiarch}", triplet);
	};
	return rules.map((rule) => ({
		...rule,
		...(rule.env ? { env: Object.fromEntries(Object.entries(rule.env).map(([name, value]) => [name, sub(value)])) } : {}),
		...(rule.args ? { args: rule.args.map(sub) } : {}),
		...(rule.preload ? { preload: { libraries: rule.preload.libraries.map(sub), pluginDir: sub(rule.preload.pluginDir) } } : {}),
	}));
}

/** Fetch, verify and extract every pinned package into <staging>/root, then write wrappers. */
export async function installDebPayload(
	group: string,
	lock: DebLock,
	staging: string,
	cache: string,
	io: DebIo,
	signal?: AbortSignal,
	rules: readonly WrapperRule[] = [],
	prune: readonly string[] = [],
): Promise<DebInstallResult> {
	const root = join(staging, "root");
	mkdirSync(root, { recursive: true });
	const debs: DebInstallResult["debs"] = {};
	let downloadedBytes = 0;
	for (const pkg of lock.packages) {
		const { path, source } = await fetchDeb(pkg, cache, io, signal);
		if (source !== "cache") downloadedBytes += pkg.size;
		await checkControl(path, pkg, io, signal);
		const res = await exec([...io.dpkgDeb, "-x", path, root], signal, io.onChild);
		if (res.code !== 0) throw new Error(`dpkg-deb -x ${pkg.name} exited ${res.code}: ${res.err.trim()}`);
		debs[pkg.name] = { version: pkg.version, sha256: pkg.sha256, source: source === "cache" ? "cache" : new URL(source).host };
	}
	// Before the layout: a pruned file is never wrapped or put on a library path.
	const { pruned, prunedBytes } = pruneExtracted(root, prune);
	const expanded = expandMultiarch(rules, lock.arch);
	return { ...layoutDebPayload(group, staging, io.imageRoot, expanded, io.canPreload ?? preloadLoads), debs, downloadedBytes, pruned, prunedBytes };
}

/** Read and schema-check a lock file. */
export function readDebLock(path: string): DebLock {
	const lock = JSON.parse(readFileSync(path, "utf8")) as DebLock;
	if (lock.schemaVersion !== DEB_LOCK_SCHEMA || !Array.isArray(lock.packages)) throw new Error(`${path}: unsupported lock schema`);
	return lock;
}

/** Bytes a lock needs on disk: downloads plus unpacked files. */
export function debLockBytes(lock: DebLock): number {
	return lock.packages.reduce((sum, p) => sum + p.size + p.installedSize, 0);
}
