# Changelog

User-visible changes to the `ghcr.io/tikoci/app-t3code` image and its
RouterOS `/app` YAML. The image version is the upstream T3 Code version.
Each promoted build is `<T3 version>-app.<N>` (`N` is the `ci` run
number), which is also its image tag, and each entry names the promoted
`sha-<commit>`. Entries from before these tags are headed by date. See
`AGENTS.md` "Versions and CHANGELOG".

Every merge to `main` that changes the image ships on its own, but its run
number is known only after the merge. So the newest changes sit under
**Not yet numbered**: they may already be in `:0.1`, and a later commit
gives them their `-app.<N>` heading.

## Not yet numbered

Nothing since `0.1.7-app.142`.

## 0.1.7-app.142 — 2026-11-10

`sha-69660fb`. The last build of T3 0.1.7 before the 0.1.8 bump; see the
[0.1.7 closeout](docs/research/2026-11-09/t3-0.1.7-closeout.md).

- Repository: every workflow action is pinned to a commit SHA (with its
  release in a comment), and Dependabot opens one grouped PR a month to
  move them (GitHub Actions only). The daily freshness check now also
  watches the gh, uv and Bun pins and CI's linters, and while it is red
  keeps one `freshness` issue open with the latest report, closing it on
  the next green run. Nothing in the image changes; the merge rebuilds and
  promotes a new build because workflows count as image-relevant.

## 0.1.7-app.137 — 2026-11-09

`sha-589e0a6`. The first build with an `-app.<N>` tag.

- Promoted builds get their own tag, `:<T3 version>-app.<N>` (`N` is the
  `ci` run number), that never moves, so a router can stay on one build.
  Every pushed image also carries that name in its
  `org.opencontainers.image.version` label, and the commit in
  `org.opencontainers.image.revision`. A re-run that rebuilds appends the
  attempt (`-app.<N>.2`). `:0.1.7`, `:0.1`, `:0` and `:latest` move as
  before.
- Repository: the `main` ruleset now also requires a pull request with
  every review thread resolved (no approval count). CHANGELOG-only PRs that
  stamp a promoted build are pre-approved for write members (`AGENTS.md`).

## 2026-11-09 — T3 Code 0.1.7, `sha-b232556`

Promoted from `ci` run 125, before `-app.<N>` tags existed.

- Repository: `SECURITY.md` (private reporting, the trust boundaries, the
  startup pairing token that RouterOS `read` users can see in
  `/container/log`, and what installs at runtime). CI now also runs
  actionlint on the workflows and markdownlint on the docs (`make lint`
  runs every gate). Repo skills moved to `.agents/skills/`
  (`.claude/skills` is a symlink to it). Repository settings: secret
  scanning with push protection, Dependabot security PRs, and a `main`
  ruleset that requires CI's `lint-test` and `build`. Nothing the image is
  built from changes, but CI counts workflow and package changes as
  image-relevant, so merging this rebuilds and promotes a new `sha-<commit>`.

## 2026-11-09 — T3 Code 0.1.7

This entry collects every rebuild of T3 0.1.7 promoted from `sha-c244a7e`
(late 2026-11-08 UTC) through `sha-e9114d1`. `sha-e9114d1` is the build
verified on both test CHRs on 2026-11-09 with `/app/update`.

- **Provider CLIs are now chosen with `T3CODE_PROVIDERS`** (#13), one token
  per provider in T3's main Add provider list: `claude codex cursor grok
  opencode antigravity pi muse`. The default is `claude codex`. Selected
  CLIs install into `/data` in the background while they are missing from
  PATH: npm into `/data/.local` for Codex, OpenCode and Pi, the vendor's
  installer for Grok and Muse, and the existing Claude installer. T3's own
  Update now keeps working on them. Cursor and Antigravity come with T3 and
  install nothing. A CLI you installed yourself always wins, and deselecting
  deletes nothing. `t3code-providers status` shows each provider's state.
- **Codex and OpenCode are no longer baked into the image.** With the
  default, Codex installs into the home on first start after the update.
  OpenCode is opt-in now (about 409 MiB): add `opencode` to
  `T3CODE_PROVIDERS` to keep it. Logins and sessions in `/data` are kept.
- Background install logs moved to one directory in the home,
  `/data/.local/state/t3code/`: `providers.log` (it replaces
  `install-claude-code.log`) and `tool-groups.log` (it was
  `/tmp/t3code-tools-install.log`, lost on every restart).
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
  `:put [/container/shell app-t3code cmd="t3-pairing-link" as-value]` as
  selectable text for manual copying, with no Copy/Selected button. Tab
  reaches the command and selects all of it for Ctrl/Cmd+C. It's a
  small script the image adds to T3's web client; no T3 code is changed.
  The container log prints the same command at start (#18, #30).
- Claude Code installs on new homes again. The background installer read a
  download URL that returns 404 and a manifest format Anthropic no longer
  uses, so `claude` was missing until installed by hand. It now follows
  Anthropic's installer: the stable channel's native build, checked against
  the manifest's size and SHA-256, set up by Claude's own `install`, in one
  resumable download. It retries for about a day when the network is not up
  yet, and logs to `/data/.local/state/t3code/` instead of the container's
  `/tmp` (`providers.log` since `T3CODE_PROVIDERS`; the first builds used
  `install-claude-code.log`). A `claude` already on PATH, including
  one installed from T3's welcome screen, is never replaced (#13).
- Files that T3, its agents and its terminals create in `/data` are no
  longer world-writable. RouterOS starts containers with umask 0000, so T3's
  settings, projects and logs came out as 666/777. The entrypoint now sets
  umask 022 before starting T3. Commands run directly through RouterOS
  `/container/shell` bypass the entrypoint and still get 0000. Files
  created before this keep their modes; `chmod -R go-w /data` from a T3
  terminal fixes those.
- `zstd` is in the image core. The background Claude Code install now
  downloads Claude's compressed build (`claude.zst`, about 99 MiB instead of
  280 MiB, measured with 2.1.311) and checks the decompressed binary against
  Anthropic's manifest as before. It falls back to the uncompressed download
  when the `.zst` is not available. The daily freshness check also confirms
  that both platforms' `.zst` builds exist (#13).

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
