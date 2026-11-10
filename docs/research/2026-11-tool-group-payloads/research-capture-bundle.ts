// Issue #5 slice 3: measure the capture native-bundle spike in disposable
// containers and save the transcript plus parsed key=value measurements.
// Never touches a router. The probe itself is research-capture-bundle.sh.
//
//   bun docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts <image> <platform> <out-prefix>
//   bun docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts --sizes <image> <out-prefix>
//
// --sizes runs research-bake-sizes.sh instead: closure sizes for vpn, routing
// and capture subsets, and the gzip size of a baked layer for vpn and routing.
//
//   bun docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts --snapshot <debs.lock.json> <package> <cache-dir>
//
// --snapshot fetches one pinned package through fetchDeb() with its mirror URL
// forced to a 404, so only snapshot.debian.org can supply it (SHA256-checked).
//
// amd64 (habitat C): image = an image with the app's apt layers (for example
// the overlay of the late Dockerfile layers on app-t3code:agent-tools).
// arm64: node:24-trixie-slim under QEMU user-mode emulation (binfmt); the
// probe adds curl/ca-certificates/iproute2 and a node-owned /data first, so its
// closure is larger than the app image's.
import { type DebLock, fetchDeb } from "../../../lib/deb-payloads.ts";
import { TZSP_DNS_PCAPNG } from "../../../lib/tool-catalog.ts";

if (process.argv[2] === "--snapshot") {
	const [lockPath, name = "tcpdump", cache = "snapshot-cache"] = process.argv.slice(3);
	const lock = (await Bun.file(lockPath as string).json()) as DebLock;
	const pkg = lock.packages.find((p) => p.name === name);
	if (!pkg) throw new Error(`${name} is not in ${lockPath}`);
	const forced = { ...pkg, uris: [`https://deb.debian.org/debian/pool/main/${name[0]}/${name}/does-not-exist.deb`] };
	const t = Date.now();
	const log: string[] = [];
	const result = await fetchDeb(forced, cache, { fetch: (u, i) => fetch(u, i), dpkgDeb: [], snapshotBase: "https://snapshot.debian.org", imageRoot: "/", log: (l) => log.push(l) });
	console.log(JSON.stringify({ habitat: "C (orca)", at: new Date().toISOString(), name, version: pkg.version, pinnedSha256: pkg.sha256, source: result.source, ms: Date.now() - t, log }));
	process.exit(0);
}

const sizes = process.argv[2] === "--sizes";
const args = process.argv.slice(sizes ? 3 : 2);
const [image, platform, out] = sizes ? [args[0], "linux/amd64", args[1] ?? "bake-sizes"] : [args[0], args[1] ?? "linux/amd64", args[2] ?? "capture-bundle"];
if (!image) {
	console.error("usage: bun docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts <image> <platform> <out-prefix>");
	process.exit(2);
}
const probe = new URL(sizes ? "./research-bake-sizes.sh" : "./research-capture-bundle.sh", import.meta.url).pathname;
const started = Date.now();
const proc = Bun.spawnSync(
	["docker", "run", "--rm", "--platform", platform, "--user", "root", "-v", `${probe}:/probe.sh:ro`, "--entrypoint", "bash", image, "/probe.sh", TZSP_DNS_PCAPNG],
	{ stdout: "pipe", stderr: "pipe" },
);
const text = `${proc.stdout.toString()}${proc.stderr.toString()}`;
await Bun.write(`${out}.txt`, text);
const measurements: Record<string, string> = {};
for (const line of text.split("\n")) {
	if (line.startsWith("## ")) break;
	// --sizes lines start with a label: "vpn packages=20 …", "vpn bake files_bytes=…".
	const words = line.split(" ");
	const label = sizes ? words.filter((w) => !w.includes("=")).join("_") : "";
	for (const pair of words) {
		const i = pair.indexOf("=");
		if (i > 0) measurements[`${label ? `${label}_` : ""}${pair.slice(0, i)}`] = pair.slice(i + 1);
	}
}
const inspect = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", image]).stdout.toString().trim();
const result = { generatedAt: new Date().toISOString(), habitat: "C (orca)", image, imageId: inspect, platform, exitCode: proc.exitCode, wallSeconds: (Date.now() - started) / 1000, measurements };
await Bun.write(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(proc.exitCode ?? 1);
