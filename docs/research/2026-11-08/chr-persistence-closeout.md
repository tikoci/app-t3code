# #3 closeout: `gh` login and uncommitted files across `/app/update`, x86 and arm64

Live run, 2026-11-08 UTC, on both test CHRs, driven from the x86_64 host
with quickchr 0.5.5 and centrs 0.1.9. It covers the two items left open in
`docs/research/2026-11-07/chr-0.1.7-upgrade.md`: a `gh` login, and
uncommitted checkout/worktree files, each across a digest-changing
`/app/update`. The recipe is `.claude/skills/chr-app-lab/SKILL.md`.

| CHR | RouterOS | Arch | Home |
|---|---|---|---|
| `t3code` | 7.25, p-unlimited | x86, HVF | long-lived: projects, threads, Codex and Claude logins |
| `t3code-arm64` | 7.25.1, p-unlimited | arm64, TCG | fresh 0.1.7 install from #26 |

The update crossed `:0.1` = `:0.1.7` from `sha256:3d9ae1b7…` (#23) to
`sha256:cdb5615e…` (#27's `main` build, promoted). T3 stays 0.1.7. The
image adds the pairing-screen hint (`routeros-pairing.js` is served after
the update). Each container's new `image-id` is the per-arch config
digest of that index:

| | Before | After | Replaced in |
|---|---|---|---|
| x86 | `c74aef5ab18d…` | `ff7268baa654…` (linux/amd64) | 2m40s |
| arm64 | `6e2ceab6e253…` | `a271d4d2c27f…` (linux/arm64) | 6m30s |

## Fixtures

The same fixtures went into both homes:

- **`gh` login.** Amm0Bot, by device flow from `/container/shell` (skill
  step 7). No token left the host. It's stored in `/data/.config/gh/hosts.yml`
  (mode 600; the container has no keyring). Scopes: `repo`, `read:org`,
  `workflow`, `gist`.
- **Checkout** `/data/tikoci/app-t3code` (on arm64, cloned for this run):
  - one unstaged edit and one staged edit
  - an untracked `.persist/sentinel.txt`
  - a stash entry
- **Worktree** `/data/.t3/worktrees/app-t3code/t3-persist-3`, on branch
  `t3/persist-3`, in T3's own layout. It has a tracked edit and an untracked
  `WORKTREE-SENTINEL.md`.

For this run, `scripts/research-home-manifest.ts` gained three fields per
repo: a hash over untracked file names and contents, the `git worktree list`,
and the stash list. The old `statusSha` and `diffSha` didn't cover
untracked contents.

## Steps

1. Fixtures, then the `gh` logins.
2. **Offline backup** of both (skill step 5). Each guest shut down cleanly
   ("guest exited"). The APFS clones passed `qemu-img check`.
3. **Control manifest** after that restart.
4. **`/app/update`**, then a **post manifest**, compared with the control.
5. **Restore test** on x86. First a safety clone of the current disks, then
   the backup clones copied over the machine's disks. The restored router
   booted the old image (`c74aef5a…`). Its manifest was compared with the
   control.
6. **`/app/update` again** from the restored state, compared with the first
   post manifest.

## Result: everything preserved, on both architectures

Compared with the control, the post manifests changed only in the restart
noise already known from the 0.1.7 run:

- one `auth_pairing_links` row per server start
- `~/.claude.json` rewritten by Claude's startup probe (x86 only; arm64
  has no Claude, see #13)
- the mtime of one T3 Connect secret

| Item | x86 | arm64 |
|---|---|---|
| Environment ID | same | same |
| T3 DB row hashes (`HASHED_TABLES`, see below) | identical | identical |
| Row counts of every other T3 DB table | identical | identical |
| Settings, keybindings, secrets | identical | identical |
| `gh` `hosts.yml`, `gh auth status` | unchanged, exit 0 | unchanged, exit 0 |
| `gh api user` after the update | `Amm0Bot` | `Amm0Bot` |
| Checkout: HEAD, status, tracked diff, untracked contents, stash | identical | identical |
| Worktree: registration, branch, tracked diff, untracked contents | identical | identical |
| Sentinel `sha256sum`, read directly after the update | matches | matches |
| Tool groups and payload IDs | `ready`, unchanged | `ready`, unchanged |

Row hashes cover the manifest's `HASHED_TABLES`:

- projects
- the v2 thread, message, run, turn-item and node projections
- the v2 and legacy event logs
- auth sessions
- scheduled tasks
- peer environment links

The other tables are compared by row count only, along with the migration
IDs.

The **restore** reproduced the control state exactly, apart from the same
restart noise, and the pairing-link count matched as well. The second
update from that restored state was again identical to the first post
manifest, apart from restart noise. So the documented backup → restore →
update path works end to end.

## Other observations

- **The stop is still a SIGKILL** (`signal 15 (Terminated) not caught, kill
  immediately`, then `exited with signal 9`). Nothing was lost (#25).
- **Old layers are garbage-collected late.** About a minute after the
  x86 restart, `/data` still showed 6.5 GB used and 42 layer directories:
  the old image's 17 unique layers, plus the 25 the new container uses.
  By 16:04, about 13 minutes later, it was back to 4.6 GB and 25 directories.
  On arm64 it was 4.6 GB by the first post check, about 7 minutes in. Budget
  room for a second image during an update and for a while after it.
- **RouterOS caps an API command's reply at about 60 s.** Under TCG, the
  manifest run (about 2 minutes of Bun) came back from RouterOS as
  `action timed out … (13)`, but its output file was complete. Measured
  afterwards on x86 with `sleep N`:
  - The command always runs to the end, and the error arrives when it
    exits: `sleep 130` failed after 131 s. Only the reply is lost.
  - The limit is between 59 s (returns) and 61 s (traps).
  - Over native API it's a `!trap`; over REST the session closes at the
    same point.
  - A plain `:delay 65s` traps too, so it's RouterOS `/execute`, not
    `/container/shell` and not centrs. centrs's `--timeout` doesn't move it.

  For long work, redirect output to a file or start it detached and poll.
  Both are in the skill.
- After the restore, the re-pull took 488 s against 160 s for the first
  update, because GC had already dropped the new layers. It was a full
  download.

## Left on the test CHRs

The fixtures, the `gh` logins, and the backups in
`~/.local/share/quickchr/backups/` are all still there:

- `t3code-20261108-074750`
- `t3code-arm64-20261108-074758`
- `t3code-20261108-080503-pre-restore`

The fixtures make the next run (#7) a third crossing. The checkout on
x86 has uncommitted edits to `README.md` and `CHANGELOG.md`. An agent using
that checkout should `git stash` or `git checkout .` first.
