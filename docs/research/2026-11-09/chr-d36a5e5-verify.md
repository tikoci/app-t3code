# CHR verification of the promoted `:0.1` (`d36a5e5`)

2026-11-09, quickchr 0.5.5, centrs 0.1.9. Two licensed (`p-unlimited`) test
CHRs from #3: `t3code` (x86, RouterOS 7.25, HVF) and `t3code-arm64` (arm64,
7.25.1, TCG). Both ran a pre-#25 image (PID 1 `tini`) with Claude Code
2.1.319 that T3's `/welcome` had installed in the home.

Covers the roadmap's (#30) CHR items for #34, #25 and #18, and the "late
rediscovery" question on #13.

## Steps

1. `disabled=yes`, then offline backup of both machines (chr-app-lab step 5),
   to `~/.local/share/quickchr/backups/<n>-20261109-044946-pre-d36a5e5`.
2. `/app/update`. New `image-id`s matched GHCR's `:0.1` config digests:
   amd64 `cc5f4307…` (pull and extract 12:50:15 → 12:53:49), arm64 `14c8d0fa…`
   (→ 12:58:12). The app stayed disabled across the update.
3. Enabled, then moved Claude aside in each home (`~/.local/bin/claude` and
   `~/.local/share/claude` to `~/.cache/pre-d36a5e5/`), so `claude` was off
   PATH as in a fresh home. The rest of the home (logins, projects) stayed.
4. `disabled=yes` / `disabled=no`. The stop checks #25, and the start runs
   the entrypoint's installer.

## Results

### #25: graceful stop

| Run | Log |
| --- | --- |
| Old image, both arches | `signal 15 (Terminated) not caught, kill immediately`, `exited with signal 9` |
| New image, x86 | `*** stop` 13:00:55 → `exited with status 130` 13:00:56 |
| New image, arm64, 42 s after start | `exited with status 143` (1 s) |
| New image, arm64, T3 fully up | `*** stop` 13:04:50 → T3 shutdown output → `exited with status 130` 13:04:54 |

No "not caught" with the new image. 143 is 128+TERM: the stop arrived while
T3 was still booting under TCG and had no handler yet, so Node took TERM's
default action. It's still not a SIGKILL. PID 1 is
`/bin/bash /usr/local/bin/t3code-init /docker-entrypoint.sh t3 serve`.

### #34: Claude installs with no user action

| | x86 | arm64 |
| --- | --- | --- |
| start | 13:01:20 | 13:01:32 |
| download (stable 2.1.311, 280 MiB) | 13:01:21 → 13:02:43 | 13:01:38 → 13:03:31 |
| `installed Claude Code 2.1.311` | 13:02:50 | 13:04:32 |

Each log is at `/data/.local/state/t3code/install-claude-code.log`, the
staged download is cleaned up, and `claude --version` reports `2.1.311`. The
existing Claude login carried over (Settings → Providers: "Authenticated ·
Claude Pro Subscription").

### #13: late rediscovery

T3 logs `Claude Agent CLI health check failed. { errorTag: 'PlatformError' }`
at start, since `claude` isn't on PATH yet. At 13:04, more than a minute
after the install, `/welcome` still showed "Not found · Claude Agent CLI
(`claude`) was not found on PATH" with an Install button.

T3 does re-probe. Settings → Providers → Advanced has a **health check
interval of 300 s** by default, and opening Settings → Providers refreshed
the status ("Checked just now"). After that, `/welcome` showed "Claude
(TIKOCI) · Ready to code". So a new user sees "Not found" for up to about
5 minutes after the first start, then Ready, with nothing for them to do.
`/welcome` itself doesn't trigger a probe.

Checks didn't seem to run while no browser was connected: Settings →
Providers read "Checked 26m ago" at 13:32, and the last check had been at
13:06.

### Claude update through T3

The installer takes the **stable** channel (2.1.311), so T3 then offers an
update (sidebar "Update 1 provider"). Its *Update now* runs
`/data/.local/bin/claude update`. On x86 that went to 2.1.319 in about 35 s
(13:32:29 → 13:33:07). It relinked `~/.local/bin/claude` and kept 2.1.311
alongside. After a stop and start (exit 130):

- `claude --version` was still 2.1.319.
- `install-claude-code.log` got no new entry: the installer acts only when
  `claude` is missing.
- `t3code-tools status` showed every group `ready`.
- Settings → Providers showed "v2.1.319 · Authenticated" with no update badge.

So a user updating Claude from T3 doesn't conflict with the image.

### #18: who can read the pairing banner

- The `/app` container has `logging=false`, so none of the container output
  (the entrypoint hint, T3's banner) reaches `/log`.
- `/container/log` keeps it all. A user in the built-in `read` group
  (`/user/add group=read`) reads it over REST (`GET /rest/container/log`) and
  sees `Token: …`, `Pairing URL: …/pair#token=…` and the QR code from the
  latest start. The same user gets `not enough permissions (9)` on
  `/container/shell`.
- `t3 serve --help` has no flag that suppresses the banner. It isn't printed
  through the logger, so `--log-level` doesn't help.

### New: umask 0000

`/proc/1/status` shows `Umask: 0000` for PID 1, T3 and `/container/shell`, so
files T3 and its agents create in `/data` are 666, and their directories 777
(`settings.json`, `keybindings.json`, logs, projects). Files whose tools set
a mode themselves are fine: `~/.claude/.credentials.json`,
`~/.config/gh/hosts.yml` and `~/.claude.json` are all 600. The entrypoint
now sets `umask 022`. Commands run through `/container/shell` still get
RouterOS's 0000, because RouterOS starts them directly, not through the
entrypoint.

## State left behind

Both CHRs run `:0.1` (`d36a5e5`) with Claude 2.1.311. The old 2.1.319 tree is
in each home under `~/.cache/pre-d36a5e5/`. Backups are listed in step 1. A
`read`-group user `rotest` added for the #18 check was removed.
