// T3CODE_TOOL_GROUPS selector, group definitions, and the agent-facing status
// report (`t3code-tools status`). Issue #5: slice 1 parses and reports; slice 2
// adds persistent npm payloads under the home (tool-payloads.ts), starting
// with `dev`; slice 3 adds Debian-package payloads (deb-payloads.ts), starting
// with `capture`; slice 4 moves `vpn` and `routing` onto them; slice 5 moves
// `labs` (QEMU and its firmware) out of the image. The final slice retires
// the baked `browser` and `agents-extra` placeholders (browser libraries and
// provider CLIs are core, harness selection is issue #13) and makes the image
// default an explicit list of the five groups. The image copies these files
// to /usr/local/lib/t3code/ and runs them with Bun.
//
// Never throw on operator input: an unknown or malformed selection is a
// warning, and T3 must always start.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEB_LOCK_FILE, resolveDebLock, type WrapperRule } from "./deb-payloads.ts";
import { buildProviderStatus, PROVIDERS_ENV, providerSummary, stateDir } from "./providers.ts";
import {
	APP_HOME,
	activateIfIdle,
	DISK_RESERVE_BYTES,
	defaultPayloadEnv,
	defaultRoot,
	INTERACTIVE_BACKOFF_MS,
	installGroups,
	isPayloadGroup,
	KEEP_TRYING_BACKOFF_MS,
	type PayloadEnv,
	type PayloadInfo,
	payloadInfo,
	prunePayloads,
} from "./tool-payloads.ts";

export const SELECTOR_ENV = "T3CODE_TOOL_GROUPS";
export const BUILD_INVENTORY_DIR = "/usr/share/t3code/inventory";
export const RUNTIME_STATUS_PATH = "/tmp/t3code-tools/status.json";
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

/**
 * `pending`: selected, waiting for the background installer. `installing`:
 * the installer is working on it (including retry back-off). `failed`: the
 * last install failed and no usable payload is active. `not-implemented`:
 * selected, but this image has no way to provide the group yet.
 */
