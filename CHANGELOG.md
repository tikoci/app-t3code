# Changelog

User-visible changes to the `ghcr.io/tikoci/app-t3code` image and its
RouterOS `/app` YAML. The image version is the upstream T3 Code version, so
each entry names a date and the T3 version that shipped. Builds are
identified by `sha-<commit>`. See `AGENTS.md` "Versions and CHANGELOG".

## Unreleased — T3 Code 0.1.7

- Removed the pairing hint's Copy/Selected button, which only selected text
  on plain HTTP. The RouterOS command stays visible and selectable for manual
  copying (#30, follow-up to #18).
- RouterOS now stops T3 gracefully. It used to SIGKILL the container on
  every stop, `/app/update` and `disabled=yes`, because PID 1 (`tini`) had
  no SIGTERM handler, and RouterOS checks for one. PID 1 is now a small
  bash init, `t3code-init`, that catches TERM and passes it on. T3 finishes
  its shutdown in about 5 s, well within RouterOS's 30 s `stop-time`. The
  container log then shows `exited with status 130`, which is T3's normal
  exit after a signal, not a failure (#25).
- The image no longer includes `tini`.
- The pairing screen now says how to get a token on RouterOS: a "Running on
  MikroTik RouterOS?" panel under the token field shows
  `:put [/container/shell app-t3code cmd="t3-pairing-link" as-value]`. It's a
  small script the image adds to T3's web client; no T3 code is changed.
  The container log prints the same command at start
  (#18).

## 2026-11-08 — T3 Code 0.1.7

- Workflow: pinned Roadmap issue, labels, the draft-PR review flow and this
  changelog. `.coderabbit.yaml` reviews ready PRs once and skips PRs labeled
  `skip-review`.
- T3 Code 0.1.7 (upstream, 2026-11-04). Its database migrations 077–079
  run on first start; back up `/data` before `/app/update` as usual (#6).
  On a test CHR, `/app/update` from 0.1.6 kept every project, thread,
  setting, login and tool payload (#3).
- Known issue: the background Claude Code install fails on new homes (its
  download URL returns 404), so `claude` is missing until installed by hand
  with Anthropic's installer (#13).

## 2026-11-08 — T3 Code 0.1.6

- `gh` is in core: a pinned GitHub release tarball, checksum-verified, so
  T3's GitHub source-control provider works and agents can open PRs (#16).
- Recorded an `/app/update` run on a 1 GiB CHR. It kept the environment ID
  and `/data`.

## 2026-11-07 — T3 Code 0.1.6

- Default tool groups are now `capture labs vpn routing dev`. Unset or empty
  means the same list, `none` means core only (#14).
- `browser` and `agents-extra` are no longer groups: browser libraries are
  in core. Muse is no longer bundled (saves about 396 MiB); install it into
  the home instead (#14).
- `uv`/`uvx` and `sqlite3` are in core (#14).
- `labs`: QEMU and its firmware moved out of the image into a Debian-package
  payload under `/data` (#12).
- CI pushes only `:sha-<commit>`. It promotes `:<ver>`, `:0.1`, `:0` and
  `:latest` after the arm64 replacement test passes (#14).

## 2026-11-06 — T3 Code 0.1.6

- `T3CODE_TOOL_GROUPS` selector and the `t3code-tools` CLI (`status`,
  `install`, `prune`, `help`), plus core network tools (#8).
- Persistent payload groups installed into the home in the background:
  `dev` (npm, #9), `capture` (#10), `vpn` and `routing` (#11).

## 2026-11-05 — T3 Code 0.1.6

- Bun, global `@tikoci/quickchr` and `@tikoci/centrs`, and QEMU
  prerequisites. `HOME` and `T3CODE_HOME` are pinned to the single `/data`
  volume. Added a container-replacement persistence test (#4).
- Documented that assigning `/app/set yaml=` wipes app-owned volumes. Use
  `/app/update` for upgrades (#3).
