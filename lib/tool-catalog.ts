// The tool groups this image offers (T3APP_TOOL_GROUPS): their definitions,
// smoke fixtures, the core every selection gets, where each researched
// network package lives, and how a selection string is parsed. Data and pure
// functions only; tool-status.ts reports on it, tool-payloads.ts installs it,
// and tool-groups.ts is the CLI. Issue #5 built the groups slice by slice.
//
// Never throw on operator input: an unknown or malformed selection is a
// warning, and T3 must always start.
import { join } from "node:path";
import type { WrapperRule } from "./deb-payloads.ts";

export const SELECTOR_ENV = "T3APP_TOOL_GROUPS";
/** Payload specs: <dir>/<group>/package{,-lock}.json (npm) or debs.lock.json (deb, generated at build time). */
export const PAYLOAD_SPEC_DIR = join(import.meta.dir, "groups");

/**
 * How a group's tools reach the container.
 * - `npm`: a persistent payload under the home, installed in the background
 *   from a lockfile shipped in the image (tool-payloads.ts).
 * - `deb`: a persistent payload of Debian packages under the home, pinned
 *   from the image's apt metadata at build time (deb-payloads.ts).
 * - `none`: no installer exists in this image yet (later slices).
 */
export type Delivery = "npm" | "deb" | "none";

/** A presence probe. In a deb group, a `file` check is a path relative to the payload's extracted root. */
export type Check = { kind: "command"; name: string } | { kind: "file"; name: string } | { kind: "library"; name: string };

export interface GroupDef {
	name: string;
	summary: string;
	delivery: Delivery;
	/** Debian packages the group will own (dependencies come along). */
	packages: readonly string[];
	/** npm packages the group will own. */
	npm?: readonly string[];
	/** What must exist for the group to be ready. Presence probes, not functional tests. */
	checks: readonly Check[];
	/** Runtime privilege the tools need beyond installation (see routeros-protocol-map.md). */
	privileges: string;
	/** Installed payload size, for the installer's disk budget (npm delivery). */
	approxBytes?: number;
	/** Payload groups: arguments that print a version and exit 0 (default `--version`). */
	versionArgs?: Readonly<Record<string, readonly string[]>>;
	/**
	 * Payload groups: a non-zero exit that also passes a command's probe when
	 * the output contains `expect`, for commands that cannot exit 0 without a
	 * daemon (birdc) or a kernel feature (nft and conntrack open a netfilter
	 * netlink socket even for --version). The message comes from the tool's own code, so it
	 * still proves the binary and its libraries load. Exit 0 always passes.
	 */
	versionExit?: Readonly<Record<string, { code: number; expect: string }>>;
	/** Payload groups: functional checks run before the payload is trusted. */
	smoke?: readonly Smoke[];
	/** deb groups: extra wrapper wiring for tools that only know compiled-in paths. */
	wrappers?: readonly WrapperRule[];
	/**
	 * deb groups: paths (relative to the extracted root) removed before the
	 * payload is laid out, for large files the group never uses. Part of the
	 * payload id, like `wrappers`.
	 */
	prune?: readonly string[];
	note?: string;
}

/** One functional check: `{input}` in args (alone or inside one, as in `--file={input}`) is a file holding inputBase64; the output must contain `expect` and the exit code be 0. */
export interface Smoke {
	command: string;
	args: readonly string[];
	inputBase64?: string;
	expect: string;
}

/**
 * A pcapng with one Ethernet/IPv4/UDP TZSP frame (RouterOS sniffer stream)
 * carrying an Ethernet/IPv4/UDP DNS query for routeros.example. Synthetic,
 * from docs/research/2026-11-agent-tools/packet-tools-probe.json.
 */
export const TZSP_DNS_PCAPNG =
	"Cg0NChwAAABNPCsaAQAAAP//////////HAAAAAEAAAAUAAAAAQAAAP//AAAUAAAABgAAAJwAAAAAAAAAAAAAAEBCDwB7AAAAewAAAAIAAAAAAgIAAAAAAQgARQAAbQAAAABAEfZ8wAACAcAAAgKn+JCQAFkAAAEAAAEBAgAAAAACAgAAAAABCABFAAA+AAAAAEAR9qvAAAIBwAACAjA5ADUAKgAAEjQBAAABAAAAAAAACHJvdXRlcm9zB2V4YW1wbGUAAAEAAQCcAAAA";

