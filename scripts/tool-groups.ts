// T3CODE_TOOL_GROUPS selector, group definitions, and the agent-facing status
// report (`t3code-tools status`). Slice 1 of issue #5: this module parses and
// reports; it installs nothing. The image copies it to
// /usr/local/lib/t3code/tool-groups.ts and runs it with Bun.
//
// Never throw on operator input: an unknown or malformed selection is a
// warning, and T3 must always start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SELECTOR_ENV = "T3CODE_TOOL_GROUPS";
export const BUILD_INVENTORY_DIR = "/usr/share/t3code/inventory";
export const RUNTIME_STATUS_PATH = "/tmp/t3code-tools/status.json";

/**
 * How a group's tools reach the container today.
 * - `image`: already baked into the image; selection does not gate them yet,
 *   so status probes the real files.
 * - `none`: no installer exists in this image yet (later slices).
 */
export type Delivery = "image" | "none";

/**
 * `pending` is reserved for the background installer (slice 2+); this image
 * never reports it. `not-implemented` means the group was selected but this
 * image has no way to provide it yet.
 */
export type GroupState = "not-selected" | "pending" | "ready" | "failed" | "not-implemented";

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
	note?: string;
}

const cmd = (...names: string[]): Check[] => names.map((name) => ({ kind: "command", name }));

export const GROUPS: readonly GroupDef[] = [
	{
		name: "capture",
		summary: "Packet capture, decoding and flow collection",
		delivery: "none",
		packages: ["tcpdump", "tshark", "wireshark-common", "nfdump"],
		checks: cmd("tcpdump", "tshark", "dumpcap", "capinfos", "editcap", "mergecap", "text2pcap", "nfcapd", "nfdump"),
		privileges: "Offline decoding needs none; live capture needs CAP_NET_RAW (tcpdump/dumpcap). TZSP/NetFlow receivers on ports >=1024 need none.",
	},
	{
		name: "labs",
		summary: "quickchr with QEMU emulators, qemu-img and firmware (one readiness contract)",
		delivery: "image",
		packages: ["qemu-system-x86", "qemu-system-arm", "qemu-efi-aarch64", "qemu-utils"],
		checks: [
			...cmd("quickchr", "qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"),
			{ kind: "file", name: "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd" },
			{ kind: "file", name: "/usr/share/seabios/bios-256k.bin" },
		],
		privileges: "None for TCG with user networking; /dev/kvm for acceleration; TAP needs CAP_NET_ADMIN.",
		note: "Still baked into the image, so it is present whether or not it is selected. Readiness probes files only; status never boots a CHR.",
	},
	{
		name: "vpn",
		summary: "WireGuard, strongSwan, OpenVPN, SSTP, L2TP and PPPoE peer tools (no default tunnel or service)",
		delivery: "none",
		packages: [
			"wireguard-tools",
			"strongswan-swanctl",
			"strongswan-pki",
			"strongswan-charon",
			"openvpn",
			"sstp-client",
			"ppp",
			"xl2tpd",
			"pppoe",
			"ike-scan",
		],
		checks: cmd("wg", "swanctl", "pki", "openvpn", "sstpc", "pppd", "xl2tpd", "pppoe-discovery", "ike-scan"),
		privileges: "`wg genkey`/`pki` need none; tunnels need CAP_NET_ADMIN plus /dev/net/tun or /dev/ppp and host kernel modules.",
	},
	{
		name: "routing",
		summary: "Linux router-peer tools: BIRD, LLDP/CDP, ND/ARP probes, nftables, conntrack, nmap",
		delivery: "none",
		packages: ["bird2", "lldpd", "ndisc6", "arping", "arp-scan", "nftables", "conntrack", "nmap"],
		checks: cmd("bird", "birdc", "lldpd", "lldpcli", "rdisc6", "ndisc6", "arping", "arp-scan", "nft", "conntrack", "nmap"),
		privileges: "An active BGP session needs none; OSPF, LLDP, ARP/ND and raw scans need CAP_NET_RAW; nftables/conntrack need CAP_NET_ADMIN.",
	},
	{
		name: "dev",
		summary: "TypeScript, CSpell, markdownlint-cli2 and Biome fallbacks (project lockfiles win)",
		delivery: "none",
		packages: [],
		npm: ["typescript", "cspell", "markdownlint-cli2", "@biomejs/biome"],
		checks: cmd("tsc", "cspell", "markdownlint-cli2", "biome"),
		privileges: "None.",
		note: "Planned as the first persistent /data group (slice 2).",
	},
	{
		name: "browser",
		summary: "Native libraries for T3's built-in browser (the browser downloads itself on first use)",
		delivery: "image",
		packages: [
			"fontconfig",
			"fonts-liberation",
			"libasound2t64",
			"libatk-bridge2.0-0t64",
			"libatk1.0-0t64",
			"libatspi2.0-0t64",
			"libdbus-1-3",
			"libexpat1",
			"libgbm1",
			"libglib2.0-0t64",
			"libnss3",
			"libx11-6",
			"libxcb1",
			"libxcomposite1",
			"libxdamage1",
			"libxext6",
			"libxfixes3",
			"libxkbcommon0",
			"libxrandr2",
		],
		checks: [
			...["libnss3.so", "libgbm.so.1", "libasound.so.2", "libatk-bridge-2.0.so.0", "libxkbcommon.so.0", "libXcomposite.so.1", "libXrandr.so.2"].map(
				(name): Check => ({ kind: "library", name }),
			),
			...cmd("fc-list"),
		],
		privileges: "User namespaces for the browser sandbox, if the host allows them.",
		note: "Still baked into the image. Checks the native libraries only, not T3's downloaded browser.",
	},
	{
		name: "agents-extra",
		summary: "Provider CLIs beyond the core provider",
		delivery: "image",
		packages: [],
		npm: ["@openai/codex", "opencode-ai"],
		checks: cmd("codex", "opencode", "muse"),
		privileges: "None.",
		note: "Still baked into the image. The core provider has not been chosen yet, so every baked provider is listed here. Claude Code installs into /data on first start and is not part of any group.",
	},
];

