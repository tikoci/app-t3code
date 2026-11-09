# AGENTS.md — app-t3code

RouterOS `/app` container for T3 Code. Greenfield tikoci repo: Dockerfile
rebuild of the wodby/t3code approach, `/app` YAML in `app/`, Bun tests.

## Commands

- `bun run check` — biome (`--error-on-warnings`) + `tsc --noEmit` +
  markdownlint (`.markdownlint.yaml` holds the rules,
  `.markdownlint-cli2.yaml` the globs; LLM instruction files such as this one
  and the skills in `.agents/` are not linted). The
  repo stays at **zero errors and zero warnings**; CI fails on either. If
  you run into one, even one that was already there, you own fixing it in your
  current PR (`bun run lint:fix` handles most).
- `make lint-shell` — hadolint on the `Dockerfile` and ShellCheck on the
  shipped and test shell scripts (`.hadolint.yaml` lists the ignores and why).
  Needs `hadolint` and `shellcheck` on PATH; CI installs pinned,
  checksum-verified copies.
- `make lint-actions` — actionlint on `.github/workflows/` (it also runs
  ShellCheck on every `run:` script). Pinned in CI the same way.
  `make lint` runs every lint gate CI runs.
- `bun run test` — offline `/app` YAML contract, the npm and deb tool-payload
  lifecycles and the Claude installer (always runs; fake npm, fake dpkg-deb,
  mirror and Claude download server).
  It needs a Linux host: the lock tests spawn util-linux `flock` and fail or
  time out without it (macOS). Run it on Linux, or rely on CI's `lint-test`
  job. As root (a container), the installer tests run it as `nobody` through
  util-linux `setpriv`, because it refuses root. `biome.json` turns off `noTemplateCurlyInString` only for the two test
  files that assert literal shell `${...}` text.
- `make freshness` — drift checks (`scripts/freshness.ts`, needs network):
  the README share link, the pinned T3 release (stable, both Linux archives)
  and its harness catalog, the newest stable T3, and the Claude Code
  download contract `bin/install-claude-code` reads. CI runs `pinned` on every
  PR; `freshness.yml` runs them all daily, and a red run there means bump.
- `APP_T3CODE_INTEGRATION=1 bun test test/integration/` — full CHR
  boot + container install + web UI probe. Needs QEMU and network; slow
  (the GHCR image pull alone is ~1GB on a free-license CHR).
- `make build T3CODE_VER=<ver>` — local multi-arch build.
- `make push T3CODE_VER=<ver>` — multi-arch push to GHCR (`:<ver>` + `:latest`).
  CI never pushes release tags directly: `main` pushes `:sha-<commit>`, the
  arm64 image runs the replacement test on `ubuntu-24.04-arm`, then
  `promote` retags it. `integration.yml` follows via `workflow_run`.

## Workflow

- **The menu is the Roadmap issue**, pinned at the top of the Issues tab
  (`gh issue list --label roadmap`). It groups every open theme into
  Now / Next / Later, with a dependency graph. Topics live there as one line
  until they are next or need cross-repo work; only then do they get their
  own issue. **Before ending a session that opened, closed or re-scoped an
  issue, re-read the live Roadmap and update its lists and dependency graph**
  (`gh issue edit <n> --body-file`). Tracking lives in GitHub, not in
  committed files, so machines don't need sync commits.