/** A BGP peer of a RouterOS router, parsed (not run) by the routing group's smoke test. */
export const BIRD_BGP_CONF = `router id 192.0.2.1;
protocol device {}
protocol bgp routeros {
	local as 65001;
	neighbor 192.0.2.2 as 65002;
	ipv4 { import all; export none; };
}
`;

/**
 * A pcap with one ARP reply from 192.0.2.1 at 4c:5e:0c:11:22:33 (a MikroTik
 * OUI), for `arp-scan --readpktfromfile`, which decodes it without sending
 * anything or opening an interface.
 */
export const ARP_REPLY_PCAP =
	"1MOyoQIABAAAAAAAAAAAAP//AAABAAAAAAAAAAAAAAA8AAAAPAAAAAIAAAAAAUxeDBEiMwgGAAEIAAYEAAJMXgwRIjPAAAIBAgAAAAABwAACAgAAAAAAAAAAAAAAAAAAAAAAAA==";

/**
 * A 16-byte aarch64 program for `qemu-system-aarch64 -M virt -kernel`: PSCI
 * SYSTEM_OFF over HVC (`mov w0, #0x84000008; hvc #0`), so with `-no-reboot`
 * QEMU powers off and exits 0 at once. Without firmware, QEMU's own PSCI
 * handles the call; a kernel that hangs instead fails the smoke test on
 * its timeout.
 */
export const AARCH64_PSCI_OFF = Buffer.from([0x00, 0x01, 0x80, 0x52, 0x00, 0x80, 0xb0, 0x72, 0x02, 0x00, 0x00, 0xd4, 0x00, 0x00, 0x00, 0x14]).toString("base64");

/** QEMU system emulators in Debian's qemu-system-x86 and qemu-system-arm, including their alias names (`kvm` links to qemu-system-x86_64). */
export const QEMU_SYSTEM_COMMANDS = [
	"kvm",
	"qemu-system-x86_64",
	"qemu-system-x86_64-microvm",
	"qemu-system-amd64",
	"qemu-system-i386",
	"qemu-system-aarch64",
	"qemu-system-arm64",
	"qemu-system-arm",
	"qemu-system-armel",
	"qemu-system-armhf",
] as const;

const cmd = (...names: string[]): Check[] => names.map((name) => ({ kind: "command", name }));

