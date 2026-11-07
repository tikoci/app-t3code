/** Debian-package payloads (issue #5 slices 3-5: capture, vpn, routing, labs), offline: fake dpkg-deb, fake .debs, fake mirror. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEB_CACHE_DIR,
	DEB_LOCK_FILE,
	type DebCompat,
	type DebLock,
	osReleaseDistro,
	parseAptSimulation,
	parsePrintUris,
	layoutDebPayload,
	parseStanzas,
	preloadLoads,
	pruneExtracted,
	resolveDebLock,
	wrapperScript,
} from "../scripts/deb-payloads.ts";
import {
	AARCH64_PSCI_OFF,
	BIRD_BGP_CONF,
	buildStatus,
	type GroupDef,
	GROUPS,
	groupStatus,
	NETWORK_PACKAGE_ASSIGNMENT,
	type Probe,
	QEMU_SYSTEM_COMMANDS,
	TZSP_DNS_PCAPNG,
} from "../scripts/tool-groups.ts";
import { activate, desiredPayload, installGroups, type Manifest, type PayloadEnv, payloadInfo, processStartTicks, prunePayloads, readState } from "../scripts/tool-payloads.ts";

const capture = GROUPS.find((g) => g.name === "capture");
if (!capture) throw new Error("capture group missing");
const payloadGroups = GROUPS.filter((g) => g.delivery === "deb");
const nothing: Probe = { which: () => null, exists: () => false, library: () => null };
const MIRROR = "https://deb.example/debian";
const SNAPSHOT = "https://snapshot.example";

let tmp: string;
let env: PayloadEnv;
let compat: DebCompat;
/** Served by the fake mirror: url -> bytes. */
let served: Map<string, Uint8Array>;
let fetched: string[];
/** Package name -> .deb bytes, as built. */
let debs: Map<string, Uint8Array>;

interface FakePkg {
	name: string;
	version: string;
	files: Record<string, string>;
	/** Control fields claim this version instead (a mislabeled file). */
	claims?: string;
}

const tool = (name: string) => `#!/bin/sh\necho "${name} fake 1.0"\n`;
/** Fake tshark: needs its payload library dir on LD_LIBRARY_PATH, like the real one. */
const tshark = (broken: string) => `#!/bin/sh
[ -e "${broken}" ] && { echo "error while loading shared libraries: libgcrypt.so.20" >&2; exit 127; }
case ":$LD_LIBRARY_PATH:" in *"/root/usr/lib/x86_64-linux-gnu:"*) ;; *) echo "libwireshark.so.18: cannot open shared object file" >&2; exit 127 ;; esac
case "$1" in
--version) echo "TShark (Wireshark) 4.4.19 (fake)" ;;
-r) [ -s "$2" ] && echo "1	routeros.example" ;;
*) echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH" ;;
esac
`;

function basePackages(): FakePkg[] {
	return [
		{ name: "libwireshark18", version: "4.4.19-0+deb13u1", files: { "usr/lib/x86_64-linux-gnu/libwireshark.so.18": "elf", "usr/lib/x86_64-linux-gnu/libz.so.1": "dup" } },
		{
			name: "tshark",
			version: "4.4.19-0+deb13u1",
			files: {
				"usr/bin/tshark": tshark(join(tmp, "image-broke")),
				"usr/bin/rawshark": tool("rawshark"),
				// The image has ip(8): never shadowed by a payload shim.
				"usr/bin/ip": tool("payload-ip"),
			},
		},
		{
			name: "wireshark-common",
			version: "4.4.19-0+deb13u1",
			files: Object.fromEntries(["dumpcap", "capinfos", "editcap", "mergecap", "text2pcap"].map((b) => [`usr/bin/${b}`, tool(b)])),
		},
		{ name: "tcpdump", version: "4.99.5-2", files: { "usr/bin/tcpdump": tool("tcpdump"), "usr/lib/x86_64-linux-gnu/libpcap.so.0.8": "elf" } },
		{ name: "nfdump", version: "1.7.5-2+deb13u1", files: { "usr/bin/nfdump": tool("nfdump"), "usr/bin/nfcapd": tool("nfcapd") } },
	];
}

/** A fake .deb: a tar of `control` and `data/`. */
function buildDeb(pkg: FakePkg): Uint8Array {
	const dir = mkdtempSync(join(tmp, "deb-"));
	writeFileSync(join(dir, "control"), `Package: ${pkg.name}\nVersion: ${pkg.claims ?? pkg.version}\nArchitecture: amd64\n`);
	for (const [path, content] of Object.entries(pkg.files)) {
		mkdirSync(join(dir, "data", path, ".."), { recursive: true });
		writeFileSync(join(dir, "data", path), content);
		if (content.startsWith("#!")) chmodSync(join(dir, "data", path), 0o755);
	}
	const out = join(dir, "pkg.deb");
	const tar = Bun.spawnSync(["tar", "-cf", out, "-C", dir, "control", "data"]);
	if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
	const bytes = new Uint8Array(readFileSync(out));
	rmSync(dir, { recursive: true, force: true });
	return bytes;
}

/** Fake `dpkg-deb -f <deb> fields…` / `-x <deb> <dir>` over the fake format. */
function fakeDpkgDeb(): string {
	const path = join(tmp, "fake-dpkg-deb");
	writeFileSync(
		path,
		`#!/bin/sh
set -eu
case "$1" in
# Like dpkg-deb 1.22: no field -> the whole control file; one field -> its
# bare value; several -> "Field: value" lines in control-file order.
-f)
	f="$2"; shift 2
	if [ $# -eq 0 ]; then tar -xOf "$f" control; exit 0; fi
	tar -xOf "$f" control | while IFS= read -r line; do
		name="\${line%%:*}"
		for want in "$@"; do
			[ "$name" = "$want" ] || continue
			if [ $# -eq 1 ]; then echo "\${line#*: }"; else echo "$line"; fi
		done
	done ;;
-x) mkdir -p "$3" && tar -xf "$2" -C "$3" --strip-components=1 data ;;
*) exit 2 ;;
esac
`,
	);
	chmodSync(path, 0o755);
	return path;
}

/** Block the first extraction in a helper process, like dpkg-deb's tar child. */
function holdExtraction() {
	const hold = join(tmp, "hold-extract");
	const pidFile = join(tmp, "extract-pid");
	const workerPidFile = join(tmp, "extract-worker-pid");
	const worker = join(tmp, "extract-worker.ts");
	const extractor = join(tmp, "extractor.ts");
	writeFileSync(hold, "");
	writeFileSync(worker, `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));
while (existsSync(${JSON.stringify(hold)})) await Bun.sleep(25);
`);
	writeFileSync(extractor, `import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "-x" && existsSync(${JSON.stringify(hold)}) && !existsSync(${JSON.stringify(pidFile)})) {
	writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
	await Bun.spawn([process.execPath, ${JSON.stringify(worker)}], { stdout: "inherit", stderr: "inherit" }).exited;
}
const proc = Bun.spawn([${JSON.stringify(env.dpkgDeb[0])}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
`);
	env.dpkgDeb = [process.execPath, extractor];
	return { pidFile, workerPidFile };
}

