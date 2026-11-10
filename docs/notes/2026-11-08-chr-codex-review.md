# app-t3code #5 CHR review — 2026-11-08

Recommendation: five-group tooling baseline looks good on this installation; full acceptance is PARTIAL. Codex through T3 works (this run). Claude is missing. GitHub API reports #5 already closed, updated 2026-11-07T17:53:18Z. Add explicit closeout evidence/linked transfers or reopen until required gates are met; no issue mutation performed.

Sources read via unauthenticated public HTTPS (no checkout created):

- <https://github.com/tikoci/app-t3code/issues/5>
- <https://github.com/tikoci/app-t3code/blob/main/README.md>
- <https://github.com/tikoci/app-t3code/blob/main/AGENTS.md>
- <https://github.com/tikoci/app-t3code/blob/main/docs/notes/2026-11-07-final-tooling-slice.md>
- Public test/tool-payloads.test.ts, test/deb-payloads.test.ts, test/container-replacement.test.ts inspected as text only.

No subagents, installs, repo modifications, service restart, auth/settings/network/capability changes, or source suite/build execution. Temporary fixtures only under /tmp/app5-review, cleaned after report. No auth contents or environment secrets read/printed. Generated ephemeral keys were withheld. A first report-write attempt was rejected by command policy for rm -rf cleanup before execution; corrected to scoped Python cleanup.

## Findings

- PASS core and all five selected groups in ordinary and login shells. Login PATH preserves user bins first and /usr/local/sbin:/usr/sbin:/sbin; ethtool resolves /usr/sbin/ethtool. `t3code-tools status` core ready, capture/labs/vpn/routing/dev ready. No browser/provider groups.
- PASS uv/uvx 0.13.7, sqlite3 3.46.1; uv offline venv with system Python 3.13.5; sqlite CLI and Python sqlite query return 42. uvx package execution not tested.
- PASS capture: synthetic TZSP/DNS fixture from image group smoke spec decodes 1/routeros.example with tshark. Offline ARP decoding resolves Routerboard.com.
- PASS labs baseline: both QEMU emulators 10.0.13, firmware search paths resolve payload, quickchr 0.5.6 doctor discovers AAVMF_CODE.fd; TCG only. 16M qcow2 create/check works. No guest boot or nested RouterOS run.
- PASS VPN key baseline: WireGuard derivation, strongSwan ed25519 key generation, OpenVPN static-key generation succeed. strongSwan emits missing-plugin warnings (captured below); successful operation does not establish all algorithms/certificates/charon. No tunnels tested.
- PASS routing: BIRD parse exits 0, NSE data available, localhost-only ephemeral port TCP connect scan finds open listener. No live peering, raw scans or kernel route changes.
- PASS dev: TypeScript compile, markdownlint, CSpell and Biome operate on fixtures. CSpell initially found no files from scratch cwd; retry `cd /tmp/app5-review; cspell --no-progress --no-must-find-files test.md` exits 0, Files checked: 1, Issues: 0. This is cwd/config selection, not a demonstrated payload defect. Biome correctly reports unused fixture variable warning, exit 0.
- PASS Codex T3 invocation/auth by this model/tool run; codex-cli 0.167.0. opencode executable 1.19.5; its model execution untested. Muse absent in ordinary/login PATH, consistent with removal; user Muse preservation untested.
- FAIL/unmet provider gate: `command -v claude` missing in both shells, consistent with parent capabilities. No Claude model request possible as installed; background installer cause not investigated. Diagnose provisioning under #13 and explicitly disposition #5's both-provider gate.

## Storage, privileges and persistence

Observed id uid/gid 1000(node), node group only; Linux CHR 5.6.3-64 x86_64. `/proc/self/status`: CapInh/CapPrm/CapEff/CapAmb all zero, CapBnd=0000003fffffffff, NoNewPrivs=0, Seccomp=2. Bounding set grants nothing itself. /dev/kvm absent; /dev/net/tun exists char 10:200 root:root 666. Device presence does not establish usability. ip_unprivileged_port_start=1024. Reserve live protocol/capability checks for #7.

