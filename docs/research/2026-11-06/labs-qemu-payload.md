# `labs` as a Debian-package payload under `/data`

**Measured 2026-11-06 PT, habitat C (orca, x86_64 Dell, Omarchy, Docker
29.9.2).** Issue [#5](https://github.com/tikoci/app-t3code/issues/5), slice 5.
The [status review](https://github.com/tikoci/app-t3code/issues/5#issuecomment-6701099771)
picked `labs` as the largest move that needs no owner decision. QEMU and its
firmware were 565 MiB of every image (33 packages per the 2026-11-05 apt
simulation), selected or not.

**Answer: `labs` is a `deb` payload.** Debian's QEMU is not relocatable,
but every path it needs can be handed to it: three leading `-L` arguments
for its data dirs and `QEMU_MODULE_DIR` for modules, both from a slice-4
wrapper rule. Two pieces were new:

- a `prune` list that drops four 64 MiB secure-boot AAVMF images after
  extraction;
- `file` checks resolved inside the payload.

quickchr stays in the image. To find the payload's arm64 UEFI firmware it
needed one upstream change, [tikoci/quickchr#254](https://github.com/tikoci/quickchr/issues/254)
(PR [#255](https://github.com/tikoci/quickchr/pull/255)): when no standard
firmware path exists, ask the QEMU quickchr runs for its data dirs
(`-L help`). With that, real CHR 7.25.1 machines boot from the payload on
both architectures, as `node` with `CapEff 0`. No global `LD_LIBRARY_PATH`
and no env override are involved.

## Relocation, piece by piece

As `node`, `CapEff 0`, no `/dev/kvm`, the closure extracted with
`dpkg-deb -x` under `/tmp/p/root`, binaries called directly (no wrapper from
this repo), in an image with QEMU purged
([transcript](labs-qemu-amd64.txt), from
[`scripts/research-labs-payload.sh`](../../../scripts/research-labs-payload.sh)):

| Piece | Compiled-in path | Result in the payload |
| --- | --- | --- |
| Libraries | none | 3 library dirs (`usr/lib/x86_64-linux-gnu` plus `rsocket/`, `vdeplug/`); no absolute or dangling symlinks in the closure |
| BIOS, option ROMs, keymaps, VGA BIOS | `/usr/share/qemu`, `/usr/share/seabios`, `/usr/lib/ipxe/qemu` (`-L help` of the raw binary lists only these) | raw binary: `qemu: could not load PC BIOS 'bios-256k.bin'`, exit 1. With `-L <payload>/usr/share/qemu -L <payload>/usr/share/seabios -L <payload>/usr/lib/ipxe/qemu` the `-L` dirs come first in `-L help`, SeaBIOS 1.16.3 boots to `No bootable device` and exits 0 in 178 ms (`-boot reboot-timeout=0 -no-reboot`). `--version` and `-L help` still work after leading `-L` |
| virtio NIC ROM (`efi-virtio.rom`) | same | a real file in `share/qemu`; loads through `-L`. A nonexistent `romfile=` stops QEMU (`failed to find romfile`), so starting cleanly with the default proves it resolved |
| aarch64 emulator | none relevant | the 16-byte PSCI `SYSTEM_OFF` program as `-kernel` exits 0 in 43 ms; 16 zero bytes hang until the timeout (exit 124), so exit 0 is not an accident |
| AAVMF (UEFI) | none: the caller passes pflash paths | prints `UEFI firmware (version 2025.02-8+deb13u1 …)` on the serial port from the payload's `AAVMF_CODE.fd` + a copy of `AAVMF_VARS.fd` |
| Modules | `/usr/lib/<triplet>/qemu` | 12 modules: audio, curses, virtio-gpu/vga, USB host/redirect/smartcard, `uefi-vars`. No accelerator is a module: `-accel help` lists `tcg kvm` without them. `QEMU_MODULE_DIR` adds `curses` to `-display help`, so the wrapper sets it |
| `qemu-img` | none relevant | creates a qcow2 |
| `kvm` | a link to `qemu-system-x86_64` | needs the same `-L`; the rule covers it |
| KVM, TAP | `/dev/kvm`, `/dev/net/tun` | fail without the devices (`Could not access KVM kernel module`, `could not open /dev/net/tun`), not permission errors; untested with devices (#7) |

Why not other approaches:

- **Bake QEMU and gate it by `PATH`:** that keeps the 565 MiB in every pull.
- **Rely on QEMU's own relocation (data dirs relative to the executable):**
  Debian's build does not use it. `-L help` of the extracted binary lists
  only `/usr/...`.
- **Set `QUICKCHR_EFI_*` env vars pointing into the payload:** that adds an
  image ENV default that dangles whenever `labs` is not installed. It also
  duplicates what QEMU already knows. Asking QEMU (`-L help`) also fixes
  Homebrew and Windows QEMU under non-default prefixes, so it belongs
  upstream.

## Firmware pruning

`qemu-efi-aarch64` ships six 64 MiB raw images (385 MiB of the 565). quickchr
boots with `AAVMF_CODE.fd` (a link to `AAVMF_CODE.no-secboot.fd`) and
`AAVMF_VARS.fd`; the secure-boot variants (`secboot`, `secboot.strictnx`,
`VARS.ms`, `VARS.snakeoil`, plus the `ms`/`snakeoil` links and the two
firmware descriptors naming them) are never used. The group's `prune` list
removes them after extraction and before the layout. The list is part of the
payload id, so a changed list is a new payload. It is recorded in the manifest
(`deb.pruned`, `deb.prunedBytes`). A listed path that a later Debian build
drops is skipped; one that would leave the payload root is refused.

The download is unchanged (32.7 MiB): the images compress to almost nothing
in the `.deb`. The install still needs the full unpacked size for a moment,
which the disk budget (download + `Installed-Size`) already covers.

## Measurements (amd64, overlay image `app-t3code:slice5`)

`t3code-tools install` as `node` with `T3CODE_TOOL_GROUPS=labs`, fast link:

```text
labs: installing payload amd64-trixie-3f6f4ab2d3047cea (attempt 1/3)
labs: downloaded 32.7 MiB in 32 packages, all SHA256-verified
labs: pruned 8 unused paths, 256.0 MiB
labs: ready in 6s (quickchr 0.5.5; QEMU emulator version 10.0.13 (Debian 1:10.0.13+ds-0+deb13u1); …; qemu-img version 10.0.13 …)
```

- 32 packages, 32.7 MiB to download, 564.3 MiB unpacked (apt metadata), 309
  MiB on disk after pruning 256 MiB. The 2026-11-05 simulation counted 33
  packages: one dependency is already in the image from another layer.
- About 4.6 minutes at 1 Mbit/s (computed, not measured).
- Status: every check `ok`. Commands resolve to the shims (`quickchr` to
  `/opt/bun/bin/quickchr` from the image). The firmware file checks resolve
  to `…/groups/labs/current/root/usr/share/…`.
- Removing QEMU from the image's first apt layer changed two other locks.
  `capture` went from 42 to 46 packages (`libjpeg62-turbo`, `libnl-3-200`,
  `libnl-route-3-200`, `libpixman-1-0`) and `vpn` from 14 to 15
  (`libnl-3-200`). QEMU used to supply those libraries. Their payload ids
  change, so homes with those groups download them once more after this
  image update. `routing` is unchanged.

## CHR boots from the payload (the readiness contract)

[`scripts/research-quickchr-runtime.ts`](../../../scripts/research-quickchr-runtime.ts)
in a disposable container as `node`, TCG (no `/dev/kvm`), real CHR 7.25.1,
managed login, qcow2 boot resize plus an extra disk, a read-only centrs
query, machines removed afterwards ([transcript](labs-chr-boot-amd64.txt)).
The probe now records the quickchr error code and which quickchr module ran:

| quickchr | x86 | arm64 |
| --- | --- | --- |
| image's `@tikoci/quickchr` 0.5.5 | ready in 69.8 s | `MISSING_FIRMWARE` after 3 ms |
| branch `feat/efi-firmware-qemu-datadirs` (quickchr#255) | ready in 60.0 s | ready in 79.7 s, `architecture-name` arm64 |

The running arm64 QEMU had the payload's three `-L` dirs and
`pflash … file=/data/.local/share/t3code-tools/groups/labs/amd64-trixie-3f6f4ab2d3047cea/root/usr/share/AAVMF/AAVMF_CODE.fd`.
quickchr resolves the path through the wrapper's real location, so it names
the payload id, not `current`. quickchr looks the path up at every launch, and
the previous payload is kept after a refresh, so a running machine keeps its
firmware.

**Until quickchr#255 is published to `@next` and an image is rebuilt, arm64
CHRs fail under `labs` with `MISSING_FIRMWARE`.** x86 works today.

## The overlay test image

The slice removes packages from the first apt layer. So the local test image
(`labs-overlay.Dockerfile`, beside this file) starts from
`app-t3code:pr10-review`, purges the four QEMU roots with `autoremove`, and
then applies this branch's Dockerfile from the home section on. CI's full
multi-arch build is the authoritative image.

## Evidence for the implementation (habitat C)

- `bun run check`: green (the same 3 biome warnings as `main`, in test code).
  `bun run test`: 82 pass. The new unit tests cover prune (ids, removal, path
  safety, including a symlinked directory that leads out of the payload),
  payload file checks (status paths, activation refused when a file
  disappears, install refused when the lock lacks one), `quickchr` from the
  image's `/opt/bun/bin`, the QEMU wrapper's `-L` order and
  `QEMU_MODULE_DIR`, and the real `labs` definition (including the PSCI
  bytes).
- [`test/labs-tools.sh`](../../../test/labs-tools.sh) as `node` against an
  installed payload: `labs ok: QEMU emulator version 10.0.13 …`. It covers
  `-L help` order (also for `kvm`), the pruned files, the NIC romfile,
  `qemu-img`, the SeaBIOS boot, the PSCI kernel, the UEFI banner, and KVM and
  TAP failing without devices.
- Docker replacement test on the overlay
  (`APP_T3CODE_DOCKER_IMAGE=app-t3code:slice5 bun test test/container-replacement.test.ts`):
  1 pass, 108 expects, 156.8 s. Under `all`, `labs` installs next to the
  other payloads and `labs-tools.sh` passes in `-c` and `-lc` shells. With
  `capture labs`, it is relinked in a new container with the same id and no
  reinstall. After `dev` only, its shims are gone and its payload kept. Under
  `--network none`, it is relinked offline and its script passes again.
- The prune path guard was added after that run. A rebuilt overlay with a
  fresh home then pruned the same 8 paths (256.0 MiB), was ready in 8 s, and
  passed `labs-tools.sh`.
- quickchr#255's firmware fallback, in a container with no system firmware
  and the payload behind a `-L` wrapper:
  `{"code":"/tmp/p/root/usr/share/AAVMF/AAVMF_CODE.fd","vars":"/tmp/p/root/usr/share/AAVMF/AAVMF_VARS.fd"}`.

## Limits

- arm64 was not run for this slice: no native arm64 host here, and TCG inside
  QEMU user-mode emulation is too slow for the boots (`LABS_TOOLS_QEMU_USER`
  skips them). The wrapper rule picks the arm64 module dir by triplet
  (`aarch64-linux-gnu`), and CI builds the arm64 image and its lock.
- Real RouterOS hardware (`/dev/kvm`, TAP, memory for nested guests) is #7.
- The smoke tests boot firmware, not a CHR. CHR boots need the network and
  minutes each, so they stay in the research probe.