/** A killed helper can remain as an inert zombie until init reaps it. */
function stopped(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ") ?? false;
	} catch {
		return true;
	}
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Build the debs, serve them, and write the lock the image build would have produced. */
function publish(pkgs: FakePkg[], lockArch = "amd64", group = "capture") {
	const roots = group === "capture" ? ["tcpdump", "tshark", "wireshark-common", "nfdump"] : pkgs.map((p) => p.name);
	const lock: DebLock = { schemaVersion: 1, group, roots, arch: lockArch, distro: "debian-trixie", packages: [] };
	for (const pkg of pkgs) {
		const bytes = buildDeb(pkg);
		debs.set(pkg.name, bytes);
		const filename = `pool/main/${pkg.name[0]}/${pkg.name}/${pkg.name}_${pkg.version}_amd64.deb`;
		const url = `${MIRROR}/${filename}`;
		served.set(url, bytes);
		lock.packages.push({ name: pkg.name, version: pkg.version, architecture: "amd64", size: bytes.length, installedSize: 4096, sha256: sha256(bytes), filename, uris: [url] });
	}
	lock.packages.sort((a, b) => a.name.localeCompare(b.name));
	mkdirSync(join(env.specDir, group), { recursive: true });
	writeFileSync(join(env.specDir, group, DEB_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
	return lock;
}

const captureState = () => buildStatus("capture", nothing, "/nonexistent", env).groups.find((g) => g.name === "capture");
const manifestOf = (id: string) => JSON.parse(readFileSync(join(env.root, "groups", "capture", id, "manifest.json"), "utf8")) as Manifest;
const shim = (bin: string) => join(env.root, "bin", bin);

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "t3code-debs-"));
	// The image already has ip(8) and zlib.
	mkdirSync(join(tmp, "image", "usr", "bin"), { recursive: true });
	writeFileSync(join(tmp, "image", "usr", "bin", "ip"), "#!/bin/sh\n");
	chmodSync(join(tmp, "image", "usr", "bin", "ip"), 0o755);
	mkdirSync(join(tmp, "image", "usr", "lib", "x86_64-linux-gnu"), { recursive: true });
	writeFileSync(join(tmp, "image", "usr", "lib", "x86_64-linux-gnu", "libz.so.1"), "");
	compat = { platform: "linux", arch: "amd64", distro: "debian-trixie" };
	served = new Map();
	fetched = [];
	debs = new Map();
	env = {
		root: join(tmp, "home", ".local/share/t3code-tools"),
		specDir: join(tmp, "spec"),
		compat: () => ({ platform: "linux", arch: "x64", nodeAbi: "137", node: "v24.0.0" }),
		debCompat: () => compat,
		npm: ["false"],
		dpkgDeb: [fakeDpkgDeb()],
		fetch: async (url) => {
			fetched.push(url);
			const bytes = served.get(url);
			return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
		},
		snapshotBase: SNAPSHOT,
		snapshotRetryMs: [0],
		imageRoot: join(tmp, "image"),
		sleep: async () => {},
		log: () => {},
		freeBytes: () => 10 * 1024 ** 3,
		backoffMs: [0, 0],
		installTimeoutMs: 30_000,
	};
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("deb payload groups (capture)", () => {
	test("installs from the pinned lock: verified, extracted as this user, wrapped and linked", async () => {
		publish(basePackages());
		expect(captureState()?.state).toBe("pending");
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]).toMatchObject({ state: "ready", attempt: 1 });
		const status = captureState();
		expect(status).toMatchObject({ state: "ready", present: true, missing: [] });
		const id = status?.payload?.active as string;
		expect(id).toStartWith("amd64-trixie-");
		expect(status?.payload?.activeVersions?.["tshark"]).toBe("TShark (Wireshark) 4.4.19 (fake)");
		expect(status?.payload?.activeVersions?.["nfdump"]).toBe("nfdump fake 1.0");

		const manifest = manifestOf(id);
		expect(manifest.delivery).toBe("deb");
		expect(Object.keys(manifest.deb?.debs ?? {}).sort()).toEqual(["libwireshark18", "nfdump", "tcpdump", "tshark", "wireshark-common"]);
		expect(manifest.deb?.debs["tcpdump"]).toEqual({ version: "4.99.5-2", sha256: sha256(debs.get("tcpdump") as Uint8Array), source: "deb.example" });
		expect(manifest.deb?.libDirs).toEqual(["usr/lib/x86_64-linux-gnu"]);
		// The image's ip(8) wins: the payload's copy gets no shim.
		expect(manifest.deb?.skippedCommands).toEqual(["ip"]);
		expect(manifest.deb?.shadows).toEqual(["usr/lib/x86_64-linux-gnu/libz.so.1"]);
		expect(manifest.commands).toContain("rawshark");
		expect(existsSync(shim("ip"))).toBe(false);

		// Shim -> current -> wrapper -> real binary, with the payload's libraries for that process only.
		expect(readlinkSync(shim("tshark"))).toBe("../groups/capture/current/bin/tshark");
		const run = Bun.spawnSync([shim("tshark"), "env"], { env: { PATH: "/usr/bin:/bin" } });
		expect(run.stdout.toString().trim()).toBe(`LD_LIBRARY_PATH=${join(env.root, "groups", "capture", id, "root", "usr/lib/x86_64-linux-gnu")}`);
		expect(Bun.spawnSync([shim("rawshark")]).stdout.toString().trim()).toBe("rawshark fake 1.0");
		expect(process.env["LD_LIBRARY_PATH"] ?? "").not.toContain("t3code-tools");
		// Downloads are not kept once the payload is ready.
		expect(existsSync(join(env.root, "groups", "capture", DEB_CACHE_DIR))).toBe(false);
		expect(fetched).toHaveLength(5);
	});

	test("a replaced container relinks the payload offline", async () => {
		publish(basePackages());
		await installGroups(payloadGroups, ["capture"], env);
		rmSync(join(env.root, "bin"), { recursive: true, force: true });
		served.clear();
		expect(activate(payloadGroups, ["capture"], env)).toEqual([]);
		await installGroups(payloadGroups, ["capture"], env);
		expect(fetched).toHaveLength(5);
		expect(captureState()?.state).toBe("ready");
		expect(Bun.spawnSync([shim("tshark"), "--version"]).exitCode).toBe(0);
	});

	test("a download that does not match its pinned SHA256 is never extracted", async () => {
		const lock = publish(basePackages());
		const tsharkUrl = lock.packages.find((p) => p.name === "tshark")?.uris[0] as string;
		const tampered = new Uint8Array(served.get(tsharkUrl) as Uint8Array);
		tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
		served.set(tsharkUrl, tampered);
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.state).toBe("failed");
		expect(result.results["capture"]?.error).toContain("sha256");
		expect(readdirSync(join(env.root, "groups", "capture")).filter((n) => !n.startsWith("."))).toEqual([]);
		expect(existsSync(shim("tshark"))).toBe(false);
		expect(captureState()?.state).toBe("failed");
	});

	test("a file whose control fields name another version is rejected even though its hash is pinned", async () => {
		publish(basePackages().map((p) => (p.name === "tcpdump" ? { ...p, claims: "9.9-1" } : p)));
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.state).toBe("failed");
		expect(result.results["capture"]?.error).toContain("contains tcpdump=9.9-1 [amd64], pinned tcpdump=4.99.5-2 [amd64]");
		expect(captureState()?.payload?.active).toBeNull();
	});

	test("a version gone from the mirror is fetched from snapshot.debian.org and verified the same way", async () => {
		const lock = publish(basePackages());
		const pkg = lock.packages.find((p) => p.name === "nfdump");
		if (!pkg) throw new Error("nfdump missing");
		const bytes = served.get(pkg.uris[0] as string) as Uint8Array;
		served.delete(pkg.uris[0] as string);
		const sha1 = createHash("sha1").update(bytes).digest("hex");
		served.set(
			`${SNAPSHOT}/mr/binary/nfdump/${encodeURIComponent(pkg.version)}/binfiles?fileinfo=1`,
			new TextEncoder().encode(
				JSON.stringify({
					fileinfo: {
						"0000000000000000000000000000000000000000": [{ name: `nfdump_${pkg.version}_arm64.deb`, archive_name: "debian" }],
						[sha1]: [{ name: `nfdump_${pkg.version}_amd64.deb`, archive_name: "debian" }],
					},
				}),
			),
		);
		served.set(`${SNAPSHOT}/file/${sha1}`, bytes);
		// The API answers 504 to a cold query first.
		const realFetch = env.fetch;
		let cold = true;
		env.fetch = async (url, init) => {
			if (url.includes("/mr/binary/") && cold) {
				cold = false;
				fetched.push(url);
				return new Response("Gateway Timeout", { status: 504 });
			}
			return realFetch(url, init);
		};
		await installGroups(payloadGroups, ["capture"], env);
		expect(fetched.filter((u) => u.includes("/mr/binary/"))).toHaveLength(2);
		const status = captureState();
		expect(status?.state).toBe("ready");
		expect(manifestOf(status?.payload?.active as string).deb?.debs["nfdump"]?.source).toBe("snapshot.example");
	});

	test("verified downloads survive an interrupted or failed run; the next run fetches only what is missing", async () => {
		const lock = publish(basePackages());
		const last = lock.packages.at(-1)?.uris[0] as string;
		const bytes = served.get(last) as Uint8Array;
		served.delete(last);
		const first = await installGroups(payloadGroups, ["capture"], env);
		expect(first.results["capture"]).toMatchObject({ state: "failed", attempt: 3 });
		expect(readdirSync(join(env.root, "groups", "capture", DEB_CACHE_DIR)).filter((n) => n.endsWith(".deb"))).toHaveLength(4);
		expect(readdirSync(join(env.root, "groups", "capture", DEB_CACHE_DIR)).filter((n) => n.endsWith(".part"))).toEqual([]);

		served.set(last, bytes);
		fetched = [];
		const second = await installGroups(payloadGroups, ["capture"], env);
		expect(second.results["capture"]?.state).toBe("ready");
		expect(fetched).toEqual([last]);
		expect(existsSync(join(env.root, "groups", "capture", DEB_CACHE_DIR))).toBe(false);
	});

	test("a new lock refreshes with rollback; a payload for another CPU is never linked", async () => {
		publish(basePackages());
		await installGroups(payloadGroups, ["capture"], env);
		const first = captureState()?.payload?.active as string;

		// The next image pins a security update of tcpdump.
		publish(basePackages().map((p) => (p.name === "tcpdump" ? { ...p, version: "4.99.5-2+deb13u1" } : p)));
		expect(activate(payloadGroups, ["capture"], env)).toEqual(["capture"]);
		expect(captureState()).toMatchObject({ state: "ready", payload: { active: first, stale: true } });

		const keep = new Map(served);
		served.clear();
		const failed = await installGroups(payloadGroups, ["capture"], env);
		expect(failed.results["capture"]?.state).toBe("failed");
		expect(captureState()).toMatchObject({ state: "ready", payload: { active: first, stale: true } });
		expect(Bun.spawnSync([shim("tcpdump")]).exitCode).toBe(0);

		served = keep;
		await installGroups(payloadGroups, ["capture"], env);
		const second = captureState()?.payload?.active as string;
		expect(second).not.toBe(first);
		expect(manifestOf(second).packages["tcpdump"]).toBe("4.99.5-2+deb13u1");
		expect(captureState()?.payload?.installed.sort()).toEqual([first, second].sort());

		// The same home on an arm64 router: the amd64 payload is not usable there.
		compat = { ...compat, arch: "arm64" };
		expect(activate(payloadGroups, ["capture"], env)).toEqual(["capture"]);
		expect(existsSync(shim("tshark"))).toBe(false);
		const status = captureState();
		expect(status?.payload?.active).toBeNull();
		expect(status?.payload?.desiredError).toContain("lock is for amd64 debian-trixie, this runtime is arm64 debian-trixie");
		await installGroups(payloadGroups, ["capture"], env);
		expect(captureState()?.state).toBe("failed");
		expect(readState(env)["capture"]).toMatchObject({ state: "failed", permanent: true });
	});

	test("the stale-payload check covers every required command, not only tshark", async () => {
		const broken = join(tmp, "tcpdump-broke");
		const tcpdump = `#!/bin/sh\n[ -e "${broken}" ] && { echo "error while loading shared libraries: libpcap.so.0.8" >&2; exit 127; }\necho "tcpdump fake 1.0"\n`;
		publish(basePackages().map((p) => (p.name === "tcpdump" ? { ...p, files: { ...p.files, "usr/bin/tcpdump": tcpdump } } : p)));
		await installGroups(payloadGroups, ["capture"], env);
		publish(basePackages().map((p) => (p.name === "nfdump" ? { ...p, version: "1.7.5-2+deb13u2" } : p)));
		writeFileSync(broken, ""); // tshark still loads; tcpdump does not
		expect(activate(payloadGroups, ["capture"], env)).toEqual(["capture"]);
		expect(existsSync(shim("tshark"))).toBe(false);
		expect(existsSync(shim("tcpdump"))).toBe(false);
	});

	test("the fake dpkg-deb answers -f like dpkg-deb 1.22: bare value for one field, Field: value for several", async () => {
		publish(basePackages());
		const deb = join(tmp, "probe.deb");
		writeFileSync(deb, debs.get("tcpdump") as Uint8Array);
		const one = Bun.spawnSync([...env.dpkgDeb, "-f", deb, "Version"]).stdout.toString();
		const several = Bun.spawnSync([...env.dpkgDeb, "-f", deb, "Architecture", "Package"]).stdout.toString();
		expect(one).toBe("4.99.5-2\n");
		expect(several).toBe("Package: tcpdump\nArchitecture: amd64\n");
	});

	test("a stale payload that no longer loads against the new image is unlinked until its refresh lands", async () => {
		publish(basePackages());
		await installGroups(payloadGroups, ["capture"], env);
		publish(basePackages().map((p) => (p.name === "nfdump" ? { ...p, version: "1.7.5-2+deb13u2" } : p)));
		writeFileSync(join(tmp, "image-broke"), ""); // the new image lost a library the old payload used
		expect(activate(payloadGroups, ["capture"], env)).toEqual(["capture"]);
		expect(existsSync(shim("tshark"))).toBe(false);
		expect(captureState()?.state).not.toBe("ready");
		rmSync(join(tmp, "image-broke"));
		await installGroups(payloadGroups, ["capture"], env);
		expect(captureState()).toMatchObject({ state: "ready", payload: { stale: false } });
	});

	test("a failing smoke test or version probe keeps the payload out", async () => {
		publish(basePackages().map((p) => (p.name === "tshark" ? { ...p, files: { ...p.files, "usr/bin/tshark": tshark(join(tmp, "image-broke")).replace('echo "1\trouteros.example"', "echo nothing") } } : p)));
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.error).toContain("smoke test tshark -r {input}");
		expect(captureState()?.payload?.active).toBeNull();

		publish(basePackages().map((p) => (p.name === "tcpdump" ? { ...p, files: { ...p.files, "usr/bin/tcpdump": "#!/bin/sh\nexit 126\n" } } : p)));
		const again = await installGroups(payloadGroups, ["capture"], env);
		expect(again.results["capture"]?.error).toContain("tcpdump --version exited 126");
	});

	test("a lock missing a required command fails with the reason", async () => {
		publish(basePackages().filter((p) => p.name !== "nfdump"));
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.error).toContain("neither the payload nor the image provides nfcapd, nfdump");
	});

	test("an image without a lock reports a permanent failure, not a download", async () => {
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]).toMatchObject({ state: "failed", permanent: true });
		expect(result.results["capture"]?.error).toContain("no Debian lock for capture");
		expect(fetched).toEqual([]);
	});

	test("low disk is checked against the lock's download and unpacked sizes", async () => {
		publish(basePackages());
		env.freeBytes = () => 256 * 1024 * 1024 + 1; // above the reserve, below reserve + the lock's download and unpacked sizes
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.error).toContain("low disk");
		expect(fetched).toEqual([]);
	});

	test("a mirror serving more than the pinned size is cut off while streaming", async () => {
		const lock = publish(basePackages());
		const url = lock.packages.find((p) => p.name === "tcpdump")?.uris[0] as string;
		const real = served.get(url) as Uint8Array;
		const huge = new Uint8Array(real.length + 1024 * 1024);
		huge.set(real);
		served.set(url, huge);
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.state).toBe("failed");
		expect(result.results["capture"]?.error).toContain(`more than the pinned ${real.length} bytes`);
		const cache = join(env.root, "groups", "capture", DEB_CACHE_DIR);
		expect(readdirSync(cache).filter((n) => n.endsWith(".part"))).toEqual([]);
		expect(captureState()?.payload?.active).toBeNull();
	});

	test("the disk budget does not count .debs already verified in the cache", async () => {
		const lock = publish(basePackages());
		const last = lock.packages.at(-1);
		if (!last) throw new Error("empty lock");
		const bytes = served.get(last.uris[0] as string) as Uint8Array;
		served.delete(last.uris[0] as string);
		await installGroups(payloadGroups, ["capture"], env); // fails, caches the other four
		served.set(last.uris[0] as string, bytes);
		const unpacked = lock.packages.reduce((sum, p) => sum + p.installedSize, 0);
		const total = lock.packages.reduce((sum, p) => sum + p.size, 0);
		// Enough for the one missing download, not for all of them.
		env.freeBytes = () => 256 * 1024 * 1024 + unpacked + last.size + 1;
		expect(256 * 1024 * 1024 + unpacked + last.size + 1).toBeLessThan(256 * 1024 * 1024 + unpacked + total);
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.state).toBe("ready");
	});

	test("a required command the image provides itself satisfies the group, with no payload shim", async () => {
		writeFileSync(join(tmp, "image", "usr", "bin", "tcpdump"), '#!/bin/sh\necho "tcpdump version 4.99.5 (image)"\n');
		chmodSync(join(tmp, "image", "usr", "bin", "tcpdump"), 0o755);
		publish(basePackages().filter((p) => p.name !== "tcpdump"));
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(result.results["capture"]?.state).toBe("ready");
		const status = captureState();
		expect(status).toMatchObject({ state: "ready", present: true, missing: [] });
		expect(status?.payload?.commandPaths["tcpdump"]).toBe(join(tmp, "image", "usr", "bin", "tcpdump"));
		expect(status?.payload?.activeVersions?.["tcpdump"]).toBe("tcpdump version 4.99.5 (image)");
		expect(existsSync(shim("tcpdump"))).toBe(false);
		// Relinking keeps it that way (a replaced container with the same home).
		expect(activate(payloadGroups, ["capture"], env)).toEqual([]);
		expect(captureState()?.state).toBe("ready");
	});

	test("a payload command the image starts providing later loses its shim; the image wins", async () => {
		publish(basePackages());
		await installGroups(payloadGroups, ["capture"], env);
		expect(existsSync(shim("rawshark"))).toBe(true);
		writeFileSync(join(tmp, "image", "usr", "bin", "rawshark"), "#!/bin/sh\n");
		chmodSync(join(tmp, "image", "usr", "bin", "rawshark"), 0o755);
		expect(activate(payloadGroups, ["capture"], env)).toEqual([]);
		expect(existsSync(shim("rawshark"))).toBe(false);
		expect(existsSync(shim("tshark"))).toBe(true);
		expect(captureState()?.state).toBe("ready");
	});

	test("a stale command replaced by the image cannot disable the remaining payload tools", async () => {
		const broken = join(tmp, "tcpdump-broke");
		const tcpdump = `#!/bin/sh\n[ -e "${broken}" ] && exit 127\necho "tcpdump fake 1.0"\n`;
		publish(basePackages().map((p) => (p.name === "tcpdump" ? { ...p, files: { ...p.files, "usr/bin/tcpdump": tcpdump } } : p)));
		await installGroups(payloadGroups, ["capture"], env);
		const previous = captureState()?.payload?.active;
		publish(basePackages().filter((p) => p.name !== "tcpdump"));
		writeFileSync(join(tmp, "image", "usr", "bin", "tcpdump"), tool("image-tcpdump"));
		chmodSync(join(tmp, "image", "usr", "bin", "tcpdump"), 0o755);
		writeFileSync(broken, "");
		served.clear(); // refresh cannot finish; the retained payload must keep serving
		expect(activate(payloadGroups, ["capture"], env)).toEqual(["capture"]);
		expect(existsSync(shim("tcpdump"))).toBe(false);
		expect(Bun.spawnSync([shim("tshark"), "--version"]).exitCode).toBe(0);
		expect(captureState()).toMatchObject({ state: "ready", payload: { active: previous, stale: true } });
		await installGroups(payloadGroups, ["capture"], env);
		expect(captureState()?.state).toBe("ready");
	});

	test("a dpkg-deb child orphaned by a killed installer is stopped before staging cleanup", async () => {
		publish(basePackages());
		const { pidFile, workerPidFile } = holdExtraction();
		const script = join(tmp, "installer.ts");
		writeFileSync(script, `import { installGroups } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-payloads.ts"))};
import { GROUPS } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-groups.ts"))};
const config = JSON.parse(process.argv[2]);
await installGroups(GROUPS.filter((g) => g.delivery === "deb"), ["capture"], {
	...config.env, debCompat: () => config.compat, sleep: async () => {}, log: () => {}, freeBytes: () => 10 * 1024 ** 3,
	fetch: async (url) => new Response(Buffer.from(config.served[url], "base64")),
});
`);
		const installer = Bun.spawn([process.execPath, script, JSON.stringify({ env, compat, served: Object.fromEntries([...served].map(([url, bytes]) => [url, Buffer.from(bytes).toString("base64")])) })]);
		let extractorPid: number | undefined;
		let workerPid: number | undefined;
		try {
			for (let i = 0; i < 100 && !existsSync(workerPidFile); i++) await Bun.sleep(20);
			extractorPid = Number(readFileSync(pidFile, "utf8"));
			workerPid = Number(readFileSync(workerPidFile, "utf8"));
			const lock = JSON.parse(readFileSync(join(env.root, "install.lock"), "utf8"));
			expect(lock.child?.pid).toBe(extractorPid);
			expect(lock.child?.processGroup).toBe(true);
			installer.kill("SIGKILL");
			await installer.exited;
			expect(processStartTicks(extractorPid)).not.toBeNull();
			const logs: string[] = [];
			env.log = (line) => logs.push(line);
			const result = await installGroups(payloadGroups, ["capture"], env);
			expect(logs.some((line) => line.includes(`stopping payload child (pid ${extractorPid})`))).toBe(true);
			expect(processStartTicks(extractorPid)).toBeNull();
			expect(stopped(workerPid)).toBe(true);
			expect(result.results["capture"]?.state).toBe("ready");
			expect(readdirSync(join(env.root, "groups", "capture")).some((name) => name.startsWith(".staging-"))).toBe(false);
		} finally {
			installer.kill("SIGKILL");
			await installer.exited;
			if (extractorPid && processStartTicks(extractorPid) !== null) process.kill(extractorPid, "SIGKILL");
			if (workerPid && processStartTicks(workerPid) !== null) process.kill(workerPid, "SIGKILL");
		}
	});

	test("the install deadline stops extraction helpers and closes their output pipes", async () => {
		publish(basePackages());
		const { pidFile, workerPidFile } = holdExtraction();
		env.installTimeoutMs = 1000;
		env.backoffMs = [];
		const started = Date.now();
		const result = await installGroups(payloadGroups, ["capture"], env);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(result.results["capture"]?.state).toBe("failed");
		expect(stopped(Number(readFileSync(pidFile, "utf8")))).toBe(true);
		expect(stopped(Number(readFileSync(workerPidFile, "utf8")))).toBe(true);
		expect(captureState()?.payload?.active).toBeNull();
		expect(JSON.parse(readFileSync(join(env.root, "install.lock"), "utf8") || "{}").child).toBeUndefined();
	});

	test("deselecting unlinks every capture shim; prune deletes the payload and kept downloads", async () => {
		publish(basePackages());
		await installGroups(payloadGroups, ["capture"], env);
		mkdirSync(join(env.root, "groups", "capture", DEB_CACHE_DIR), { recursive: true });
		activate(payloadGroups, [], env);
		expect(readdirSync(join(env.root, "bin"))).toEqual([]);
		expect(buildStatus("none", nothing, "/nonexistent", env).groups.find((g) => g.name === "capture")?.payload?.installed).toHaveLength(1);
		const removed = await prunePayloads(payloadGroups, [], env);
		expect(removed).toHaveLength(2);
		expect(removed).toContain(`capture/${DEB_CACHE_DIR}`);
		expect(removed.find((r) => r !== `capture/${DEB_CACHE_DIR}`)).toStartWith("capture/amd64-trixie-");
		expect(readdirSync(join(env.root, "groups", "capture"))).toEqual([]);
	});
});