export const GROUP_NAMES: readonly string[] = GROUPS.map((group) => group.name);

/** What the core must provide regardless of selection (presence probes). */
export const CORE_CHECKS: readonly Check[] = cmd(
	"t3",
	"node",
	"npm",
	"bun",
	"python3",
	"git",
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
);

/**
 * Where every network package named in the 2026-11-05 research lives. `core`
 * is installed in the image; group names match GROUPS; `lab-guest` runs only
 * inside a QEMU Linux guest under `labs`; `not-shipped` stays out unless
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
	"sstp-client": "vpn",
	ppp: "vpn",
	xl2tpd: "vpn",
	pppoe: "vpn",
	"ike-scan": "vpn",
	bird2: "routing",
	lldpd: "routing",
	ndisc6: "routing",
	arping: "routing",
	"arp-scan": "routing",
	nftables: "routing",
	conntrack: "routing",
	nmap: "routing",
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
	/** Selected group names in definition order. */
	selected: string[];
	unknown: string[];
	warnings: string[];
}

/**
 * Parse T3CODE_TOOL_GROUPS. Separators: whitespace, `+`, comma (RouterOS
 * `/app/set environment=` splits on commas, so docs use spaces). Names are
 * case-insensitive. Unset or empty means `none` (core only). `all` selects
 * every group. Unknown names are ignored with a warning.
 */
