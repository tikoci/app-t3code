# RouterOS protocol map → Linux counterparts

**Review addendum (Claude, 2026-11-05).** Closes the one vector the earlier
audit did not cover: which RouterOS protocols an agent in this container can
*observe*, *speak as a client*, or *serve as a peer*, and which package or
existing tool covers each. It complements [REVIEW.md](REVIEW.md); where this
corrects an earlier evidence narrative, this file says so explicitly.

Evidence level: RouterOS menus were checked with `rosetta` 0.11.3 (DB release
v0.11.3, which ends at 7.25rc1). Package versions and dependency counts come
from `apt-get install -s --no-install-recommends` against the local amd64
image `sha256:adf72089…` (Debian 13.7). **Nothing below was run against a
live RouterOS peer.** Tool coverage is therefore *pending* until a CHR lab
test proves it.

## The deciding constraint is privilege, not package size

Every candidate below is small: the complete PPP/VPN client set
(`openvpn sstp-client ppp xl2tpd pppoe`) adds 11 packages, and no single
candidate exceeds 4.5 MiB in package size. The real question is whether the
container can *use* the tool. A RouterOS container shares the router's
kernel. A tool works only if MikroTik's kernel has the needed module and
the container has the needed capability or device. Three tiers:

| Tier | Needs | Examples |
| --- | --- | --- |
| **U** user space | Outbound TCP/UDP, or a listener on a port ≥1024 | REST/API, SSH, SNMP get, RADIUS client, DNS/DoH, BGP *active* session, NetFlow/syslog/TZSP receivers, MQTT, btest |
| **R** raw socket | `CAP_NET_RAW` (or `ping_group_range` for ICMP) | ping/arping, traceroute variants, LLDP/CDP send, OSPF/VRRP, DHCP client, PPPoE discovery, live tcpdump/dumpcap |
| **A** interface admin | `CAP_NET_ADMIN`, kernel module, often `/dev/net/tun` or `/dev/ppp` | WireGuard/GRE/VXLAN/VLAN interfaces, IPsec SAs, OpenVPN, SSTP/L2TP/PPTP/PPPoE sessions, nftables, conntrack, tc |

RouterOS state that changes the answer (rosetta changelog search, DB v0.11.3):

- **7.24 added privileged containers** (`/container … privileged=`), and
  `/container` has a `devices=` pass-through. The `/app` YAML documents
  `devices` (7.23+); a YAML equivalent for `privileged` is **unverified**.
- What an *unprivileged* RouterOS container actually gets (capability set,
  `ping_group_range`, `/dev/net/tun`, `/dev/ppp`, `/dev/kvm`, kernel modules
  for wireguard/l2tp/gre/vxlan/xfrm/tun) is **unmeasured**. This is the
  single cheapest, highest-value probe left before deciding the `vpn` group.
  Run it on a 7.24+ CHR and on one physical ARM/ARM64 device:

  ```sh
  grep -E '^Cap(Eff|Bnd)' /proc/self/status
  cat /proc/sys/net/ipv4/ping_group_range
  ls -l /dev/net/tun /dev/ppp /dev/kvm
  ip link add t0 type dummy && ip link del t0          # NET_ADMIN?
  ip link add wg0 type wireguard && ip link del wg0     # module?
  ```

  Repeat with `privileged=yes` and with `devices=` set.

**Way out when tier A is denied:** run the Linux peer as a **QEMU guest inside
`labs`** (for example, a small Alpine/Debian cloud image on qcow2 under
`/data`). The guest has its own kernel and root, so openvpn, sstp-client,
xl2tpd, strongSwan, FRR, and lldpd work regardless of container
capabilities. It connects to a CHR over the same socket/user networking that
quickchr already uses. This is slower under TCG, but it is the only design
that gives full Linux-peer coverage on every host. CHR-to-CHR covers
RouterOS-to-RouterOS interoperability, and centrs already speaks several
MikroTik-only protocols.

## Already covered by core — correction to earlier research

`centrs` (image resolves `next` = **0.1.10**; `bunx @tikoci/centrs@0.1.10 --help`
lists the protocols below) already implements:
`rest-api, native-api, ssh, snmp, mndp, mac-telnet, romon, winbox-terminal, btest`.

- **Bandwidth test:** `centrs btest client|server` speaks MikroTik's
  btest protocol (TCP/UDP, control port 2000). Earlier text in
  [network-and-agent-tools.md](network-and-agent-tools.md) said nothing
  substituted for RouterOS's bandwidth-test peer. centrs does; iperf3 is
  only for Linux↔Linux paths.