export const GROUPS: readonly GroupDef[] = [
	{
		name: "capture",
		summary: "Packet capture, decoding and flow collection",
		delivery: "deb",
		packages: ["tcpdump", "tshark", "wireshark-common", "nfdump"],
		checks: cmd("tcpdump", "tshark", "dumpcap", "capinfos", "editcap", "mergecap", "text2pcap", "nfcapd", "nfdump"),
		privileges:
			"None: offline decoding and capture-file tools, `dumpcap -D`, nfcapd on ports >=1024. CAP_NET_RAW: live capture (tcpdump -i, dumpcap/tshark -i). A TZSP stream on UDP 37008 needs no privilege to receive, but no tested receiver ships.",
		// Measured on amd64 (2026-11-06): 152 MiB unpacked from 30.5 MiB of .debs.
		approxBytes: 160 * 1024 * 1024,
		versionArgs: { nfcapd: ["-V"], nfdump: ["-V"] },
		smoke: [
			{ command: "tshark", args: ["-r", "{input}", "-T", "fields", "-e", "tzsp.encap", "-e", "dns.qry.name"], inputBase64: TZSP_DNS_PCAPNG, expect: "routeros.example" },
		],
		note: "Persistent payload of Debian packages under the home, pinned by version and SHA256 from the image's apt metadata, installed in the background as the app user and reused across container replacement. Installing it grants no capture privileges.",
	},
	{
		name: "labs",
		summary: "quickchr with QEMU emulators, qemu-img and firmware (one readiness contract)",
		delivery: "deb",
		packages: ["qemu-system-x86", "qemu-system-arm", "qemu-efi-aarch64", "qemu-utils"],
		checks: [
			// quickchr is in the image (opt/bun/bin); QEMU comes from the payload.
			...cmd("quickchr", "qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"),
			// Relative to the payload root: the firmware quickchr and QEMU load.
			{ kind: "file", name: "usr/share/AAVMF/AAVMF_CODE.fd" },
			{ kind: "file", name: "usr/share/AAVMF/AAVMF_VARS.fd" },
			{ kind: "file", name: "usr/share/seabios/bios-256k.bin" },
			{ kind: "file", name: "usr/share/qemu/efi-virtio.rom" },
		],
		privileges: "None: TCG with user-mode networking, qemu-img. /dev/kvm (readable and writable by node): acceleration. CAP_NET_ADMIN plus /dev/net/tun: creating TAP devices (or a TAP pre-created for node).",
		// Measured on amd64 (2026-11-06): 32.8 MiB of .debs, 566 MiB unpacked
		// before pruning, about 310 MiB after. See labs-qemu-payload.md.
		approxBytes: 320 * 1024 * 1024,
		// Debian's QEMU looks for its BIOS, option ROMs and keymaps only in
		// directories compiled into it. `-L` dirs are searched first (later
		// -L from the caller come after them), so the wrapper puts the
		// payload's copies in front; quickchr finds the UEFI images through
		// `qemu-system-aarch64 -L help` (tikoci/quickchr#254). Display, USB
		// and virtio-gpu modules load from QEMU_MODULE_DIR.
		wrappers: [
			{
				commands: QEMU_SYSTEM_COMMANDS,
				env: { QEMU_MODULE_DIR: "{root}/usr/lib/{multiarch}/qemu" },
				args: ["-L", "{root}/usr/share/qemu", "-L", "{root}/usr/share/seabios", "-L", "{root}/usr/lib/ipxe/qemu"],
			},
		],
		// The secure-boot AAVMF variants (64 MiB each) and the descriptors that
		// name them. quickchr boots CHR with AAVMF_CODE.fd (-> no-secboot) and
		// AAVMF_VARS.fd only.
		prune: [
			"usr/share/AAVMF/AAVMF_CODE.secboot.fd",
			"usr/share/AAVMF/AAVMF_CODE.secboot.strictnx.fd",
			"usr/share/AAVMF/AAVMF_CODE.ms.fd",
			"usr/share/AAVMF/AAVMF_CODE.snakeoil.fd",
			"usr/share/AAVMF/AAVMF_VARS.ms.fd",
			"usr/share/AAVMF/AAVMF_VARS.snakeoil.fd",
			"usr/share/qemu/firmware/40-edk2-aarch64-secure-enrolled.json",
			"usr/share/qemu/firmware/50-edk2-aarch64-secure.json",
		],
		smoke: [
			// SeaBIOS from the payload (through the wrapper's -L) boots, finds
			// nothing to boot and, with reboot-timeout=0 and -no-reboot, exits.
			{
				command: "qemu-system-x86_64",
				args: ["-M", "pc", "-accel", "tcg", "-display", "none", "-nodefaults", "-no-reboot", "-boot", "reboot-timeout=0", "-chardev", "stdio,id=d", "-device", "isa-debugcon,iobase=0x402,chardev=d"],
				expect: "No bootable device",
			},
			{
				command: "qemu-system-aarch64",
				args: ["-M", "virt", "-cpu", "cortex-a710", "-accel", "tcg", "-display", "none", "-nodefaults", "-no-reboot", "-kernel", "{input}"],
				inputBase64: AARCH64_PSCI_OFF,
				expect: "",
			},
			{ command: "qemu-img", args: ["create", "-f", "qcow2", "{input}", "16M"], expect: "Formatting" },
		],
		note: "Persistent payload of Debian packages under the home, like capture: QEMU with its firmware, behind wrappers that point it at the payload's data dirs. quickchr stays in the image and finds the payload's UEFI firmware through QEMU (tikoci/quickchr#254). Readiness boots firmware, not a CHR.",
	},
	{
		name: "vpn",
		summary: "WireGuard, strongSwan and OpenVPN peer and key tools, ike-scan (no default tunnel or service)",
		delivery: "deb",
		packages: ["wireguard-tools", "strongswan-swanctl", "strongswan-pki", "strongswan-charon", "openvpn", "ike-scan"],
		checks: cmd("wg", "swanctl", "pki", "openvpn", "ike-scan"),
		privileges:
			"None: `wg genkey`/`wg pubkey`, `pki` keys and certificates, `openvpn --genkey`, `ike-scan --sport=0`. CAP_NET_ADMIN: WireGuard interfaces (`ip link add type wireguard` + `wg set`; kernel module, no /dev/net/tun). CAP_NET_ADMIN plus /dev/net/tun: OpenVPN tunnels. Root: `wg-quick` (it re-executes itself with sudo, which the image lacks) and charon (shipped, not wired). CAP_NET_BIND_SERVICE: ike-scan's default source port 500 where ports below 1024 are restricted.",
		// Measured on amd64 (2026-11-06): see docs/research/2026-11-tool-group-payloads/vpn-routing-payloads.md.
		approxBytes: 16 * 1024 * 1024,
		// swanctl --version asks charon over VICI; --help prints the version line offline.
		versionArgs: { pki: ["--help"], swanctl: ["--help"] },
		// strongSwan reads /etc/strongswan.conf (and swanctl /etc/swanctl) and
		// loads plugins from /usr/lib/ipsec/plugins, all compiled in. The
		// wrapper defaults STRONGSWAN_CONF and SWANCTL_DIR to the payload's
		// copies (a caller's own setting wins) and preloads the plugins that
		// load against libstrongswan alone (the crypto, encoding and credential
		// ones); its loader finds a preloaded plugin by symbol before it looks
		// for a file.
		wrappers: [
			{
				commands: ["pki", "swanctl", "pt-tls-client"],
				env: { STRONGSWAN_CONF: "{root}/etc/strongswan.conf", SWANCTL_DIR: "{root}/etc/swanctl" },
				preload: { libraries: ["usr/lib/ipsec/libstrongswan.so.0"], pluginDir: "usr/lib/ipsec/plugins" },
			},
		],
		smoke: [
			{ command: "pki", args: ["--gen", "--type", "ed25519", "--outform", "pem"], expect: "BEGIN PRIVATE KEY" },
			{ command: "wg", args: ["genkey"], expect: "=" },
		],
		note: "Persistent payload of Debian packages under the home, like capture. strongSwan's pki and swanctl get the payload's config and plugins through their wrappers; charon is shipped but not wired or proven (it needs root). PPP-based peers (SSTP, L2TP, PPPoE) are not here: pppd needs root and /etc/ppp, and xl2tpd and sstpc start /usr/sbin/pppd by a compiled-in path.",
	},
	{
		name: "routing",
		summary: "Linux router-peer tools: BIRD, ND/ARP probes, nftables, conntrack, nmap",
		delivery: "deb",
		packages: ["bird2", "ndisc6", "arping", "arp-scan", "nftables", "conntrack", "nmap"],
		checks: cmd("bird", "birdc", "rdisc6", "ndisc6", "arping", "arp-scan", "nft", "conntrack", "nmap"),
		privileges:
			"None: BIRD config parsing and BGP on ports >=1024 (birdc needs only its socket), nmap connect scans and NSE data. CAP_NET_RAW: ARP/ND probes (arping, arp-scan, rdisc6, ndisc6), nmap raw scans and raw NSE scripts, BIRD OSPF. CAP_NET_BIND_SERVICE: BGP on port 179 where the namespace restricts ports below 1024. CAP_NET_ADMIN and netfilter netlink: nft (even `nft -c`) and conntrack operations, BIRD kernel route sync.",
		// Measured on amd64 (2026-11-06): see docs/research/2026-11-tool-group-payloads/vpn-routing-payloads.md.
		approxBytes: 40 * 1024 * 1024,
		versionArgs: {
			birdc: ["-s", "/nonexistent/bird.ctl", "show", "status"],
			rdisc6: ["-V"],
			ndisc6: ["-V"],
			arping: ["--help"],
		},
		// arp-scan looks for its vendor files in the current directory, then at
		// compiled-in paths the image lacks; without them every MAC is
		// "(Unknown)". A later --ouifile/--macfile from the caller still wins.
		wrappers: [
			{
				commands: ["arp-scan"],
				args: ["--ouifile={root}/usr/share/arp-scan/ieee-oui.txt", "--macfile={root}/etc/arp-scan/mac-vendor.txt"],
			},
		],
		// birdc has no version flag and needs a running BIRD: refusing to
		// connect is the proof that it loads. nft and conntrack open a
		// netfilter netlink socket even for --version; a kernel (or QEMU
		// user-mode emulation) without one must not fail the whole group.
		versionExit: {
			birdc: { code: 1, expect: "Unable to connect to server control socket" },
			nft: { code: 3, expect: "Unable to initialize Netlink socket" },
			conntrack: { code: 1, expect: "mnl_socket_open" },
		},
		smoke: [
			// NSE and service names come from nmap's data dir, found relative to the binary.
			{ command: "nmap", args: ["--script-help", "banner"], expect: "discovery" },
			{ command: "bird", args: ["-p", "-c", "{input}"], inputBase64: Buffer.from(BIRD_BGP_CONF).toString("base64"), expect: "" },
			// Vendor lookup through the wrapper's files, from a capture: no privilege needed.
			{ command: "arp-scan", args: ["--readpktfromfile={input}", "192.0.2.1"], inputBase64: ARP_REPLY_PCAP, expect: "Routerboard.com" },
		],
		note: "Persistent payload of Debian packages under the home, like capture. BIRD takes its config and socket paths as arguments (bird -c/-s, birdc -s); the image has no /etc/bird or /run/bird. lldpd is not here: it needs root and a _lldpd user for privilege separation, which an extracted payload cannot provide.",
	},
	{
		name: "dev",
		summary: "TypeScript, CSpell, markdownlint-cli2 and Biome fallbacks (project lockfiles win)",
		delivery: "npm",
		packages: [],
		npm: ["typescript", "cspell", "markdownlint-cli2", "@biomejs/biome"],
		checks: cmd("tsc", "cspell", "markdownlint-cli2", "biome"),
		privileges: "None.",
		// 154 MiB measured for node_modules on amd64 (2026-11-06).
		approxBytes: 160 * 1024 * 1024,
		note: "Persistent payload under the home, installed in the background on first selection and reused across container replacement. A project's own node_modules/.bin (bun run, npx) still wins.",
	},
];

