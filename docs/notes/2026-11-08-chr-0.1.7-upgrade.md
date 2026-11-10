# #3 re-run: `/app/update` 0.1.6 → 0.1.7 with a content comparison

Live run, 2026-11-08 UTC, on an existing x86 test CHR (RouterOS 7.25,
p-unlimited) driven from the host with quickchr 0.5.5 and centrs 0.1.9.
The recipe is in the repo skill `.claude/skills/chr-app-lab/SKILL.md`. The
review written by an agent running on the upgraded install is
`chr-claude-review.md`.

## Steps

1. **Baseline manifest.** `scripts/research-home-manifest.ts` (and an
   equivalent Python first draft) ran inside the container: read-only and
   metadata-only. Secret and login files were recorded as metadata plus a
   hash, compared only as same/different. Raw manifests were kept off the
   repo.
2. **Offline backup.** `/app/set … disabled=yes` until `/container`
   reported `stopped`, then `quickchr shutdown` ("guest exited", not forced).
   Then an APFS clone (`cp -c`) of `machine.json`, `boot.qcow2` and
   `disk1.qcow2` into an owner-only directory on the host, and
   `qemu-img check` on the data disk. Restarted and re-enabled.
3. **Control manifest** after that restart, on the same image.
4. **Upgrade.** After the #23 merge, CI promoted `:0.1` = `:0.1.7` =
   `sha-c6a3f22…` (`sha256:3d9ae1b7…`). `/app/update [find where
   name="t3code"]` replaced the container in about 2m45s (image ID
   `9498bff52b55…` → `c74aef5ab18d…`). The web UI answered 200 right after,
   and T3 reported `serverVersion` 0.1.7 on the same environment ID. The
   linked T3 environment reconnected with nothing to do.
5. **Post-upgrade manifest**, compared with the control.

## Result: content preserved

| Item | Before (0.1.6) | After (0.1.7) |
|---|---|---|
| Environment ID | `b23b5799-…` | same |
| Projects / threads | 2 / 2 | same IDs, **identical row hashes** |
| Messages, runs, turn items, nodes | 8 / 2 / 30 / 26 rows | **identical row hashes** |
| Legacy orchestration events | 153 rows | identical hash |
| Auth sessions | 5 | identical hash |
| Settings, keybindings, `environment-id` | — | identical hashes |
| `userdata/secrets/*` (18 files) | — | contents unchanged |
| Codex `auth.json`, Claude `.credentials.json` | present | unchanged |
| DB migrations | max 76 | **77, 78, 79 applied** (max 79) |
| Tool groups (all five) | `ready` | `ready`, **same payload IDs**, no re-download |
| `gh` | absent (image predates #16) | 2.103.3, not logged in (`gh auth status` exit 1) |
| Repo checkout `/data/tikoci/app-t3code` | clean | same HEAD, clean |

Migration 077 rewrites boolean `settledOverride` values in thread
projections. The thread rows' hashes didn't change, so this home had none.

**Restart noise**, the same in the control and after the upgrade: every
server start adds one row to `auth_pairing_links` (a startup pairing link,
relevant to #18). Claude's startup probe rewrites `~/.claude.json`, and one
T3 Connect secret's mtime moves with its content unchanged.

**Disk:** during the update, `/data`'s filesystem (the whole app disk) briefly
read 6.4 GB used against 4.6 GB before. Afterwards it was back to 4.6 GB, with
exactly the new image's 23 layer directories. `/app/update` doesn't leave the
old layers behind.

**The stop was a SIGKILL.** RouterOS logged `signal 15 (Terminated) not
caught, kill immediately`, then `exited with signal 9`, for the
`/app/update` stop. PID 1 (`tini`) has `SigCgt` 0; `t3 serve` catches
SIGTERM but never receives it. Nothing was lost (SQLite's WAL is
crash-safe), but RouterOS never stops T3 gracefully. That's #25.

Not covered: authenticated provider requests after the upgrade (the agent
review running through T3 is the evidence there), downgrade to 0.1.6
(source reading only, in #23), and a reboot.

## Fresh install on an arm64 CHR

A new arm64 CHR (RouterOS 7.25.1, TCG on the x86_64 host, 2 vCPU, 2 GiB,
24G app disk, p-unlimited trial, bridged to the same LAN as the x86 CHR)
installed the published 0.1.7 image from `app/t3code.tikapp.yaml` with
`use-https=no`. The pull and extract took about 8 minutes, and the web UI
answered 200 about 11.5 minutes after the `/app` PUT. Its environment ID is new,
as expected for a fresh home.

Findings:

- **The Claude background installer fails on every fresh home.**
  `/tmp/install-claude-code.log` holds `curl: (22) The requested URL returned
  error: 404`, and `/data/.local/bin` doesn't exist. The installer fetches
  `https://downloads.claude.ai/claude-code/stable/manifest.json` (404 from
  the host as well). Anthropic's own `install.sh` reads
  `downloads.claude.ai/claude-code-releases/<version>/manifest.json`, keyed
  by `.platforms[…]`. This is why `claude` was "missing" in
  `chr-codex-review.md`: on the x86 home it was later installed by hand.
  Tracked in #13.
- **`/app` LAN redirect follows `router-ip`.** `/app/settings` records
  `assumed-router-ip` from the first address it sees. The LAN bridge got
  its DHCP lease after the disk was set, so the app's dst-nat bound to the
  user-mode NIC (`10.0.2.15`) and the UI wasn't reachable on the LAN. Setting
  `/app/settings/set router-ip=<LAN address>` (as on the x86 CHR) moved the
  redirect at once, but it also restarted the app with a SIGKILL (#25). That
  interrupted the first `capture` install, which the next attempt cleaned
  up (`removing interrupted install .staging-…`). Set `router-ip` before
  installing the app.
- Group payloads install in the background under arm64 IDs (`capture` is
  `arm64-trixie-c149fa9e83498601`). Under TCG this is slow: `capture`
  alone (46 packages, 27.9 MiB) was still unpacking 7 minutes after its
  download finished. Readiness of all five groups is tracked in #7.
- Under TCG, `/container/shell` commands that start Bun (`t3code-tools
  status`) took over 110 s while the background install ran. Plain shell
  commands returned in seconds.

## Tool feedback from this run

Filed or recorded on #24: centrs `transfer` can't see files under an `/app`
container root (tikoci/centrs#636); quickchr license flags
(tikoci/quickchr#261); the `/app` skills were installed but not offered to
the agent.
