import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Run inside the image at build time, or inspect an existing local image with
// --image. Always bypass the entrypoint: it installs tools into the home volume.
const commands = `sh bash dash awk sed grep find xargs sort uniq cut tr head tail
wc tee env timeout tar gzip bzip2 xz zstd zip unzip curl wget git ssh scp sftp
jq rg less ps top free pgrep pkill make patch diff file strings readelf
ip ss ping dig nslookup nc socat rsync tree time which xxd hexdump
bridge tc arping traceroute tracepath mtr iperf3 ethtool whois
tcpdump tshark dumpcap capinfos editcap mergecap text2pcap
swanctl pki wg conntrack nft snmpget snmpwalk snmptranslate radtest radclient nmap
nfcapd nfdump openvpn sstpc pppd xl2tpd pppoe-discovery ike-scan bird birdc lldpd lldpcli
rdisc6 ndisc6 arp-scan mosquitto_pub mosquitto_sub fc-list t3app
tsc tsserver cspell markdownlint-cli2 biome
openssl gpg sudo locale python python3 pip pip3 pipx uv uvx node npm npx
corepack yarn pnpm bun bunx gcc g++ cc c++ ld ar pkg-config cmake ninja
autoconf automake libtool shellcheck shfmt sqlite3 zstd gh git-lfs yq
docker podman kubectl go rustc cargo ruby java dotnet
qemu-system-x86_64 qemu-system-aarch64 qemu-img quickchr centrs
t3 codex opencode muse claude`.split(/\s+/).sort();

function run(argv: string[]) {
	const result = Bun.spawnSync(argv, {
		env: { ...process.env, LC_ALL: "C", NO_COLOR: "1" },
		timeout: 15_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(`${argv[0]} failed (${result.exitCode}): ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trimEnd();
}

export function readDebianPackages() {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query field syntax, passed without a shell.
	const format = "${db:Status-Status}\t${binary:Package}\t${Version}\t${Architecture}\t${Installed-Size}\n";
	return run(["dpkg-query", "-W", `-f=${format}`]).split("\n")
		.filter((line) => line.startsWith("installed\t"))
		.map((line) => {
			const [, name, version, architecture, size] = line.split("\t");
			return { name: name as string, version: version as string,
				architecture: architecture as string, installedSizeKiB: Number(size) };
		}).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export async function collect() {
	const packages = readDebianPackages();
	const paths = run(["bash", "--noprofile", "--norc", "-c",
		'for tool in "$@"; do printf "%s\\t%s\\n" "$tool" "$(type -P "$tool" || true)"; done',
		"inventory", ...commands]).split("\n").map((line) => {
			const [command, path = ""] = line.split("\t");
			return { command: command as string, path: path || null };
		});
	const versions: Record<string, string> = {};
	for (const command of ["node", "npm", "bun", "python3", "uv", "sqlite3", "git", "gh", "jq", "rg", "t3"]) {
		versions[command] = run([command, "--version"]);
	}
	const npm = JSON.parse(run(["npm", "ls", "--global", "--prefix", "/usr/local", "--depth=0", "--json"]));
	const bun = JSON.parse(await Bun.file("/opt/bun/install/global/package.json").text());
	const bunPackages: Record<string, string> = {};
	for (const name of Object.keys(bun.dependencies ?? {}).sort()) {
		const pkg = await Bun.file(`/opt/bun/install/global/node_modules/${name}/package.json`).json();
		bunPackages[name] = pkg.version;
	}
	return { schemaVersion: 1, generatedAt: new Date().toISOString(),
		osRelease: await Bun.file("/etc/os-release").text(),
		architecture: run(["dpkg", "--print-architecture"]),
		path: process.env.PATH, packages, commands: paths, versions,
		npmPackages: npm.dependencies, bunPackages,
		notes: ["Image contents before entrypoint/first boot; provider CLIs (T3APP_PROVIDERS), browser downloads, tool-group payloads and user installs are excluded.",
			"Commands are curated executable PATH probes, not an exhaustive list or functional tests; shims can need downloads.",
			"Installed-Size is dpkg metadata in KiB, not compressed image size.",
			"npm/Bun list top-level global packages; this is not a complete dependency SBOM."] };
}

type Inventory = Awaited<ReturnType<typeof collect>> & { image?: unknown };

export async function writeInventory(inventory: Inventory, output: string) {
	await mkdir(output, { recursive: true });
	await Bun.write(`${output}/inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`);
	await Bun.write(`${output}/packages.tsv`, "package\tversion\tarchitecture\tinstalled_size_kib\n" +
		inventory.packages.map((p) => [p.name, p.version, p.architecture, p.installedSizeKiB].join("\t")).join("\n") + "\n");
	await Bun.write(`${output}/commands.tsv`, "command\tpath\n" +
		inventory.commands.map((p) => `${p.command}\t${p.path ?? "MISSING"}`).join("\n") + "\n");
	await Bun.write(`${output}/README.md`, `# Built image inventory\n\n` +
		`Generated ${inventory.generatedAt}; architecture: ${inventory.architecture}.\n\n` +
		`${inventory.packages.length} installed Debian packages; ` +
		`${inventory.commands.filter((p) => p.path).length}/${inventory.commands.length} curated commands found on PATH.\n\n` +
		"- `inventory.json`: OS, package versions/sizes, PATH probes, runtime versions, global npm/Bun packages.\n" +
		"- `packages.tsv`: full installed Debian package list, including dependencies.\n" +
		"- `commands.tsv`: curated command availability; MISSING is explicit.\n\n" +
		inventory.notes.map((note) => `${note}\n`).join("\n"));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const imageIndex = args.indexOf("--image");
	const outputIndex = args.indexOf("--output");
	const output = outputIndex < 0 ? "image-inventory" : args[outputIndex + 1];
	if (!output) throw new Error("--output requires a directory");
	let inventory: Inventory;
	if (imageIndex >= 0) {
		const image = args[imageIndex + 1];
		if (!image || image.startsWith("--")) throw new Error("--image requires a local image reference");
		const script = resolve(import.meta.path);
		inventory = JSON.parse(run(["docker", "run", "--rm", "--network", "none", "--read-only",
			"--mount", `type=bind,src=${script},dst=/tmp/image-inventory.ts,readonly`,
			"--entrypoint", "bun", image, "/tmp/image-inventory.ts", "--stdout"]));
		const metadata = JSON.parse(run(["docker", "image", "inspect", image]))[0];
		inventory.image = { reference: image, id: metadata.Id, repoDigests: metadata.RepoDigests,
			created: metadata.Created, architecture: metadata.Architecture, sizeBytes: metadata.Size };
	} else {
		inventory = await collect();
	}
	if (args.includes("--stdout")) console.log(JSON.stringify(inventory));
	else await writeInventory(inventory, output);
}