- **Labels:** `track` is a long-lived issue that collects one concern and
  is never "done" (updating #6, skills). `research` means grounding comes before
  code. `upstream` means it needs work or a bug report in a sister project
  (centrs, quickchr, restraml, routeros-skills) or in T3 Code. `ux` means
  first-user friction.
- **Research output** goes to `docs/research/<YYYY-MM-DD>/`, with a comment
  on the issue linking it. A review of a live install by an agent running on it
  is `chr-<agent>-review.md`, in the same shape as
  `docs/research/2026-11-07/chr-codex-review.md`.
- **Closing an issue** takes a closeout comment that marks each acceptance item
  done, transferred (to an issue, by link) or dropped. Use `Closes #n` only
  in the PR that finishes it; slices use `Refs #n`.
- **Sister projects:** a clear, reproduced bug in centrs, quickchr or T3 gets
  filed there (or handed to an agent in that project) and linked from the
  issue, even if you worked around it here.
- **Tooling & skills feedback** (#29, pinned; it reconstructs #24, hidden
  since the Amm0Bot suspension): the low-stakes way to *note* a
  possible bug in another tikoci tool without switching tasks. When a tool call
  fails or misses mid-task, work around it, leave one comment on #29 and get
  back to the main work; triage happens later, here or in the tool's repo.
  Those failures are still worth that later look. It also covers a skill that
  was missing or not loaded, a missing cross-ref, a confusing error, or a doc
  that disagreed with behavior. The issue body has the comment shape. Bugs
  filed in sister repos get a one-line link there too.

### Branches, PRs, reviews

- Branch from `main`, one PR per slice, squash merge. Merged branches are
  deleted automatically.
- A ruleset on `main` ("main: image changes need CI") requires the `ci`
  jobs `lint-test` and `build` and blocks force-push and deletion. A docs-only
  change skips `build`, which counts as passing, so it waits only on
  `lint-test`. Admins bypass it; that is what lets small doc fixes go
  straight to `main`. Don't rename those two jobs without updating the ruleset.
- Substantive PRs open as **draft**. Another agent in T3 Code reviews the draft,
  then the owner reviews it, then it is marked ready.
- CI on a draft runs `lint-test` only. The ~10 min image `build` runs when
  the PR is marked ready, so don't wait on it while refining a draft. A
  change that touches only docs (`*.md`, `docs/`, `.agents/`, `.claude/`, `LICENSE`,
  `.coderabbit.yaml`) never builds, on a PR or on `main`: nothing new would
  reach the image. To
  build a draft anyway (say, a pre-merge CHR test image),
  `gh workflow run ci.yml --ref <branch>` builds both arches, pushes
  `:sha-<commit>` and runs the arm64 test (it never promotes off `main`).
- **The reviewer is a different model from the author.** Claude-authored work
  is reviewed by Codex on `gpt-6.1-sol`. Work that sol authored is reviewed by
  Claude Opus. The owner may swap them depending on credits and rate limits.
- Marking a PR ready starts CodeRabbit (`.coderabbit.yaml`: no drafts, one
  pass, no incremental re-reviews). The OSS plan is rate-limited, so don't push
  review-churn commits. The owner may ask for a final Copilot review on tricky
  or important PRs.
- **`skip-review` label**: when the agent review is enough (docs, easy to
  revert), label the PR `skip-review` and CodeRabbit won't review it
  automatically (`@coderabbitai review` still works). It can merge once the
  agent approves and CI is green. Small doc fixes that are easy
  to revert may go straight to `main`.

### Versions and CHANGELOG

- The image version **is** the upstream T3 Code version (`T3CODE_VER`, see
  README "Tags"), and `package.json` carries it unchanged (we don't publish
  to npm). Our own changes don't get a semver. A promoted build is
  `<T3 version>-app.<N>`, where `N` is the `ci` run number:
  `promote` tags it (`:0.1.7-app.<N>`, never moved) and every pushed
  image carries it in the `org.opencontainers.image.version` label. It is a
  rolling build of one T3 release, not a prerelease or a release of ours.
  `app` is chosen to sort below other semver prerelease labels (`beta`,
  `next`, `rc`), so any label added later ranks above it, and the bare
  `0.1.7` above all of them.
- Every PR that changes the image, the YAML or user-visible behavior adds a
  line under `## Unreleased` in `CHANGELOG.md`. When its `main` build is
  promoted, rename that heading `## <T3 version>-app.<N> — <date>` and
  start the entry with the promoted `sha-<commit>`. `N` exists only once the
  merge's `ci` run starts, so the rename goes in the next PR or a docs-only
  commit to `main` (`gh run list --workflow ci.yml --branch main` shows the
  number).
- A change to what the container exposes (listeners, logs, tokens,
  privileges) or installs at runtime also updates `SECURITY.md`. It follows
  T3's security model; it documents behavior rather than adding a layer.

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
  `routeros-tikoci-centrs`, `routeros-tikoci-quickchr-cli`, `tikoci-crossref`.
  The repo skill `.agents/skills/chr-app-lab/SKILL.md` is the hands-on recipe
  for a quickchr CHR: preparing it for `/app`, install and `/app/update`, an
  offline `/data` backup, commands inside the container, and the
  before/after content manifest (`scripts/research-home-manifest.ts`).
  Repo skills live in `.agents/skills/` (the cross-agent location Codex and
  OpenCode read); `.claude/skills` is a symlink to it for Claude Code. Add new
  repo skills under `.agents/skills/` only.

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
- The shipped default is the explicit list
  `T3CODE_TOOL_GROUPS="capture labs vpn routing dev"` (`DEFAULT_TOOL_GROUPS`,
  mirrored in Dockerfile `ENV`, both YAML files and the README; a test ties
  them). Unset/empty also mean that list; `none` is core only; `all` also
  picks up future groups. A new group joins the default only deliberately
  (update the constant, ENV, YAMLs, share link). Tests set selections
  explicitly; don't pick product defaults for test convenience.
- Not groups: `browser` (its native libraries are core, in the first apt
  layer; T3 launches its own browser, so no relocation or launch hooks) and
  provider CLIs. Providers are `T3CODE_PROVIDERS` (`scripts/providers.ts`,
  shipped as `t3code-providers`, issue #13): one token per provider in T3's
  main Add provider list, default `claude codex` (Dockerfile `ENV`, both
  YAMLs and the README; a test ties them). No provider CLI is baked into
  the image. Installs run only while the CLI is missing from PATH and use the
  path a user would (npm into `NPM_CONFIG_PREFIX=/data/.local`, the vendor's
  `install.sh`, `install-claude-code`), so T3's **Update now** recognizes and
  owns them afterwards. Don't pin, shim or wrap provider CLIs: T3 then can't
  prove who owns the install and its updater puts a second copy on PATH.
  Cursor (SDK inside T3) and Antigravity (T3 downloads it into
  `/data/.t3/tools`) are `t3` installs: accepted, nothing to do. Kiro, fx and
  ACP-registry agents get no token unless someone asks (an issue).
  Deselecting never deletes. `scripts/harnesses.ts` holds the catalog: every
  driver in T3's `BUILT_IN_DRIVERS`, and a token plus install recipe for the
  selectable ones. A T3 bump fails CI's freshness step until a new or removed
  driver is classified there (0.1.7 added Kiro).
- Background installers (tool groups, providers) log to
  `/data/.local/state/t3code/<name>.log` through the entrypoint's
  `background` helper (append, one rotation at 1 MiB, container-log
  fallback); provider state is `providers.json` and the lock
  `providers.lock` in the same directory.
- Core bootstrap: uv/uvx come from `ghcr.io/astral-sh/uv:${UV_VER}` (pinned
  ARG), `UV_PYTHON_DOWNLOADS=manual`; `sqlite3` and `zstd` are in the late
  core apt layer (`bin/install-claude-code` fetches Claude's `.zst` build
  with zstd); `gh` is GitHub's release tarball (`GH_VER` ARG,
  checksum-verified; Debian trixie's is 2.46.0) because T3's GitHub provider
  and agent PR work need it. Other forge CLIs (glab, fj/tea, az) and login UX are issue #15.
  No general SDK expansion beyond that.
- `t3code-tools help` (`USAGE` in `scripts/tool-groups.ts`) is the command
  reference; a test checks every command is in it, so update it with the
  CLI. `install`/`prune`/`init` re-exec as the payload root's owner when
  run as root (`/container/shell`), never leaving root-owned payloads.
  The entrypoint runs `install --keep-trying` (rounds for about a day, lock
  released between them); a terminal `install` stays at three attempts.
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
  `app/t3code.tikapp.yaml`. Whenever that file changes (including comments),
  run `make share-link`; `test/freshness.test.ts` fails until the link
  decodes to the file exactly.
  URL-based loading is requested in https://github.com/tikoci/restraml/issues/123;
  once supported, prefer a link that loads the published YAML URL.
- RouterOS sends a container's stop signal only if PID 1 has a handler for
  it (`SigCgt` in `/proc/1/status`); otherwise it logs `signal 15
  (Terminated) not caught, kill immediately` and SIGKILLs. tini blocks
  signals instead of catching them, so it always got SIGKILL. PID 1 is
  `bin/t3code-init` (bash: traps and forwards signals, reaps orphans, passes
  the child's status through). Don't put tini, or any init that only
  blocks and waits for signals, back in front of it. T3's normal signal exit
  is 130, which RouterOS logs as `error: exited with status 130`. See
  `docs/research/2026-11-08/routeros-sigterm.md` (#25).
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
  CHR disk. Use an 8G app disk at minimum: the image extracts to roughly
  3GB, and the default groups add about 0.7GB in `/data` (plus install
  headroom; about twice that after a refreshing update, until
  `t3code-tools prune`), before projects and lab VMs. Extra RAM (`mem: 1024`) for the
  pull + unpack.
- `centrs api <router> app -X PUT` is the structured write path
  (PUT = RouterOS create). `execute` is the fallback if validation rejects.