export function parseToolGroups(raw: string | undefined | null): Selection {
	const selection: Selection = { variable: SELECTOR_ENV, raw: raw ?? null, selected: [], unknown: [], warnings: [] };
	const tokens = (raw ?? "")
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

export function groupStatus(group: GroupDef, selected: boolean, probe: Probe): GroupStatus {
	const checks = group.checks.map((check) => runCheck(check, probe));
	const missing = checks.filter((check) => !check.ok).map((check) => check.name);
	const present = missing.length === 0;
	let state: GroupState = "not-selected";
	if (selected) state = group.delivery === "none" ? "not-implemented" : present ? "ready" : "failed";
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

export function buildStatus(raw: string | undefined | null, probe: Probe = systemProbe, inventoryDir = BUILD_INVENTORY_DIR) {
	const selection = parseToolGroups(raw);
	const core = CORE_CHECKS.map((check) => runCheck(check, probe));
	const coreMissing = core.filter((check) => !check.ok).map((check) => check.name);
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		selector: selection,
		core: { state: coreMissing.length === 0 ? "ready" : "degraded", missing: coreMissing, checks: core },
		groups: GROUPS.map((group) => groupStatus(group, selection.selected.includes(group.name), probe)),
		buildInventory: readBuildInventory(inventoryDir),
		runtimeStatusPath: RUNTIME_STATUS_PATH,
		notes: [
			"Group payload installation is not implemented in this image; selection only reports state.",
			"Checks are presence probes (PATH, files, ldconfig), not functional tests or capability grants.",
			"Change the selection with /app/set environment= (see README), never by reapplying the /app YAML.",
		],
	};
}

export type Status = ReturnType<typeof buildStatus>;

export function formatStatus(status: Status): string {
	const lines = [
		`${SELECTOR_ENV}=${status.selector.raw === null ? "(unset)" : JSON.stringify(status.selector.raw)} -> ${status.selector.selected.length ? status.selector.selected.join(" ") : "none (core only)"}`,
		`core: ${status.core.state}${status.core.missing.length ? ` (missing: ${status.core.missing.join(", ")})` : ""}`,
	];
	for (const group of status.groups) {
		const extra = group.missing.length && group.state !== "not-selected" ? ` missing: ${group.missing.join(", ")}` : "";
		lines.push(`${group.name.padEnd(13)} ${group.state.padEnd(16)}${group.present ? "present" : "absent "}  ${group.summary}${extra}`);
	}
	for (const warning of status.selector.warnings) lines.push(`warning: ${warning}`);
	const inv = status.buildInventory;
	lines.push(`build inventory: ${inv.present ? `${inv.path} (${"architecture" in inv ? inv.architecture : "?"})` : `missing at ${inv.path}`}`);
	return `${lines.join("\n")}\n`;
}

const USAGE = `usage: t3code-tools status [--json] [--groups <selection>]
       t3code-tools init
       t3code-tools groups

status   report the T3CODE_TOOL_GROUPS selection and per-group state
         (--groups evaluates another selection without changing anything)
init     entrypoint hook: log warnings and write ${RUNTIME_STATUS_PATH}; never fails
groups   print group definitions and the network package assignment as JSON
`;

export function main(argv: string[]): number {
	const [command = "status", ...rest] = argv;
	if (command === "-h" || command === "--help" || command === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	if (command === "groups") {
		process.stdout.write(`${JSON.stringify({ groups: GROUPS, core: CORE_CHECKS, networkPackageAssignment: NETWORK_PACKAGE_ASSIGNMENT }, null, 2)}\n`);
		return 0;
	}
	if (command === "init") {
		try {
			const status = buildStatus(process.env[SELECTOR_ENV]);
			for (const warning of status.selector.warnings) console.error(`t3code-tools: warning: ${warning}`);
			const summary = status.groups.filter((g) => g.selected).map((g) => `${g.name}=${g.state}`);
			console.error(`t3code-tools: groups ${summary.length ? summary.join(" ") : "none (core only)"}; core ${status.core.state}`);
			mkdirSync(dirname(RUNTIME_STATUS_PATH), { recursive: true });
			writeFileSync(RUNTIME_STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
		} catch (error) {
			console.error(`t3code-tools: warning: status unavailable: ${String(error)}`);
		}
		return 0;
	}
	if (command !== "status") {
		process.stderr.write(USAGE);
		return 2;
	}
	let json = false;
	let raw = process.env[SELECTOR_ENV];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--json") json = true;
		else if (arg === "--groups" && i + 1 < rest.length) raw = rest[++i];
		else if (arg?.startsWith("--groups=")) raw = arg.slice("--groups=".length);
		else {
			process.stderr.write(USAGE);
			return 2;
		}
	}
	const status = buildStatus(raw);
	process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
