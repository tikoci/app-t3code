# Native bundle spike: `capture` as a Debian-package payload under `/data`

**Measured 2026-11-06 PT, habitat C (orca, x86_64 Dell, Omarchy).** Issue
[#5](https://github.com/tikoci/app-t3code/issues/5), slice 3. Question: can a
Debian-package-derived native tool group live under `/data` as user `node`
(no root at runtime), with working loaders, libraries, plugins and data paths,
without a global `LD_LIBRARY_PATH` and without overlaying `/usr` or `/lib`?
How does that compare with baking the packages into the image and gating them
by PATH only?

**Answer: yes, and that is what ships for `capture`.** The Debian closure the
image lacks is pinned at image build time from apt's verified metadata. At
runtime it is downloaded, checked against size, SHA256 and control fields,
and extracted with `dpkg-deb -x` as `node`. Per-command wrappers set the
payload's library directory for their own process tree. It reuses the slice-2
payload machinery (lock, states, manifest, atomic activation, refresh with
rollback, prune).

## What was compared

| | Approach | Where it runs | Verdict |
| --- | --- | --- | --- |
| a | Closure minus image, `.deb`s extracted under `/data` as node; one `sh` wrapper per command sets `LD_LIBRARY_PATH` to the payload's library dir, then `exec`s the real binary | runtime, background | **chosen** |
| a′ | Same, but the wrapper runs `ld.so --library-path …` (no environment variable at all) | runtime | rejected: `/proc/self/exe` becomes `ld.so`, so Wireshark computes `Program: /usr/lib/x86_64-linux-gnu` and loses its program-relative data and plugin dirs ([transcript](capture-bundle-amd64.txt), "ld.so" section) |
| a″ | Same, with an `$ORIGIN` RUNPATH patched into each ELF (`patchelf`) | runtime | not built: needs `patchelf` in the image (a new dependency) to patch at install time, and it changes the bytes the SHA256 pins describe; the env-var wrapper already scopes the path to the process tree |
| b | `apt-get install` in the image; `dpkg-divert` the commands out of `/usr/bin` into a group dir that only selection links onto PATH | image build | works only with extra symlinks (below); costs every router the full size whether selected or not |
| c | Ship a prebuilt bundle per arch (tarball from CI) | CI + runtime | not pursued: needs our own hosting and signing; Debian already publishes signed, hash-pinned artifacts |

## Measurements

The probes are reproducible: [`research-capture-bundle.ts`](research-capture-bundle.ts)
runs [`research-capture-bundle.sh`](research-capture-bundle.sh)
(or `--sizes` → [`research-bake-sizes.sh`](research-bake-sizes.sh))
as root in a disposable container. The payload steps switch to `node`.
The amd64 image is `app-t3code:slice3`: this branch's late Dockerfile layers on
the local `app-t3code:agent-tools`, Debian 13.7 trixie. Raw output:
[amd64 transcript](capture-bundle-amd64.txt) / [JSON](capture-bundle-amd64.json),
[arm64 transcript](capture-bundle-arm64-qemu.txt) / [JSON](capture-bundle-arm64-qemu.json),
[bake sizes](bake-sizes-amd64.json), [divert check](bake-divert-amd64.txt).

### `capture` (tcpdump 4.99.5, Wireshark 4.4.19, nfdump 1.7.5)

| Measure (amd64) | (a) payload under `/data` | (b) baked + PATH gate |
| --- | ---: | ---: |
| Packages | 42 (closure the image lacks) | 42 (same set) |
| Download | 31,954,984 B (30.5 MiB) `.deb`s, once per lock change, only where selected | +41,648,417 B gzip layer (41.6 MB), every image pull on every router |
| On disk | 159,569,254 B (152.2 MiB) in the home, only where selected | +157,178,522 B in the image, every router |
| Install time (orca link) | download 2.4 s + verify 0.5 s + extract 1.1–1.2 s (three probe runs; in a fourth, run while the arm64 emulation loaded the host, the mirror download took 304 s: [JSON](capture-bundle-amd64-stalled-mirror.json)). The real installer took 4.7 s end to end, including 9 version probes and the decode smoke test | apt 14.4–18.0 s at build |
| At 1 Mbit/s (computed, CHR free license) | about 4.3 min, in the background; T3 is serving meanwhile | about 5.6 min more per image update, before T3 starts |
| `tshark -r` first / warm average | 0.16–0.18 s / 0.16–0.24 s | 0.16 s |
| Wrapper overhead | 1.4 ms per command (`readlink -f` plus `exec`) | none |
| Payload libraries that shadow an image library | 0 | n/a |

The payload as a single `tar | gzip -6` would be 43,458,174 B. That is
larger than the `.deb` downloads, which is another reason not to build our
own bundles (c).

Breaking the closure down (apt metadata against the same image):
`tcpdump`+`nfdump` alone are 16 packages, 3.1 MB to download and 9.2 MB
unpacked. nfdump pulls `librrd8t64` and with it cairo, pango and harfbuzz.
`tshark` alone is 26 packages, 28.9 MB and 151.6 MB. TShark is the whole
cost. Splitting the group would save little and break its single readiness
contract.

### Correctness (amd64, as `node`, no capabilities: `CapEff 0`)

Through the shims on PATH (`/data/.local/share/t3code-tools/bin`), with no
`LD_LIBRARY_PATH` in the shell environment or in PID 1:

- `tshark -r` decodes the synthetic TZSP-in-pcapng fixture
  (`TZSP_DNS_PCAPNG`, from the [2026-11-05 probe](../2026-11-agent-tools/packet-tools-probe.json)) to
  `tzsp.encap=1`, `dns.qry.name=routeros.example`, as fields and JSON.
- `tshark -G folders` reports Program, Global configuration and Global Plugins
  inside the payload (`…/groups/capture/<id>/root/usr/…`). Debian's Wireshark
  4.4 resolves them relative to the binary, so no `WIRESHARK_*` variables are
  needed. `tshark -G plugins` lists 29 entries. `tshark -G fields` has 13,434
  RADIUS fields, against 91 with `WIRESHARK_DATA_DIR=/nonexistent`, so the
  payload's RADIUS dictionaries are in use.
- `tcpdump -nr`, `capinfos`, `editcap -F pcap`, `mergecap` (2 packets) and a
  `tshark -x | text2pcap` round trip all work.
- `dumpcap -D` and `tshark -D` list interfaces (exit 0) without privileges.
- Live capture is refused: `dumpcap -i lo` says `You do not have permission to
  capture on device "lo"` (exit 1), and `tcpdump -i lo` fails with
  `socket: Operation not permitted`. Installing grants nothing (#7 covers
  real RouterOS capabilities).
- `nfcapd -p 9995` (unprivileged port) collected one NetFlow v5 record sent to
  127.0.0.1. `nfdump -R` reads it back as `192.0.2.1 → 192.0.2.2 :53, 5
  packets, 500 bytes`.

### (b) PATH gating needs symlinks to stay correct

Diverting `/usr/bin/tshark` to `/usr/lib/t3code/capture/bin/tshark`
([check](bake-divert-amd64.txt)) moves Wireshark's program-relative paths
with it: `Global configuration: /usr/lib/t3code/capture/share/wireshark`,
plugins 29 → **0**, RADIUS fields 13,434 → **91**. Decoding still "works",
silently degraded. Diverting into `/usr/lib/t3code/capture/usr/bin/` with
`usr/share → /usr/share` and `usr/lib → /usr/lib` symlinks restores 29
plugins and 13,434 fields. So (b) is viable, but it needs per-tool
relocation knowledge as well, and its size cost is paid everywhere.

### arm64 (QEMU user-mode emulation via binfmt on orca, not native)

Two runs, both QEMU user-mode on orca, base `node:24-trixie-slim` (arm64
variant, `sha256:0820eaa8…` index). That base lacks libraries the app image
has, so its closure is larger than the app image's would be.

**Spike** ([transcript](capture-bundle-arm64-qemu.txt), [JSON](capture-bundle-arm64-qemu.json)):

| Measure (arm64, emulated) | (a) payload | (b) baked |
| --- | ---: | ---: |
| Packages | 67 | 67 |
| Download / gzip layer | 37,099,120 B `.deb`s | +47,431,144 B |
| On disk | 184,023,513 B | +178,919,014 B |
| Install | download 49.4 s, verify 21.1 s, extract 13.5 s (emulated CPU) | apt 99.6 s |
| `tshark -r` first / warm | 1.97 s / 2.02 s (emulation) | 2.42 s |
| Payload libraries shadowing image libraries | 0 | n/a |

The emulated timings measure QEMU more than the tools: wrapper overhead
reads 72 ms there against 1.4 ms natively on amd64.

Correctness matched amd64 for everything that does not touch a network
interface. tshark decoded the fixture with Global configuration and plugins
inside the payload (29 plugins), and RADIUS fields were 13,434 against 91 with
the data dir hidden. `capinfos`, `editcap`, `mergecap`, `text2pcap`,
`tcpdump -r` and nfcapd→nfdump (`192.0.2.1 → 192.0.2.2 :53, 5 packets, 500
bytes`) all worked. `ld.so --library-path` broke the program-relative paths
the same way, and (b) with symlinks kept 29 plugins.

**Not proven on arm64:** `dumpcap -D`, `tshark -D` and the live-capture
refusal. Under QEMU user mode they fail earlier, on `SIOCETHTOOL … ioctl
failed: Inappropriate ioctl for device`, because QEMU does not implement
that ioctl. The privilege behaviour on arm64 is therefore untested here.
Native arm64 (a RouterOS ARM64 router) is #7 territory.

**Implementation** ([transcript](capture-impl-arm64-qemu.txt)): the real
`t3code-tools deb-lock` as root (83 packages for arm64 debian-trixie, 38.7
MiB download, 190.0 MiB unpacked by apt metadata, 58 s including `apt-get
update`), then `t3code-tools install` as node: ready in 37 s, all 9 version
probes and the decode smoke test passed, 196,305,250 B on disk.
`test/capture-tools.sh` then passed with `CAPTURE_TOOLS_QEMU_USER=1`. In
that recorded run the flag skipped only `dumpcap -D`, and the live-capture
checks passed merely because capture failed: on the ioctl, not on a missing
privilege. After review the script requires an explicit permission error,
treats a timeout or any other failure as a test failure, and under
`CAPTURE_TOOLS_QEMU_USER=1` skips the live-capture checks as well, so an
emulated run claims nothing about privileges. `t3code-tools init` relinked the payload after its shims were
deleted. The container had network for this run; the offline relink is
proven on amd64 (`--network none` in the docker test). (The lock has more
packages than the spike's 67 because the spike first installs `curl`, whose
dependencies then count as part of the image.)

### The other small native groups, if baked (amd64)

| Group | Closure packages | Download | Unpacked (apt) | Baked files | Baked layer (gzip) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vpn | 20 | 4.4 MB | 14.9 MB | 12.1 MB | 3.9 MB |
| routing | 23 | 9.1 MB | 36.1 MB | 32.7 MB | 9.2 MB |
| capture | 42 | 32.0 MB | 160.9 MB | 157.2 MB | 41.6 MB |

## Decision

`capture` is a `deb` payload. Baking it would make every image pull about 42
MB bigger and every router's image about 157 MB bigger, selected or not,
and RouterOS `auto-update` pulls a new image for each release. The payload is
downloaded once per Debian lock change, and only by routers that select it.
The payload is also the more correct of the two: Wireshark relocates
naturally under the payload root, while (b) needed symlink scaffolding to keep
its plugins and data.

`vpn` (3.9 MB gzip) and `routing` (9.2 MB) are cheap enough to bake and gate
by PATH. Their tools still need a relocation check per tool before either
approach is chosen. Candidates to verify, not findings: strongSwan's
compiled-in plugin directory, nmap's data directory (`NMAPDIR`), and BIRD's
and lldpd's default `/etc` and `/run` paths. They also need privileges (#7)
for anything beyond key generation, scans and an unprivileged BGP session.
That choice is left to the next slice.

## How the implementation works

- **Build time** (`Dockerfile`, after the last apt layer, as root with
  `HOME=/root`): `apt-get update && t3code-tools deb-lock`. For each
  `delivery: "deb"` group it runs `apt-get install -s --no-install-recommends
  <packages>` to get the closure the image lacks, `--print-uris` for each
  file's archive (`debian` or `debian-security`), and `apt-cache show` for
  Version, Architecture, Size, Installed-Size and SHA256. The result is
  `groups/capture/debs.lock.json`. It is deterministic and sorted, with no
  timestamps, so an unchanged Debian state gives a byte-identical lock and
  the same payload id. It is copied into the build inventory as
  `capture-debs.lock.json`. Packages the image already has are never in the
  closure. If apt would *upgrade* one of the group's root packages
  (`tcpdump`, `tshark`, `wireshark-common`, `nfdump`) already in the image,
  lock generation fails. The image copy would win over the payload's, and an
  old tool still answering `--version` is no proof that a security update
  landed. For any other image dependency, a proposed upgrade is recorded
  under `imageUpgrades` and the build prints a warning, but it is not
  extracted, so a payload copy never shadows an image library such as a
  lagging `libc6`. The current amd64 lock has none.
- **Payload id**: `<arch>-<codename>-<sha256(schema, group, lock bytes,
  platform, dpkg arch, distro)[:16]>`. A Debian security update in a rebuilt
  image changes the lock, which gives a new id and a background refresh
  while the previous payload keeps serving. A different CPU or Debian
  release (a home moved between routers) is never linked.
- **Runtime install** (as node, background, under the shared `flock`):
  - Each package is tried at `https://deb.debian.org/…`, then `http://`, then
    `snapshot.debian.org` (by SHA1 via `/mr/binary/<pkg>/<ver>/binfiles`).
    It must match its size and SHA256, then `dpkg-deb -f` must report the
    pinned Package, Version and Architecture.
  - Verified files are kept in `.cache-debs/` across interruptions, then
    extracted with `dpkg-deb -x` into `<staging>/root`. Maintainer scripts
    never run.
  - Every executable in `root/usr/{bin,sbin}` gets a wrapper in `bin/`,
    except names the image already has. A required command the image itself
    provides satisfies the group and is version-probed from the image. Each
    relink re-checks this, so a command an updated image gains wins over a
    kept payload's shim.
  - Downloads stream with a hard stop at the pinned size. The disk budget
    excludes `.deb`s already verified in the cache.
  - Every `--version` probe must exit 0 and the smoke decode must print
    `routeros.example`. Only then are the manifest (debs with SHA256 and
    source host, library dirs, skipped commands, shadows) and the atomic
    `current` swap written.
- **Stale payloads**: during a refresh, a payload from an older lock stays
  linked only if `tshark --version` still runs against the current image.
- **snapshot.debian.org** is a best-effort fallback. It answered `504` to a
  cold API query and `200` seconds later from its cache, so the client retries
  the lookup (after 5 s and 20 s). Live checks with the mirror URL forced to
  404: the pinned `tcpdump 4.99.5-2` came from
  `snapshot.debian.org/file/6dcce1d1…` in 17.8 s and in 15.8 s, both matching
  the pinned SHA256 `c35a180e…`. One run failed with 504 even after both
  retries ([log](snapshot-fallback.txt)). The fallback only matters for an
  image old enough that Debian has superseded its pins, and an image rebuild
  removes the need for it.

## Evidence for the implementation (habitat C)

- `bun run check` is green. `bun run test` passes 64 tests across 3 files
  (YAML contract, npm payload lifecycle, deb payload lifecycle with a fake
  `dpkg-deb`, fake mirror and fake snapshot service).
- `APP_T3CODE_DOCKER_IMAGE=app-t3code:slice3 bun test
  test/container-replacement.test.ts`: 1 pass, 60 expects, 51.5 s. Sequence:
  `all`, where both `dev` and `capture` install in the background and
  [`test/capture-tools.sh`](../../../test/capture-tools.sh) runs as node in
  `-c` and `-lc` shells; then `capture+bogus labs`, which relinks with no
  reinstall (same id and same `last.updatedAt`); then `dev` with
  `--network none` (capture deselected, payload kept, `tshark` off PATH); then
  `capture` with `--network none`, which relinks offline and passes the
  functional script again.
- A real build-time lock in that image: `capture: 42 packages for amd64
  debian-trixie, 30.5 MiB download, 153.4 MiB unpacked`. Installed in a
  fresh container in 4.7 s; nfdump's self-reported path is stripped from the
  manifest versions.

## Limits

- arm64 was emulated (QEMU user mode) on an amd64 host, not native, and the
  arm64 base was `node:24-trixie-slim`, not the app image. Its closure is
  larger because the bare image lacks libraries the app image already has.
- Nothing here was run on a RouterOS container. Capture capabilities on real
  hosts are #7.
- One Debian release (trixie). A move to forky changes `distro` and forces a
  fresh payload. That is intentional, but untested beyond the unit test.
- The full multi-arch image build is CI's; orca builds overlays only (disk).