describe("deb lock resolution (image build)", () => {
	const simulation = `NOTE: This is only a simulation!
Inst libpcap0.8t64 (1.10.5-2 Debian:13.7/stable [amd64])
Inst libzstd1 [1.5.7+dfsg-1] (1.5.7+dfsg-1+deb13u1 Debian:13.7/stable [amd64])
Inst libcares2 [1.34.5-1] (1.34.5-1+deb13u1 Debian:13.7/stable, Debian-Security:13/stable-security [amd64])
Inst libwireshark-data (4.4.19-0+deb13u1 Debian-Security:13/stable-security [all])
Inst libcap2-bin (1:2.75-10+deb13u1+b3 Debian:13.7/stable [amd64])
Conf libpcap0.8t64 (1.10.5-2 Debian:13.7/stable [amd64])
`;
	const uris = `'http://deb.debian.org/debian/pool/main/libp/libpcap/libpcap0.8t64_1.10.5-2_amd64.deb' libpcap0.8t64_1.10.5-2_amd64.deb 169000 MD5Sum:00
'http://deb.debian.org/debian/pool/main/c/c-ares/libcares2_1.34.5-1%2bdeb13u1_amd64.deb' libcares2_1.34.5-1+deb13u1_amd64.deb 98272 MD5Sum:00
'http://deb.debian.org/debian-security/pool/updates/main/w/wireshark/libwireshark-data_4.4.19-0%2bdeb13u1_all.deb' libwireshark-data_4.4.19-0+deb13u1_all.deb 464736 MD5Sum:00
'http://deb.debian.org/debian/pool/main/libc/libcap2/libcap2-bin_2.75-10%2bdeb13u1%2bb3_amd64.deb' libcap2-bin_1%3a2.75-10+deb13u1+b3_amd64.deb 36500 MD5Sum:00
`;
	const stanza = (name: string, version: string, arch: string, filename: string, sha: string) =>
		`Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nInstalled-Size: 100\nDescription: x\n multi-line\nFilename: ${filename}\nSize: 1000\nSHA256: ${sha}\n`;
	const show = [
		stanza("libpcap0.8t64", "1.10.5-2", "amd64", "pool/main/libp/libpcap/libpcap0.8t64_1.10.5-2_amd64.deb", "a".repeat(64)),
		stanza("libcares2", "1.34.5-1+deb13u1", "amd64", "pool/main/c/c-ares/libcares2_1.34.5-1+deb13u1_amd64.deb", "b".repeat(64)),
		stanza("libwireshark-data", "4.4.19-0+deb13u1", "all", "pool/updates/main/w/wireshark/libwireshark-data_4.4.19-0+deb13u1_all.deb", "c".repeat(64)),
		// An epoch: in the version and apt's local file name, never in the pool file name.
		stanza("libcap2-bin", "1:2.75-10+deb13u1+b3", "amd64", "pool/main/libc/libcap2/libcap2-bin_2.75-10+deb13u1+b3_amd64.deb", "d".repeat(64)),
	].join("\n");
	const osRelease = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_CODENAME=trixie\n';

	test("parses apt's simulation, URIs and index stanzas", () => {
		expect(parseAptSimulation(simulation)).toEqual([
			{ name: "libpcap0.8t64", version: "1.10.5-2", architecture: "amd64" },
			{ name: "libzstd1", version: "1.5.7+dfsg-1+deb13u1", architecture: "amd64", installed: "1.5.7+dfsg-1" },
			{ name: "libcares2", version: "1.34.5-1+deb13u1", architecture: "amd64", installed: "1.34.5-1" },
			{ name: "libwireshark-data", version: "4.4.19-0+deb13u1", architecture: "all" },
			{ name: "libcap2-bin", version: "1:2.75-10+deb13u1+b3", architecture: "amd64" },
		]);
		expect(parsePrintUris(uris).get("libcares2_1.34.5-1+deb13u1_amd64.deb")).toBe("http://deb.debian.org/debian/pool/main/c/c-ares/libcares2_1.34.5-1%2bdeb13u1_amd64.deb");
		expect(parseStanzas(show)[0]?.["Description"]).toBe("x\nmulti-line");
		expect(osReleaseDistro(osRelease)).toBe("debian-trixie");
	});

	test("pins the closure with SHA256 from the index, https first, sorted and timestamp-free", () => {
		const calls: string[][] = [];
		const exec = (cmd: string[]) => {
			calls.push(cmd);
			if (cmd[0] === "dpkg") return "amd64\n";
			if (cmd.includes("-s")) return simulation;
			if (cmd.includes("--print-uris")) return uris;
			return show;
		};
		const lock = resolveDebLock("capture", ["tcpdump"], exec, osRelease);
		expect(lock).toMatchObject({ schemaVersion: 1, group: "capture", roots: ["tcpdump"], arch: "amd64", distro: "debian-trixie" });
		// libcares2 is an upgrade of an image package: recorded, never extracted.
		expect(lock.packages.map((p) => p.name)).toEqual(["libcap2-bin", "libpcap0.8t64", "libwireshark-data"]);
		// Sorted by name whatever order apt printed them in, so the lock bytes are stable.
		expect(lock.imageUpgrades).toEqual([
			{ name: "libcares2", installed: "1.34.5-1", candidate: "1.34.5-1+deb13u1" },
			{ name: "libzstd1", installed: "1.5.7+dfsg-1", candidate: "1.5.7+dfsg-1+deb13u1" },
		]);
		expect(calls.find((c) => c[0] === "apt-cache")).not.toContain("libcares2=1.34.5-1+deb13u1");
		expect(lock.packages[0]?.uris[0]).toBe("https://deb.debian.org/debian/pool/main/libc/libcap2/libcap2-bin_2.75-10%2bdeb13u1%2bb3_amd64.deb");
		expect(lock.packages[2]).toEqual({
			name: "libwireshark-data",
			version: "4.4.19-0+deb13u1",
			architecture: "all",
			size: 1000,
			installedSize: 100 * 1024,
			sha256: "c".repeat(64),
			filename: "pool/updates/main/w/wireshark/libwireshark-data_4.4.19-0+deb13u1_all.deb",
			uris: [
				"https://deb.debian.org/debian-security/pool/updates/main/w/wireshark/libwireshark-data_4.4.19-0%2bdeb13u1_all.deb",
				"http://deb.debian.org/debian-security/pool/updates/main/w/wireshark/libwireshark-data_4.4.19-0%2bdeb13u1_all.deb",
			],
		});
		expect(JSON.stringify(lock)).not.toMatch(/20\d\d-\d\d-\d\dT/);
		expect(calls.find((c) => c[0] === "apt-cache")).toContain("libpcap0.8t64=1.10.5-2");
		expect(() => resolveDebLock("capture", ["tcpdump"], (cmd) => (cmd.includes("-s") ? "" : exec(cmd)), osRelease)).toThrow("apt resolves nothing");
		expect(() => resolveDebLock("capture", ["tcpdump"], (cmd) => (cmd[0] === "apt-cache" ? show.replace("a".repeat(64), "") : exec(cmd)), osRelease)).toThrow("no SHA256");
	});

	test("rejects outdated image roots before resolving downloads, with or without missing dependencies", () => {
		for (const root of capture.packages) {
			for (const dependencies of ["", simulation]) {
				const exec = (cmd: string[]) => {
					if (cmd.includes("-s")) return `Inst ${root} [1.0-1] (1.0-1+deb13u1 Debian-Security:13/stable-security [amd64])\n${dependencies}`;
					throw new Error("must reject the outdated root before resolving downloads");
				};
				expect(() => resolveDebLock("capture", capture.packages, exec, osRelease)).toThrow(`${root} 1.0-1 -> 1.0-1+deb13u1`);
			}
		}
	});

	test("the docker test's capture script uses the same fixture as the installer's smoke test", () => {
		const script = readFileSync(join(import.meta.dir, "capture-tools.sh"), "utf8");
		expect(script).toContain(`printf %s '${TZSP_DNS_PCAPNG}' | base64 -d`);
		expect(capture.smoke?.[0]?.inputBase64).toBe(TZSP_DNS_PCAPNG);
	});

	test("wrappers set the library path for their own process only and resolve the payload through links", () => {
		const script = wrapperScript("capture", "root/usr/bin/tshark", ["usr/lib/x86_64-linux-gnu"]);
		expect(script).toContain('p=$(readlink -f -- "$0")');
		expect(script).toContain(`LD_LIBRARY_PATH="$p/root/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`);
		expect(script).toContain('exec "$p/root/usr/bin/tshark" "$@"');
		expect(wrapperScript("capture", "root/usr/bin/nfdump", [])).not.toContain("LD_LIBRARY_PATH=");
	});
});

