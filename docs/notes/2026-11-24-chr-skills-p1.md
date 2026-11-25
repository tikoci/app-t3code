# `T3APP_SKILLS` in-container acceptance on a CHR — 2026-11-24

The last pending item on PR #67 (issue #46 P1): the image from the PR head,
installed fresh on a quickchr CHR with the image defaults, then checked from
RouterOS and in T3's web UI. Times below are UTC (2026-11-25).

Result: **pass** for checks 1–6 and the parts of check 7 that were run. The
offline check was a restart, not a new image (see 7b). No blocking defects.
Two nits and three observations are listed at the end. arm64 was not tested.

## Habitat

- Developer's Mac: Intel Core i9-9980HK, macOS, x86_64. HVF accelerates
  x86_64 guests here; an arm64 CHR would run under TCG. So the run is
  **x86_64 only**. The brief asked for arm64 on the belief that HVF covers
  it; on this Mac it doesn't.
- quickchr 0.5.5, centrs 0.1.9. CHR `skills-p1`: RouterOS **7.25.2**
  (x86_64), 2 vCPU, 2 GiB, p-unlimited, `container` package, device-mode
  `container=yes`, 8G boot disk, a 16G ext4 app disk (`pcie1`),
  `use-https=no`, user-mode network only, T3 forwarded to host port 9146
  (`--forward t3web::3773`).