export const GROUP_NAMES: readonly string[] = GROUPS.map((group) => group.name);

/**
 * The selection when T3APP_TOOL_GROUPS is unset or empty, and the value the
 * image ENV and the /app YAML ship. An explicit list rather than `all`, so a
 * group added later never activates on an existing install by itself:
 * operators remove names, or set `none` for core only.
 */
export const DEFAULT_TOOL_GROUPS = "capture labs vpn routing dev";

/** Native libraries T3's built-in browser loads; the browser itself downloads on first use. */
export const BROWSER_LIBRARIES = ["libnss3.so", "libgbm.so.1", "libasound.so.2", "libatk-bridge-2.0.so.0", "libxkbcommon.so.0", "libXcomposite.so.1", "libXrandr.so.2"] as const;

/**
 * What the core must provide regardless of selection (presence probes): T3,
 * the language bootstraps (Node, Bun, Python with uv/uvx), sqlite3, zstd,
 * the browser's native libraries, centrs and the core network tools. Provider
 * CLIs are not core: T3APP_PROVIDERS installs them into the home
 * (providers.ts, #13), and status reports them separately.
 */
export const CORE_CHECKS: readonly Check[] = [
	...cmd(
	"t3",
	"node",
	"npm",
	"bun",
	"python3",
	"uv",
	"uvx",
	"sqlite3",
	"zstd",
	"git",
	"gh",
	"ssh",
	"curl",
	"jq",
	"rg",
	"centrs",
	"ip",
	"ping",
	"dig",
	"nc",
	"socat",
	"traceroute",
	"mtr",
	"iperf3",
	"ethtool",
	"whois",
	"snmpget",
	"radclient",
	"mosquitto_pub",
	"fc-list",
	),
	...BROWSER_LIBRARIES.map((name): Check => ({ kind: "library", name })),
];