export type GroupState = "not-selected" | "pending" | "installing" | "ready" | "failed" | "not-implemented";

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
 * The selection when T3CODE_TOOL_GROUPS is unset or empty, and the value the
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
 * CLIs are not core: T3CODE_PROVIDERS installs them into the home
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
 * Parse T3CODE_TOOL_GROUPS. Separators: whitespace, `+`, comma (RouterOS
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

export interface CheckResult {
	kind: Check["kind"];
	name: string;
	ok: boolean;
	path: string | null;
}

export interface GroupStatus {
	name: string;
	summary: string;
	selected: boolean;
	state: GroupState;
	delivery: Delivery;
	/** True when every check passes, whatever the state. */
	present: boolean;
	missing: string[];
	packages: readonly string[];
	npm: readonly string[];
	privileges: string;
	checks: CheckResult[];
	/** npm delivery only: desired/active payload ids, installer and last result. */
	payload?: PayloadInfo;
	note?: string;
}

export interface Probe {
	which(command: string): string | null;
	exists(path: string): boolean;
	library(soname: string): string | null;
}

let ldcache: string | undefined;
function findLibrary(soname: string): string | null {
	if (ldcache === undefined) {
		try {
			// Absolute path: library checks must not depend on the caller's PATH,
			// which may omit /usr/sbin. Fall back to PATH outside Debian.
			const ldconfig = ["/usr/sbin/ldconfig", "/sbin/ldconfig"].find((p) => existsSync(p)) ?? "ldconfig";
			const proc = Bun.spawnSync([ldconfig, "-p"], { env: { ...process.env, LC_ALL: "C" } });
			ldcache = proc.exitCode === 0 ? proc.stdout.toString() : "";
		} catch {
			ldcache = "";
		}
	}
	for (const line of ldcache.split("\n")) {
		const match = line.match(/^\s*(\S+) \(.*\) => (\S+)$/);
		if (match?.[1] === soname) return match[2] as string;
	}
	return null;
}

export const systemProbe: Probe = { which: (c) => Bun.which(c), exists: existsSync, library: findLibrary };

function runCheck(check: Check, probe: Probe): CheckResult {
	const path = check.kind === "command" ? probe.which(check.name) : check.kind === "library" ? probe.library(check.name) : probe.exists(check.name) ? check.name : null;
	return { kind: check.kind, name: check.name, ok: path !== null, path };
}

/** State of an npm payload group, from its payload info (never from PATH alone). */
function payloadState(info: PayloadInfo): GroupState {
	if (info.active && info.linked) return "ready";
	if (info.installer && info.last?.state === "installing") return "installing";
	if (info.last?.state === "failed" && (info.last.payloadId === info.desired || info.desired === null)) return "failed";
	return "pending";
}

export function groupStatus(group: GroupDef, selected: boolean, probe: Probe, payload?: PayloadInfo): GroupStatus {
	// Payload groups are checked at their shims (or, for deb, the image's own
	// command of that name), so the result does not depend on the caller's
	// PATH; other groups are probed where the image put them.
	const checks =
		isPayloadGroup(group) && payload
			? group.checks.map((check) => {
					const path =
						check.kind === "command" ? (payload.commandPaths?.[check.name] ?? null) : check.kind === "file" ? (payload.filePaths?.[check.name] ?? null) : null;
					return { kind: check.kind, name: check.name, ok: path !== null && existsSync(path), path };
				})
			: group.checks.map((check) => runCheck(check, probe));
	const missing = checks.filter((check) => !check.ok).map((check) => check.name);
	const present = missing.length === 0;
	let state: GroupState = "not-selected";
	if (selected) state = group.delivery === "none" ? "not-implemented" : payload ? payloadState(payload) : "pending";
	return {
		name: group.name,
		summary: group.summary,
		selected,
		state,
		delivery: group.delivery,
		present,
		missing,
		packages: group.packages,
		npm: group.npm ?? [],
		privileges: group.privileges,
		checks,
		...(payload ? { payload } : {}),
		...(group.note ? { note: group.note } : {}),
	};
}

function readBuildInventory(dir: string) {
	const path = `${dir}/inventory.json`;
	if (!existsSync(path)) return { path: dir, present: false };
	try {
		const inventory = JSON.parse(readFileSync(path, "utf8")) as { architecture?: string; generatedAt?: string; versions?: Record<string, string> };
		return {
			path: dir,
			present: true,
			architecture: inventory.architecture ?? null,
			generatedAt: inventory.generatedAt ?? null,
			t3: inventory.versions?.["t3"] ?? null,
		};
	} catch (error) {
		return { path: dir, present: false, error: String(error) };
	}
}

export function buildStatus(
	raw: string | undefined | null,
	probe: Probe = systemProbe,
	inventoryDir = BUILD_INVENTORY_DIR,
	payloads: PayloadEnv | null = defaultPayloadEnv(PAYLOAD_SPEC_DIR),
	providers: string | undefined | null = process.env[PROVIDERS_ENV],
) {
	const selection = parseToolGroups(raw);
	const core = CORE_CHECKS.map((check) => runCheck(check, probe));
	const coreMissing = core.filter((check) => !check.ok).map((check) => check.name);
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		selector: selection,
		core: { state: coreMissing.length === 0 ? "ready" : "degraded", missing: coreMissing, privileges: CORE_PRIVILEGES, checks: core },
		groups: GROUPS.map((group) =>
			groupStatus(group, selection.selected.includes(group.name), probe, isPayloadGroup(group) && payloads ? payloadInfo(group, payloads) : undefined),
		),
		// Provider CLIs are not groups (T3CODE_PROVIDERS, #13); `t3code-providers status` has the detail.
		providers: buildProviderStatus(providers, probe.which).providers.map(({ token, selected, state, path }) => ({ token, selected, state, path })),
		buildInventory: readBuildInventory(inventoryDir),
		runtimeStatusPath: RUNTIME_STATUS_PATH,
		notes: [
			"npm and deb groups install in the background into the home and are reused across container replacement; not-implemented groups have no installer yet.",
			`Unset or empty ${SELECTOR_ENV} selects the default "${DEFAULT_TOOL_GROUPS}"; "none" is core only. Installing a group grants no privileges (see each group's privileges).`,
			"Provider CLIs are not tool groups: T3CODE_PROVIDERS installs them into the home in the background (issue #13). The providers block is as of generatedAt; t3code-providers status is always live.",
			"A deb group's file checks are paths inside its payload root, reported through the group's current link.",
			"Checks are presence probes (PATH, files, ldconfig), not functional tests or capability grants.",
			"Change the selection with /app/set environment= (see README), never by reapplying the /app YAML.",
		],
	};
}

export type Status = ReturnType<typeof buildStatus>;

