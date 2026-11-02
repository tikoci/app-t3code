# AGENTS.md — app-t3code

RouterOS `/app` container for T3 Code. Greenfield tikoci repo: Dockerfile
rebuild of the wodby/t3code approach, `/app` YAML in `app/`, Bun tests.

## Commands

- `bun run check` — biome + `tsc --noEmit`. Keep both green.
- `bun test test/app-yaml.test.ts` — offline `/app` YAML contract (always runs).
- `APP_T3CODE_INTEGRATION=1 bun test test/integration/` — full CHR
  boot + container install + web UI probe. Needs QEMU and network; slow
  (the GHCR image pull alone is ~650MB on a free-license CHR).
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
  CHR disk. Extra RAM (`mem: 1024`) for the pull + unpack.
- `centrs api <router> app -X PUT` is the structured write path
  (PUT = RouterOS create). `execute` is the fallback if validation rejects.