/** What the core network tools need beyond installation (verified on the app image under Docker, 2026-11-06). */
export const CORE_PRIVILEGES =
	"None for ordinary client use: dig, whois, nc/socat and iperf3 on ports >=1024, SNMP, RADIUS and MQTT clients, curl/ssh/centrs, UDP traceroute, ip and ethtool queries. ping uses ICMP echo sockets, which net.ipv4.ping_group_range must allow (Docker allows every group; the image's ping has no file capability), otherwise CAP_NET_RAW. mtr: its helper mtr-packet has a cap_net_raw file capability, so CAP_NET_RAW must be in the container's bounding set. CAP_NET_RAW: traceroute -T/-I, radsniff live capture. CAP_NET_ADMIN: ip and ethtool changes.";

/**
 * Where every network package named in the 2026-11-05 research lives. `core`
 * is installed in the image; group names match GROUPS; `lab-guest` runs only
 * inside a QEMU Linux guest under `labs` that the user boots and provisions
 * (nothing installs it); `not-shipped` stays out unless
 * requested (with the reason).
 */
export const NETWORK_PACKAGE_ASSIGNMENT: Readonly<Record<string, string>> = {
	iproute2: "core",
	"iputils-ping": "core",
	"bind9-dnsutils": "core",
	"netcat-openbsd": "core",
	socat: "core",
	traceroute: "core",
	"mtr-tiny": "core",
	iperf3: "core",
	ethtool: "core",
	whois: "core",
	snmp: "core",
	"freeradius-utils": "core",
	"mosquitto-clients": "core",
	tcpdump: "capture",
	tshark: "capture",
	"wireshark-common": "capture",
	nfdump: "capture",
	"wireguard-tools": "vpn",
	"strongswan-swanctl": "vpn",
	"strongswan-pki": "vpn",
	"strongswan-charon": "vpn",
	openvpn: "vpn",
	"ike-scan": "vpn",
	bird2: "routing",
	ndisc6: "routing",
	arping: "routing",
	"arp-scan": "routing",
	nftables: "routing",
	conntrack: "routing",
	nmap: "routing",
	lldpd: "lab-guest",
	"sstp-client": "lab-guest",
	ppp: "lab-guest",
	xl2tpd: "lab-guest",
	pppoe: "lab-guest",
	frr: "lab-guest",
	keepalived: "lab-guest",
	"freeradius (server)": "lab-guest",
	"pptp-linux": "not-shipped: legacy PPTP, on request only",
	"zerotier-one": "not-shipped: not in Debian main; RouterOS-side feature",
	smbclient: "not-shipped: large Samba dependency set",
	snmptrapd: "not-shipped: port 162 needs bind privilege; use a uvx pysnmp receiver on >=1024",
	eapoltest: "not-shipped: niche 802.1X test client, on request only",
	"ntpsec-ntpdate": "not-shipped: unmeasured; add only if NTP troubleshooting is needed",
};