export function formatStatus(status: Status): string {
	const lines = [
		`${SELECTOR_ENV}=${status.selector.raw === null ? "(unset)" : JSON.stringify(status.selector.raw)}${status.selector.defaulted ? " (default)" : ""} -> ${status.selector.selected.length ? status.selector.selected.join(" ") : "none (core only)"}`,
		`core: ${status.core.state}${status.core.missing.length ? ` (missing: ${status.core.missing.join(", ")})` : ""}`,
		`providers: ${providerSummary(status.providers)} (t3code-providers status)`,
	];
	for (const group of status.groups) {
		const extra = group.missing.length && group.state !== "not-selected" ? ` missing: ${group.missing.join(", ")}` : "";
		lines.push(`${group.name.padEnd(13)} ${group.state.padEnd(16)}${group.present ? "present" : "absent "}  ${group.summary}${extra}`);
		const p = group.payload;
		if (p && (group.selected || p.installed.length)) {
			const detail = [`payload ${p.active ?? "none"}${p.stale ? ` (refresh to ${p.desired} due)` : ""}`];
			if (!group.selected && p.installed.length) detail.push(`kept on disk: ${p.installed.join(", ")} (t3code-tools prune removes)`);
			if (p.last?.error && group.state !== "ready") detail.push(`last error: ${p.last.error}`);
			if (group.state === "installing" && p.installer?.waitingUntil) detail.push(`retrying at ${p.installer.waitingUntil} (t3code-tools install retries now)`);
			if (p.desiredError) detail.push(p.desiredError);
			lines.push(`${"".padEnd(14)}${detail.join("; ")}`);
		}
	}
	for (const warning of status.selector.warnings) lines.push(`warning: ${warning}`);
	const inv = status.buildInventory;
	lines.push(`build inventory: ${inv.present ? `${inv.path} (${"architecture" in inv ? inv.architecture : "?"})` : `missing at ${inv.path}`}`);
	return `${lines.join("\n")}\n`;
}

