# `vpn` and `routing` as Debian-package payloads under `/data`

**Measured 2026-11-06 PT, habitat C (orca, x86_64 Dell, Omarchy).** Issue
[#5](https://github.com/tikoci/app-t3code/issues/5), slice 4. Slice 3
([capture write-up](capture-native-bundle.md)) left the choice open: bake
`vpn` (3.9 MB gzip) and `routing` (9.2 MB gzip) into the image and gate them
by PATH, or reuse the `deb` payload driver. It also listed per-tool
relocation checks to do first: strongSwan's compiled-in plugin directory,
nmap's data directory, and BIRD's and lldpd's `/etc` and `/run` paths.

**Answer: both are `deb` payloads.** Every tool relocates under the payload
root with three exceptions. strongSwan needs two pieces of wrapper wiring.
The PPP family and `lldpd` cannot work from `/data` at all, even in a
privileged container, so they move to the `labs` Linux guest. Baking would add about 13 MB to every image pull on every
router, selected or not. Baking also does not avoid the strongSwan issue:
it would avoid the paths, but the container runs as `node` and charon,
pppd and tunnels need root or capabilities either way.

## Relocation, tool by tool

As `node`, `CapEff 0`, through the payload shims, with no `LD_LIBRARY_PATH`,
`LD_PRELOAD` or `STRONGSWAN_CONF` in the caller's environment
([amd64 transcript](vpn-routing-amd64.txt), from
[`research-vpn-routing.sh`](research-vpn-routing.sh)):

| Tool | Compiled-in paths | Result in the payload |
| --- | --- | --- |
| `wg` | none relevant | works: `wg genkey`, `wg pubkey`; interfaces need `CAP_NET_ADMIN` and the kernel module, not `/dev/net/tun` |
| `wg-quick` | none relevant (calls `ip`, `wg` by name) | needs **root**: as non-root it re-executes itself with `sudo` (line 85 of the packaged script), and the image has no `sudo` → `exec: sudo: not found`. `CAP_NET_ADMIN` alone would not help |
| strongSwan `pki`, `swanctl`, `pt-tls-client` | `/etc/strongswan.conf`; plugins in `/usr/lib/ipsec/plugins` (`PLUGINDIR`, no runtime override) | raw binary: `no files found matching '/etc/strongswan.conf'`, exit 64. With `STRONGSWAN_CONF` only: `building CRED_PRIVATE_KEY - ED25519 failed, tried 0 builders`. Through the wrapper (both fixes): ed25519 and RSA keys, a self-signed CA, a CSR with a SAN, an issued certificate, `pki --verify` → `certificate trusted` |
| `charon` (`/usr/lib/ipsec/charon`) | same, plus `/var/run/charon.vici` | shipped, not on PATH, not wired: needs root/`CAP_NET_ADMIN`, and its plugins need libcharon's symbols |
| `openvpn` | plugin dir (used only with `--plugin <name>`) | works: `openvpn --genkey secret` |
| `ike-scan` | none | works with `--sport=0`; the default source port 500 needs `CAP_NET_BIND_SERVICE` where ports below 1024 are restricted |
| `bird`, `birdc` | `/etc/bird/bird.conf`, `/run/bird/bird.ctl` | works with `-c`/`-s`/`-P`: two BIRDs on 127.0.0.1/127.0.0.2, ports 11791/11792, reach `Established` and exchange a prefix (`1 imported`, `BGP.as_path: 65002`) |
| `nmap`, `nping` | `/usr/share/nmap`, but checked after `<exe dir>/../share/nmap` | works with no `NMAPDIR`: `Fetchfile found …/root/usr/bin/../share/nmap/nmap.xsl`, NSE `--script-help` (script data loads), a connect scan to an open port. Raw scans (`-sS`, refused) and NSE scripts that use raw sockets or capture need `CAP_NET_RAW`; running NSE scripts in general was not tested |
| `lldpd`, `lldpcli` (moved out) | `/run/lldpd.socket` (`-u` overrides); a `_lldpd` user | `-v` works, but `lldpd -d -u /tmp/lldpd.socket` stops at `no _lldpd user for privilege separation, please create it`. The image has no such user, and extraction never runs Debian's maintainer scripts. Upstream also needs root for its privileged monitor. Moved to the `labs` guest |
| `rdisc6`, `ndisc6`, `arping`, `arp-scan` | none relevant | load; probes need `CAP_NET_RAW` and are refused without it |
| `nft`, `conntrack` | none relevant | `--version` works unprivileged natively; ruleset and connection operations (even `nft -c`) need netfilter netlink and `CAP_NET_ADMIN`, and `nft -c` and `conntrack -L` are refused without it |
| `pppd` (ppp) | `/etc/ppp/options` read before any argument; plugins in `/usr/lib/pppd/2.5.2` | `Can't open options file /etc/ppp/options`, exit 2, as non-root even for `--version` |
| `xl2tpd`, `sstpc` | start `/usr/sbin/pppd` by that path | cannot run a tunnel from `/data`, even with capabilities |
| BGP on port 179 | n/a | not a raw-socket or admin matter: binding below 1024 needs `CAP_NET_BIND_SERVICE` only where the namespace restricts it. Docker sets `net.ipv4.ip_unprivileged_port_start=0`, so it is not even restricted here. The RouterOS value is unknown (#7). Not tested |

### strongSwan: config and plugins through the wrapper

strongSwan has no runtime plugin-path setting: `PLUGINDIR` is compiled in,
and `plugin_loader.add_path()` is only called by the build-tree test helper
(`plugin_loader_add_plugindirs`, strongSwan 6.0.1 source). Before it looks
for `libstrongswan-<name>.so` in that directory, its loader looks up
`<name>_plugin_create` with `dlsym(RTLD_DEFAULT, …)`. That lookup is what
monolithic builds use, and it also finds plugins that are already loaded.
So the wrappers of `pki`, `swanctl` and `pt-tls-client`:

- set `STRONGSWAN_CONF=<payload>/root/etc/strongswan.conf` (strongSwan reads
  that variable; the Debian config's `include strongswan.d/*.conf` resolves
  relative to it);
- set `LD_PRELOAD` to `libstrongswan.so.0` plus every plugin that loads
  against it alone. The installer picks them by preloading each plugin with
  `libstrongswan.so.0` into `/bin/true` and keeping those that ld.so loads
  silently. It then checks the whole set together and records it in the
  manifest (`deb.wired`). That gives 14 of the 57 plugin files:
  constraints, dnskey, drbg, nonce, openssl, pem, pkcs1, pkcs7, pkcs8,
  pubkey, random, revocation, tnc-tnccs and x509. The other 43 need
  libcharon's `charon` symbol and belong to the daemon.

`pki --help` then reports `loaded plugins: random x509 revocation constraints
pubkey pkcs1 pkcs7 dnskey pem openssl pkcs8 drbg`. Both `pki` and `swanctl`
still print `plugin '…': failed to load` lines for names in their default
load lists that Debian builds into other plugins or does not ship. A stock
root install of `strongswan-pki` prints the same lines (last section of the
transcript), so this is Debian's behaviour, not the payload's.

`LD_PRELOAD` reaches child processes too. `pki`, `swanctl` and
`pt-tls-client` do not start any. The `ipsec` script is not wired; it starts
`/usr/lib/ipsec/starter` by path and needs root anyway.

`swanctl --version` asks charon over VICI and exits 2 without it (stock
Debian too). Its probe is `swanctl --help`, which prints the version line
offline.

### Probes that cannot exit 0

Each command's probe must prove the binary and its libraries load. Three
cannot exit 0 in an ordinary environment. A group can now declare an exit
code and message that also pass (`versionExit`); exit 0 always passes:

- `birdc` has no version flag and needs a running BIRD:
  `birdc -s /nonexistent/bird.ctl show status` → exit 1, `Unable to connect
  to server control socket`.
- `nft --version` and `conntrack --version` open a netfilter netlink socket
  before doing anything. Natively that works unprivileged, so they exit 0.
  Under QEMU user-mode emulation (arm64 below) the socket protocol is
  missing: `nft` exits 3 with `Unable to initialize Netlink socket`,
  `conntrack` exits 1 with `mnl_socket_open: Protocol not supported`. A
  kernel without nf_tables would do the same. The first arm64 run failed the
  whole `routing` group on `nft`, although BIRD and nmap were fine. That was
  the reason for the change.

Groups now take a list of smoke tests. `vpn`: `pki --gen --type ed25519`
(must print a PEM key, so the plugin wiring is exercised) and `wg genkey`.
`routing`: `nmap --script-help banner` (NSE data from the payload) and
`bird -p -c` on a BGP config (`BIRD_BGP_CONF`).

### PPP-based peers and lldpd move to the `labs` guest

`ppp`, `xl2tpd`, `pppoe` and `sstp-client` were in `vpn` by the
[2026-11-05 proposal](../2026-11-agent-tools/routeros-protocol-map.md). None of them
can work from a payload. `pppd` requires root for anything, and as a
non-root user it fails on the missing `/etc/ppp/options` before reading
its arguments. `xl2tpd` and `sstpc` start `/usr/sbin/pppd` by that
compiled-in path, which the image does not have. They are now assigned to
the QEMU Linux guest under `labs` (with FRR, keepalived and a FreeRADIUS
server), where a full Debian with root can test RouterOS's SSTP, L2TP and
PPPoE servers. Baking them into the image would not help either: the
container runs as `node`.

`lldpd` follows the same reasoning (review round, below). It refuses to
start without a `_lldpd` account for privilege separation, and its monitor
needs root. `lldpcli` alone only talks to a running `lldpd`. Taking it out
leaves `routing` at 21 packages.

## Measurements (amd64, the app image)

The image is `app-t3code:slice4`: this branch's late Dockerfile layers on
`app-t3code:pr10-review` (the PR #10 overlay of `app-t3code:agent-tools`),
Debian 13 trixie.

| | `vpn` | `routing` |
| --- | ---: | ---: |
| Packages (closure the image lacks) | 14 | 21 (23 before `lldpd` moved out) |
| Download | 3,700,844 B (3.5 MiB) | 8,687,316 B (8.3 MiB) |
| On disk (latest run) | 11,976,042 B (11.4 MiB) | 34,074,039 B (32.5 MiB) |
| Baked layer instead (slice 3, gzip) | +3.9 MB per image pull (20 packages, including PPP) | +9.2 MB per image pull |
| Install (`durationMs`: download on a fast link, verify, extract, probes, smoke; four runs) | 0.64–0.74 s | 0.99–1.30 s |
| Both groups end to end, fast link (`time t3code-tools install`, four runs) | 1.75–2.15 s | |
| At 1 Mbit/s (computed) | about 30 s | about 70 s |
| Through the shim, 50 runs | `pki --help` 0.44–0.55 s (9–11 ms each, with 15 preloads) | `wg --version` 0.11–0.13 s (2–3 ms each) |

Payload libraries shadowing image libraries: 0 for both. Commands skipped
because the image has them: none.

`routing`'s closure still brings `ucf` and `sensible-utils` as dependencies,
so their commands (`ucf`, `sensible-editor`,
`select-editor`, …) get shims too. They are harmless, but not tools the
group promises. Exposing only the commands of a group's root packages is a
possible follow-up.

## Review round (Codex, GPT-6.1 Sol, on the draft PR)

The review found no blocking bug. It found privilege claims that were wrong
or unproven, and three latent wrapper-rule bugs. Each finding was checked on
the app image before it was changed:

- `lldpd` cannot start from the payload (`no _lldpd user for privilege
  separation`, reproduced): moved to the `labs` guest, see above.
- `wg-quick` needs root, not just `CAP_NET_ADMIN` (`exec: sudo: not found`,
  reproduced). Kernel WireGuard needs no `/dev/net/tun`; only OpenVPN's
  tunnel does. The `vpn` privileges string now splits these.
- The README's "apart from ping, [core tools] work without extra
  privileges" was wrong both ways. `mtr-packet` carries a `cap_net_raw` file
  capability (`security.capability` = `0x2000` permitted+effective),
  `radsniff` (in core's `freeradius-utils`) and `traceroute -T` are refused,
  and `ping` has **no** file capability: it works only because Docker sets
  `net.ipv4.ping_group_range` to all groups. Core now reports
  `core.privileges`, and the README has a per-tool privilege table with
  what was tested.
- BGP on 179 needs `CAP_NET_BIND_SERVICE` (namespace-dependent), not
  `CAP_NET_RAW`. "NSE needs none" was narrowed to NSE data plus non-raw
  scripts. The write-up no longer says `nft`/`conntrack` need privileges
  for every operation.
- Wrapper rules: a rule whose commands get no wrapper is no longer resolved
  (an image that provides the tool cannot fail the payload). A command
  preloaded by several rules has its merged, deduplicated set checked
  together. Env values are shell-quoted literals; only `{root}` expands.
  Each has a new unit test, and the quoting test runs the generated shell.
- `test/routing-tools.sh` arms BIRD cleanup before the first start and waits
  for exit. It requires the BIRD port to be `open`. Its checks no longer
  pipe into `grep -q`, which can SIGPIPE a producer under `pipefail`. The
  evidence script runs with `pipefail`, so transcript exit codes are real
  (raw `pki` 64, config-only `pki` 1).

## Review round (CodeRabbit, on the ready PR)

There were 11 findings, all valid once checked against the tools:

- **arp-scan vendor names.** arp-scan looks for `ieee-oui.txt` and
  `mac-vendor.txt` in the current directory and then at compiled-in paths
  the image lacks. A crafted pcap (`ARP_REPLY_PCAP`: one ARP reply from
  `4c:5e:0c:11:22:33`) decoded with `arp-scan --readpktfromfile` shows
  `(Unknown)` and two `Cannot open MAC/Vendor file` warnings without the
  files, and `Routerboard.com` with them. That needs no interface and no
  privilege. Wrapper rules gained `args` (placed before the caller's;
  arp-scan takes the last `--ouifile`, so the caller still wins), and the
  same decode is now a `routing` smoke test and part of
  `test/routing-tools.sh`.
- **swanctl config.** swanctl reads `SWANCTL_DIR` (the string is in the
  binary). The wrapper now sets it too. Rule variables became defaults: a
  caller's own `STRONGSWAN_CONF` or `SWANCTL_DIR` (even an empty one) wins.
- **LD_PRELOAD and spaces.** ld.so splits `LD_PRELOAD` on spaces and colons
  with no escape. Preloads are now file names found on the wrapper's
  `LD_LIBRARY_PATH`, which splits only on `:`/`;`. Each must be the first
  file of that name on that path. With `T3CODE_TOOLS_HOME="/data/with
  space/tools"`, both groups installed and both functional scripts passed.
  A payload path containing `:` or `;` is refused with a clear error.
- **Payload id.** Wrapper rules (and a `WRAPPER_FORMAT` version) are hashed
  into the id of groups that have them, so a corrected rule reinstalls
  them. `capture` has no rules and keeps its id.
- **Smoke `{input}`.** The smoke test runner now substitutes `{input}`
  inside an argument too (`--readpktfromfile={input}`). The first real run
  of the new arp-scan smoke test failed on exactly that, which a new unit
  test now covers.
- **Docs and tests:**
  - The README's privilege introduction separates host settings (the ping
    sysctl) from container privileges.
  - The lab guest is something you boot and provision yourself.
  - Activation no longer implies compatibility for operations the probes do
    not reach.
  - The README routing numbers were stale and are updated.
  - `ike-scan`'s exit status is checked.
  - The evidence script keeps nmap's pipeline status.
  - The docker test forwards `CAPTURE_TOOLS_QEMU_USER` and
    `ROUTING_TOOLS_QEMU_USER` to the scripts for emulated images.

## arm64 (QEMU user-mode emulation via binfmt on orca, not native)

Base `node:24-trixie-slim` (arm64) with Bun 1.4.4 copied in, this branch's
scripts, the real `t3code-tools deb-lock` as root, then the installer and
the functional scripts as `node` ([transcript](vpn-routing-arm64-qemu.txt)).
That base lacks libraries the app image has, so its closures are bigger:
`vpn` 29 packages (5.5 MiB), `routing` 54 packages (23.2 MiB). This run was
before the review round, with `lldpd` still in `routing`.

- `vpn`: ready on the first attempt. The same 14 strongSwan plugins were
  selected and preloaded, and [`test/vpn-tools.sh`](../../../test/vpn-tools.sh)
  passed (WireGuard keys, the `pki` CA and certificate chain, `openvpn
  --genkey`, `ike-scan`).
- `routing`: the first two runs failed the whole group, first on `nft
  --version` (exit 3) and then on `conntrack --version` (exit 1), both on
  the missing netfilter netlink protocol. With their declared exits, it
  was ready on the first attempt (25 s emulated, 108 MB on disk with the
  bare base's larger closure).
  [`test/routing-tools.sh`](../../../test/routing-tools.sh) passed with
  `ROUTING_TOOLS_QEMU_USER=1`, including the BIRD prefix exchange and nmap.
  That flag skips only the privilege-refusal checks (nft, conntrack, arping,
  arp-scan): under emulation they fail on the missing netlink protocol, not
  on a missing privilege, so an emulated run claims nothing about
  privileges. BIRD logs `Cannot disable transparent huge pages` there
  (QEMU does not implement that `prctl`) and carries on.

## Evidence for the implementation (habitat C)

- `bun run check` is green. `bun run test` passes 77 tests across 3 files.
  The new tests cover a synthetic strongSwan-like group: wrapper variables,
  preload selection order and the combined check, the user's own
  `LD_PRELOAD` kept after the payload's, other commands left unwired, a
  missing preload library, a set that does not load together, declared
  exit codes in both install and stale-payload probes, and every smoke
  test in the list. They also cover the real `vpn` and `routing`
  definitions and the PPP reassignment.
- `APP_T3CODE_DOCKER_IMAGE=app-t3code:slice4 bun test
  test/container-replacement.test.ts`: under `all`, `dev`, `capture`, `vpn`
  and `routing` install in the background and the three functional scripts
  pass as `node` in `-c` and `-lc` shells. Later containers deselect them
  (shims gone, payloads kept), then a container with `--network none` and
  `capture vpn routing` relinks all three with the same ids and no
  reinstall, and runs their scripts again.

## Limits

- Nothing ran on a RouterOS container. Capabilities, `/dev/net/tun`, and
  whether a RouterOS host kernel offers netfilter netlink to a container
  are [#7](https://github.com/tikoci/app-t3code/issues/7). So are two
  Docker defaults the unprivileged results lean on:
  `net.ipv4.ping_group_range` (core `ping`) and
  `net.ipv4.ip_unprivileged_port_start` (BGP on 179, low-port listeners).
- arm64 was emulated, not native, and on a bare base image rather than the
  app image.
- No tunnel was brought up, charon never ran, and no BGP session with a
  RouterOS peer was tested (only BIRD to BIRD on loopback).
