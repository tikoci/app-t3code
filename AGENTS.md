# AGENTS.md — app-t3code

RouterOS `/app` container for T3 Code. Greenfield tikoci repo: Dockerfile
rebuild of the wodby/t3code approach, `/app` YAML in `app/`, Bun tests.

## Layout

What ships, and where, versus what stays in the repo. Folders that ship
mirror their place in the image.

| Path | Ships to | What |
| --- | --- | --- |
| `app/` | routers (`/app add`) | The `/app` YAML and app-store document |
| `Dockerfile`, `docker-entrypoint.sh`, `profile.sh` | image | The build, the server start, the login-shell PATH |
| `bin/` | `/usr/local/bin` | Entry points: `t3app` (the operator command), `t3code-init` (PID 1), `install-claude-code` |
| `lib/` | `/usr/local/lib/t3app` | Shipped runtime modules: tool groups (catalog, status, payloads, CLI), providers, shared runtime, the harness catalog, image inventory, the build-only `deb-lock.ts`; `lib/groups/` holds payload specs and locks |
| `client/` | T3's web client, at build time | Deliberate UI overlays (`scripts/install-pairing-help.sh` installs them) |
| `scripts/` | never | Build, CI and repo upkeep: freshness, runner inventory, `home-manifest.ts` for CHR runs |
| `test/` | never | Bun tests, plus the shell smoke tests the image tests run |
| `docs/notes/`, `docs/research/` | never | Logbook and research topics (Workflow below). Probes sit next to their evidence and are frozen: type-checked and linted, not shell-linted. A probe that imports `lib/` gets mechanical import and path fixes when `lib/` moves; changing what it measures is new research |
| `.agents/skills/` | never | Skills for developing this repo (`.claude/skills` links here) |
| `scratch/` | never | Git-ignored dump for files agents need (a `/tmp` that lasts a few sessions). Never referenced from docs, tests or skills |

