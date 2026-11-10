# Networking and Node/Python/Bun tool evidence

**Evidence appendix.** [REVIEW.md](REVIEW.md) defines approved packaging and
lifecycle requirements. This catalog measures useful tools; it does not
require every candidate in core. Capture, VPN, Node fallback, and lab tools
belong to their approved groups.

Owner refinement after the initial comparison: the original small-tool list
is the right baseline, especially `sqlite3`. Agents should also have Linux
tools for investigating RouterOS protocols, collecting captures, and turning
that data into useful output. Node.js, Python, and Bun are the supported
general development runtimes. Go, Rust, Ruby, JVM, .NET, and other language
SDKs are outside the default image scope. Libraries required by a selected
analyzer remain ordinary package dependencies.

This document refines the recommendations in [issue #5](https://github.com/tikoci/app-t3code/issues/5).
Production package additions remain deferred; the installations described
below occurred only in disposable research containers.

## Recommended scope

Keep the original file/archive/data/Python baseline. `socat`, `dig`, and
`nslookup` were already included: Debian's `socat` provides the socket relay,
and `bind9-dnsutils` supplies the DNS commands. Include `sqlite3` explicitly
rather than assuming that the SQLite shared library supplies its CLI.

Add the following Linux networking tools to the proposed image toolset:

| Task | Packages / commands | Reason |
| --- | --- | --- |
| Linux interfaces, VLANs, bridges, routes, queues | `iproute2` → `ip`, `bridge`, `tc`, `ss` | Already in the original proposal; also provides `ip xfrm` for kernel IPsec inspection. |
| Packet capture and protocol/data analysis | `tcpdump tshark` | Capture/filter traffic and decode router captures into fields or JSON. TShark is recommended despite its larger dependency footprint. |
| Capture metadata and transformation | Dependencies of `tshark` provide `capinfos editcap mergecap text2pcap dumpcap` | No separate GUI Wireshark package is needed. These commands were verified in Debian's `wireshark-common`. |
| Route/path/throughput/link checks | `traceroute mtr-tiny iperf3 ethtool whois` | Common Linux counterparts for network diagnosis. iperf3 needs a compatible peer; it does not substitute for RouterOS's bandwidth-test peer. |
| WireGuard peer tooling | `wireguard-tools` → `wg` | Inspect/configure a Linux peer when the kernel and permissions support it. No additional language runtime. |
| IPsec/IKE peer and certificates | `strongswan-swanctl strongswan-pki strongswan-charon` | A complete peer package group; no default connection or running service is proposed. |
| Linux firewall/connection tracking | `conntrack nftables` | Linux-side flow/firewall inspection and lab configuration when capabilities permit. |
| SNMP and RADIUS clients | `snmp freeradius-utils` | `snmpget/snmpwalk`, `radclient/radtest`; useful RouterOS management/authentication counterparts without adding those servers. |

The combined original baseline plus this networking proposal is estimated
at **205.97 MiB installed / 47.39 MiB apt downloads / 105 added packages** on
the inspected amd64 image. That is dependency-inclusive, with recommends
disabled. It is an apt metadata estimate, not a measured compressed or
uncompressed OCI layer delta. The exact scenario and candidate versions
are preserved in [network-package-costs-amd64.json](network-package-costs-amd64.json).

Treat `nmap` as an optional addition: it is useful for service discovery,
but the request's core counterpart/parsing tasks are covered above. Keep
`ike-scan` optional too; it is not a complete modern IKEv2 peer and does not
replace strongSwan. Do not bundle FRR, DHCP/DNS servers, VPN servers, or
other always-running network services merely because RouterOS has those
features. They can be explicit lab components, including CHR guests.

## Why both tcpdump and TShark

The [TShark manual](https://www.wireshark.org/docs/man-pages/tshark.html)
documents saved-file decoding, display filters, JSON, and selected-field
output. Wireshark's [TZSP reference](https://www.wireshark.org/docs/dfref/t/tzsp.html)
confirms a dedicated TZSP decoder. This makes TShark a useful agent parser
for RouterOS captures and TZSP streams. tcpdump remains a small, familiar
capture/filter tool; it should not be treated as a replacement for the
TZSP dissector.

This pass installed only `tcpdump` and `tshark` in a disposable copy of the
baseline image and synthesized a pcapng file containing a DNS query inside
TZSP. Running **as the normal node user, without added capabilities**, it
successfully decoded the inner question as both a field and JSON:

```sh
tshark -n -r routeros-tzsp-example.pcapng -Y 'tzsp && dns' \
  -T fields -e tzsp.encap -e dns.qry.name
# 1    routeros.example

tshark -n -r routeros-tzsp-example.pcapng -Y 'tzsp && dns' \
  -T json -e dns.qry.name
```

The test also found decoder registrations for MNDP, LLDP, DNS, DHCP/DHCPv6,
RADIUS, SNMP, IKE/ISAKMP, ESP/AH, WireGuard, BGP, OSPF, and VXLAN. This
proves the decoders are present, not that every protocol has been tested
against RouterOS. See [packet-tools-probe.json](packet-tools-probe.json) for
the fixture bytes, actual decoded output, package versions, and tool list.

Offline parsing needs no packet-capture privileges. Live capture does:
Wireshark documents [capture privileges, including container capabilities](https://wiki.wireshark.org/CaptureSetup/CapturePrivileges).
Installing a CLI does not grant the current node user root access or grant
the container capabilities its host withheld. Linux-side tools observe the
container's interfaces and namespace; they do not automatically see router
forwarding traffic. Router-origin captures/TZSP and CHR labs provide the
router-side data. Capability/runtime validation belongs in the package
implementation follow-up, not an implied promise in the inventory.

## IPsec means three related capabilities

1. `ip xfrm` inspects/configures Linux kernel SAs and policies where permitted.
2. `pki` handles strongSwan certificates/keys; the existing `openssl` also
   helps inspect certificates and TLS material.
3. `swanctl` controls a strongSwan `charon` IKE daemon through VICI, as
   [documented upstream](https://docs.strongswan.org/docs/latest/swanctl/swanctl.html).
   It is not a remote RouterOS administration CLI, and installing swanctl
   alone does not create a working IKE peer.

The measured complete group includes `strongswan-charon`; Debian also pulls
`strongswan-starter` as a dependency. That does not mean the agent image
should start a service by default. A tunnel test must explicitly start and
configure its peer, verify needed algorithms/authentication plugins, and
check the runtime's kernel IPsec support and network capabilities (see
[strongSwan's privilege requirements](https://docs.strongswan.org/docs/latest/install/reducedPrivileges.html)).
No live IKE negotiation or RouterOS-hosted IPsec endpoint was tested here.
For a service-managed host, upstream documents another packaging arrangement
with `charon-systemd`; this image uses tini and is not such a host. See the
[strongSwan installation guidance](https://docs.strongswan.org/docs/latest/install/install.html).

Likewise, throughput tools need a compatible endpoint: RouterOS's
[speed-test](https://manual.mikrotik.com/docs/cli-reference/tool/speed-test/)
uses the remote RouterOS bandwidth-test server. An iperf3 installation is
useful for Linux/CHR lab paths with an iperf3 peer, not a claim of RouterOS
bandwidth-test protocol compatibility.

## Node development and documentation tools

Recommend global fallback commands for all four requested tools:

| Command | Package | Policy |
| --- | --- | --- |
| `tsc` | `typescript` | An explicit supported tool. The current image contains TypeScript 6.0.3 under quickchr's transitive dependency tree, but has no `tsc` on PATH. |
| `cspell` | `cspell` | Useful for documentation and generated text. RouterOS/tikoci vocabulary belongs in project dictionaries/configuration. |
| `markdownlint-cli2` | `markdownlint-cli2` | Useful for Markdown work; honor the repository's rules rather than imposing image-wide rules. |
| `biome` | `@biomejs/biome` | Useful for TypeScript/JavaScript/JSON and repository checks; use the project-pinned version when available. |

A global fallback makes scratch tasks work, while existing projects should
use their lockfiles and local tool versions. This follows TypeScript's
[project-vs-global guidance](https://www.typescriptlang.org/download/).
Primary installation references:
[CSpell](https://cspell.org/docs/installation),
[markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2#install), and
[Biome](https://biomejs.dev/installation/quick-start/).

Do not infer the full footprint from npm's direct package unpacked size:
CSpell dictionaries, transitive dependencies, and platform-specific native
binaries matter. [node-tool-costs-amd64.json](node-tool-costs-amd64.json)
records exact registry versions and fresh-prefix installations, individual
and combined disk usage, resolved dependency versions/integrities, and CLI
probes. The measurements exclude npm's download cache. Fresh npm prefixes
do not credit the unrelated TypeScript copy already under `/opt/bun`, and
an eventual shared Bun-global install may deduplicate differently.

Measured versions and allocated disk usage on Node 24.22.2/npm 11.19.1:

| Package | Resolved version | Fresh-prefix disk usage |
| --- | --- | ---: |
| `typescript` | 7.0.2 | 30.47 MiB |
| `cspell` | 10.4.0 | 13.88 MiB |
| `markdownlint-cli2` | 0.24.0 | 16.77 MiB |
| `@biomejs/biome` | 2.6.5 | 92.88 MiB |
| All four together | Versions above | 153.79 MiB |

These are observed research versions, not instructions to change existing
projects' pinned compiler or linter versions. All four CLI probes succeeded
after installation; Markdownlint processed a clean fixture successfully.
Biome's native binary is a material part of this budget. Do not add a Go
or Rust toolchain merely because a chosen CLI happens to use a native binary.

See [all follow-up cost tables](network-and-node-costs.md) for the individual
network packages, complete IPsec group, and combined scenarios. Apt sizes
and npm disk allocation use different methods; neither is a measured OCI
layer change, and ARM64 has not been measured here.

## Reproduction and inventory coverage

[network-command-probes.tsv](network-command-probes.tsv) records the expanded
PATH probes against the unchanged baseline image. These include the new
packet/IPsec/management commands and all four requested Node tools. The
build inventory script now probes them too, so future artifacts can show
which tools actually landed. The original 113-command snapshot remains a
dated record of the first pass.

```sh
docker run --rm --user root \
  --mount "type=bind,src=$PWD/docs/research/2026-11-agent-tools/research-package-costs.ts,dst=/tmp/research.ts,readonly" \
  --entrypoint bun app-t3code:agent-tools /tmp/research.ts \
  network-extension routeros-network-baseline ipsec-peer

docker run --rm --user root \
  --mount "type=bind,src=$PWD/docs/research/2026-11-agent-tools/research-node-tools.ts,dst=/tmp/research.ts,readonly" \
  --entrypoint bun app-t3code:agent-tools /tmp/research.ts

docker run --rm --user root \
  --mount "type=bind,src=$PWD/docs/research/2026-11-agent-tools/research-packet-tools.ts,dst=/tmp/research.ts,readonly" \
  --entrypoint bun app-t3code:agent-tools /tmp/research.ts
```

These helpers require network and only modify their disposable containers.
No production image packages, router configuration, daemon startup policy,
or container permissions were changed. ARM64 costs and runtime behavior
remain follow-up build/lab checks.
