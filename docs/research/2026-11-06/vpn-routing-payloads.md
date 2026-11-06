# `vpn` and `routing` as Debian-package payloads under `/data`

**Measured 2026-11-06 PT, habitat C (orca, x86_64 Dell, Omarchy).** Issue
[#5](https://github.com/tikoci/app-t3code/issues/5), slice 4. Slice 3
([capture write-up](capture-native-bundle.md)) left the choice open: bake
`vpn` (3.9 MB gzip) and `routing` (9.2 MB gzip) into the image and gate them
by PATH, or reuse the `deb` payload driver. It also listed per-tool
relocation checks to do first: strongSwan's compiled-in plugin directory,
nmap's data directory, and BIRD's and lldpd's `/etc` and `/run` paths.

**Answer: both are `deb` payloads.** Every tool relocates under the payload
root except strongSwan, which needs two pieces of wrapper wiring, and the
PPP family, which cannot work from `/data` at all and moves to the `labs`
Linux guest. Baking would add about 13 MB to every image pull on every
router, selected or not. Baking also does not avoid the strongSwan issue:
it would avoid the paths, but the container runs as `node` and charon,
pppd and tunnels need root or capabilities either way.

## Relocation, tool by tool

As `node`, `CapEff 0`, through the payload shims, with no `LD_LIBRARY_PATH`,
`LD_PRELOAD` or `STRONGSWAN_CONF` in the caller's environment
([amd64 transcript](vpn-routing-amd64.txt), from
[`scripts/research-vpn-routing.sh`](../../../scripts/research-vpn-routing.sh)):

| Tool | Compiled-in paths | Result in the payload |
| --- | --- | --- |
| `wg`, `wg-quick` | none relevant (`wg-quick` calls `ip`, `wg` by name) | works: `wg genkey`, `wg pubkey` |
| strongSwan `pki`, `swanctl`, `pt-tls-client` | `/etc/strongswan.conf`; plugins in `/usr/lib/ipsec/plugins` (`PLUGINDIR`, no runtime override) | raw binary: `no files found matching '/etc/strongswan.conf'`, exit 64. With `STRONGSWAN_CONF` only: `building CRED_PRIVATE_KEY - ED25519 failed, tried 0 builders`. Through the wrapper (both fixes): ed25519 and RSA keys, a self-signed CA, a CSR with a SAN, an issued certificate, `pki --verify` → `certificate trusted` |
| `charon` (`/usr/lib/ipsec/charon`) | same, plus `/var/run/charon.vici` | shipped, not on PATH, not wired: needs root/`CAP_NET_ADMIN`, and its plugins need libcharon's symbols |
| `openvpn` | plugin dir (used only with `--plugin <name>`) | works: `openvpn --genkey secret` |
| `ike-scan` | none | works with `--sport=0` (port 500 needs bind privilege) |
| `bird`, `birdc` | `/etc/bird/bird.conf`, `/run/bird/bird.ctl` | works with `-c`/`-s`/`-P`: two BIRDs on 127.0.0.1/127.0.0.2, ports 11791/11792, reach `Established` and exchange a prefix (`1 imported`, `BGP.as_path: 65002`) |
| `nmap`, `nping` | `/usr/share/nmap`, but checked after `<exe dir>/../share/nmap` | works with no `NMAPDIR`: `Fetchfile found …/root/usr/bin/../share/nmap/nmap.xsl`, NSE `--script-help`, a connect scan |
| `lldpd`, `lldpcli` | `/run/lldpd.socket` (`-u` overrides) | `-v` works; the daemon needs `CAP_NET_RAW` |
| `rdisc6`, `ndisc6`, `arping`, `arp-scan` | none relevant | load; probes need `CAP_NET_RAW` and are refused without it |
| `nft`, `conntrack` | none relevant | load; every operation (even `nft -c`) needs netfilter netlink and `CAP_NET_ADMIN`, refused without it |
| `pppd` (ppp) | `/etc/ppp/options` read before any argument; plugins in `/usr/lib/pppd/2.5.2` | `Can't open options file /etc/ppp/options`, exit 2, as non-root even for `--version` |
| `xl2tpd`, `sstpc` | start `/usr/sbin/pppd` by that path | cannot run a tunnel from `/data`, even with capabilities |

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

### PPP-based peers move to the `labs` guest

`ppp`, `xl2tpd`, `pppoe` and `sstp-client` were in `vpn` by the
[2026-11-05 proposal](../2026-11-05/routeros-protocol-map.md). None of them
can work from a payload. `pppd` requires root for anything, and as a
non-root user it fails on the missing `/etc/ppp/options` before reading
its arguments. `xl2tpd` and `sstpc` start `/usr/sbin/pppd` by that
compiled-in path, which the image does not have. They are now assigned to
the QEMU Linux guest under `labs` (with FRR, keepalived and a FreeRADIUS
server), where a full Debian with root can test RouterOS's SSTP, L2TP and
PPPoE servers. Baking them into the image would not help either: the
container runs as `node`.

## Measurements (amd64, the app image)

The image is `app-t3code:slice4`: this branch's late Dockerfile layers on
`app-t3code:pr10-review` (the PR #10 overlay of `app-t3code:agent-tools`),
Debian 13 trixie.

| | `vpn` | `routing` |
| --- | ---: | ---: |
| Packages (closure the image lacks) | 14 | 23 |
| Download | 3,700,844 B (3.5 MiB) | 9,118,684 B (8.7 MiB) |
| On disk | 11,976,936 B (11.4 MiB) | 35,058,034 B (33.4 MiB) |
| Baked layer instead (slice 3, gzip) | +3.9 MB per image pull (20 packages, including PPP) | +9.2 MB per image pull |
| Install (`durationMs`: download on a fast link, verify, extract, probes, smoke; two runs) | 0.65–0.66 s | 1.03–1.28 s |
| Both groups end to end, fast link (`time t3code-tools install`, two runs) | 1.8–2.1 s | |
| At 1 Mbit/s (computed) | about 30 s | about 73 s |
| Through the shim, 50 runs | `pki --help` 0.44–0.55 s (9–11 ms each, with 15 preloads) | `wg --version` 0.11–0.13 s (2–3 ms each) |

Payload libraries shadowing image libraries: 0 for both. Commands skipped
because the image has them: none.

`routing`'s closure also brings `ucf` and `sensible-utils` as dependencies,
so their commands (`ucf`, `sensible-editor`,
`select-editor`, …) get shims too. They are harmless, but not tools the
group promises. Exposing only the commands of a group's root packages is a
possible follow-up.

## arm64 (QEMU user-mode emulation via binfmt on orca, not native)

Base `node:24-trixie-slim` (arm64) with Bun 1.4.4 copied in, this branch's
scripts, the real `t3code-tools deb-lock` as root, then the installer and
the functional scripts as `node` ([transcript](vpn-routing-arm64-qemu.txt)).
That base lacks libraries the app image has, so its closures are bigger:
`vpn` 29 packages (5.5 MiB), `routing` 54 packages (23.2 MiB).

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

- `bun run check` is green. `bun run test` passes 73 tests across 3 files.
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
  are [#7](https://github.com/tikoci/app-t3code/issues/7).
- arm64 was emulated, not native, and on a bare base image rather than the
  app image.
- No tunnel was brought up, charon never ran, and no BGP session with a
  RouterOS peer was tested (only BIRD to BIRD on loopback).