- Image `ghcr.io/tikoci/app-t3code:sha-1b7c65d46f48ceefe3268e23b7a69c266fc0be6a`
  from dispatched run [45534869768](https://github.com/tikoci/app-t3code/actions/runs/45534869768)
  (`lint-test`, `build`, `arm64` green; `promote` skipped). Index digest
  `sha256:f9265a3a486caef30ac2428bda937bf747f0c691f618ba3bdc16d630afcf6610`,
  amd64 manifest `sha256:662160cb64a66ce12a410de23b06fb53bf03113c816f057543925aa1e6b31f21`.
  RouterOS `image-id` `1889adfa16fcdd074248f75aad6f5f8264745b8d4725580e3b38b45c488f1ec9`.
- In the container: T3 v0.1.11, Claude Code 2.1.332, codex-cli 0.172.0,
  OpenCode 1.19.6 (check 6), Bun 1.4.5.
- Install: the YAML in `app/t3code.tikapp.yaml` with only `image:` changed
  to the tag above, `centrs api … app -X PUT -f yaml=… -f use-https=no`,
  then `disabled=no`. Running at 02:58:22, about 2 minutes after enable.

## Checks

| # | Check | Result |
| --- | --- | --- |
| 1 | Fresh install, image defaults: `skills status`, `t3app status`, `skills.log` | pass |
| 2 | Layout: real folders owned by `node`, relative Claude links, library lock | pass |
| 3 | Claude and Codex logged in to the container's T3 | pass (Codex needed a workaround, observation C) |
| 4 | `$` discovery in T3's composer | pass for Codex; for Claude, see below |
| 5 | Harmless invocation per provider | pass |
| 6 | OpenCode lists each skill once | pass (CLI listing) |
| 7a | User edit shows `modified`; `update` leaves it alone | pass |
| 7b | Offline replacement: skills persist; status says failed and retries | pass, as an offline restart (same image) |
| — | arm64 CHR | not tested |

### 1. Fresh install with the image defaults

`/container/shell app-t3code cmd="t3app skills status"`:

```text
T3APP_SKILLS="tikoci/routeros-skills" -> tikoci/routeros-skills
tikoci/routeros-skills                   resolved  09eda23  22 skills
skills:
  routeros-app-yaml                installed 09eda23  tikoci/routeros-skills
  routeros-cmr                     installed 09eda23  tikoci/routeros-skills
  routeros-command-tree            installed 09eda23  tikoci/routeros-skills
  routeros-container               installed 09eda23  tikoci/routeros-skills
  routeros-firewall                installed 09eda23  tikoci/routeros-skills
  routeros-fundamentals            installed 09eda23  tikoci/routeros-skills
  routeros-hotspot                 installed 09eda23  tikoci/routeros-skills
  routeros-legacy-wireless         installed 09eda23  tikoci/routeros-skills
  routeros-mac-telnet              installed 09eda23  tikoci/routeros-skills
  routeros-mndp                    installed 09eda23  tikoci/routeros-skills
  routeros-netinstall              installed 09eda23  tikoci/routeros-skills
  routeros-proprietary-protocols   installed 09eda23  tikoci/routeros-skills
  routeros-qemu-chr                installed 09eda23  tikoci/routeros-skills
  routeros-scripting               installed 09eda23  tikoci/routeros-skills
  routeros-sniffer                 installed 09eda23  tikoci/routeros-skills
  routeros-syntax-inspection       installed 09eda23  tikoci/routeros-skills
  routeros-tikoci-centrs           installed 09eda23  tikoci/routeros-skills
  routeros-tikoci-house            installed 09eda23  tikoci/routeros-skills
  routeros-tikoci-quickchr         installed 09eda23  tikoci/routeros-skills
  routeros-tikoci-quickchr-cli     installed 09eda23  tikoci/routeros-skills
  routeros-webfig                  installed 09eda23  tikoci/routeros-skills
  routeros-zerotier                installed 09eda23  tikoci/routeros-skills
skills: /data/.agents/skills (Claude links: /data/.claude/skills); logs and state: /data/.local/state/t3code
```

`gh api repos/tikoci/routeros-skills/commits/HEAD -q .sha` at the time:
`09eda2318e5d73c654b38a8b70f3f73d639693c9`, so 22 at HEAD.

`t3app status`, skills section (Claude was still installing at that moment):

```text
== skills (t3app skills help; every skill: t3app skills status)
T3APP_SKILLS="tikoci/routeros-skills" -> tikoci/routeros-skills
tikoci/routeros-skills                   resolved  09eda23  22 skills
summary: tikoci/routeros-skills=resolved (22 installed)
skills: /data/.agents/skills (Claude links: /data/.claude/skills); logs and state: /data/.local/state/t3code

logs: /data/.local/state/t3code/tool-groups.log, /data/.local/state/t3code/providers.log, /data/.local/state/t3code/skills.log; payload installs: /data/.local/share/t3code-tools/install.log
```

`t3app status --json` has `skills` with `lastRun.mode` `update`,
`tokens[0].state` `resolved`, `commit` `09eda2318e5d…`, `skills: 22`,
`clashes: []`, `installer: null`.

The entrypoint's background run, `/data/.local/state/t3code/skills.log`
(the whole file at the end of the session; the later lines belong to
checks 6 and 7):

```text
2026-11-25T02:58:22.571Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T02:58:24.573Z t3app skills: tikoci/routeros-skills: installing routeros-legacy-wireless routeros-webfig routeros-tikoci-quickchr-cli routeros-firewall routeros-cmr routeros-fundamentals routeros-hotspot routeros-scripting routeros-zerotier routeros-app-yaml routeros-tikoci-centrs routeros-command-tree routeros-proprietary-protocols routeros-tikoci-quickchr routeros-container routeros-sniffer routeros-tikoci-house routeros-syntax-inspection routeros-netinstall routeros-mac-telnet routeros-qemu-chr routeros-mndp
2026-11-25T02:58:24.958Z t3app skills: done: 22 installed, 0 skipped, 0 modified, 0 failed
2026-11-25T03:28:00.511Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T03:28:01.944Z t3app skills: done: 21 installed, 0 skipped, 1 modified, 0 failed
2026-11-25T03:29:21.148Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T03:29:26.294Z t3app skills: tikoci/routeros-skills: failed: Failed to clone https://github.com/tikoci/routeros-skills.git: Cloning into '/tmp/skills-FLMPca'...
2026-11-25T03:29:26.294Z t3app skills: nothing installed or updated: tikoci/routeros-skills could not be fetched, and every source must resolve to decide which token wins each name
2026-11-25T03:29:41.299Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T03:29:46.373Z t3app skills: tikoci/routeros-skills: failed: Failed to clone https://github.com/tikoci/routeros-skills.git: Cloning into '/tmp/skills-s3lGit'...
2026-11-25T03:29:46.373Z t3app skills: nothing installed or updated: tikoci/routeros-skills could not be fetched, and every source must resolve to decide which token wins each name
2026-11-25T03:30:27.588Z t3app: skills install started in the background (pid 269)
2026-11-25T03:30:27.742Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T03:30:28.940Z t3app skills: done: 21 installed, 0 skipped, 1 modified, 0 failed
2026-11-25T03:30:46.392Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T03:30:47.543Z t3app skills: done: 21 installed, 0 skipped, 1 modified, 0 failed
```

The first pass took 2.4 s from resolve to done, anonymously (no GitHub token
in the container).

### 2. Layout inside the container

```text
$ stat -c %n:%U:%G:%a:%F /data/.agents/skills/routeros-fundamentals /data/.agents/skills/routeros-fundamentals/SKILL.md /data/.claude/skills/routeros-fundamentals
/data/.agents/skills/routeros-fundamentals:node:node:755:directory
/data/.agents/skills/routeros-fundamentals/SKILL.md:node:node:644:regular file
/data/.claude/skills/routeros-fundamentals:node:node:777:symbolic link
$ readlink /data/.claude/skills/routeros-fundamentals
../../.agents/skills/routeros-fundamentals
$ find /data/.agents/skills -mindepth 1 -maxdepth 1 -type d -user node | wc -l
22
$ find /data/.agents/skills /data/.claude/skills -not -user node
(no output)
$ find /data/.claude/skills -mindepth 1 -maxdepth 1 -type l -xtype d | wc -l
22
```

`ls -l /data/.claude/skills` showed 22 links of the form
`routeros-<name> -> ../../.agents/skills/routeros-<name>`, owned
`node:node`. `/data/.agents/.skill-lock.json` (`node`, 644):

```json
{
  "version": 3,
  "n": 22,
  "sample": {
    "source": "tikoci/routeros-skills",
    "sourceType": "github",
    "sourceUrl": "https://github.com/tikoci/routeros-skills.git",
    "commit": "09eda2318e5d73c654b38a8b70f3f73d639693c9",
    "skillPath": "routeros-fundamentals/SKILL.md",
    "skillFolderHash": "baef752fe18c1012086880b32c4a5e7efe37610b",
    "installedAt": "2026-11-25T02:58:24.945Z",
    "updatedAt": "2026-11-25T02:58:24.945Z"
  }
}
```

(`jq '{version, n: (.skills|length), sample: .skills["routeros-fundamentals"]}'`;
the 22 keys match the status list.) `/data/.local/state/t3code/skills.json`
is `node`, 644.

### 3. Providers logged in

`t3app providers status` before the logins: `codex ready
/data/.local/bin/codex`, `claude ready /data/.local/bin/claude`. Pairing
with `:put [/container/shell app-t3code cmd="t3app pairing" as-value]` and
`http://127.0.0.1:9146/` worked. The developer did both logins. No
credentials passed through this session.

- **Claude**: T3 opened a terminal running `claude`, which printed the
  OAuth URL; pasting the code back into the CLI worked.
- **Codex**: T3's built-in login does not complete in the container. The
  OAuth callback goes to an ephemeral `localhost` port in the browser's
  host, which doesn't reach the container. Workaround that worked: in a T3
  terminal run `codex`, pick option 2 (device code) instead of option 1
  (the same browser callback flow), finish in the browser, then use
  **Use CLI** in T3's provider settings. See observation C.

### 4. Discovery

- **Codex: pass.** The developer used `$routeros-tikoci-centrs` from the
  composer with Codex selected. Codex's rollout (`/data/.codex/sessions/2026/11/25/rollout-…01a210b3….jsonl`,
  thread "Register RouterOS Container Host in CDB") carries the injected
  skill block: `<skill> <name>routeros-tikoci-centrs</name>
  <path>/data/.agents/skills/routeros-tikoci-centrs/SKILL.md</path>`, and
  the agent then read `/data/.agents/skills/routeros-container/SKILL.md`
  and `/data/.agents/skills/routeros-fundamentals/SKILL.md`.
