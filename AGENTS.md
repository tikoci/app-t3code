# AGENTS.md — app-t3code

RouterOS `/app` container for T3 Code. Greenfield tikoci repo: Dockerfile
rebuild of the wodby/t3code approach, `/app` YAML in `app/`, Bun tests.

## Commands

- `bun run check` — biome + `tsc --noEmit`. Keep both green.
- `bun run test` — offline `/app` YAML contract and the npm and deb tool-payload
  lifecycles (always runs; fake npm, fake dpkg-deb and mirror).
- `APP_T3CODE_INTEGRATION=1 bun test test/integration/` — full CHR
  boot + container install + web UI probe. Needs QEMU and network; slow
  (the GHCR image pull alone is ~1GB on a free-license CHR).
- `make build T3CODE_VER=<ver>` — local multi-arch build.
- `make push T3CODE_VER=<ver>` — multi-arch push to GHCR (`:<ver>` + `:latest`).

## Conventions

- Bun + TypeScript only. Bun 1.4.x (matches quickchr pin).
- RouterOS is driven via `@tikoci/centrs@next` (CLI) in tests; CHR VMs are
  booted with `@tikoci/quickchr@next` (library). Both float on `next` on
  purpose: if a helper breaks, report it to the sister project.
- `/app` YAML uses the new colon-style port format (`host:ctr:label:tcp`,
  RouterOS 7.23+). Strict schema wants uppercase env names.
- Test installs use `use-https=no` (CHR has no `/ip/cloud` without a paid
  license, so `yes` can never mint certs there). Production uses
  `use-https=yes` — README documents the flip, not a second YAML file.
- Image tags track upstream T3 Code stable releases only (no nightlies,
  but CI accepts any `T3CODE_VER` input). YAML references the `:0.1`
  stability tag; releases also push `:0`, full version, and `:latest`.
- Skills that govern this repo: `routeros-app-yaml`, `routeros-container`,
  `routeros-centrs`, `routeros-quickchr-cli`, `tikoci-crossref`.

## Gotchas

- On CHR 7.25.1, assigning `/app/set ... yaml=...` deletes app-owned volume
  contents, even for a comment-only change. Image upgrades use `/app/update`;
  applying YAML requires offline backups of the home, external project
  volumes, and every other app-owned volume outside the app directory.
  Restore the home and other app-owned volumes into their new mount sources;
  verify external project mounts and restore their backups if needed, all
  before enabling. More app-owned volumes do not prevent the reset.
- The YAML wipe also reproduces on 7.26beta5, and `yaml=` leaves the app
  disabled. `/app/set environment=` is safe: it restarts the container and keeps
  volumes, and the override survives `/app/update` and reboot. But it replaces
  the *whole* env list (YAML env is only the initial value), and the CLI and
  REST split values on commas. See
  `docs/research/2026-11-05/app-set-environment.md`.
