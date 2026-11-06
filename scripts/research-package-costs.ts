// Research helper: run as root in a disposable copy of the baseline image.
// Refreshes apt indexes and simulates installs; never installs packages.
const candidates = ["patch", "file", "bzip2", "xz-utils", "zip", "zstd", "wget",
	"rsync", "tree", "time", "python-is-python3", "iproute2", "iputils-ping",
	"bind9-dnsutils", "netcat-openbsd", "socat", "sqlite3", "xxd", "bsdextrautils",
	"shellcheck", "shfmt", "gh", "git-lfs", "gnupg", "sudo", "locales",
	"python3-venv", "python3-pip", "pipx", "build-essential", "pkg-config",
	"cmake", "ninja-build", "autoconf", "automake", "libtool", "yq",
	"tcpdump", "tshark", "wireshark-common", "strongswan-swanctl", "strongswan-pki", "strongswan-charon",
	"ike-scan", "wireguard-tools", "traceroute", "mtr-tiny", "iperf3", "ethtool", "whois",
	"conntrack", "nftables", "snmp", "freeradius-utils", "nmap"];
const bundles: Record<string, string[]> = {
	"small-baseline": ["patch", "file", "bzip2", "xz-utils", "zip", "zstd", "wget", "rsync", "tree", "time", "python-is-python3"],
	"network-tools": ["iproute2", "iputils-ping", "bind9-dnsutils", "netcat-openbsd", "socat"],
	"inspection-lint": ["sqlite3", "xxd", "bsdextrautils", "shellcheck", "shfmt"],
	"native-build": ["build-essential", "pkg-config"],
	"python-environments": ["python3-venv"],
	"recommended-baseline": ["patch", "file", "bzip2", "xz-utils", "zip", "zstd", "wget", "rsync", "tree", "time", "python-is-python3",
		"iproute2", "iputils-ping", "bind9-dnsutils", "netcat-openbsd", "socat", "python3-venv", "sqlite3", "xxd", "bsdextrautils"],
	"network-extension": ["tcpdump", "tshark", "traceroute", "mtr-tiny", "iperf3", "ethtool", "whois", "wireguard-tools", "strongswan-swanctl", "strongswan-pki",
		"strongswan-charon", "conntrack", "nftables", "snmp", "freeradius-utils"],
	"routeros-network-baseline": ["patch", "file", "bzip2", "xz-utils", "zip", "zstd", "wget", "rsync", "tree", "time", "python-is-python3",
		"iproute2", "iputils-ping", "bind9-dnsutils", "netcat-openbsd", "socat", "python3-venv", "sqlite3", "xxd", "bsdextrautils",
		"tcpdump", "tshark", "traceroute", "mtr-tiny", "iperf3", "ethtool", "whois", "wireguard-tools", "strongswan-swanctl", "strongswan-pki",
		"strongswan-charon", "conntrack", "nftables", "snmp", "freeradius-utils"],
	"ipsec-peer": ["strongswan-swanctl", "strongswan-pki", "strongswan-charon"],
};

function run(args: string[]) {
	const p = Bun.spawnSync(args, { env: { ...process.env, LC_ALL: "C" } });
	if (p.exitCode) throw new Error(`${args.join(" ")}: ${p.stderr}`);
	return p.stdout.toString();
}

if (import.meta.main) {
	const updated = run(["apt-get", "update"]);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query field syntax, passed without a shell.
	const installed = new Map(run(["dpkg-query", "-W", "-f=${binary:Package}\t${Installed-Size}\n"])
		.trim().split("\n").map((line) => { const [name, size] = line.split("\t"); return [name as string, Number(size)]; }));
	const metadata = new Map<string, { installedSizeKiB: number; downloadBytes: number }>();
	function sizes(name: string, version: string) {
		const key = `${name}=${version}`;
		let value = metadata.get(key);
		if (!value) {
			const raw = run(["apt-cache", "show", key]);
			value = { installedSizeKiB: Number(raw.match(/^Installed-Size: (\d+)/m)?.[1]),
				downloadBytes: Number(raw.match(/^Size: (\d+)/m)?.[1]) };
			if (!Number.isFinite(value.installedSizeKiB) || !Number.isFinite(value.downloadBytes)) throw new Error(`No sizes for ${key}`);
			metadata.set(key, value);
		}
		return value;
	}
	const measurements = [];
	for (const [label, packages] of [...candidates.map((p): [string, string[]] => [p, [p]]), ...Object.entries(bundles)]) {
		if (process.argv[2] && !process.argv.slice(2).includes(label)) continue;
		const simulation = run(["apt-get", "--simulate", "--no-install-recommends", "install", ...packages]);
		const changes = [...simulation.matchAll(/^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)/gm)].map((match) => {
			const [, name, previousVersion, version] = match;
			const size = sizes(name as string, version as string);
			return { name, version, previousVersion: previousVersion ?? null, ...size,
				installedDeltaKiB: size.installedSizeKiB - (installed.get(name as string) ?? installed.get(`${name}:amd64`) ?? 0) };
		});
		measurements.push({ label, packages, downloadBytes: changes.reduce((sum, p) => sum + p.downloadBytes, 0),
			installedDeltaKiB: changes.reduce((sum, p) => sum + p.installedDeltaKiB, 0), changes, simulation });
	}
	console.log(JSON.stringify({ generatedAt: new Date().toISOString(), architecture: run(["dpkg", "--print-architecture"]).trim(),
		method: "apt-get --simulate --no-install-recommends; candidate metadata Size and Installed-Size; subtract installed sizes for upgrades. Indexes refreshed, no packages installed. Independent scenarios from the same image, not additive. These are apt estimates, not measured OCI layers.",
		aptSources: run(["sh", "-c", "cat /etc/apt/sources.list.d/*"]), aptUpdate: updated, measurements }, null, 2));
}
