---
name: chr-app-lab
description: Run app-t3code on a quickchr CHR. Covers preparing a fresh x86 or arm64 CHR for /app (device-mode, container package, ext4 app disk, license, LAN bridge); installing, enabling and upgrading the app without losing /data; an offline /data backup; running commands inside the container; and a before/after content manifest. Use for a CHR install or upgrade test (#3, #7), a fresh arm64 install, /app/update, or comparing a home's content across an upgrade.
---

# app-t3code on a quickchr CHR

The recipe used for the #3 re-run (2026-11-07, RouterOS 7.25/7.25.1, quickchr
0.5.5, centrs 0.1.9). quickchr boots and changes the VM, and centrs talks to
RouterOS. `test/integration/app-install.test.ts` automates steps 1–4 for CI;
this skill is the hands-on version, plus the safe upgrade and backup steps
the test never runs. `AGENTS.md` → Gotchas has the reasons behind each rule.

**Two rules that lose data if broken:**
- Never `/app/set … yaml=` on an installed app. It wipes the app-owned
  volume, even for a comment-only change. Upgrade with `/app/update`.
- Back up `/data` offline before an upgrade (step 5), and keep the backup
  outside the app directory.

## 1. Create the CHR

```sh
quickchr add --name <n> --arch arm64 --version 7.25.1 --cpu 2 --mem 2048 \
  --boot-size 8G --add-disk 24G \
  --add-network user --add-network bridged:<host-if> \
  --device-mode-enable container
quickchr start <n>
quickchr set <n> --license --level p-unlimited
```

- `user` first: RouterOS DHCPs only ether1, and the host forwards ride on it.
- `--device-mode-enable container` must apply at first boot. Guest-side
  `/system/device-mode/update` never completes.
- `bootSize 8G` and a separate data disk of 8G or more. The image extracts
  to about 3 GB, and the default groups add about 0.7 GB to `/data`.