- Tool groups (`T3CODE_TOOL_GROUPS`, issue #5) live in
  `scripts/tool-groups.ts`, shipped as `t3code-tools`. Any key added to the
  YAML `environment:` must also be a Dockerfile `ENV` default with the same
  value (a test enforces it), because an operator's `environment=` set
  drops the YAML values. Never document group changes as a YAML edit.
- npm payload groups (`dev`) are installed by `scripts/tool-payloads.ts`
  from the lockfile in `scripts/groups/<group>/` into
  `/data/.local/share/t3code-tools`; startup only relinks (offline) and
  installs in the background. Pins change with `make dev-lock`; a changed
  lockfile is a new payload id on every home. `bun run test` covers the
  lifecycle with a fake npm; the docker replacement test covers real npm and
  offline reuse.
- `capture` (issue #5 slice 3) is a deb payload: `scripts/deb-payloads.ts`.
  The Dockerfile pins its Debian closure from apt metadata with
  `t3code-tools deb-lock` after the last apt layer (run with `HOME=/root`, or
  Bun seeds a root-owned `/data/.bun`). The closure is "what the image lacks",
  so any apt-layer change can change the lock and every home's payload id
  (a re-download on next start). Wrappers set `LD_LIBRARY_PATH` per process
  only; `ld.so --library-path` was rejected because it breaks Wireshark's
  program-relative data/plugin lookup. snapshot.debian.org (the fallback for
  superseded versions) answers 504 to cold queries; the client retries.
  Never claim capture privileges from installing it (#7).
- `vpn` and `routing` (slice 4) are deb payloads too. A tool that only knows
  compiled-in paths gets a `wrappers` rule in its group (env with `{root}`,
  and `{multiarch}` for triplet paths, expanded from the lock's dpkg arch,
  never Bun's `process.arch`; plus an install-time-checked `LD_PRELOAD`
  plugin set): strongSwan has no
  runtime plugin dir, so `pki`/`swanctl` preload the plugins that load
  against libstrongswan alone. Probes that cannot exit 0 (birdc without a
  daemon; nft/conntrack without netfilter netlink, e.g. under QEMU user mode)
  declare `versionExit` so one kernel feature cannot fail the whole group.
  PPP peers (pppd, xl2tpd, sstpc, pppoe) and lldpd cannot run from `/data`
  even when privileged (root, `/etc/ppp`, `/usr/sbin/pppd`, a `_lldpd`
  user); they belong to the `labs` Linux guest. Keep the README's
  "Privileges by tool" table and each group's `privileges` (plus
  `CORE_PRIVILEGES`) in step when tools move.
  See `docs/research/2026-11-06/vpn-routing-payloads.md`.
- `labs` (slice 5) is a deb payload too: QEMU and its firmware are no longer
  in the image (the first apt layer dropped them, which also moved a few
  libraries into the `capture`/`vpn` closures). Debian's QEMU is not
  relocatable (data dirs compiled in); the `qemu-system-*` wrappers pass
  leading `-L` for the payload's `share/qemu`, `share/seabios` and
  `lib/ipxe/qemu`, plus `QEMU_MODULE_DIR`. The group `prune`s the secure-boot
  AAVMF images (256 MiB) after extraction; the prune list is in the payload
  id. In a deb group, `file` checks are paths inside the payload root.
  quickchr stays in the image (`/opt/bun/bin` counts as an image bin dir)
  and finds arm64 UEFI firmware via `qemu-system-aarch64 -L help`, which
  ships in quickchr 0.5.6 (`@next`; tikoci/quickchr#254/#255). Older builds
  fail with `MISSING_FIRMWARE` on arm64. Its smoke tests boot firmware, not
  a CHR; CHR boots are the research probe
  (`scripts/research-quickchr-runtime.ts`, `QUICKCHR_MODULE` for a branch
  build). See `docs/research/2026-11-06/labs-qemu-payload.md`.
- The README's `/app` YAML Editor share link embeds a snapshot of
  `app/t3code.tikapp.yaml`, so it can get stale. Whenever that file changes
  (including comments), regenerate the link's `yaml` query parameter from
  the full file contents and verify decoding it reproduces the file exactly.
  URL-based loading is requested in https://github.com/tikoci/restraml/issues/123;
  once supported, prefer a link that loads the published YAML URL.
- `deviceMode: { enable: ["container"] }` must be set at first boot;
  guest-side `/system/device-mode/update container=yes` never completes.
- `installPackage("container")` reboots the guest; poll, don't assume.
- `/app` enable refuses until a disk is configured
  (`/app/settings/set disk=<mount-point>`); format first with
  `/disk/format <id> file-system=ext4` — 7.25 has `ext4`, no `ext3`,
  and the id is positional (`disk=` is rejected). Discover verbs via
  `/console/inspect` `request=child`, enums via `request=completion`.
- `api … app -X PUT` leaves the app `disabled:true`; enable with
  `/app/set [find where name=…] disabled=no`, then poll `/container`
  (`.running` is the string `"true"`, not a boolean).
- CHR free license: 1 Mbps/interface upload cap; size all waits from TCG,
  not HVF. `bootSize: "8G"` is required — the image will not fit a stock
  CHR disk. Use an 8G app disk: the image with agent tools extracts to
  roughly 4GB, before projects and lab VMs. Extra RAM (`mem: 1024`) for
  the pull + unpack.
- `centrs api <router> app -X PUT` is the structured write path
  (PUT = RouterOS create). `execute` is the fallback if validation rejects.
