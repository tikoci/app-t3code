# app-t3code #3 CHR review (Claude, after the 0.1.7 upgrade) — 2026-11-08

Recommendation: PARTIAL, close to done. A digest-changing `/app/update` that also crossed a T3 version (0.1.6 → 0.1.7) and three T3 DB migrations kept the home intact on a test CHR. The environment ID, DB migration history, tool-group payloads, provider logins, a hand-installed Claude, T3-managed tools and this checkout are all present, and Claude runs through T3 here (this review is that run). Before closing #3: prove uncommitted checkout/worktree files survive on a CHR, prove a `gh` login survives (none exists yet), and post a closeout comment. Separate defect for #13: the image's Claude installer cannot work, because its manifest URL returns 404 and it parses a manifest schema that doesn't exist.

Sources: `git pull --ff-only` of the public repo to `c6a3f22` (Bump T3 Code 0.1.6 → 0.1.7, #23), then read `AGENTS.md`, `README.md` (Storage → What survives an image replacement, Tags) and `docs/notes/2026-11-08-chr-codex-review.md`. Issues #3, #6 and #13 with their comments, read through the unauthenticated public API (`gh` is not logged in here). No subagents, installs, restarts, RouterOS, settings or auth changes, `/app/set yaml=`, issue mutations or pushes. Temporary files only under `/tmp/claude-review`, removed afterward. No credential or secret contents read. Every subprocess was bounded to 20 s.

Parent-reported (measured from outside the container, not by this reviewer):

- At 2026-11-08T05:49Z, `/app/update` moved the image from `9498bff52b55…` (T3 0.1.6, built before `gh` was in core) to `c74aef5ab18d…` (T3 0.1.7, published digest `sha256:3d9ae1b7…`). The container was replaced in about 2m45s.
- An offline backup was taken first: app disabled, guest shut down, host-side disk clone.
- A metadata-only content manifest was taken before the upgrade, after a restart-only control, and after the upgrade. Row hashes of projects, threads, messages, runs, turn items, nodes, auth sessions and legacy events were identical across the upgrade.
- Also unchanged: the environment ID, settings, keybindings, every secret's contents, and the Claude and Codex credential files. All five payload IDs were unchanged and `ready`.
- Restart-only noise: one new startup pairing link, a rewritten `~/.claude.json`, and a new mtime on one T3 Connect secret.

## Findings

- PASS: home pinning. `HOME=/data`, `T3CODE_HOME=/data/.t3`, `T3CODE_VER=0.1.7`, and `t3 v0.1.7` all hold on the new root. `/data` is still `/dev/vdb[/apps/t3code/t3code-data]` ext4 (same app name, volume and destination). PID 1 `tini` started at 2026-11-08 05:52:11, so this is the replaced container.
- PASS: environment identity. `environment-id` = `b23b5799-783c-46f6-bc8b-afd00c6993b9`, mtime 2026-11-04T20:18:41. That is the same ID the Codex review recorded before the earlier 0.1.6 update, so the ID has now survived two digest-changing `/app/update`s.
- PASS: T3 DB migration across a version change. `effect_sql_migrations` rows 77–79 have `created_at` 2026-11-08 05:52:11; rows 75–76 still have their original 2026-11-04 20:18:41.
  - The server trace has `runMigrations` exit `Success` at 05:52:11Z, with the event `Migrations ran successfully` listing `77_RepairBooleanSettledOverride`, `78_DropOrchestrationEventCorrelationIndex` and `79_DelegatedRecoveryIndexes`.
  - The restart-only control at 05:35:09Z also shows `runMigrations` `Success`, but no new rows.
  - Current counts: 2 projects, 3 threads, 11 messages. These are live counts that can include threads created after the upgrade. The before/after identity proof is the parent's manifest.
- PASS: tool groups. Core and all five groups are `ready`. The desired and active payload IDs equal the Codex review's snapshot, and each payload's `last.updatedAt` and directory mtime are still 2026-11-07T23:58–23:59Z, so the upgrade reused them with no download.
  - One command per group works: tshark 4.4.19, QEMU 10.0.13 (aarch64), wireguard-tools v1.0.20210914, BIRD 2.17.5, Biome 2.6.5.
  - Caveat: 0.1.6 → 0.1.7 left every lock unchanged, so a changed-payload refresh was not exercised by this upgrade (#6).
- PASS: Claude through T3. `/data/.local/bin/claude` → `/data/.local/share/claude/versions/2.1.319` (mtime 2026-11-08T00:37, before the upgrade) resolves in ordinary and login shells and reports `2.1.319 (Claude Code)`.
  - In the process tree, PID 2 `t3 serve` is the parent of `/data/.local/bin/claude --output-format stream-json … --input-format stream-json`.
  - This review is that session. It proves Claude works through T3 0.1.7 on this install, and that a home-installed Claude persists across `/app/update`.
  - It does not prove the image provisions Claude (see the next finding).
- FAIL (#13, not #3): `install-claude-code` is broken in two ways.
  - Line 19 fetches `https://downloads.claude.ai/claude-code/stable/manifest.json`, which returns 404. With `set -eu` and `curl -f`, the script exits there, which matches the parent's `curl: (22) … 404` on the old root.
  - Line 24 also parses `.artifacts[] | select(.arch == …) | .url, .sha256` and untars a `.tar.gz`. The real manifest at `claude-code-releases/<ver>/manifest.json` has top-level keys `buildDate, commit, manifestSignatureEnforcement, platforms, sdkCompat, version`, and `.platforms["linux-x64"]` has `binary, checksum, size`.
  - `claude-code-releases/<ver>/linux-x64/claude` returns 200, `application/octet-stream`, with a length that equals the manifest `size` (a raw binary, not a tarball).
  - The channel pointers differ: `claude-code-releases/stable` = 2.1.311 and `…/latest` = 2.1.319. The script intends stable; the hand install here is latest.
  - The failure is silent. The log goes to `/tmp/install-claude-code.log` in the container root, which is discarded on replacement, and the entrypoint skips the installer once any `claude` is on PATH (no log exists on the new root).
- PASS (presence only): `gh` 2.103.3 is new in core, at `/usr/local/bin/gh` in both shells. `gh auth status` exits 1 and `/data/.config/gh/hosts.yml` is absent, so login persistence is untestable until someone logs in. `/data/.local/state/gh` (created 05:52) shows `gh` writes its state into the home.
- PASS: other providers. codex-cli 0.167.0 and opencode 1.19.5 are present; Muse is absent, as documented. Their logins: the parent reports Codex credentials unchanged; `/data/.codex` exists. Not re-verified by content.
- PASS: T3-managed tools persist. `/data/.t3/tools/cloudflared/2026.10.4` (T3's own managed install, mtime 2026-11-08T00:00) survived, which answers #13's question about whether `/data/.t3/tools` survives `/app/update`.
- PASS: this checkout. `/data/tikoci/app-t3code` is present under `/data` with a clean tree before this file was written. It is a committed checkout, so it does not prove uncommitted files survive.

## Storage, privileges and persistence

`id`: uid/gid 1000(node), node group only. Kernel `5.6.3-64 x86_64`. CapInh/CapPrm/CapEff/CapAmb are all zero, CapBnd=0000003fffffffff, NoNewPrivs=0, Seccomp=2 (unchanged from the Codex review).

`df -h / /data`: overlay and `/dev/vdb` both 24G, 4.5G used, 18G available (21%). Root and `/data` share the app disk.

Ownership: `/data` is 1000:1000 755; `/data/.t3`, `/data/.local/share/t3code-tools`, `/data/.claude` and `/data/.codex` are 1000:1000 777; `/data/.t3/userdata` is 700. `statev2.sqlite` with its `-wal` and `-shm` sidecars is in place. `settings.json` and `keybindings.json` are present (metadata only).

This install now has two digest-changing CHR `/app/update` crossings on the same home volume: `ccdbfdd9…` → `9498bff5…` (Codex review) and `9498bff5…` → `c74aef5a…` (this one). The second also crossed a T3 release and a schema migration. Together with the parent's row-hash manifest, this is the strongest persistence evidence #3 has: the README's "keep the app name, volume and destination, use `/app/update`" contract holds on RouterOS 7.25 x86. The `/app/set yaml=` wipe was not re-tested here and stays a documented hazard.

## Remaining coverage

To close #3:

- Uncommitted checkout and worktree files across a digest-changing CHR update. Write a sentinel into a T3 worktree and an uncommitted change into a `/data` checkout, `/app/update`, then compare hashes. The Docker replacement test covers this; this CHR run does not (`/data/.t3/worktrees` is empty, and this checkout was clean).
- A `gh` login surviving `/app/update` (#3's comment adds `/data/.config/gh`). Untestable until a login exists.
- A closeout comment marking each acceptance item done or transferred. The YAML-reset hazard and recovery are already documented.

UNTESTED here:

- A RouterOS reboot of the upgraded install.
- arm64 hardware.
- A digest change that also changes payload IDs (#6).
- The T3 self-update path (`t3 update`, the desktop "update servers" button; #6).
- Late Claude rediscovery after a background install (#13).

Transfer to #13: fix `install-claude-code`. Follow the official installer: read `claude-code-releases/stable`, then `<ver>/manifest.json` and `.platforms[<platform>]`, download `<ver>/<platform>/claude`, check its SHA-256 against `checksum`, and install it like the official layout. Keep the log in the home, or surface failure in `t3code-tools status`, so it isn't silent.

## Commands/results

Each subprocess was bounded to 20 s; outputs are trimmed only where marked.

```text
$ id; uname -a; t3 --version; cat /data/.t3/userdata/environment-id; echo $T3CODE_VER $HOME $T3CODE_HOME
uid=1000(node) gid=1000(node) groups=1000(node)
Linux CHR 5.6.3-64 #1 SMP Thu Oct 22 14:17:50 EEST 2026 x86_64 GNU/Linux
t3 v0.1.7
b23b5799-783c-46f6-bc8b-afd00c6993b9
0.1.7 /data /data/.t3

$ df -h / /data; findmnt -T /data
overlay          24G  4.5G   18G  21% /
/dev/vdb         24G  4.5G   18G  21% /data
/data  /dev/vdb[/apps/t3code/t3code-data] ext4   rw,nosuid,nodev,relatime

$ for c in claude codex opencode gh muse; do command -v $c || echo missing; done   # same in bash -lc
claude: /data/.local/bin/claude
codex: /usr/local/bin/codex
opencode: /usr/local/bin/opencode
gh: /usr/local/bin/gh
muse: missing
$ claude --version; codex --version; opencode --version; gh --version | head -1   # same in bash -lc
2.1.319 (Claude Code)
codex-cli 0.167.0
1.19.5
gh version 2.103.3 (2026-10-26)

$ ps -o pid,ppid,comm,args -e   (trimmed)
    1     0 tini            /usr/bin/tini -- /docker-entrypoint.sh t3 serve
    2     1 node-MainThread t3 serve
  401     2 claude          /data/.local/bin/claude --output-format stream-json --verbose --input-format stream-json …

$ grep -n -E "https?://|manifest|platform" /usr/local/bin/install-claude-code
19:manifest_url="https://downloads.claude.ai/claude-code/stable/manifest.json"
24:asset="$(jq -r --arg arch "$manifest_arch" '.artifacts[] | select(.arch == $arch) | "\(.url) \(.sha256)"' "$tmp/manifest.json" | head -n 1)"
$ curl -sS -o /dev/null -w '%{http_code}' https://downloads.claude.ai/claude-code/stable/manifest.json
404
$ curl -sS https://downloads.claude.ai/claude-code-releases/latest     -> 2.1.319 (200)
$ curl -sS https://downloads.claude.ai/claude-code-releases/stable     -> 2.1.311 (200)
$ curl … claude-code-releases/2.1.319/manifest.json (200); jq keys, .platforms["linux-x64"]
{"version":"2.1.319","keys":["buildDate","commit","manifestSignatureEnforcement","platforms","sdkCompat","version"],"linux_x64":{"size":340226576,"checksum":"dabafec82ca1…"},"artifacts":null}
$ … 2.1.311/manifest.json (200)
{"version":"2.1.311", … "linux_x64":{"size":293776752,"checksum":"86dc1fcc6949…"},"artifacts":null}
.platforms keys: darwin-arm64 darwin-x64 linux-arm64 linux-arm64-musl linux-x64 linux-x64-musl win32-arm64 win32-x64
.platforms["linux-x64"] keys: binary checksum size
$ curl -sS -I -o /dev/null -w '%{http_code} %{content_type} %header{content-length}' …/claude-code-releases/2.1.311/linux-x64/claude
200 application/octet-stream 293776752

$ gh auth status >/dev/null 2>&1; echo $?; test -e /data/.config/gh/hosts.yml
gh auth status exit=1
hosts.yml absent

$ t3code-tools status
T3CODE_TOOL_GROUPS="capture labs vpn routing dev" -> capture labs vpn routing dev
core: ready
capture       ready           present  Packet capture, decoding and flow collection
              payload amd64-trixie-8835b1586201c453
labs          ready           present  quickchr with QEMU emulators, qemu-img and firmware (one readiness contract)
              payload amd64-trixie-498eb8218e64b9d2
vpn           ready           present  WireGuard, strongSwan and OpenVPN peer and key tools, ike-scan (no default tunnel or service)
              payload amd64-trixie-f197c5f52e2d7e3a
routing       ready           present  Linux router-peer tools: BIRD, ND/ARP probes, nftables, conntrack, nmap
              payload amd64-trixie-7d4831ecb9d171fa
dev           ready           present  TypeScript, CSpell, markdownlint-cli2 and Biome fallbacks (project lockfiles win)
              payload x64-abi137-39009bbc8749a88d
build inventory: /usr/share/t3code/inventory (amd64)

$ t3code-tools status --json | jq -r '.groups[] | [.name,.state,.payload.desired,.payload.active,.payload.last.updatedAt] | @tsv'
capture  ready  amd64-trixie-8835b1586201c453  amd64-trixie-8835b1586201c453  2026-11-07T23:58:58.315Z
labs     ready  amd64-trixie-498eb8218e64b9d2  amd64-trixie-498eb8218e64b9d2  2026-11-07T23:59:11.396Z
vpn      ready  amd64-trixie-f197c5f52e2d7e3a  amd64-trixie-f197c5f52e2d7e3a  2026-11-07T23:59:18.577Z
routing  ready  amd64-trixie-7d4831ecb9d171fa  amd64-trixie-7d4831ecb9d171fa  2026-11-07T23:59:23.784Z
dev      ready  x64-abi137-39009bbc8749a88d    x64-abi137-39009bbc8749a88d    2026-11-07T23:59:34.862Z
(each group: installed = [that one id], stale = false)

$ tshark -v | head -1; qemu-system-aarch64 --version | head -1; wg --version; bird --version; biome --version
TShark (Wireshark) 4.4.19.
QEMU emulator version 10.0.13 (Debian 1:10.0.13+ds-0+deb13u1)
wireguard-tools v1.0.20210914 - https://git.zx2c4.com/wireguard-tools/
BIRD version 2.17.5
Version: 2.6.5

$ sqlite3 -readonly /data/.t3/userdata/statev2.sqlite "select migration_id,name,created_at from effect_sql_migrations where migration_id>=75"
75|SubagentDeliveryState|2026-11-04 20:18:41
76|ProjectionProjectsPinArchive|2026-11-04 20:18:41
77|RepairBooleanSettledOverride|2026-11-08 05:52:11
78|DropOrchestrationEventCorrelationIndex|2026-11-08 05:52:11
79|DelegatedRecoveryIndexes|2026-11-08 05:52:11
$ sqlite3 -readonly … "select count(*) from …"
projection_projects|2
orchestration_v2_projection_threads|3
orchestration_v2_projection_messages|11

$ grep 'Migrations ran successfully' / '"name":"runMigrations"' in the newest server.trace.ndjson{,.1} | jq (trimmed)
{"name":"runMigrations","start":"2026-11-08T04:04:04Z","durationMs":39.60168,"exit":"Success"}
{"name":"runMigrations","start":"2026-11-08T05:35:09Z","durationMs":19.422568,"exit":"Success"}
{"name":"runMigrations","start":"2026-11-08T05:52:11Z","durationMs":21.373972,"exit":"Success"}
{"name":"Migrations ran successfully","attributes":{"migrations":["77_RepairBooleanSettledOverride","78_DropOrchestrationEventCorrelationIndex","79_DelegatedRecoveryIndexes"],"effect.logLevel":"INFO"}}

$ ls -ld /data/.t3/tools/cloudflared/* /data/.t3/worktrees /data/.local/bin/claude
/data/.t3/tools/cloudflared/2026.10.4  (dir mtime /data/.t3/tools 2026-11-08T00:00:12)
/data/.t3/worktrees                    (empty, 2026-11-04T20:18:41)
/data/.local/bin/claude -> /data/.local/share/claude/versions/2.1.319  (2026-11-08T00:37)
$ ls /tmp/install-claude-code.log
No such file or directory

$ git status --porcelain | wc -l; git log --oneline -1     (before writing this file)
0
c6a3f22 Bump T3 Code 0.1.6 → 0.1.7 (#23)
```
