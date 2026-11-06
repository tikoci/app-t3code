// Debian-package payloads for native tool groups (issue #5, slice 3: capture).
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
// Pins come from the image's own apt metadata at build time (`t3code-tools
// deb-lock`, run in the Dockerfile right after `apt-get update`): package,
// version, architecture, size and SHA256 from the signed indexes apt
// verified, so the lock changes exactly when Debian (or the image) does. At
// runtime every file must match its pinned size and SHA256, and its control
// fields must name the pinned package, version and architecture, before it is
// extracted. A superseded version that left deb.debian.org is fetched from
// snapshot.debian.org and checked the same way.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

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
	 * Image packages apt wanted to upgrade for this group. Never extracted: a
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
}

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
async function exec(cmd: string[], signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(signal ? { signal } : {}) });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out, err };
}

/** The control fields must name the pinned package; a hash match alone could be a mislabeled lock. */
export async function checkControl(path: string, pkg: DebLockPackage, io: DebIo, signal?: AbortSignal) {
	const res = await exec([...io.dpkgDeb, "-f", path, "Package", "Version", "Architecture"], signal);
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
const IMAGE_BIN_DIRS = ["usr/local/bin", "usr/local/sbin", ...BIN_DIRS];

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

export interface DebPayloadLayout {
	/** Commands exposed through wrappers (and shims). */
	commands: string[];
	/** Payload commands not exposed because the image has a command of that name. */
	skippedCommands: string[];
	/** Library directories (relative to root/) on each wrapper's library path. */
	libDirs: string[];
	/** Payload library files that the image also has (the payload's copy wins for payload processes only). */
	shadows: string[];
}

/** The `sh` wrapper for one payload command: payload libraries for this process tree only, then exec. */
export function wrapperScript(group: string, payloadRelTarget: string, libDirs: readonly string[]): string {
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
	lines.push(`exec "$p/${payloadRelTarget}" "$@"`, "");
	return lines.join("\n");
}

/** Find the payload's commands and library dirs and write one wrapper per command into <staging>/bin. */
export function layoutDebPayload(group: string, staging: string, imageRoot: string): DebPayloadLayout {
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
	const commands: string[] = [];
	const skippedCommands: string[] = [];
	mkdirSync(join(staging, "bin"), { recursive: true });
	const seen = new Set<string>();
	for (const dir of BIN_DIRS) {
		const abs = join(root, dir);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs).sort()) {
			const path = join(abs, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(path); // follows symlinks inside the payload
			} catch {
				continue;
			}
			if (!st.isFile() || !(st.mode & 0o111) || seen.has(name)) continue;
			seen.add(name);
			if (imageCommand(imageRoot, name)) {
				skippedCommands.push(name);
				continue;
			}
			const wrapper = join(staging, "bin", name);
			writeFileSync(wrapper, wrapperScript(group, join("root", dir, name), [...libDirs].sort()));
			chmodSync(wrapper, 0o755);
			commands.push(name);
		}
	}
	return { commands: commands.sort(), skippedCommands: skippedCommands.sort(), libDirs: [...libDirs].sort(), shadows: shadows.sort() };
}

export interface DebInstallResult extends DebPayloadLayout {
	debs: Record<string, { version: string; sha256: string; source: string }>;
	downloadedBytes: number;
}

/** Fetch, verify and extract every pinned package into <staging>/root, then write wrappers. */
export async function installDebPayload(group: string, lock: DebLock, staging: string, cache: string, io: DebIo, signal?: AbortSignal): Promise<DebInstallResult> {
	const root = join(staging, "root");
	mkdirSync(root, { recursive: true });
	const debs: DebInstallResult["debs"] = {};
	let downloadedBytes = 0;
	for (const pkg of lock.packages) {
		const { path, source } = await fetchDeb(pkg, cache, io, signal);
		if (source !== "cache") downloadedBytes += pkg.size;
		await checkControl(path, pkg, io, signal);
		const res = await exec([...io.dpkgDeb, "-x", path, root], signal);
		if (res.code !== 0) throw new Error(`dpkg-deb -x ${pkg.name} exited ${res.code}: ${res.err.trim()}`);
		debs[pkg.name] = { version: pkg.version, sha256: pkg.sha256, source: source === "cache" ? "cache" : new URL(source).host };
	}
	return { ...layoutDebPayload(group, staging, io.imageRoot), debs, downloadedBytes };
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