describe("deb wrapper rules, expected-exit probes and smoke lists (vpn, routing)", () => {
	// A strongSwan-like tool: its config and plugins are found only through the
	// wrapper; a birdc-like client that cannot exit 0 without its daemon.
	const strong: GroupDef = {
		name: "strong",
		summary: "test",
		delivery: "deb",
		packages: ["strong"],
		checks: [
			{ kind: "command", name: "pki" },
			{ kind: "command", name: "ctl" },
		],
		privileges: "None.",
		versionArgs: { pki: ["--help"], ctl: ["-s", "/nonexistent/ctl.sock"] },
		versionExit: { ctl: { code: 1, expect: "Unable to connect" } },
		wrappers: [
			{
				commands: ["pki", "not-in-payload"],
				env: { STRONGSWAN_CONF: "{root}/etc/strongswan.conf" },
				preload: { libraries: ["usr/lib/ipsec/libstrongswan.so.0"], pluginDir: "usr/lib/ipsec/plugins" },
			},
		],
		smoke: [
			{ command: "pki", args: ["--gen"], expect: "BEGIN PRIVATE KEY" },
			{ command: "ctl", args: ["parse", "{input}"], inputBase64: Buffer.from("router id 192.0.2.1;\n").toString("base64"), expect: "" },
			// {input} inside an argument, like arp-scan's --readpktfromfile={input}.
			{ command: "ctl", args: ["--file={input}"], inputBase64: Buffer.from("router id 192.0.2.1;\n").toString("base64"), expect: "file ok" },
		],
	};
	const groups = [strong];
	const pki = `#!/bin/sh
case "$1" in
--help) [ -s "$STRONGSWAN_CONF" ] || { echo "no files found matching '/etc/strongswan.conf'" >&2; exit 64; }; echo "strongSwan 6.0.1 PKI tool" ;;
--gen) case "$LD_PRELOAD" in *libstrongswan-openssl.so*) echo "-----BEGIN PRIVATE KEY-----" ;; *) echo "building CRED_PRIVATE_KEY failed, tried 0 builders" >&2; exit 1 ;; esac ;;
env) echo "STRONGSWAN_CONF=$STRONGSWAN_CONF"; echo "LD_PRELOAD=$LD_PRELOAD" ;;
esac
`;
	const ctl = (connect = 'echo "Unable to connect to server control socket ($2): No such file or directory" >&2; exit 1') => `#!/bin/sh
case "$1" in
-s) ${connect} ;;
parse) grep -q "router id" "$2" ;;
--file=*) grep -q "router id" "\${1#--file=}" && echo "file ok" ;;
*) echo "LD_PRELOAD=$LD_PRELOAD" ;;
esac
`;
	const packages = (over: Partial<Record<"pki" | "ctl", string>> = {}): FakePkg[] => [
		{
			name: "strong",
			version: "6.0.1-6",
			files: {
				"usr/bin/pki": over.pki ?? pki,
				"usr/sbin/ctl": over.ctl ?? ctl(),
				"etc/strongswan.conf": "charon { load_modular = yes }\n",
				"usr/lib/ipsec/libstrongswan.so.0": "elf",
				"usr/lib/ipsec/plugins/libstrongswan-openssl.so": "elf",
				"usr/lib/ipsec/plugins/libstrongswan-x509.so": "elf",
				// Needs symbols only charon provides: never preloaded.
				"usr/lib/ipsec/plugins/libstrongswan-kernel-netlink.so": "elf",
				"usr/lib/ipsec/plugins/README": "not a plugin",
			},
		},
	];
	const preloadCalls: string[][] = [];
	beforeEach(() => {
		preloadCalls.length = 0;
		env.canPreload = (libs, libraryPath) => {
			preloadCalls.push([...libs]);
			// Checked with the payload's own library dirs, as the wrapper will run.
			expect(libraryPath).toContain("/root/usr/lib/ipsec");
			return !libs.some((lib) => lib.endsWith("kernel-netlink.so"));
		};
	});
	/** The active payload's manifest. */
	const state = () => JSON.parse(readFileSync(join(env.root, "groups", "strong", "current", "manifest.json"), "utf8")) as Manifest;

	test("the wrapper carries the rule's variables and the plugins that load against the base library alone", async () => {
		publish(packages(), "amd64", "strong");
		const result = await installGroups(groups, ["strong"], env);
		expect(result.results["strong"]).toMatchObject({ state: "ready", attempt: 1 });
		const manifest = state();
		const payload = join(env.root, "groups", "strong", manifest.payloadId, "root");
		const preload = [
			"usr/lib/ipsec/libstrongswan.so.0",
			"usr/lib/ipsec/plugins/libstrongswan-openssl.so",
			"usr/lib/ipsec/plugins/libstrongswan-x509.so",
		];
		// Recorded for agents; the rule's command that the payload lacks is ignored.
		expect(manifest.deb?.wired).toEqual({ pki: { env: ["STRONGSWAN_CONF"], preload } });
		expect(manifest.versions).toEqual({ pki: "strongSwan 6.0.1 PKI tool", ctl: "Unable to connect to server control socket (/nonexistent/ctl.sock): No such file or directory" });
		const out = Bun.spawnSync([shim("pki"), "env"], { env: { PATH: "/usr/bin:/bin", LD_PRELOAD: "/user/own.so" } }).stdout.toString();
		expect(out).toContain(`STRONGSWAN_CONF=${payload}/etc/strongswan.conf\n`);
		// File names, found on the wrapper's library path; the user's own LD_PRELOAD is kept after them.
		expect(out).toContain(`LD_PRELOAD=libstrongswan.so.0:libstrongswan-openssl.so:libstrongswan-x509.so:/user/own.so\n`);
		// The rule's variables are defaults: a caller's own setting wins, even an empty one.
		const own = (value: string) => Bun.spawnSync([shim("pki"), "env"], { env: { PATH: "/usr/bin:/bin", STRONGSWAN_CONF: value } }).stdout.toString();
		expect(own("/mine/strongswan.conf")).toContain("STRONGSWAN_CONF=/mine/strongswan.conf\n");
		expect(own("")).toContain("STRONGSWAN_CONF=\n");
		// Other commands get no preload at all.
		expect(Bun.spawnSync([shim("ctl"), "env"], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString().trim()).toBe("LD_PRELOAD=");
		// Each plugin was tried alone with the base library, then the chosen set together.
		expect(preloadCalls).toEqual([
			["libstrongswan.so.0", "libstrongswan-kernel-netlink.so"],
			["libstrongswan.so.0", "libstrongswan-openssl.so"],
			["libstrongswan.so.0", "libstrongswan-x509.so"],
			preload.map((l) => l.split("/").pop() as string),
		]);
	});

	test("a stale payload whose client exits with its declared code still relinks", async () => {
		publish(packages(), "amd64", "strong");
		await installGroups(groups, ["strong"], env);
		const first = state().payloadId;
		// A new image pins a new version: the old payload is stale but still runs.
		publish(packages().map((p) => ({ ...p, version: "6.0.1-6+deb13u1" })), "amd64", "strong");
		rmSync(join(env.root, "bin"), { recursive: true, force: true });
		// Still needs the installer (the refresh), but stays linked meanwhile.
		expect(activate(groups, ["strong"], env)).toEqual(["strong"]);
		expect(readlinkSync(shim("ctl"))).toBe("../groups/strong/current/bin/ctl");
		expect(state().payloadId).toBe(first);
		// A client that no longer loads is not kept.
		writeFileSync(join(env.root, "groups", "strong", first, "root", "usr", "sbin", "ctl"), '#!/bin/sh\necho "error while loading shared libraries" >&2\nexit 127\n');
		activate(groups, ["strong"], env);
		expect(existsSync(shim("ctl"))).toBe(false);
	});

	test("a declared exit code passes only with its message; exit 0 always passes", async () => {
		publish(packages({ ctl: ctl('echo "error while loading shared libraries: libreadline.so.8" >&2; exit 1') }), "amd64", "strong");
		const result = await installGroups(groups, ["strong"], env);
		expect(result.results["strong"]?.error).toContain("ctl -s /nonexistent/ctl.sock exited 1: error while loading shared libraries");
		// The message with another exit code fails too; exit 0 always passes.
		publish(packages({ ctl: ctl('echo "Unable to connect" >&2; exit 2') }), "amd64", "strong");
		expect((await installGroups(groups, ["strong"], env)).results["strong"]?.error).toContain("ctl -s /nonexistent/ctl.sock exited 2: Unable to connect");
		publish(packages({ ctl: ctl('echo "ctl 2.17.5"; exit 0') }), "amd64", "strong");
		expect((await installGroups(groups, ["strong"], env)).results["strong"]).toMatchObject({ state: "ready" });
	});

	test("every smoke test must pass, not only the first", async () => {
		publish(packages({ ctl: ctl().replace('grep -q "router id" "$2"', "exit 3") }), "amd64", "strong");
		const result = await installGroups(groups, ["strong"], env);
		expect(result.results["strong"]?.error).toContain("smoke test ctl parse {input} failed (exit 3)");
	});

	test("a missing preload library or a plugin set that does not load together keeps the payload out", async () => {
		publish(packages().map((p) => ({ ...p, files: Object.fromEntries(Object.entries(p.files).filter(([f]) => !f.endsWith("libstrongswan.so.0"))) })), "amd64", "strong");
		expect((await installGroups(groups, ["strong"], env)).results["strong"]?.error).toContain("preload library usr/lib/ipsec/libstrongswan.so.0 is not in the payload");

		publish(packages(), "amd64", "strong");
		env.canPreload = (libs) => libs.length < 3 && !libs.some((lib) => lib.endsWith("kernel-netlink.so"));
		expect((await installGroups(groups, ["strong"], env)).results["strong"]?.error).toContain("the 3 preload libraries from usr/lib/ipsec/plugins do not load together");

		env.canPreload = () => false;
		expect((await installGroups(groups, ["strong"], env)).results["strong"]?.error).toContain("no plugin in usr/lib/ipsec/plugins loads against usr/lib/ipsec/libstrongswan.so.0");
	});

	test("the default preload check asks ld.so: a library it cannot load is rejected", () => {
		expect(preloadLoads([], "")).toBe(true);
		expect(preloadLoads([join(tmp, "missing.so")], "")).toBe(false);
		writeFileSync(join(tmp, "garbage.so"), "not an ELF file");
		expect(preloadLoads([join(tmp, "garbage.so")], "")).toBe(false);
	});

	test("wrapper values are literal except {root}: quotes, dollars, backticks and backslashes survive", () => {
		const staging = join(tmp, "quoting");
		mkdirSync(join(staging, "root", "usr", "bin"), { recursive: true });
		writeFileSync(join(staging, "root", "usr", "bin", "show"), '#!/bin/sh\nprintf "%s\\n" "$WEIRD" "$PLAIN" "$EMPTY"\n');
		chmodSync(join(staging, "root", "usr", "bin", "show"), 0o755);
		const weird = `it's "$HOME" \`id\` $(echo x) \\n {root}/etc {root}`;
		layoutDebPayload("t", staging, join(tmp, "image"), [{ commands: ["show"], env: { WEIRD: weird, PLAIN: "{root}", EMPTY: "" } }]);
		const out = Bun.spawnSync([join(staging, "bin", "show")], { env: { PATH: "/usr/bin:/bin", HOME: "/home/x" } }).stdout.toString();
		const root = join(staging, "root");
		expect(out).toBe(`${weird.replaceAll("{root}", root)}\n${root}\n\n`);
		expect(() => layoutDebPayload("t", staging, join(tmp, "image"), [{ commands: ["show"], env: { "BAD-NAME": "x" } }])).toThrow("not a shell variable name");
	});

	test("a rule whose commands get no wrapper is never resolved; merged preload sets are checked together", () => {
		const staging = join(tmp, "rules");
		for (const [path, content] of Object.entries({
			"usr/bin/tool": "#!/bin/sh\necho tool\n",
			"usr/bin/ip": "#!/bin/sh\necho payload-ip\n", // the image has ip(8)
			"usr/lib/a/libbase.so.0": "elf",
			"usr/lib/a/plugins/libone.so": "elf",
			"usr/lib/b/libother.so.0": "elf",
			"usr/lib/b/plugins/libtwo.so": "elf",
		})) {
			mkdirSync(join(staging, "root", path, ".."), { recursive: true });
			writeFileSync(join(staging, "root", path), content);
			if (content.startsWith("#!")) chmodSync(join(staging, "root", path), 0o755);
		}
		const missingBase = { libraries: ["usr/lib/none/libmissing.so.0"], pluginDir: "usr/lib/none" };
		// Commands absent from the payload or provided by the image: the broken rule is skipped.
		const layout = layoutDebPayload("t", staging, join(tmp, "image"), [{ commands: ["absent", "ip"], preload: missingBase }], () => true);
		expect(layout.commands).toEqual(["tool"]);
		expect(layout.skippedCommands).toEqual(["ip"]);
		expect(layout.wired).toBeUndefined();
		// The same rule on a wrapped command still fails loudly.
		expect(() => layoutDebPayload("t", staging, join(tmp, "image"), [{ commands: ["tool"], preload: missingBase }], () => true)).toThrow("is not in the payload");
		// Two rules that each load alone, but not together.
		const rules = [
			{ commands: ["tool"], preload: { libraries: ["usr/lib/a/libbase.so.0"], pluginDir: "usr/lib/a/plugins" } },
			{ commands: ["tool"], preload: { libraries: ["usr/lib/b/libother.so.0"], pluginDir: "usr/lib/b/plugins" } },
		];
		const apart = (libs: readonly string[]) => !(libs.some((l) => /base|one/.test(l)) && libs.some((l) => /other|two/.test(l)));
		expect(() => layoutDebPayload("t", staging, join(tmp, "image"), rules, apart)).toThrow("tool: its 4 merged preload libraries do not load together");
		expect(layoutDebPayload("t", staging, join(tmp, "image"), rules, () => true).wired?.["tool"]?.preload).toEqual([
			"usr/lib/a/libbase.so.0",
			"usr/lib/a/plugins/libone.so",
			"usr/lib/b/libother.so.0",
			"usr/lib/b/plugins/libtwo.so",
		]);
	});

	test("wrappers set extra variables and preloads after the library path, sorted, for their own process", () => {
		const script = wrapperScript("vpn", "root/usr/bin/pki", ["usr/lib/ipsec"], {
			env: { STRONGSWAN_CONF: "{root}/etc/strongswan.conf", A_FIRST: "x" },
			preload: ["usr/lib/ipsec/libstrongswan.so.0"],
		});
		const lines = script.split("\n");
		const at = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix));
		expect(at("LD_LIBRARY_PATH=")).toBeLessThan(at("[ -n \"${A_FIRST+x}\" ]"));
		expect(at("[ -n \"${A_FIRST+x}\" ] || A_FIRST=")).toBeLessThan(at("[ -n \"${STRONGSWAN_CONF+x}\" ]"));
		expect(script).toContain(`[ -n "\${STRONGSWAN_CONF+x}" ] || STRONGSWAN_CONF="$p/root"'/etc/strongswan.conf'\nexport STRONGSWAN_CONF`);
		expect(script).toContain(`LD_PRELOAD="libstrongswan.so.0\${LD_PRELOAD:+:$LD_PRELOAD}"\nexport LD_PRELOAD`);
		expect(wrapperScript("vpn", "root/usr/bin/wg", ["usr/lib/ipsec"])).not.toContain("LD_PRELOAD");
		// Leading arguments go before the caller's, so a repeated option from the caller wins.
		expect(wrapperScript("routing", "root/usr/sbin/arp-scan", [], { args: ["--ouifile={root}/x y.txt"] })).toContain(
			`exec "$p/root/usr/sbin/arp-scan" '--ouifile='"$p/root"'/x y.txt' "$@"`,
		);
	});

	test("a payload under a path with a space still preloads and runs; ':' in the path is refused", async () => {
		env.root = join(tmp, "home with space", ".local/share/t3code-tools");
		env.canPreload = (libs, libraryPath) => !libs.some((l) => l.includes(" ") || l.includes("/")) && libraryPath.includes("home with space") && !libs.some((l) => l.endsWith("kernel-netlink.so"));
		publish(packages(), "amd64", "strong");
		expect((await installGroups(groups, ["strong"], env)).results["strong"]).toMatchObject({ state: "ready" });
		expect(Bun.spawnSync([shim("pki"), "--gen"], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString()).toContain("BEGIN PRIVATE KEY");
		const staging = join(tmp, "a:b");
		mkdirSync(join(staging, "root", "usr", "lib"), { recursive: true });
		writeFileSync(join(staging, "root", "usr", "lib", "libx.so.1"), "elf");
		expect(() => layoutDebPayload("t", staging, join(tmp, "image"))).toThrow("LD_LIBRARY_PATH cannot carry");
	});

	test("wrapper rules are part of a payload's id; groups without rules keep theirs", async () => {
		publish(packages(), "amd64", "strong");
		const before = desiredPayload(strong, env);
		const changed = desiredPayload({ ...strong, wrappers: [{ commands: ["pki"], env: { STRONGSWAN_CONF: "{root}/etc/other.conf" } }] }, env);
		const none = desiredPayload({ ...strong, wrappers: [] }, env);
		const plain = desiredPayload({ ...strong, wrappers: undefined }, env);
		if ("error" in before || "error" in changed || "error" in none || "error" in plain) throw new Error("no desired payload");
		expect(changed.id).not.toBe(before.id);
		expect(none.id).toBe(plain.id);
		expect(none.id).not.toBe(before.id);
	});
});