Skills shipped in the image will get their own top-level `skills/` (#46);
it doesn't exist yet.

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
  and its harness catalog, the newest stable T3, the Claude Code
  download contract `bin/install-claude-code` reads, and `tools`: every other
  pinned download (`TOOL_PINS`: gh, uv, Bun, hadolint, ShellCheck,
  actionlint) against its upstream's latest release. CI runs `pinned` on every
  PR; `freshness.yml` runs them all daily, and a red run there means bump.
  While the scheduled run (or a manual run on `main`) is red it keeps one
  open `freshness` issue with the latest report (`scripts/freshness-issue.sh`)
  and closes it when green.
- Workflow actions are pinned to a commit SHA with the release in a comment
  (`uses: actions/checkout@<sha> # v7.0.1`). Dependabot (`.github/dependabot.yml`,
  GitHub Actions only) moves both monthly in one grouped PR; pin new actions
  the same way. Jobs run on a named release (`ubuntu-24.04`,
  `ubuntu-24.04-arm`), never `ubuntu-latest`, which GitHub moves to 26.04
  on its own schedule; the "runner pin" test checks it. Bun's version is in
  the Dockerfile (`BUN_VER`) and every setup-bun step; `test/app-yaml.test.ts` keeps them equal.
- `APP_T3CODE_INTEGRATION=1 bun test test/integration/` — full CHR
  boot + container install + web UI probe. Needs QEMU and network; slow
  (the GHCR image pull alone is ~1GB on a free-license CHR).
- `make build T3CODE_VER=<ver>` — local multi-arch build.
- `make push T3CODE_VER=<ver>` — multi-arch push to GHCR (`:<ver>` + `:latest`).
  CI never pushes release tags directly: `main` pushes `:sha-<commit>`, the
  arm64 image runs the replacement test on `ubuntu-24.04-arm`, then
  `promote` retags it. `integration.yml` follows via `workflow_run`.

## Tests

Where each suite runs and what it needs. CI's `lint-test` (`ubuntu-24.04`,
`bun run test`) runs every row above `container-replacement`; the rest need
an image or a CHR. On macOS, only the first five rows are meaningful today:
the others hang or fail rather than skip, because they need Linux tools
(#30 "CI modularity" tracks gating them).

| Suite | Checks | Runs on | Needs |
| --- | --- | --- | --- |
| `app-yaml` | `/app` YAML and store doc, release and Bun/runner pins, selector parsing, docs ↔ image contract | any host | nothing (reads files) |
| `freshness` | drift checks with GitHub mocked, the README share link | any host | nothing |
| `pairing-help` | the pairing UI overlay and its install script | any host | `sh` |
| `providers` | `T3APP_PROVIDERS` selection, install steps, installer state | any host | fakes; lock via FFI `flock` |
| `t3app` | the `t3app` CLI: usage errors and exit codes, ignored legacy `T3CODE_*` keys, combined status, background `install` starts and "already running", umask 022 | any host | `sh`; lock via FFI `flock`; skips the start tests as root |
| `init` | `t3code-init` signal forwarding and reaping | Linux | bash ≥ 5.1 (skipped on macOS's 3.2) |
| `entrypoint` | background installs, log rotation and fallbacks | Linux | GNU `stat`; two tests skip as root |
| `tool-payloads`, `deb-payloads` | npm and deb payload lifecycles: install, activate, recover, prune, locks, CLI | Linux | util-linux `flock`, `/proc`, `setpriv` as root; fake npm, dpkg-deb, mirror |
| `install-claude-code` | the Claude installer against a fake download server | Linux | util-linux `flock`, `setpriv` as root (runs as `nobody`); `zstd` optional |
| `container-replacement` | the built image: start, replacement with the same home, every tool group's smoke script (`test/*-tools.sh`, run only inside the image) | CI `build` (amd64) and `arm64` jobs | Docker, `APP_T3CODE_DOCKER_IMAGE` (skips without it) |
| `integration/app-install` | `/app` install on a real CHR and the web UI answering | `integration.yml`: after each successful `ci` push to `main`, weekly, on dispatch | QEMU, network, quickchr, centrs, `APP_T3CODE_INTEGRATION=1` |

## CLI conventions

`t3app` (`bin/t3app` → `lib/t3app.ts`) is the one operator command; its
`USAGE` and each area's (`t3app tools help`, `t3app providers help`) are the
reference. Every area follows these rules:

- **Shape:** `t3app <area> <verb>`. `lib/t3app.ts` calls the area module's
  `main(argv)` in-process, never through a shell string. A new area
  (inventory, skills #46, credential handoff #47, a `t3 triage`-style
  support command) is a new module and a line in `t3app.ts`, never a new
  binary in `bin/`.
- **Exit codes:** `help`, `--help` or `-h` alone, or `<command> --help`,
  exits 0 on stdout. An unknown command or an extra argument, including
  with a help flag (`help extra`, `install now --help`), exits 2 with usage
  on stderr, before anything runs (including the switch to the payload
  owner). `helpRequest` in `lib/runtime.ts` is the shared rule. 1 means the operation
  failed; 3 means the wrong user.
- **`--json` only on status:** `t3app status --json` is the agent form;
  `tools status` and `providers status` keep theirs for the image build and
  tests. No other verb grows `--json` unless something consumes it.
- **Within 60 s:** RouterOS drops a `/container/shell` reply after about
  60 s (`.agents/skills/chr-app-lab`), so a verb that can run longer starts
  its work in the background (`startInBackground` in `lib/runtime.ts`),
  answers at once with what started and its log, and leaves progress to
  `t3app status`. `--wait` runs it in place. If one is already running, it
  says so and starts nothing. Measured on the lab CHRs, idle: `t3app status`
  stays within a few seconds on x86 and about 6 s on arm64 under TCG.
- **Users:** `/container/shell` runs as `node` (uid 1000) unless given
  `user=root` (measured on 7.25 x86 and 7.25.1 arm64). Commands that write
  the tool payload root re-exec as its owner; `providers install` refuses
  root (exit 3).
- **umask:** `t3app` sets 022 at start, like the entrypoint, because
  `/container/shell` starts commands with 0000.
- **Internal forms:** `t3app init` and `install --keep-trying` are the
  entrypoint's and stay out of the top-level help; `lib/deb-lock.ts` is
  build-only and not a `t3app` command at all.
- **Settings:** the image reads `T3APP_*` only. `LEGACY_ENV` in
  `lib/t3app.ts` names the old `T3CODE_*` keys so `init` can log them as
  ignored, and that is the only place they appear (a test checks).

## Workflow

- **The menu is the Roadmap issue**, pinned at the top of the Issues tab
  (`gh issue list --label roadmap`). It groups every open theme into
  Now / Next / Later, with a dependency graph. Topics live there as one line
  until they are next or need cross-repo work; only then do they get their
  own issue. **Before ending a session that opened, closed or re-scoped an
  issue, re-read the live Roadmap and update its lists and dependency graph**
  (`gh issue edit <n> --body-file`). Tracking lives in GitHub, not in
  committed files, so machines don't need sync commits.
- **Now is a handful of items.** Each one is either clear, needs only a
  small decision, or has unknowns you resolve by starting it (a T3 version
  bump). Anything waiting on hardware, on another repo or on GitHub goes to
  Next. When every Now item is done, fold them into a collapsed
  "Now: closed <date> (<what>)" section with one line each. Move what's left
  to Next, and promote a few Next items so Now has some work again. A
  closeout note (`docs/notes/`) records the baseline when that matters, as
  in `docs/notes/2026-11-10-t3-0.1.7-closeout.md`.
- **Labels:** `track` is a long-lived issue that collects one concern and
  is never "done" (updating #6, skills). `research` means grounding comes before
  code. `upstream` means it needs work or a bug report in a sister project
  (centrs, quickchr, restraml, routeros-skills) or in T3 Code. `ux` means
  first-user friction.
- **`docs/` has two kinds of writing.** Most sessions add to neither; the
  PR, the issue and `CHANGELOG.md` are the record. Write one only when the
  work earns it: research that later work will build on, or a closeout,
  deep review or major design decision across sessions. Link it from the
  issue in a comment.
  - **`docs/research/<YYYY-MM>-<topic>/`**: a research topic that can grow
    over several days, with its evidence beside it (probes, JSON, logs).
    The main write-up is `README.md`. The month dates the topic, not each
    edit; update the folder rather than starting a new dated one. Example:
    `docs/research/2026-11-t3code-presentation/`.
  - **`docs/notes/<YYYY-MM-DD>-<topic>.md`**: an engineering logbook entry,
    one file, written once and not edited later: a live CHR run, a review
    of an install, a closeout. A later run gets a new note. A review of a
    live install by an agent running on it is
    `<date>-chr-<agent>-review.md`, in the same shape as
    `docs/notes/2026-11-08-chr-codex-review.md`.
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
- A ruleset on `main` ("main: PRs with resolved threads; image changes need
  CI") requires a pull request (squash only, no approval needed, every
  review thread resolved) and the `ci` jobs `lint-test` and `build`, and
  blocks force-push and deletion. A docs-only change skips `build`, which
  counts as passing, so it waits only on `lint-test`. Admins bypass it; that
  is what lets small doc fixes go straight to `main`. Don't rename those two
  jobs without updating the ruleset.
- **CHANGELOG stamps** (numbering `## Not yet numbered` after a promotion, below)
  are pre-approved for anyone with write access: a PR that changes only
  `CHANGELOG.md`, labeled `skip-review`, merged by its author once
  `lint-test` passes. Rulesets can't exempt a single file, so a PR is the
  path for non-admins.
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
  line under `## Not yet numbered` in `CHANGELOG.md`. When its `main` build is
  promoted, move its lines under a new `## <T3 version>-app.<N> — <date>`
  heading that starts with the promoted `sha-<commit>` (each promoted build
  gets its own heading). `N` exists only once the merge's `ci` run starts,
  so the move goes in the next PR or a CHANGELOG stamp (see Branches). Take the name from the promoted image, which already
  includes any re-run suffix:
  `crane config ghcr.io/tikoci/app-t3code:0.1 | jq -r '.config.Labels["org.opencontainers.image.version"]'`.
  Without crane, `gh run list --workflow ci.yml --branch main --event push --json number,attempt,headSha`
  gives the run number and attempt (the run *number*, not its ID).
- A re-run that rebuilds the image appends the attempt (`0.1.7-app.133.2`),
  so a pushed `-app.` tag never moves.
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
  before/after content manifest (`scripts/home-manifest.ts`).
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
  `docs/research/2026-11-app-set-environment/README.md`.
- Tool groups (`T3APP_TOOL_GROUPS`, issue #5): the groups and selection
  parsing are in `lib/tool-catalog.ts`, the report in `lib/tool-status.ts`,
  installs in `lib/tool-payloads.ts`, and the `t3app tools` CLI in
  `lib/tool-groups.ts`. `lib/runtime.ts` holds only what payloads and
  providers both use (app home, state dir, budgets, process identity,
  orphan stop, `flock`); it is not an installer framework. Any key added to the
  YAML `environment:` must also be a Dockerfile `ENV` default with the same
  value (a test enforces it), because an operator's `environment=` set
  drops the YAML values. Never document group changes as a YAML edit.
- The shipped default is the explicit list
  `T3APP_TOOL_GROUPS="capture labs vpn routing dev"` (`DEFAULT_TOOL_GROUPS`,
  mirrored in Dockerfile `ENV`, both YAML files and the README; a test ties
  them). Unset/empty also mean that list; `none` is core only; `all` also
  picks up future groups. A new group joins the default only deliberately
  (update the constant, ENV, YAMLs, share link). Tests set selections
  explicitly; don't pick product defaults for test convenience.
- Not groups: `browser` (its native libraries are core, in the first apt
  layer; T3 launches its own browser, so no relocation or launch hooks) and
  provider CLIs. Providers are `T3APP_PROVIDERS` (`lib/providers.ts`,
  shipped as `t3app providers`, issue #13): one token per provider in T3's
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
  Deselecting never deletes. `lib/harnesses.ts` holds the catalog: every
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
- `t3app tools help` (`USAGE` in `lib/tool-groups.ts`) is the area's
  command reference; a test checks every command is in it, so update it
  with the CLI. `install`/`prune`/`init` re-exec as the payload root's owner
  when run as root (`/container/shell user=root`, `docker exec -u 0`),
  never leaving root-owned payloads. The entrypoint runs
  `t3app tools install --keep-trying` (rounds for about a day, lock released
  between them); `t3app tools install` starts three attempts in the
  background, and `--wait` runs them in place.
- npm payload groups (`dev`) are installed by `lib/tool-payloads.ts`
  from the lockfile in `lib/groups/<group>/` into
  `/data/.local/share/t3code-tools`; startup only relinks (offline) and
  installs in the background. Pins change with `make dev-lock`; a changed
  lockfile is a new payload id on every home. `bun run test` covers the
  lifecycle with a fake npm; the docker replacement test covers real npm and
  offline reuse.
- `capture` (issue #5 slice 3) is a deb payload: `lib/deb-payloads.ts`.
  The Dockerfile pins its Debian closure from apt metadata with
  `lib/deb-lock.ts` after the last apt layer (run with `HOME=/root`, or
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
  See `docs/research/2026-11-tool-group-payloads/vpn-routing-payloads.md`.
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
  (`docs/research/2026-11-tool-group-payloads/research-quickchr-runtime.ts`, `QUICKCHR_MODULE` for a branch
  build). See `docs/research/2026-11-tool-group-payloads/labs-qemu-payload.md`.
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
  `docs/research/2026-11-routeros-sigterm/README.md` (#25).
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
  `t3app tools prune`), before projects and lab VMs. Extra RAM (`mem: 1024`) for the
  pull + unpack.
- `centrs api <router> app -X PUT` is the structured write path
  (PUT = RouterOS create). `execute` is the fallback if validation rejects.