- License **after** the first start. `add` has no license flag, and
  `start --license-level` ignores the stored credential.
  `--level unlimited` is rejected by RouterOS; use `p-unlimited`
  (tikoci/quickchr#261). On a free license, the 1 Mbps cap makes the
  roughly 1 GB pull painful.
- arm64 on an x86_64 host runs under TCG, so size waits from minutes, not
  seconds.

## 2. Prepare RouterOS for /app

```sh
quickchr set <n> --package container        # reboots the guest
centrs retrieve --quickchr <n> /disk        # find the blank disk (fs "-")
centrs execute --quickchr <n> --yes '/disk/format *1 file-system=ext4'
centrs execute --quickchr <n> --yes '/app/settings/set disk=pcie1'
```

LAN access next to an existing bridged CHR: put the bridged NIC in a bridge
with a DHCP client, and push ether1's default route behind the LAN one.

```sh
centrs execute --quickchr <n> --yes '/interface/bridge/add name=bridge-lan'
centrs execute --quickchr <n> --yes '/interface/bridge/port/add bridge=bridge-lan interface=ether2'
centrs execute --quickchr <n> --yes '/ip/dhcp-client/add interface=bridge-lan default-route-distance=1'
centrs execute --quickchr <n> --yes '/ip/dhcp-client/set [find where interface=ether1] default-route-distance=10'
centrs execute --quickchr <n> --yes '/app/settings/set router-ip=<LAN address>'
```

The app's dst-nat redirect binds to `/app/settings` `router-ip`. When that's
unset, it uses `assumed-router-ip`, taken from the first address RouterOS
saw, which is ether1's user-mode `10.0.2.15` if the LAN lease came later.
Set `router-ip` and the redirect moves at once. It also **restarts the app**
(a hard kill), so set it before installing, not while groups install.

## 3. Install and enable

```sh
centrs api --quickchr <n> app -X PUT -f "yaml=$(cat app/t3code.tikapp.yaml)" -f use-https=no --yes
centrs execute --quickchr <n> --yes '/app/set [find where name="t3code"] disabled=no'
centrs retrieve --quickchr <n> /container   # .running is the string "true"
```

`use-https=no` on CHR: there's no `/ip/cloud` to mint certificates. A PUT
leaves the app disabled, so enable it. The pull plus the first five-group
install takes a while; `t3code-tools status --json` (step 6) says when the
groups are `ready`.

## 4. Upgrade an existing install

```sh
centrs execute --quickchr <n> --yes '/app/update [find where name="t3code"]'
```

`/app/update` pulls the tag again and replaces the container, keeping
`/data`. Change env with `/app/set environment=` (it replaces the whole list;
`AGENTS.md`), never `yaml=`. Toggling `disabled=yes/no` is safe and restarts
the container.

## 5. Offline /data backup

Stop the app first, so nothing writes during the copy. Note that RouterOS
doesn't stop it gracefully: it SIGKILLs at once, because PID 1 (`tini`)
installs no SIGTERM handler (#25). SQLite's WAL is crash-safe, and the clone
carries `statev2.sqlite` with its `-wal` and `-shm`. Then shut down the guest
and clone its disks on the host (on APFS, `cp -c` takes no time or space):

```sh
centrs execute --quickchr <n> --yes '/app/set [find where name="t3code"] disabled=yes'
centrs retrieve --quickchr <n> /container   # wait for stopped=true
quickchr shutdown <n> --timeout 150         # "guest exited", not "forced"
B=~/.local/share/quickchr/backups/<n>-$(date +%Y%m%d-%H%M%S); mkdir -p -m 700 "$B"
M=~/.local/share/quickchr/machines/<n>
cp -c "$M"/machine.json "$M"/boot.qcow2 "$M"/disk*.qcow2 "$B"/
qemu-img check "$B"/disk1.qcow2
quickchr start <n>
centrs execute --quickchr <n> --yes '/app/set [find where name="t3code"] disabled=no'
```

To restore: shut down, copy the clones back over the machine's disks, and
start. That restores the whole router, which is the point. It also undoes
anything else done since the backup.

## 6. Commands inside the container

```sh
centrs execute --quickchr <n> --yes '/container/shell app-t3code cmd="t3code-tools status --json"' --json | jq -r .data.ret
```

- Output comes back in `.data.ret` with CRLF line ends (`tr -d '\r'`). It
  runs as the image user (uid 1000, `node`).
- No bare `$` inside `cmd="…"`. RouterOS treats it as a variable, and centrs
  refuses it offline (write `\$`, or move the logic into a script).
- Files in: `centrs transfer --quickchr <n> upload <local>
  pcie1/apps/t3code/t3code_root/tmp/<new-name>`. The file shows up at
  `/tmp/<new-name>` in the container. RouterOS `/file` doesn't index the
  container root, so `--force`, download and remove fail there; use a new
  name each time (tikoci/centrs#636). Files out: `cat` them through
  `/container/shell`.
- `/tmp` is on the container root, so `/app/update` replaces it. Nothing
  written there touches `/data`.

## 7. Content manifest (before and after)

`scripts/research-home-manifest.ts` prints a read-only, metadata-only JSON
manifest of the home. It records:
- the T3 and provider versions, and the environment ID
- settings key paths
- migration IDs, row counts and row hashes of the T3 DB (opened read-only)
- the `t3code-tools` payload IDs
- the presence of each provider and `gh` login, and git state of each repo

Secret and login files appear only as metadata plus a hash for
same/different. Run it in the container with the baked Bun:

```sh
centrs transfer --quickchr <n> upload scripts/research-home-manifest.ts pcie1/apps/t3code/t3code_root/tmp/m1.ts
centrs execute --quickchr <n> --yes '/container/shell app-t3code cmd="bun /tmp/m1.ts > /tmp/m-pre.json && echo ok"' --timeout 190s
centrs execute --quickchr <n> --yes '/container/shell app-t3code cmd="cat /tmp/m-pre.json"' --json | jq -r .data.ret | tr -d '\r' > m-pre.json
bun scripts/research-home-manifest.ts --compare m-pre.json m-post.json
```

Take a **control** manifest after a plain restart, too. A start mints one
startup pairing link and rewrites `~/.claude.json`, so those differences are
noise, not upgrade effects. Publish comparisons, never raw manifests; those
stay out of the repo.