/** A back-off delay as 15s / 5m / 1h. */
const fmtWait = (ms: number) => (ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`);
const keepTryingHours = Math.round(KEEP_TRYING_BACKOFF_MS.reduce((a, b) => a + b, 0) / 3_600_000);

/**
 * The command reference: the one place that says what t3code-tools does.
 * `t3code-tools help` (or any command with --help) prints it. Keep it in
 * step with main(); a test checks every command is described.
 */
export const USAGE = `t3code-tools: optional tool groups for the app-t3code image (issue #5)

usage: t3code-tools <command> [options]        (no command: status)
       t3code-tools help | --help | <command> --help

Commands
  status [--json] [--groups <selection>]
      Report the selection, core readiness and each group's state, payload and
      last error. --groups evaluates another selection without changing
      anything. Read-only; safe at any time.
  install [--keep-trying]
      Install missing payloads for the selection, one group at a time, then
      link them. Without --keep-trying: ${INTERACTIVE_BACKOFF_MS.length + 1} attempts per group over about
      ${fmtWait(INTERACTIVE_BACKOFF_MS.reduce((a, b) => a + b, 0))} (use this to retry now). --keep-trying is the entrypoint's
      background run: retries for about ${keepTryingHours}h (${KEEP_TRYING_BACKOFF_MS.slice(0, 5).map(fmtWait).join(", ")}, then hourly) and
      releases the lock between rounds, so a manual install or prune can run.
      Exit 1 if a group ended failed.
  prune
      Delete payloads no selected group uses (deselected groups, the previous
      payload kept after a refresh), interrupted installs and kept downloads.
      Exit 1 while an installer holds the lock.
  init
      Entrypoint hook: relink already-installed payloads for the selection,
      unlink deselected ones, log warnings and write the status file. Offline,
      bounded, never fails.
  groups
      Print the group definitions, core checks and network package assignment
      as JSON (the static spec this image ships).
  deb-lock [--spec-dir <dir>]
      Image build only (root, after apt-get update): pin each deb group's
      package closure from apt metadata into <spec-dir>/<group>/${DEB_LOCK_FILE}.

Selection (${SELECTOR_ENV})
  Group names separated by spaces (or commas or +), case-insensitive:
  ${GROUP_NAMES.join(", ")}.
  Unset or empty: the default "${DEFAULT_TOOL_GROUPS}". "none": core only.
  "all": every group, including ones added later. Unknown names are ignored
  with a warning. On RouterOS change it with /app/set environment= (keep the
  other entries; use spaces), never by reapplying the YAML.

Files
  ${defaultRoot()}
      payload root (T3CODE_TOOLS_HOME moves it): groups/<group>/<id>, bin/
      shims on PATH, state.json, install.log, install.lock
  ${RUNTIME_STATUS_PATH}
      status JSON written by init and install
  ${join(stateDir(), "tool-groups.log")}
      output of the entrypoint's background install
  ${BUILD_INVENTORY_DIR}
      build-time inventory (image contents, deb locks)

Users
  install, prune and init must run as the owner of the payload root (node in
  this image). Run as root (for example RouterOS /container/shell), they
  re-execute as that owner with setpriv, so files never become root-owned;
  root always means the app's payload root (${APP_HOME}), whatever its HOME.
  A waiting background installer is recorded in install.wait.

Exit codes: 0 ok, 1 a group failed or the lock is busy (prune), 2 usage,
3 wrong user and cannot switch. Installing a group grants no privileges;
each group's "privileges" field says what its operations need. Each install
needs its payload and downloads plus ${DISK_RESERVE_BYTES / 1024 / 1024} MiB free.
`;

const COMMANDS = ["status", "install", "prune", "init", "groups", "deb-lock", "help"] as const;

/** Commands that write the payload root, so must run as its owner. */
const OWNER_COMMANDS = new Set(["install", "prune", "init"]);

/** The nearest existing directory at or above path (the payload root may not exist yet). */
function existingAncestor(path: string): string {
	let p = path;
	while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
	return p;
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Who should run a command that writes the payload root: null when this
 * process owns it (or the platform has no uids), else the owner. A root
 * that does not exist yet belongs to whoever creates it: a non-root caller
 * may create it under any parent it can write (a shared /tmp, say); root
 * defers to the parent's owner, so the app's home never gains root-owned files.
 */
export function ownerMismatch(root: string, uid: number | undefined = process.getuid?.()): { uid: number; gid: number; path: string } | null {
	if (uid === undefined) return null;
	const path = existingAncestor(root);
	const st = statSync(path);
	if (st.uid === uid) return null;
	if (path !== root && uid !== 0 && writable(path)) return null;
	return { uid: st.uid, gid: st.gid, path };
}

/**
 * Run as the payload root's owner: root re-executes this command through
 * setpriv (so /container/shell, which may be root, leaves no root-owned
 * files); anyone else gets exit 3. Returns null when no switch is needed.
 */
function runAsOwner(command: string, argv: string[]): number | null {
	const owner = ownerMismatch(defaultRoot());
	if (!owner) return null;
	const uid = process.getuid?.();
	if (uid !== 0) {
		process.stderr.write(`t3code-tools ${command}: ${owner.path} belongs to uid ${owner.uid}, this is uid ${uid}; run it as that user\n`);
		return 3;
	}
	// Pin the payload root and home for the child: root's HOME (often /root)
	// would otherwise point the app user's run somewhere else.
	const env = { ...process.env, HOME: APP_HOME, T3CODE_TOOLS_HOME: defaultRoot() };
	const proc = Bun.spawnSync(
		["setpriv", `--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", "--", process.execPath, import.meta.path, ...argv],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit", env },
	);
	if (proc.exitCode === null || (proc.exitCode === 127 && !Bun.which("setpriv"))) {
		process.stderr.write(`t3code-tools ${command}: running as root and cannot switch to uid ${owner.uid} (setpriv unavailable)\n`);
		return 3;
	}
	return proc.exitCode;
}

