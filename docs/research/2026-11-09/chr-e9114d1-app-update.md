# `/app/update` to the promoted `:0.1` (`e9114d1`, #38)

2026-11-09, quickchr and centrs `@next`. The same two licensed test CHRs as
[chr-d36a5e5-verify.md](chr-d36a5e5-verify.md): `t3code` (x86, RouterOS
7.25, HVF) and `t3code-arm64` (arm64, 7.25.1, TCG).

This closes the two acceptance items PR #38 left open: a literal
`/app/update` through the `:0.1` release tag (the candidate was tested with a
direct container start), and the `/welcome` provider cards after it.

## Starting state

Both ran the previous `:0.1` (`d685ba3`: Codex and OpenCode baked into
`/usr/local/bin`, no `t3code-providers`). Neither app's environment list sets
`T3CODE_PROVIDERS`, so the new image's default (`claude codex`) applies.

| | x86 `t3code` | arm64 `t3code-arm64` |
|---|---|---|
| `codex` | `/data/.local/bin/codex` 0.167.0, left in the home by the #38 candidate run | `/usr/local/bin/codex` 0.167.0 (image); none in the home (restored from the pre-candidate snapshot) |
| `claude` | `/data/.local/bin/claude` 2.1.311 | `/data/.local/bin/claude` 2.1.311 |
| `opencode` | `/usr/local/bin/opencode` 1.19.5 (image) | `/usr/local/bin/opencode` (image) |
| Tool groups | `capture labs vpn routing dev`, all `ready` | `labs vpn dev`, all `ready` |

So arm64 is the clean upgrade path for an existing install: Codex has to
leave the image and arrive in the home.

## Steps

1. `disabled=yes`, guest shutdown, offline clone of every disk
   (chr-app-lab step 5) to
   `~/.local/share/quickchr/backups/<n>-20261109-1157xx-pre-update-e9114d1`.
   Both stops took under 10 s.
2. Start, `disabled=no`, wait for `running`.
3. `/app/update [find where name="t3code"]`, then poll `/container` until
   `image-id` changed and `running` was `"true"`.

## Results

### The update

| | x86 | arm64 |
|---|---|---|
| `/app/update` sent → new container running | 2 min 3 s | 4 min 52 s |
| New `image-id` | `c108cb95…` | `e7f3f1fb…` |
| GHCR `:0.1` config digest for that arch | `c108cb95…` | `e7f3f1fb…` |

The app stayed enabled across the update.

### Providers after the update

| | x86 | arm64 |
|---|---|---|
| `T3CODE_PROVIDERS` in the container | `claude codex` (image default) | same |
| `codex` | `ready`, the home's existing install reused, no download | `installing` at first look, then `ready` at `/data/.local/bin/codex`: `npm install --global @openai/codex` 20:02:40 → 20:05:25 (2 min 45 s), 393 MiB under `/data/.local/lib/node_modules/@openai` |
| `claude` | `ready`, reused | `ready`, reused |
| `opencode` | gone with the old image (not selected) | gone |
| `/usr/local/bin/codex` | gone | gone |
| `t3code-tools status` | `providers: codex=ready claude=ready` | same |

Every tool-group payload ID matched the pre-update one on both machines, so
nothing in `/data` was re-downloaded.

### `/welcome`

Paired a fresh browser session with `t3-pairing-link`, then opened
`/welcome` → **Agents**.

- **x86:** Codex **Ready** (signed in) and Claude **Ready**. Same result as
  the candidate run, now through the release tag.
- **arm64:** the Codex card offers **Use existing CLI** / **Continue with
  ChatGPT**, which means T3 found the CLI installed into the home. This home
  has no Codex login, so it's not Ready. Claude shows **Needs attention ·
  Timed out after 25s while checking Claude account status**, and T3 raised
  "t3code-arm64 froze for 8s · CPU overloaded (load 5 on 2 cores)". This is
  the same TCG slowness the candidate run hit (a direct `claude auth status`
  took 46 s there), not a provider-install problem. A login check on arm64
  needs native hardware (an RDS2216, or the CI `ubuntu-24.04-arm` runner for
  the non-UI part).

## Notes

- The state directory `/data/.local/state/t3code` on both homes is still
  `drwxrwxrwx`, and `install-claude-code.log` is `-rw-rw-rw-`: both were
  created before the umask fix (#35). Files written since are 644. This is
  the documented behavior (CHANGELOG, SECURITY.md); `chmod -R go-w /data`
  fixes old files.
- Each pairing added a client session to the T3 database on both homes.
- Backups are kept. Both CHRs are left running the new `:0.1`.