export interface Selection {
	variable: string;
	/** The raw value, or null when the variable is unset. */
	raw: string | null;
	/** True when an unset or empty value selected DEFAULT_TOOL_GROUPS. */
	defaulted: boolean;
	/** Selected group names in definition order. */
	selected: string[];
	unknown: string[];
	warnings: string[];
}

/**
 * Parse T3APP_TOOL_GROUPS. Separators: whitespace, `+`, comma (RouterOS
 * `/app/set environment=` splits on commas, so docs use spaces). Names are
 * case-insensitive. Unset or empty means DEFAULT_TOOL_GROUPS (the image ENV
 * sets the same value, so a dropped key falls back to it); `none` means core
 * only; `all` selects every group, including any added later. Unknown names
 * are ignored with a warning.
 */
export function parseToolGroups(raw: string | undefined | null): Selection {
	const defaulted = (raw ?? "").trim() === "";
	const selection: Selection = { variable: SELECTOR_ENV, raw: raw ?? null, defaulted, selected: [], unknown: [], warnings: [] };
	const tokens = (defaulted ? DEFAULT_TOOL_GROUPS : (raw as string))
		.split(/[\s+,]+/)
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean);
	const chosen = new Set<string>();
	let sawNone = false;
	for (const token of tokens) {
		if (token === "none") sawNone = true;
		else if (token === "all") for (const name of GROUP_NAMES) chosen.add(name);
		else if (GROUP_NAMES.includes(token)) chosen.add(token);
		else if (!selection.unknown.includes(token)) selection.unknown.push(token);
	}
	for (const name of selection.unknown) {
		selection.warnings.push(`${SELECTOR_ENV}: unknown group "${name}" ignored (known: ${GROUP_NAMES.join(", ")}, none, all)`);
	}
	if (sawNone && chosen.size > 0) {
		selection.warnings.push(`${SELECTOR_ENV}: "none" combined with other groups; using the other groups`);
	}
	selection.selected = GROUP_NAMES.filter((name) => chosen.has(name));
	return selection;
}