describe("vpn and routing group definitions", () => {
	const vpn = GROUPS.find((g) => g.name === "vpn");
	const routing = GROUPS.find((g) => g.name === "routing");
	if (!vpn || !routing) throw new Error("vpn or routing group missing");

	test("both are Debian payloads with probes for every special command and a functional smoke test", () => {
		for (const group of [vpn, routing]) {
			expect(group.delivery).toBe("deb");
			expect(group.smoke?.length).toBeGreaterThan(0);
			const commands = group.checks.filter((c) => c.kind === "command").map((c) => c.name);
			for (const bin of Object.keys(group.versionArgs ?? {})) expect(commands).toContain(bin);
			for (const bin of Object.keys(group.versionExit ?? {})) expect(commands).toContain(bin);
			for (const smoke of group.smoke ?? []) expect(commands).toContain(smoke.command);
		}
		// strongSwan's pki and swanctl get the payload's config and plugins.
		const rule = vpn.wrappers?.[0];
		expect(rule?.commands).toEqual(expect.arrayContaining(["pki", "swanctl"]));
		expect(rule?.env?.["STRONGSWAN_CONF"]).toBe("{root}/etc/strongswan.conf");
		expect(rule?.preload).toEqual({ libraries: ["usr/lib/ipsec/libstrongswan.so.0"], pluginDir: "usr/lib/ipsec/plugins" });
		expect(vpn.smoke?.map((s) => s.command)).toEqual(["pki", "wg"]);
		expect(routing.smoke?.find((s) => s.command === "bird")?.inputBase64).toBe(Buffer.from(BIRD_BGP_CONF).toString("base64"));
	});

	test("PPP-based peers left vpn for the lab guest: pppd needs root and /usr/sbin/pppd", () => {
		for (const pkg of ["ppp", "xl2tpd", "pppoe", "sstp-client"]) {
			expect(vpn.packages).not.toContain(pkg);
			expect(NETWORK_PACKAGE_ASSIGNMENT[pkg]).toBe("lab-guest");
		}
		for (const bin of ["pppd", "xl2tpd", "sstpc", "pppoe-discovery"]) expect(vpn.checks.map((c) => c.name)).not.toContain(bin);
		for (const group of [vpn, routing]) {
			for (const pkg of group.packages) expect(NETWORK_PACKAGE_ASSIGNMENT[pkg]).toBe(group.name);
		}
	});
});