- **MNDP / MAC-Telnet / RoMON / WinBox terminal:** these MikroTik-only
  protocols are covered by centrs, not by Debian packages. Required
  privileges for RoMON (L2 ethertype) inside the container are unverified.

## Protocol map

Status: **core** = in image today · **base** = in the accepted small
baseline/networking proposal · **group** = assigned to a proposed group ·
**new** = not in any proposal (this review's suggestion) · **uv** = no image
cost; run via the proven persistent `uvx` path · **lab** = Linux peer in a
QEMU guest. Tier is the privilege needed for the *peer/client* role; offline
decoding of a pcap is always tier U.

| RouterOS feature (menu) | Observe / decode | Client / peer tool | Tier | Status / recommendation |
| --- | --- | --- | --- | --- |
| REST, API, API-SSL, SSH, SFTP | — | centrs, curl, openssh | U | core |
| FTP/TFTP/HTTP fetch targets (`/tool/fetch`, backups) | tshark | curl (client); `python3 -m http.server`, uv `pyftpdlib` (server on ≥1024) | U | core + uv recipe |
| SOCKS / web proxy (`/ip/socks`, `/ip/proxy`) | tshark | curl `--socks5`/`-x` | U | core |
| MNDP, MAC-Telnet, RoMON, WinBox terminal | tshark (MNDP) | centrs | U/R | core |
| Bandwidth test | tshark | **centrs btest** | U | core (correction above) |
| DNS server, DoH client (`/ip/dns`) | tshark | `dig` (+https/+tls), `nslookup` | U | base (`bind9-dnsutils`) |
| NTP client/server (`/system/ntp`) | tshark | *none proposed*; `sntp`/`ntpsec-ntpdate` query only | U | **new**, small, optional |
| SNMP v1/v2c/v3 (`/snmp`) | tshark | `snmpget/walk`, centrs snmp | U | base. MIKROTIK-MIB is not shipped; fetch it per task |
| SNMP traps | tshark | `snmptrapd` (11 pkgs) | U only if trap port is ≥1024; default 162 needs bind privilege | **new**, optional; or a uv `pysnmp` receiver |
| RADIUS client, User Manager, CoA (`/radius`, `/user-manager`) | tshark | `radclient/radtest` | U | base (`freeradius-utils`) |
| RADIUS server for RouterOS-as-client | tshark | uv `pyrad`; full FreeRADIUS server | U (1812 needs bind privilege) | lab |
| 802.1X (`/interface/dot1x`) | tshark | `eapol_test` (Debian `eapoltest`) | U for RADIUS-side EAP | **new**, niche, optional |
| Syslog remote logging | tshark | `socat`/`nc` listener; `logger` (present) | U if remote port ≥1024 | base; document the recipe |
| Traffic-Flow (NetFlow v1/5/9, IPFIX) | tshark (`cflow`) | `nfcapd`/`nfdump` collector (16 pkgs) | U | **new** → `capture` |
| Sniffer / mangle `sniff-tzsp` (TZSP) | tshark TZSP decoder (offline proven) | **`udpdump` extcap ships with Debian tshark** (verified in `…/wireshark/extcap/`) | U | group `capture`. Live TZSP through `udpdump` is an **unprivileged** live path, but this decode path is untested. Alternative path: sniffer file → `centrs transfer` → tshark |
| LLDP / CDP (`/ip/neighbor` `protocol=cdp,lldp,mndp`) | tshark | `lldpd` (speaks LLDP, CDP, EDP, and FDP; 7 pkgs) | R | **new**; lab or `routing` group |
| ARP, IPv6 ND/RA | tshark | `arping`, `arp-scan`, `ndisc6` (`rdisc6`) | R | **new**, tiny; consider base |
| DHCPv4/v6 server, relay, PD | tshark | `nmap --script broadcast-dhcp*`; a real client needs raw socket and NET_ADMIN | R/A | optional (`nmap` already optional) |
| BGP (`/routing/bgp`) | tshark | uv **`exabgp`**, or `bird2`. Use an *active* session to RouterOS; listening on 179 needs bind privilege | U | **uv recipe** first; `bird2` (6 pkgs) for a full speaker |
| OSPFv2/v3, RIP, BFD, PIM-SM (`/routing/*`) | tshark | `bird2` (OSPF/RIP/BFD/Babel), FRR (adds PIM, IS-IS, LDP) | R/A | **new**: `bird2` in a `routing`/labs set; FRR only as a lab guest |
| RPKI (`/routing/rpki`) | tshark | RTR cache (stayrtr/routinator) | U | lab/optional; no Debian-small option measured |
| VRRP (`/interface/vrrp`) | tshark | `keepalived` | R/A | lab |
| MQTT (`/iot/mqtt`) | tshark | `mosquitto-clients` (3 pkgs); broker for RouterOS-as-publisher | U | **new**, tiny; consider base |
| WireGuard / Back To Home | tshark | `wg` (`wireguard-tools`) | U for `wg genkey/pubkey`; A for interfaces | group `vpn`. Key generation and config work with no privileges |
| IPsec IKEv1/v2 (`/ip/ipsec`) | tshark (ISAKMP, ESP) | strongSwan (`swanctl`, `pki`, `charon`) | A (kernel xfrm); `kernel-libipsec` needs TUN | group `vpn` |
| **OpenVPN** (`/interface/ovpn-*`, TCP and UDP) | tshark | `openvpn` 2.6.14 (4 pkgs) | A + `/dev/net/tun` | **new → `vpn`** |
| **SSTP** (`/interface/sstp-*`) | tshark (TLS) | `sstp-client` 1.0.20 + `ppp` | A + `/dev/ppp` | **new → `vpn`** |
| L2TP / L2TP+IPsec / L2TPv3 (`/interface/l2tp-*`) | tshark | `xl2tpd` + `ppp` (+ strongSwan); `ip l2tp` for v3 | A | **new → `vpn`** |
| PPPoE (`/interface/pppoe-*`) | tshark | `pppoe` (`pppoe-discovery` probes a server; R) + `ppp` session (A) | R/A | **new → `vpn`** |
| PPTP | tshark | `pptp-linux` | A | skip; legacy, include only on request |
| GRE, IPIP, 6to4, VXLAN, VLAN (`/interface/*`) | tshark | `ip link add type …` (`iproute2`) | A + modules | base (`iproute2`); runtime depends on tier A |
| EoIP (MikroTik GRE variant) | tshark: GRE layer; EoIP payload decode **unverified** | no in-kernel Linux driver | A | gap; CHR-to-CHR only |
| MPLS/LDP/VPLS | tshark | FRR `ldpd` | A | lab only |
| ZeroTier (`/zerotier`) | tshark | `zerotier-one`, not in Debian main | A + TUN | out of scope; RouterOS-side |
| SMB / ROSE storage (`/ip/smb`, `/disk`) | tshark | `smbclient` (large Samba dependencies); NFS/iSCSI mounts need privilege | U/A | optional; out of the default set |
| Hotspot / captive portal | tshark | curl | U | core |
| SMTP (`/tool/e-mail`) | tshark | uv `aiosmtpd` sink on ≥1024 | U | uv recipe |
| Container/registry (`/container`) | — | curl against the OCI API | U | core |

## Recommendations for the PR

1. **Run the capability probe first** (above, on 7.24+ CHR and on one physical
   ARM device; unprivileged, `privileged=yes`, and `devices=`). The `vpn`
   group's usefulness depends entirely on it. Record the result per habitat
   and per RouterOS version in the README group table, as Q5 in REVIEW.md
   already asks.
2. **Expand `vpn` to the PPP/TLS families RouterOS actually serves:**
   `openvpn sstp-client ppp xl2tpd pppoe` in addition to strongSwan and
   WireGuard (adds 11 packages per apt simulation). Document `wg genkey` and
   `pki` as tier-U uses that work without capabilities.
3. **Decide where routing/L2 peers live.** Either add a small `routing` group
   (`bird2 lldpd ndisc6 arping`) or fold those packages into `labs`. Keep FRR,
   keepalived, and full RADIUS servers as *lab-guest* components, not image
   packages. This keeps the six-group contract stable if folded into `labs`.
4. **Add `nfdump` to `capture`.** Document `udpdump` as the unprivileged live
   TZSP and UDP path once a TZSP-through-`udpdump` decode is proven.
5. **Treat uv/uvx as the long-tail protocol path.** `exabgp`, `scapy`
   (offline fixture crafting for MNDP/LLDP/CDP/TZSP), `pysnmp`, `pyrad`,
   `aiosmtpd`, and `pyftpdlib` cost nothing in the image and persist under
   `/data` via the proven mechanism. Ship a short recipe list instead of
   packages, and keep project lockfiles authoritative.
6. **Small base candidates to decide explicitly:** `mosquitto-clients`,
   `arping`, and `ndisc6` are each 1–3 packages. Include an NTP query tool only
   if NTP troubleshooting matters. These are cheap, but they still need
   tier R or a ≥1024 port to be useful.
7. **Add a "Linux peer guest" to `labs` scope** as the answer when tier A is
   unavailable. A persisted qcow2 under `/data`, booted by the same QEMU,
   is the only path to OpenVPN, SSTP, L2TP, IPsec, and OSPF interop that
   works on every host.
