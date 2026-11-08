# RouterOS stops a container gracefully only if PID 1 catches TERM (#25)

RouterOS 7.25 (x86 CHR `t3code`, HVF), 2026-11-08. Throwaway `/container`s
on their own veth, next to the running app, which wasn't touched.

## Finding

On `/container/stop` (and so on `/app/update`, `disabled=yes` and a
`router-ip` change), RouterOS reads PID 1's **caught**-signal mask, `SigCgt`
in `/proc/1/status`. If the stop signal's bit is clear, it doesn't send it:
it logs `*** signal 15 (Terminated) not caught, kill immediately` and sends
SIGKILL at once. If the bit is set, it sends SIGTERM and waits up to
`/container` `stop-time` (`30s` on the app's container, which this app's
YAML doesn't set). The `/app` YAML's `stop_grace_period` is documented as
the graceful-shutdown timeout; that it maps to `stop-time` wasn't tested.

| Container | PID 1 | `SigCgt` | On stop |
| --- | --- | --- | --- |
| `sig-b` (alpine) | `sleep 100000` | `0` | `not caught, kill immediately`, `exited with signal 9`, same second |
| `sig-a` (alpine) | `sh` with `trap … TERM` | `0x14002` | trap ran 5 s, `exited with status 0` |
| app-t3code 0.1.7 | `tini` | `0` | `not caught, kill immediately` (every stop since 0.1.6; earlier notes) |
| `sig-c` (debian:trixie-slim) | `bin/t3code-init` → `sh` with trap | `0x8014a07` | TERM forwarded, child exited 0 after 3 s, `exited with status 0` |
| `sig-t3` (app image 0.1, entrypoint swapped) | `bin/t3code-init` → `/docker-entrypoint.sh t3 serve` | `0x8014a07` | T3 logged `V2 orchestration shutdown reconciliation completed`, exited 5 s later with status 130 |

Bit 14 (`0x4000`) is signal 15. The check is about the mask, not about
whether the process handles TERM. tini *does* handle it: it blocks every
signal and collects them with `sigtimedwait`, so a blocked TERM would reach
it fine. But a blocked signal isn't a caught one, so RouterOS kills it
first. Any init built the same way (blocked signals plus `sigwait`,
`sigtimedwait` or `signalfd`) should get the same treatment; only tini was
tested.

## Fix

`bin/t3code-init` is a 30-line bash PID 1. It starts its arguments as its
one child, traps TERM, INT, HUP, QUIT, USR1, USR2 and WINCH and forwards
them, and exits with the child's status. bash's traps are real handlers, so
`SigCgt` has the bit. bash also reaps every child that exits, known or not,
which was tini's other job:

- In `sig-c`, five orphaned `sleep 1`s (re-parented to PID 1) left no
  zombies.
- A command detached from `/container/shell` (`setsid nohup sh -c …`, the
  pattern the chr-app-lab skill uses) re-parents to PID 1 too, and was
  reaped.

Three bash details the init handles (found in review, checked under the image's
bash 5.2):

- Without job control, bash starts a background job with SIGINT and SIGQUIT
  ignored, so a forwarded INT would have done nothing. The child starts as
  `( trap - INT QUIT; exec "$@" ) &`, which restores the defaults and is
  still one process. macOS's `/bin/bash` 3.2 keeps them ignored.
- The traps go in before the child starts, and signals that arrive first
  are queued and passed on once the child exists.
- A trapped signal interrupts `wait` with 128+n. `wait -p` (bash 5.1+) tells
  that apart from the child's exit: the variable stays unset, and waiting
  again returns the child's own status, even if it exited in between.
  That's checked under bash 5.2 (a child exiting 7 while the shell was in a
  trap still came back as 7). macOS's `/bin/bash` 3.2 lacks `wait -p`, so
  `test/init.test.ts` skips as a whole there.

Exit 130 is T3's own status after a signal-driven shutdown. The init passes
it through unchanged, so RouterOS logs `*** error: exited with status 130`.
That reads like an error, but it's the clean path.

## For other images

This applies to any RouterOS container whose PID 1 is tini or a similar
init, not only this one. Either make PID 1 something that installs a TERM
handler (a shell `trap`, or the app itself when it never spawns children),
or accept SIGKILL on every stop. `stop-time` does nothing for a PID 1
without a handler, and neither, presumably, does `stop_grace_period`.