`df -h / /data`: 24G total, 4.2G used, 19G available, 19%. `findmnt -T /data`: /dev/vdb[/apps/t3code/t3code-data], ext4 rw,nosuid,nodev. `stat -c '%n %u:%g %a %F' /data /data/.t3 /data/.local /data/.local/share/t3code-tools`: all 1000:1000, /data 755, others 777. Projects and provider directories inspected by metadata only: 1000:1000 mode 777. This is path/ownership evidence, not full preservation proof. Inventory: amd64, t3 v0.1.6, generated 2026-11-07T17:55:03.256Z.

Parent-reported (not independently queried from RouterOS): 1 CPU/1024MiB, RouterOS 7.25 x86 CHR; app disk expanded 4G to 24G; offline backup on Morpheus; /app/update changed ccdbfdd929e62ff5a21afeb5211313541fce5a1082a2322b295f97900912e4a8 to 9498bff52b556e5fb73e4fbcdd78b7b06e0e8854465fc6bfe73bc4b54fd20db3; retained environment b23b5799-783c-46f6-bc8b-afd00c6993b9 and /data. This supplies reported digest-changing CHR upgrade evidence. No before/after content manifest, payload ids, auth/project/thread/settings comparison or offline condition available to this reviewer. Existing timestamps below alone cannot prove reuse or preservation.

## Remaining acceptance coverage

PARTIAL persistence and CHR replacement as above. UNTESTED locally: blocked-network/non-blocking startup while groups pending, compatible offline replacement, deselection/reselection/prune, changed payload/ABI, interrupted install/retry, low disk, user Muse preservation, reboot persistence. No active-home init/install/prune invoked.

SOURCE COVERAGE ONLY: public npm tests cover lockfile/ABI refresh; deb tests cover new lock/CPU mismatch/stale payload load rejection, interrupted verified download reuse/orphan helper cleanup and low-disk budgeting; retries and offline replacement appear in test sources. Research notes report Docker replacement 1 pass/151 expectations and 88 offline tests, not new results here. No source suite rerun or full image rebuild in this constrained installation.

UNTESTED here: native ARM64 host and actual native ARM64 CI outcome; docs describe CI gating, not independently verified in this run. Nested x86/ARM64 RouterOS guest, quickchr transfer/snapshot/cleanup on CHR, and native ARM64 RouterOS hardware remain matrix evidence gaps requiring completion or explicit linked transfer. No KVM acceleration expected here. Live protocol/device/capability validation belongs to #7.

No functional tooling defects found in tested operations. Concrete installation shortfall is absent Claude; strongSwan warnings limit confidence beyond tested generation. Issue body's statement that unset means core-only is stale relative to current docs/runtime default. Current issue closed state should have explicit acceptance dispositions. Closure is not supported unconditionally by this smoke run alone.

## Commands/results

Initial: `id; uname -a; t3code-tools help; t3code-tools status; df -h / /data; findmnt -T /data; command -v codex claude opencode muse; codex --version; opencode --version`.
Login: `bash -lc 'printf "PATH=%s\n" "$PATH"; command -v ethtool codex opencode claude muse; t3code-tools status'`.

Each subprocess below bounded to 20 seconds. Fixture bytes decoded from inputBase64 in `t3code-tools groups` smoke specs. Local listener was a Python socket bound to 127.0.0.1 port 0, closed after scan. Key output redirected to temporary mode-600 files.

Payload snapshot:

```text
capture ready amd64-trixie-8835b1586201c453 last={'state': 'ready', 'payloadId': 'amd64-trixie-8835b1586201c453', 'attempt': 1, 'updatedAt': '2026-11-07T23:58:58.315Z'}
labs ready amd64-trixie-498eb8218e64b9d2 last={'state': 'ready', 'payloadId': 'amd64-trixie-498eb8218e64b9d2', 'attempt': 1, 'updatedAt': '2026-11-07T23:59:11.396Z'}
vpn ready amd64-trixie-f197c5f52e2d7e3a last={'state': 'ready', 'payloadId': 'amd64-trixie-f197c5f52e2d7e3a', 'attempt': 1, 'updatedAt': '2026-11-07T23:59:18.577Z'}
routing ready amd64-trixie-7d4831ecb9d171fa last={'state': 'ready', 'payloadId': 'amd64-trixie-7d4831ecb9d171fa', 'attempt': 1, 'updatedAt': '2026-11-07T23:59:23.784Z'}
dev ready x64-abi137-39009bbc8749a88d last={'state': 'ready', 'payloadId': 'x64-abi137-39009bbc8749a88d', 'attempt': 1, 'updatedAt': '2026-11-07T23:59:34.862Z'}
```

```text
$ ['bash', '-c', 'printf "PATH=%s\\n" "$PATH"; uv --version; uvx --version; sqlite3 --version; node --version; bun --version; t3 --version; quickchr --version; centrs --version']
exit=0
PATH=/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path:/data/.local/bin:/data/.bun/bin:/data/.local/share/t3code-tools/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:/usr/local/sbin:/usr/sbin:/sbin
uv 0.13.7 (x86_64-unknown-linux-musl)
uvx 0.13.7 (x86_64-unknown-linux-musl)
3.46.1 2024-08-13 09:16:08 c9c2ab54ba1f5f46360f1b4f35d849cd3f080e6fc2b6c60e91b16c63f69aalt1 (64-bit)
v24.22.2
1.4.4
t3 v0.1.6
quickchr 0.5.6

Latest RouterOS versions:
  stable       7.25.1
  long-term    7.24.6
  testing      7.25.1
  development  7.26beta5
0.1.10

$ ['uv', 'venv', '--offline', '--no-managed-python', '/tmp/app5-review/venv']
exit=0
Using CPython 3.13.5 interpreter at: /usr/bin/python3
Creating virtual environment at: /tmp/app5-review/venv
Activate with: source /tmp/app5-review/venv/bin/activate

$ ['/tmp/app5-review/venv/bin/python', '-c', 'import sqlite3; print(sqlite3.connect(":memory:").execute("select 6*7").fetchone())']
exit=0
(42,)

$ ['sqlite3', ':memory:', 'create table t(n); insert into t values(42); select * from t;']
exit=0
42

$ ['tshark', '-r', '/tmp/app5-review/capture-0', '-T', 'fields', '-e', 'tzsp.encap', '-e', 'dns.qry.name']
exit=0
1	routeros.example

$ ['nmap', '--script-help', 'banner']
exit=0
Starting Nmap 7.95 ( https://nmap.org ) at 2026-11-08 00:28 manual

banner
Categories: discovery safe
https://nmap.org/nsedoc/scripts/banner.html
  A simple banner grabber which connects to an open TCP port and prints out anything sent by the listening service within five seconds.

  The banner will be truncated to fit into a single line, but an extra line may be printed for every
  increase in the level of verbosity requested on the command line.

$ ['bird', '-p', '-c', '/tmp/app5-review/routing-1']
exit=0

$ ['arp-scan', '--readpktfromfile=/tmp/app5-review/routing-2', '192.0.2.1']
exit=0
Interface: pcap file
Starting arp-scan 1.10.0 with 1 hosts (https://github.com/royhills/arp-scan)
192.0.2.1	4c:5e:0c:11:22:33	Routerboard.com

Ending arp-scan 1.10.0: 1 hosts scanned in 0.167 seconds (5.99 hosts/sec). 1 responded

$ ['qemu-system-x86_64', '--version']
exit=0
QEMU emulator version 10.0.13 (Debian 1:10.0.13+ds-0+deb13u1)
Copyright (c) 2003-2025 Fabrice Bellard and the QEMU Project developers

$ ['qemu-system-aarch64', '--version']
exit=0
QEMU emulator version 10.0.13 (Debian 1:10.0.13+ds-0+deb13u1)
Copyright (c) 2003-2025 Fabrice Bellard and the QEMU Project developers

$ ['qemu-system-aarch64', '-L', 'help']
exit=0
/data/.local/share/t3code-tools/groups/labs/amd64-trixie-498eb8218e64b9d2/root/usr/share/qemu
/data/.local/share/t3code-tools/groups/labs/amd64-trixie-498eb8218e64b9d2/root/usr/share/seabios
/data/.local/share/t3code-tools/groups/labs/amd64-trixie-498eb8218e64b9d2/root/usr/lib/ipxe/qemu
/usr/share/qemu
/usr/share/seabios
/usr/lib/ipxe/qemu

$ ['quickchr', 'doctor']
exit=0
quickchr doctor

✓ Bun runtime: bun 1.4.4; tested with Bun 1.4.4
✓ qemu-system-aarch64: 10.0.13
✓ qemu-system-x86_64: 10.0.13
✓ UEFI firmware: /data/.local/share/t3code-tools/groups/labs/amd64-trixie-498eb8218e64b9d2/root/usr/share/AAVMF/AAVMF_CODE.fd
⚠ Acceleration: tcg (host: x64) — TCG software emulation only (no KVM/HVF); expect slow boots
✓ HTTPS proxy: not set (direct egress)
✓ Data directory: /data/.local/share/quickchr
✓ Cache: empty (0 B)
✓ Machines: 0 instances (0 running, 0 B on disk)
✓ Storage: /data/.local/share: 18.2 GiB free; quickchr uses 0 B (cache 0 B, machines 0 B)
✓ socat: /usr/bin/socat
✓ qemu-img: /data/.local/share/t3code-tools/bin/qemu-img
✓ Shell: bash 5.2.37 (/bin/bash)
⚠ Shell completions: bash: not installed — run 'quickchr completions --install'

All checks passed.

$ ['qemu-img', 'create', '-f', 'qcow2', '/tmp/app5-review/test.qcow2', '16M']
exit=0
Formatting '/tmp/app5-review/test.qcow2', fmt=qcow2 cluster_size=65536 extended_l2=off compression_type=zlib size=16777216 lazy_refcounts=off refcount_bits=16

$ ['qemu-img', 'check', '/tmp/app5-review/test.qcow2']
exit=0
No errors were found on the image.
Image end offset: 262144

$ ['bash', '-c', 'umask 077; wg genkey > /tmp/app5-review/wg.key; wg pubkey < /tmp/app5-review/wg.key > /tmp/app5-review/wg.pub; test $(wc -c < /tmp/app5-review/wg.pub) -eq 45 && echo "wg key derivation PASS (key withheld)"; pki --gen --type ed25519 --outform pem > /tmp/app5-review/pki.key; test -s /tmp/app5-review/pki.key && echo "pki generation PASS (key withheld)"; openvpn --genkey secret /tmp/app5-review/ovpn.key; test -s /tmp/app5-review/ovpn.key && echo "OpenVPN key generation PASS (key withheld)"']
exit=0
wg key derivation PASS (key withheld)
pki generation PASS (key withheld)
OpenVPN key generation PASS (key withheld)
plugin 'test-vectors': failed to load - test_vectors_plugin_create not found and no plugin file available
plugin 'pkcs11': failed to load - pkcs11_plugin_create not found and no plugin file available
plugin 'tpm': failed to load - tpm_plugin_create not found and no plugin file available
plugin 'aesni': failed to load - aesni_plugin_create not found and no plugin file available
plugin 'aes': failed to load - aes_plugin_create not found and no plugin file available
plugin 'rc2': failed to load - rc2_plugin_create not found and no plugin file available
plugin 'sha2': failed to load - sha2_plugin_create not found and no plugin file available
plugin 'sha1': failed to load - sha1_plugin_create not found and no plugin file available
plugin 'md5': failed to load - md5_plugin_create not found and no plugin file available
plugin 'mgf1': failed to load - mgf1_plugin_create not found and no plugin file available
plugin 'rdrand': failed to load - rdrand_plugin_create not found and no plugin file available
plugin 'pkcs12': failed to load - pkcs12_plugin_create not found and no plugin file available
plugin 'sshkey': failed to load - sshkey_plugin_create not found and no plugin file available
plugin 'gcrypt': failed to load - gcrypt_plugin_create not found and no plugin file available
plugin 'af-alg': failed to load - af_alg_plugin_create not found and no plugin file available
plugin 'gmp': failed to load - gmp_plugin_create not found and no plugin file available
plugin 'curve25519': failed to load - curve25519_plugin_create not found and no plugin file available
plugin 'hmac': failed to load - hmac_plugin_create not found and no plugin file available
plugin 'kdf': failed to load - kdf_plugin_create not found and no plugin file available
plugin 'curl': failed to load - curl_plugin_create not found and no plugin file available

$ ['tsc', '--version']
exit=0
Version 7.0.2

$ ['cspell', '--version']
exit=0
10.4.0

$ ['markdownlint-cli2', '--version']
exit=0
markdownlint-cli2 v0.24.0 (markdownlint v0.42.0)
Finding: --version
Linting: 0 files
Summary: 0 issues in 0 files

$ ['biome', '--version']
exit=0
Version: 2.6.5


$ ['tsc', '--noEmit', '--strict', '/tmp/app5-review/test.ts']
exit=0

$ ['cspell', '--no-progress', '/tmp/app5-review/test.md']
exit=1
CSpell: Files checked: 0, Issues found: 0 in 0 files.
No files found to check.

$ ['markdownlint-cli2', '/tmp/app5-review/test.md']
exit=0
markdownlint-cli2 v0.24.0 (markdownlint v0.42.0)
Finding: /tmp/app5-review/test.md
Linting: 1 file
Summary: 0 issues in 0 files

$ ['biome', 'check', '/tmp/app5-review/test.ts']
exit=0
/tmp/app5-review/test.ts:1:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━

  ! This variable answer is unused.
  
  > 1 │ const answer: number = 42;
      │       ^^^^^^
    2 │ 
  
  i Unused variables are often the result of typos, incomplete refactors, or other sources of bugs.
  
  i Unsafe fix: If this is intentional, prepend answer with an underscore.
  
    1   │ - const·answer:·number·=·42;
      1 │ + const·_answer:·number·=·42;
    2 2 │   
  

Checked 1 file in 16ms. No fixes applied.
Found 1 warning.

$ ['nmap', '--unprivileged', '-sT', '-Pn', '-n', '--max-retries', '0', '--host-timeout', '5s', '-p', '60297', '127.0.0.1']
exit=0
Starting Nmap 7.95 ( https://nmap.org ) at 2026-11-08 00:28 manual
Nmap scan report for 127.0.0.1
Host is up (0.000045s latency).

PORT      STATE SERVICE
60297/tcp open  unknown

Nmap done: 1 IP address (1 host up) scanned in 0.02 seconds

$ ['bash', '-c', 'sed -n \'/^Cap/p; /^NoNewPrivs/p; /^Seccomp/p\' /proc/self/status; for d in /dev/kvm /dev/net/tun; do if test -e "$d"; then ls -l "$d"; else echo "$d absent"; fi; done; cat /proc/sys/net/ipv4/ip_unprivileged_port_start; stat -c \'%n %u:%g %a\' /data/projects /data/.codex /data/.claude 2>/dev/null']
exit=0
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	0000003fffffffff
CapAmb:	0000000000000000
NoNewPrivs:	0
Seccomp:	2
/dev/kvm absent
crw-rw-rw- 1 root root 10, 200 Nov  8 00:07 /dev/net/tun
1024
/data/projects 1000:1000 777
/data/.codex 1000:1000 777
/data/.claude 1000:1000 777

```