describe("labs: QEMU wrappers, pruned firmware, payload file checks, image Bun globals", () => {
	// A QEMU-like payload: data dirs only through -L, a firmware dir with
	// variants the group prunes, and quickchr from the image's Bun globals.
	const lab: GroupDef = {
		name: "lab",
		summary: "test",
		delivery: "deb",
		packages: ["qemu-fake", "efi-fake"],
		checks: [
			{ kind: "command", name: "quickchr" },
			{ kind: "command", name: "qemu-system-x86_64" },
			{ kind: "file", name: "usr/share/AAVMF/AAVMF_CODE.fd" },
			{ kind: "file", name: "usr/share/seabios/bios-256k.bin" },
		],
		privileges: "None.",
		wrappers: [
			{
				commands: ["qemu-system-x86_64", "qemu-system-i386"],
				env: { QEMU_MODULE_DIR: "{root}/usr/lib/x86_64-linux-gnu/qemu" },
				args: ["-L", "{root}/usr/share/qemu", "-L", "{root}/usr/share/seabios"],
			},
		],
		prune: ["usr/share/AAVMF/AAVMF_CODE.secboot.fd", "usr/share/AAVMF/AAVMF_CODE.ms.fd", "usr/share/qemu/firmware", "usr/share/not/in/this/build"],
		smoke: [{ command: "qemu-system-x86_64", args: ["-M", "pc"], expect: "No bootable device" }],
	};
	// Fails like Debian's QEMU without -L: its BIOS is only found in a -L dir.
	const qemu = `#!/bin/sh
case "$1" in --version) echo "QEMU emulator version 10.0.13 (fake)"; exit 0 ;; esac
bios=""
while [ $# -gt 0 ]; do
	case "$1" in -L) [ -e "$2/bios-256k.bin" ] && bios="$2/bios-256k.bin"; shift 2 ;; args) shift; echo "ARGS $*"; echo "MOD=$QEMU_MODULE_DIR"; exit 0 ;; *) shift ;; esac
done
[ -n "$bios" ] || { echo "qemu: could not load PC BIOS 'bios-256k.bin'" >&2; exit 1; }
echo "SeaBIOS from $bios"; echo "No bootable device."
`;
	const packages = (over: { secboot?: boolean; code?: boolean } = {}): FakePkg[] => [
		{ name: "qemu-fake", version: "1:10.0.13+ds-0+deb13u1", files: { "usr/bin/qemu-system-x86_64": qemu, "usr/bin/qemu-img": tool("qemu-img") } },
		{
			name: "efi-fake",
			version: "2025.02-8+deb13u1",
			files: {
				"usr/share/seabios/bios-256k.bin": "bios",
				...(over.code === false ? {} : { "usr/share/AAVMF/AAVMF_CODE.fd": "code" }),
				"usr/share/AAVMF/AAVMF_VARS.fd": "vars",
				...(over.secboot === false ? {} : { "usr/share/AAVMF/AAVMF_CODE.secboot.fd": "x".repeat(4096), "usr/share/AAVMF/AAVMF_CODE.ms.fd": "y".repeat(100) }),
				"usr/share/qemu/firmware/50-edk2-aarch64-secure.json": "{}",
				"usr/share/qemu/keymaps/en-us": "keys",
			},
		},
	];
	const imageQuickchr = () => {
		mkdirSync(join(tmp, "image", "opt", "bun", "bin"), { recursive: true });
		writeFileSync(join(tmp, "image", "opt", "bun", "bin", "quickchr"), '#!/bin/sh\necho "quickchr 0.5.6 (image)"\n');
		chmodSync(join(tmp, "image", "opt", "bun", "bin", "quickchr"), 0o755);
	};
	const labState = () => groupStatus(lab, true, nothing, payloadInfo(lab, env));

	test("installs: firmware pruned before layout, files checked in the payload, quickchr from the image's Bun globals", async () => {
		imageQuickchr();
		publish(packages(), "amd64", "lab");
		const result = await installGroups([lab], ["lab"], env);
		expect(result.results["lab"]).toMatchObject({ state: "ready", attempt: 1 });
		const manifest = JSON.parse(readFileSync(join(env.root, "groups", "lab", "current", "manifest.json"), "utf8")) as Manifest;
		const root = join(env.root, "groups", "lab", manifest.payloadId, "root");
		// Absent prune paths are skipped; a directory goes with its contents.
		expect(manifest.deb?.pruned).toEqual(["usr/share/AAVMF/AAVMF_CODE.secboot.fd", "usr/share/AAVMF/AAVMF_CODE.ms.fd", "usr/share/qemu/firmware"]);
		expect(manifest.deb?.prunedBytes).toBe(4096 + 100 + 2);
		expect(existsSync(join(root, "usr/share/AAVMF/AAVMF_CODE.secboot.fd"))).toBe(false);
		expect(existsSync(join(root, "usr/share/qemu/keymaps/en-us"))).toBe(true);
		expect(manifest.versions["quickchr"]).toBe("quickchr 0.5.6 (image)");
		expect(manifest.deb?.wired).toEqual({ "qemu-system-x86_64": { env: ["QEMU_MODULE_DIR"], args: ["-L", "{root}/usr/share/qemu", "-L", "{root}/usr/share/seabios"], preload: [] } });
		// The wrapper's -L dirs come first, then the caller's arguments.
		const out = Bun.spawnSync([shim("qemu-system-x86_64"), "args", "-M", "virt"], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();
		expect(out).toContain(`ARGS -M virt\nMOD=${root}/usr/lib/x86_64-linux-gnu/qemu\n`);
		expect(Bun.spawnSync([shim("qemu-system-x86_64")], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString()).toContain(`SeaBIOS from ${root}/usr/share/seabios/bios-256k.bin`);
		// Status: file checks resolve through the current link; quickchr through the image.
		const status = labState();
		expect(status).toMatchObject({ state: "ready", present: true, missing: [] });
		expect(status?.payload?.filePaths).toEqual({
			"usr/share/AAVMF/AAVMF_CODE.fd": join(env.root, "groups", "lab", "current", "root", "usr/share/AAVMF/AAVMF_CODE.fd"),
			"usr/share/seabios/bios-256k.bin": join(env.root, "groups", "lab", "current", "root", "usr/share/seabios/bios-256k.bin"),
		});
		expect(status?.payload?.commandPaths["quickchr"]).toBe(join(tmp, "image", "opt", "bun", "bin", "quickchr"));
		expect(existsSync(shim("quickchr"))).toBe(false);
		// A required file that disappears takes the payload out on the next start.
		rmSync(join(root, "usr/share/AAVMF/AAVMF_CODE.fd"));
		expect(activate([lab], ["lab"], env)).toEqual(["lab"]);
		expect(existsSync(shim("qemu-system-x86_64"))).toBe(false);
		expect(labState()?.state).not.toBe("ready");
	});

	test("a payload without a required firmware file never activates", async () => {
		imageQuickchr();
		publish(packages({ code: false }), "amd64", "lab");
		const result = await installGroups([lab], ["lab"], env);
		expect(result.results["lab"]?.state).toBe("failed");
		expect(result.results["lab"]?.error).toContain("the payload lacks usr/share/AAVMF/AAVMF_CODE.fd");
	});

	test("without quickchr in the image the group is not ready", async () => {
		publish(packages(), "amd64", "lab");
		const result = await installGroups([lab], ["lab"], env);
		expect(result.results["lab"]?.error).toContain("neither the payload nor the image provides quickchr");
	});

	test("the prune list is part of the payload id; prune paths must stay inside the root", () => {
		publish(packages(), "amd64", "lab");
		const before = desiredPayload(lab, env);
		const changed = desiredPayload({ ...lab, prune: ["usr/share/AAVMF/AAVMF_CODE.secboot.fd"] }, env);
		const none = desiredPayload({ ...lab, prune: [] }, env);
		const plain = desiredPayload({ ...lab, prune: undefined }, env);
		if ("error" in before || "error" in changed || "error" in none || "error" in plain) throw new Error("no desired payload");
		expect(changed.id).not.toBe(before.id);
		expect(none.id).toBe(plain.id);
		const root = join(tmp, "prune-root");
		mkdirSync(root, { recursive: true });
		for (const bad of ["../etc/passwd", "/etc/passwd", "usr/../../x", "usr//share", "", "./usr"]) {
			expect(() => pruneExtracted(root, [bad])).toThrow("must be a normalized path inside the payload root");
		}
		expect(pruneExtracted(root, ["usr/missing"])).toEqual({ pruned: [], prunedBytes: 0 });
		// A directory link leading out of the payload is not followed for the delete.
		const outside = join(tmp, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep"), "x");
		symlinkSync(outside, join(root, "usr-link"));
		expect(() => pruneExtracted(root, ["usr-link/keep"])).toThrow("resolves outside the payload root");
		expect(existsSync(join(outside, "keep"))).toBe(true);
		// The link itself may go: only its target is protected.
		expect(pruneExtracted(root, ["usr-link"]).pruned).toEqual(["usr-link"]);
		expect(existsSync(join(outside, "keep"))).toBe(true);
	});

	test("the real labs group: QEMU emulators get the -L dirs, unused firmware is pruned, smoke tests boot firmware", () => {
		const labs = GROUPS.find((g) => g.name === "labs");
		if (!labs) throw new Error("labs group missing");
		expect(labs.delivery).toBe("deb");
		const commands = labs.checks.filter((c) => c.kind === "command").map((c) => c.name);
		const files = labs.checks.filter((c) => c.kind === "file").map((c) => c.name);
		expect(commands).toEqual(["quickchr", "qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"]);
		// The pair quickchr picks on Debian, and the x86 BIOS and NIC ROM QEMU loads.
		expect(files).toEqual(["usr/share/AAVMF/AAVMF_CODE.fd", "usr/share/AAVMF/AAVMF_VARS.fd", "usr/share/seabios/bios-256k.bin", "usr/share/qemu/efi-virtio.rom"]);
		for (const file of files) expect(labs.prune).not.toContain(file);
		expect(labs.prune).not.toContain("usr/share/AAVMF/AAVMF_CODE.no-secboot.fd");
		const rule = labs.wrappers?.[0];
		expect(rule?.commands).toEqual(QEMU_SYSTEM_COMMANDS);
		expect(rule?.commands).not.toContain("qemu-img");
		expect(rule?.args).toEqual(["-L", "{root}/usr/share/qemu", "-L", "{root}/usr/share/seabios", "-L", "{root}/usr/lib/ipxe/qemu"]);
		expect(rule?.env?.["QEMU_MODULE_DIR"]).toMatch(/^\{root\}\/usr\/lib\/(x86_64|aarch64)-linux-gnu\/qemu$/);
		for (const smoke of labs.smoke ?? []) expect(commands).toContain(smoke.command);
		// mov w0, #0x84000008 (PSCI SYSTEM_OFF); hvc #0; b .
		const words = Buffer.from(AARCH64_PSCI_OFF, "base64");
		expect([0, 4, 8, 12].map((at) => words.readUInt32LE(at).toString(16))).toEqual(["52800100", "72b08000", "d4000002", "14000000"]);
	});
});