/** Write the runtime status JSON atomically; a failure is a warning, never fatal (T3 must start). */
function writeRuntimeStatus(raw: string | undefined) {
	try {
		const status = buildStatus(raw);
		mkdirSync(dirname(RUNTIME_STATUS_PATH), { recursive: true });
		writeFileSync(`${RUNTIME_STATUS_PATH}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
		renameSync(`${RUNTIME_STATUS_PATH}.tmp`, RUNTIME_STATUS_PATH);
		return status;
	} catch (error) {
		console.error(`t3code-tools: warning: status unavailable: ${String(error)}`);
		return null;
	}
}

/** The t3code-tools CLI (see USAGE); returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command = "status", ...rest] = argv;
	const raw = process.env[SELECTOR_ENV];
	if (command === "-h" || command === "--help" || command === "help" || rest.includes("--help") || rest.includes("-h")) {
		if (command !== "-h" && command !== "--help" && !(COMMANDS as readonly string[]).includes(command)) {
			process.stderr.write(USAGE);
			return 2;
		}
		process.stdout.write(USAGE);
		return 0;
	}
	if (OWNER_COMMANDS.has(command)) {
		const code = runAsOwner(command, argv);
		if (code !== null) return code;
	}
	if (command === "groups") {
		process.stdout.write(`${JSON.stringify({ groups: GROUPS, core: CORE_CHECKS, networkPackageAssignment: NETWORK_PACKAGE_ASSIGNMENT }, null, 2)}\n`);
		return 0;
	}
	if (command === "init") {
		const selection = parseToolGroups(raw);
		try {
			// Serialized with install/prune; if one is running it activates instead.
			const pending = await activateIfIdle(GROUPS.filter(isPayloadGroup), selection.selected, defaultPayloadEnv(PAYLOAD_SPEC_DIR));
			if (pending === null) console.error("t3code-tools: an install or prune is running; it will relink payloads when done");
		} catch (error) {
			console.error(`t3code-tools: warning: payload activation failed: ${String(error)}`);
		}
		const status = writeRuntimeStatus(raw);
		if (status) {
			for (const warning of status.selector.warnings) console.error(`t3code-tools: warning: ${warning}`);
			const summary = status.groups.filter((g) => g.selected).map((g) => `${g.name}=${g.state}`);
			console.error(`t3code-tools: groups ${summary.length ? summary.join(" ") : "none (core only)"}; core ${status.core.state}`);
		}
		return 0;
	}
	if (command === "install") {
		if (rest.some((arg) => arg !== "--keep-trying")) {
			process.stderr.write(USAGE);
			return 2;
		}
		const selection = parseToolGroups(raw);
		const env = defaultPayloadEnv(PAYLOAD_SPEC_DIR);
		if (rest.includes("--keep-trying")) env.backoffMs = KEEP_TRYING_BACKOFF_MS;
		const result = await installGroups(GROUPS.filter(isPayloadGroup), selection.selected, env, () => writeRuntimeStatus(raw));
		writeRuntimeStatus(raw);
		return Object.values(result.results).some((r) => r.state === "failed") ? 1 : 0;
	}
	if (command === "prune") {
		const selection = parseToolGroups(raw);
		try {
			const removed = await prunePayloads(GROUPS.filter(isPayloadGroup), selection.selected, defaultPayloadEnv(PAYLOAD_SPEC_DIR));
			process.stdout.write(removed.length ? `removed ${removed.join(" ")}\n` : "nothing to remove\n");
		} catch (error) {
			process.stderr.write(`t3code-tools: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
		writeRuntimeStatus(raw);
		return 0;
	}
	if (command === "deb-lock") {
		let specDir = PAYLOAD_SPEC_DIR;
		if (rest[0] === "--spec-dir" && rest[1]) specDir = rest[1];
		else if (rest.length) {
			process.stderr.write(USAGE);
			return 2;
		}
		const exec = (cmd: string[]) => {
			const proc = Bun.spawnSync(cmd, { env: { ...process.env, LC_ALL: "C" } });
			if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
			return proc.stdout.toString();
		};
		for (const group of GROUPS.filter((g) => g.delivery === "deb")) {
			const lock = resolveDebLock(group.name, group.packages, exec, readFileSync("/etc/os-release", "utf8"));
			const path = join(specDir, group.name, DEB_LOCK_FILE);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
			const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
			const download = lock.packages.reduce((s, p) => s + p.size, 0);
			const installed = lock.packages.reduce((s, p) => s + p.installedSize, 0);
			process.stdout.write(`${group.name}: ${lock.packages.length} packages for ${lock.arch} ${lock.distro}, ${mib(download)} MiB download, ${mib(installed)} MiB unpacked -> ${path}\n`);
			for (const up of lock.imageUpgrades ?? []) {
				process.stdout.write(`${group.name}: warning: apt wants ${up.name} ${up.installed} -> ${up.candidate}; not extracted (the image copy wins). Rebuild the image if the tools need it.\n`);
			}
		}
		return 0;
	}
	if (command !== "status") {
		process.stderr.write(USAGE);
		return 2;
	}
	let json = false;
	let selection = raw;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--json") json = true;
		else if (arg === "--groups" && i + 1 < rest.length) selection = rest[++i];
		else if (arg?.startsWith("--groups=")) selection = arg.slice("--groups=".length);
		else {
			process.stderr.write(USAGE);
			return 2;
		}
	}
	const status = buildStatus(selection);
	process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