- **Claude: pass, from the session.** Claude's transcript has a
  `skill_listing` attachment listing the imported skills (`-
  routeros-app-yaml: RouterOS /app YAML format …` first), and the developer
  reports the skills load. No screenshot of T3's `$` menu with Claude
  selected was taken.

### 5. Harmless invocation

- **Claude: pass.** New thread after the logins, prompt "Use the
  `routeros-fundamentals` skill to answer: what does `/ip/address print`
  show?". The transcript has `tool_use Skill {"skill":"routeros-fundamentals"}`,
  then the injected `Base directory for this skill:
  /data/.claude/skills/routeros-fundamentals` (our symlink, not the
  account-synced copy, observation B), then a `Bash` grep in
  `/data/.claude/skills/routeros-fundamentals/references/routeros-networking-rest.md`.
  Its answer said that the skill's reference describes the fields and the
  REST response from the official docs, untested on a live router, and that
  the CLI column layout was from memory (developer's screenshot).
- **Codex: pass**, the `$routeros-tikoci-centrs` session above. It added
  the container's RouterOS host (172.18.0.1) to the centrs device list.
  The developer's note: the skills load, but without an environment note
  the agent needs extra prompting to work out it runs in a RouterOS
  container (that is #46 P1b). Also T3's secure-credential prompt refused
  quickchr's empty admin password (observation D).

### 6. OpenCode

Added `opencode` to `T3APP_PROVIDERS` with the README's keep-the-other-keys
script, run through `centrs execute`:

```routeros
:local app "t3code"; :local key "t3code:T3APP_PROVIDERS="; :local val "claude codex opencode"; :local keep ({}); :foreach e in=[/app/get $app environment] do={ :if ([:find $e $key] != 0) do={ :set keep ($keep, $e) } }; /app/set $app environment=($keep, ($key . $val))
```

Before: `t3code:HOME=/data;t3code:T3APP_PROVIDERS=claude codex;t3code:T3APP_SKILLS=tikoci/routeros-skills;t3code:T3APP_TOOL_GROUPS=capture labs vpn routing dev;t3code:T3CODE_HOME=/data/.t3;t3code:T3CODE_HOST=0.0.0.0;t3code:T3CODE_PORT=3773;t3code:T3CODE_TELEMETRY_ENABLED=false`.
After: the same keys, with `t3code:T3APP_PROVIDERS=claude codex opencode`
last. The container restarted (`exited with status 130`, start 03:27:59),
`opencode ready /data/.local/bin/opencode` about 30 s later, and the
start's skills pass logged `done: 21 installed, 0 skipped, 1 modified, 0 failed`.

`cd /data/.t3 && opencode debug skill` (OpenCode 1.19.6), reduced with
`jq -r '.[] | "\(.name)\t\(.location)"'`:

```text
total: 36  unique names: 36  routeros-* entries: 22
routeros-app-yaml	/data/.agents/skills/routeros-app-yaml/SKILL.md
routeros-cmr	/data/.agents/skills/routeros-cmr/SKILL.md
…
routeros-zerotier	/data/.agents/skills/routeros-zerotier/SKILL.md
```

Each of the 22 skills is listed **once**, from `/data/.agents/skills`; no
`/data/.claude/skills/routeros-*` entry appears. The other 14 entries are
the built-in `customize-opencode` and Claude account-synced skills found
inside `~/.claude/skills/.trash/…` and `~/.claude/skills/synced/…/.staging/…`
(observation B). This is the CLI's listing. OpenCode was not logged in and
not tried in T3's composer.

### 7a. User edit to one skill

```text
$ printf '\n<!-- local note: acceptance edit 2026-11-25 -->\n' >> /data/.agents/skills/routeros-mndp/SKILL.md
$ sha256sum /data/.agents/skills/routeros-mndp/SKILL.md
05f65b4884af5521af771b05178f685278af9259156cd3ac4b234f9065d2761b  /data/.agents/skills/routeros-mndp/SKILL.md
$ t3app skills status | grep mndp
  routeros-mndp                    modified  09eda23  tikoci/routeros-skills  (edited since it was installed; left alone)
$ t3app skills update --wait
2026-11-25T02:59:49.267Z t3app skills: resolving tikoci/routeros-skills
2026-11-25T02:59:51.439Z t3app skills: done: 21 installed, 0 skipped, 1 modified, 0 failed
$ t3app skills status | grep mndp
  routeros-mndp                    modified  09eda23  tikoci/routeros-skills  (edited since it was installed)
$ sha256sum /data/.agents/skills/routeros-mndp/SKILL.md
05f65b4884af5521af771b05178f685278af9259156cd3ac4b234f9065d2761b  /data/.agents/skills/routeros-mndp/SKILL.md
```

The edit also survived the check 6 restart, the offline run and the later
online passes (same hash at 03:31). (`/container/shell` joins the two
`--wait` lines into one; the line break above is restored. Inside the
container the output has normal newlines.)

### 7b. Offline replacement (as an offline restart)

The container was cut off from the internet while RouterOS could still
reach the registry:

```routeros
/ip/firewall/filter/add chain=forward src-address=172.18.0.0/24 out-interface=ether1 action=reject reject-with=icmp-network-unreachable comment=skills-p1-offline
```

`curl -sS -m 8 https://api.github.com/` in the container: `curl: (6)
Could not resolve host: api.github.com`. Then `/app/update [find where
name="t3code"]`. RouterOS log:

```text
03:29:18 app-t3code: *** stop
03:29:18 app-t3code: exited with status 130
03:29:19 app-t3code: *** repull
03:29:19 app-t3code: *** downloading and extracting remote image: registry=ghcr.io nspace=tikoci name=app-t3code tag=sha-1b7c65d46f48ceefe3268e23b7a69c266fc0be6a arch=amd64
03:29:20 app-t3code: *** skip importing same version
03:29:20 app-t3code: *** start
```

So the container restarted (PID 1 start ticks 230507 → 238554) but kept its
root (`/tmp` files survived): an offline **restart**, not a new image. A
real replacement needs a different image digest, which was not available
without a `yaml=` change. The offline replacement with a different
container stays covered by `test/container-replacement.test.ts` in CI.

During it, all 22 folders stayed (`ls /data/.agents/skills | wc -l` → 22)
and status reported the failure and the retry:

```text
T3APP_SKILLS="tikoci/routeros-skills" -> tikoci/routeros-skills
tikoci/routeros-skills                   failed    -
                                         SKILLS_GIT_CLONE_FAILED: Failed to clone https://github.com/tikoci/routeros-skills.git: Cloning into '/tmp/skills-s3lGit'...
skills:
  routeros-mndp                    modified  09eda23  tikoci/routeros-skills  (edited since it was installed; left alone)
run waiting; retrying at 2026-11-25T03:30:46.373Z (t3app skills install retries now)
```

`t3app status` showed the same, plus `summary: tikoci/routeros-skills=failed
(21 installed, 1 modified)` and `last run: nothing installed or updated:
tikoci/routeros-skills could not be fetched, and every source must resolve
to decide which token wins each name`. The other skills stay listed as
`installed` in `skills status`.

Back online (rule removed), `t3app skills install` answered `started in the
background (pid 269)`, and the log shows `done: 21 installed, 0 skipped, 1
modified, 0 failed` a second later. The entrypoint's waiting
`--keep-trying` run then ran its scheduled retry at 03:30:46 (same result)
and exited; `installer` is `null` afterwards. That matches the code: only a
pass with another selection stops a waiting retry.

## Nits (suggested fixes, for the PR's author)

1. **The clone error loses its cause.** `message()` in `lib/skills.ts`
   keeps the first line of the error, and for `SKILLS_GIT_CLONE_FAILED` the
   library's detail is git's stderr, whose first line is `Cloning into
   '/tmp/skills-…'...`. The cause is on the next line; in the container
   `git clone --depth 1 https://github.com/tikoci/routeros-skills.git`
   prints `fatal: unable to access
   'https://github.com/tikoci/routeros-skills.git/': Could not resolve
   host: github.com`. Suggested fix: keep the last non-empty line (or a
   `fatal:` line when there is one) instead of `[0]`, with a test on a
   multi-line clone error.
2. **A redundant retry after "retry now".** When `t3app skills install`
   succeeds while the entrypoint's run waits with the same selection, the
   waiting run still resolves once more at its scheduled time (03:30:46
   above). Harmless, one more anonymous GitHub request. Optional: let a
   newer successful pass with the same selection also end the wait.

## Observations (not this PR)

- **A. Environment context.** The developer's view: the skills load, but
  the agent doesn't know it is inside a RouterOS container and needs
  prompting to find the host and its credentials. That is #46 P1b (the
  user-level environment note).
- **B. Claude Code's account-synced skills share `~/.claude/skills`.**
  After the Claude login, Claude Code wrote `~/.claude/skills/synced/<bucket>/`
  (the account's skills, including its own `routeros-fundamentals`,
  `routeros-scripting` and `routeros-command-tree`) and a `.trash/` with 40
  rotated copies. `t3app skills` ignored both (status unchanged, no
  `skipped (not ours)`), and Claude loaded our `routeros-fundamentals`.
  OpenCode, which scans `~/.claude/skills`, lists the stale `.trash` and
  `.staging` copies as skills. That's Claude Code × OpenCode, worth a line
  in #29 or the OpenCode support decision, not a change here.
- **C. Codex login in the container.** T3's browser login for Codex can't
  complete (the OAuth callback is a `localhost` port on the browser's
  machine). The device-code path in a T3 terminal plus **Use CLI** works.
  Belongs to login UX (#15), and worth a line in the README.
- **D. T3's secure prompt and an empty password.** With quickchr's blank
  `admin` password, T3's secret prompt (used by the centrs skill) doesn't
  accept an empty value. The developer told the agent in chat instead. A
  T3 UI limit; a lab with a set password avoids it.

## Not tested

- arm64 CHR (TCG on this Mac); the CI `arm64` job covers the image's
  container-replacement test natively.
- A real offline replacement with a different image digest (7b above).
- OpenCode in T3's composer, and an OpenCode invocation (not logged in).
- Clash, deselect/re-enable and `CLAUDE_CONFIG_DIR` on the CHR (covered by
  `test/skills.test.ts` and the orca run in the PR body).

The CHR `skills-p1` is still running, for the developer to poke at.
