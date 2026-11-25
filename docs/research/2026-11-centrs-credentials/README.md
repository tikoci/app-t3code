# centrs inside the container: settings and credentials

**Started 2026-11-25, habitat C (orca).** The research behind #47 (centrs
inside T3) and the host facts in #71 (agent context). The question is how
an agent in the container gets the router it runs on, and other routers,
into centrs: which address, which account, and through which of several
paths. This topic records what each path does before any recipe is chosen.

Grounding for this first pass:

- **RouterOS:** a disposable quickchr CHR, 7.25.2 x86 (KVM), `container`
  package, device-mode `container=yes`, 2 GiB ext4 app disk, quickchr
  0.5.2. The app is the Alpine probe in [`probe/`](probe/), not the
  app-t3code image, so each step takes seconds.
- **T3 Code:** source at tag `v0.1.12` (the image ships 0.1.11; #68 tracks
  the bump), so the T3 side isn't dated again by that bump.
  Earlier T3 research here is older: `2026-11-t3code-integration` is
  v0.1.6, `2026-11-t3code-presentation` (including `secrets.md`) v0.1.7.
- **centrs:** `0.2.0-next` (the image floats on `@next`), source at
  `3cf57ae`.

## The paths

Seven ways a setting or credential can reach centrs in the container. The
owner listed them on #47; rows 2, 3 and 7 were measured, 4 and 5 read from
source.

| # | Path | Who can read the value | Survives | Status |
| --- | --- | --- | --- | --- |
| 1 | Literal `CENTRS_*` in the app env (`/app/set environment=`) | Every process in the container; RouterOS users who can read `/container` or `/app`; `/export` | restart, `/app/update`, reboot (earlier lab) | known; not useful for passwords |
| 2 | `/app` secret via `[secret:name]` in an env value | As 1: the expanded value is in `/container` `env`, even for a group without `sensitive`, and in a plain `/export` | restart, `secrets=` change, env change, `/app/update`, reboot | **measured** |
| 3 | `/app` secret as a file (`/run/secrets/<name>`) | Every process in the container (mode 0444, root); RouterOS users who can read `/file` (`pcie1/apps/<app>/secret-<name>`), even without `sensitive` | as 2 | **measured** |
| 4 | T3 provider environment variable (value or `op://` reference) | Every process the agent starts; T3's secret store in `/data` (mode 0600, same uid as the agent) | T3 settings in `/data` | source (v0.1.12); runtime pending |
| 5 | T3 secret request card, delivered to a file | The agent's own commands | about 24 h (TTL); across a T3 restart: pending | source (v0.1.12); runtime pending |
| 6 | Project `.env` | Any `centrs` run in that directory (Bun auto-load, [centrs#666](https://github.com/tikoci/centrs/issues/666)) | the project | known bug; not a design path |
| 7 | User-level CDB in `/data` (default `/data/.config/tikoci/winbox.cdb`), encrypted, key from `/run/secrets` | Whoever has both the file and the key: the agent (same uid), a RouterOS user who can read `/file` and the app volume | `/data` (the key: as 3) | **measured** in the image |

Rows 3 and 7 together are the one combination that keeps a plain password
off the `/data` volume using today's centrs. See "Inside the image" and
"Direction".

Off RouterOS (#72), rows 1–3 change: Docker and Podman have their own
secrets (`/run/secrets` from a file or swarm), and there is no host router
at the gateway. Not measured yet.

## RouterOS lab results (7.25.2 x86)

The probe app declares an app-level secret, puts it in an env value
(`P_SECRET_ENV: "[secret:routeros_pw]"`) and lists it under the service
(`secrets: [routeros_pw]`). It also puts each address placeholder in the env
and, at every start, appends one record to its volume: the `P_*` values
(secret as length and hash only), `/run/secrets`, `id`, addresses, routes,
and a TCP and REST check against the gateway and the placeholder addresses
([`probe/boot.sh`](probe/boot.sh)). Six starts on one volume, read back with
`/file/get`.

### Address placeholders: the host router without configuration

| Placeholder | Value in the container |
| --- | --- |
| `[networkRouterIP]` | `172.18.0.1`, the container's default gateway |
| `[routerIP]` | `10.0.2.15` (no `router-ip` set, so the assumed address on ether1) |
| `[accessIP]` | `10.0.2.15` |
| `[containerIP]` | `172.18.0.2` |
| `[containerInterface]` | `veth-app-credpr` (truncated to 15 characters) |

`/app print` lists them as `variables-to-use-in-environment`. Placeholders
expand in an operator's `/app/set environment=` value as well as in the
YAML: `probe:P_EXTRA_GW=[networkRouterIP]` arrived as `172.18.0.1`, and
`[secret:routeros_pw]` as the secret's value.

From the container, the router answered on the gateway and on `[routerIP]`:
TCP 22, 80, 8728 and 8729 open, 443 closed (no certificate), and REST as
`admin` with an empty password returned `{"name":"CHR"}`. On a default
quickchr CHR, `CENTRS_HOST=[networkRouterIP]` with `admin` and no password
would therefore reach the host with no setup. A real router has a password,
and its `/ip/service` `address=` lists and firewall may not allow the app
network, which defaults to 172.18.0.0/24 here.

### `/app` secrets

- **RouterOS generates a value** (32 characters) when the app is installed.
  It appears in the container both as the env value and as
  `/run/secrets/routeros_pw` (mode 0444, owned by root, so the image's
  `node` user can read it too). On the router it is a 32-byte file,
  `pcie1/apps/credprobe/secret-routeros_pw`, mounted into the container.
- **An operator can set it:** `/app/set <app> secrets="routeros_pw:<value>"`
  restarts the container, and the new value arrives in both places. The
  volume is kept (unlike `yaml=`).
- **It is stable** across a disable/enable, an `environment=` change,
  `/app/update` and a reboot. In all six starts the hash changed only when the
  operator set a new value.
- **Visibility.** `/app`'s `secrets` field follows the `sensitive` policy
  (the owner's pointer): a group without `sensitive` sees it
  empty, and `/export` shows it only with `show-sensitive`. The built-in
  `read`, `write` and `full` groups all have `sensitive`. But the value
  escapes that policy in two places:
  - the derived `/container` entry's `env` and `env-current` carry the
    **expanded** value, readable over REST by a `read,api,rest-api,!sensitive`
    user, and printed by a plain `/export` (no `show-sensitive`);
  - the backing file's `contents` are readable through `/file` (REST
    `/rest/file?name=…` and `:put [/file/get …]`) by that same user.

  So on 7.25.2, an `/app` secret hides the value from someone without `sensitive` only
  in `/app` itself. The `/container` copy looks like a RouterOS bug (it's a
  secret, and the field it's copied from is sensitive); report it to
  MikroTik and note it in the routeros-skills app-yaml skill via #29. Not yet
  re-checked on 7.26 betas.
- `/container/shell` needs more than `read`: the `!sensitive` read user got
  `not enough permissions (9)`.

**What it is good for:** a password RouterOS makes up, that the container
and a router-side script can both read, without anyone typing it. For
example, after install (tested in "Inside the image"):
`/user/add name=t3code group=<group> password=[/file/get pcie1/apps/t3code/secret-routeros_pw contents]`.
What it is not: a value hidden from other router users. Anyone with `read`
and API or web access can read it.

## T3 Code side (source, v0.1.12)

- **Secret store:** `<T3 state>/secrets`, mode 0700, one file per secret, mode
  0600, plain text (`apps/server/src/auth/ServerSecretStore.ts`,
  `config.ts` `secretsDir`). In this image that's under `/data/.t3`, owned by
  `node`, the same uid the agent runs as, so it protects against other users,
  not against the agent. It can't simply be moved off `/data`: the directory
  is `$T3CODE_HOME/userdata/secrets` with no separate setting, and it holds
  T3's own keys too (`server-signing-key` for paired sessions,
  `mcp-oauth-signing-key`, `guest-share-signing-key`, the `cloud-relay-*`
  credentials). On non-persistent storage every restart and `/app/update`
  would unpair every device. Moving only the user's credentials elsewhere
  would need T3 itself to support it (an at-rest key, or a pluggable secret
  provider).
- **Provider environment variables** (Settings → Providers, per provider
  instance) take a plain value, a value marked sensitive (kept in the secret
  store) or a secret-provider reference (`op://vault/item/field` with
  1Password). T3 merges them over its own environment for the provider
  process and the terminals: `mergeProviderInstanceEnvironment`, whose
  comment reads "Commands the agent runs inherit this env"
  (`packages/provider-core/src/server/instanceEnvironment.ts`; used by
  `CodexDriver.ts` and `terminal/Manager.ts`). So `CENTRS_PASSWORD` set there
  should reach `centrs` run by that provider's agent. Pending: a runtime check
  for Claude and Codex (Codex's own `shell_environment_policy` may filter names).
- **Secret providers:** 1Password only (`BUILT_IN_SECRET_PROVIDER_DRIVER_LIST`),
  through `op`, signed in on the server's machine (service account or
  Connect for a headless server). New since the v0.1.7 research. `op` isn't
  in the image. The driver runs exactly `op read --account=<a> --no-newline
  <ref>` and `op inject --account=<a> -i <template>`
  (`packages/secret-provider-onepassword/src/server/driver.ts`). So an `op`
  on PATH that resolves `op://…` from something we control (the CDB, or
  `/run/secrets`) is technically possible: T3 would read references
  without storing values. Against it: it poses as 1Password's CLI, T3's UI
  says 1Password, and any change to the driver's calls breaks it. A note,
  not a recommendation; a real pluggable provider is T3's call.
- **Secret request cards** (`SecretRequests.ts`): the value never enters the
  conversation; a `file` request moves it to an owner-only file for the
  agent's own shell, valid about 24 h (`SECRET_REF_TTL_MS`). This is the
  "temporary secret delivery" recipe of #47. The 2026-11-24 CHR run found the
  card refuses an empty value (#29), which matters for `admin` with no password.

## centrs side (0.2.0-next)

- `CENTRS_HOST`, `CENTRS_PORT`, `CENTRS_USERNAME`, `CENTRS_PASSWORD`,
  `CENTRS_VIA` and `CENTRS_INSECURE` are read from the env. Precedence:
  `centrs.env` → CDB comment-kv → `CENTRS_*` env → flag, and `meta.settings`
  in every envelope says which source won.
- The CDB defaults to `~/.config/tikoci/winbox.cdb` (WinBox's format,
  optionally encrypted) and has a reserved `__default__` record: fallback
  credentials for any target whose own record leaves them unset.
- The CDB password comes only from `--cdb-password` or `CENTRS_CDB_PASSWORD`,
  deliberately never from `centrs.env` or a file (`src/settings.ts`,
  `src/devices.ts`).
- Side note for #29: `centrs execute ':put [/console/inspect request=child …]'`
  was refused as write-shaped without `--yes`.

## Inside the image (`0.1.11-app.221`, same CHR family)

A second CHR, `credfull` (7.25.2 x86, free license, 8 GiB boot, 10 GiB app
disk), runs the real image from a lab copy of the YAML
([`probe/t3code-lab.tikapp.yaml`](probe/t3code-lab.tikapp.yaml)). The copy
declares one app secret, passed **as a file only** (no `[secret:…]` in the
env), and `LAB_ROUTER: "[networkRouterIP]"`, with core tools and Codex
only. Commands ran as `node` through `/container/shell`
([`probe/in-container.sh`](probe/in-container.sh),
[`probe/host-account.sh`](probe/host-account.sh)).

| Step | Result |
| --- | --- |
| `/run/secrets/routeros_pw` | present, mode 0444, readable by `node`; no env variable carries it |
| `CENTRS_HOST=$LAB_ROUTER centrs retrieve /system/identity` | `input/invalid-command`: the env doesn't stand in for the `<target>` (the `--host` flag does) |
| `centrs retrieve $LAB_ROUTER …` with no credentials | `transport/auth-failed` (401): centrs has no built-in `admin`/empty fallback, it sends none |
| same with `CENTRS_USERNAME=admin CENTRS_PASSWORD=` | works; sources `env` |
| `CENTRS_CDB_PASSWORD=$(cat /run/secrets/…) centrs devices init --encrypt` | creates `/data/.config/tikoci/winbox.cdb`, mode 0600 |
| `devices add __default__ --user admin --password ''`, `devices add 172.18.0.1 --group host` | both accepted (empty password allowed) |
| `centrs retrieve 172.18.0.1 /system/identity` with the key | works; host, user and password all from `cdb` |
| same without the key, and `devices list` | `cdb/password-required`, fail closed |
| the CDB file | 202 bytes, no plaintext `admin` |

**A router-made account, no password typed anywhere.** On the router, as
admin:

```routeros
/user/group/add name=t3-agent policy=read,api,rest-api,!sensitive,!write,!policy,!ftp,!ssh,!winbox,!web,!telnet,!local,!reboot,!password,!sniff,!test,!romon
/user/add name=t3code group=t3-agent address=172.18.0.0/24 password=[/file/get [find where name="pcie1/apps/t3code/secret-routeros_pw"] contents]
```

In the container, the host record switched to `--user t3code
--password-stdin < /run/secrets/routeros_pw`. `centrs retrieve` then read
as `t3code` (sources `cdb`), and `/system/identity/set` was refused by
RouterOS (`routeros/permission-denied`, `not enough permissions (9)`); the
identity was unchanged. So the one generated value served as the CDB key
and as the account password, and the agent's limits were the RouterOS
group's.

**Free license, measured on the side:** RouterOS pulled the image (about
1 GB) and started the container in 73 s, but traffic *into* the container
is capped: `curl` from inside measured about 46 KB/s, and Codex's npm
install was still running after 17 minutes. Everything the container
downloads (provider CLIs, tool groups, skills) is slow on an unlicensed
CHR; the image pull isn't. This answers part of the roadmap's "Unlicensed
CHR" item.

## Direction (owner, 2026-11-25; not a spec)

From the discussion on #47 and in the session that ran this research:

- **The policy is the RouterOS account the user gives the agent.** No
  read-only layer here: centrs's `mcp=ro|rw` is metadata for tips and early
  errors, not a guarantee, and a `DEFAULT_ROUTEROS_ACCESS` setting is
  dropped. `admin` with no password is fine as the default for
  quickchr-style testing (the main use case); nobody should run it in
  production.
- **No plain password on the `/data` volume.** An encrypted CDB on disk is
  acceptable even though its key is readable by a RouterOS admin; T3's
  plaintext secret store is not a good home for router passwords.
- **Don't turn the secret into an env value.** RouterOS's `/container` copy,
  `/export` and logs all show env values. `t3app` reads `/run/secrets` and
  sets up what centrs needs instead.
- **Start users on the CDB.** Initialize an encrypted CDB at first start if
  none exists, key it from the app secret, and seed `__default__` with
  `admin` and no password, so a quickchr host just works and the path to
  more routers is the same CDB.
- **Know the platform.** `init` may record whether it runs on a RouterOS
  host (placeholder values present, `/run/secrets` present) or under
  Docker/Podman, because logic will fork on it.
- **Upstream:** track a MikroTik report for the `/container` env copy of a
  secret. Longer term, centrs as an MCP App with OAuth is where stronger
  policy belongs; a centrs MCP server managing the CDB for app-t3code is an
  open idea, not aligned yet.

### What today's centrs can and can't do for that scheme

- **Can:** encrypted CDB in `/data`, `__default__`, per-router records,
  `--password-stdin`, fail-closed without the key. All measured above.
- **The gap is the key's delivery.** Each `centrs` process needs
  `CENTRS_CDB_PASSWORD` in its env, and agents start `centrs` themselves.
  Options:
  1. `t3app`'s startup exports `CENTRS_CDB_PASSWORD` (read from
     `/run/secrets`) into the T3 server's process env before T3 starts.
     It is process env, not RouterOS config, so it doesn't reach `/container`,
     `/export` or the router log, but every process in the container
     inherits it. Whether T3 passes its own env down to provider sessions
     is the pending runtime check (`LAB_ROUTER` is the marker).
  2. A small centrs change: `CENTRS_CDB_PASSWORD_FILE` (or the
     same-named setting) that reads the key from a path, as Docker images
     commonly do with `*_FILE`. Then nothing secret is in any env, and
     `CENTRS_CDB_PASSWORD_FILE=/run/secrets/<name>` is safe to put in the YAML,
     the image `ENV` and the README. This conflicts with centrs's current
     "never from a file" rule, whose reason is a password *persisted*
     beside the CDB; `/run/secrets` is neither.
  3. Agents prefix `CENTRS_CDB_PASSWORD=$(cat /run/secrets/…)` themselves:
     works today, but it's a recipe every agent must follow, and it puts the
     key on command lines in transcripts.
- **Host address:** `CENTRS_HOST` doesn't select a target, so the address
  belongs in the CDB record (seeded by `init` from `[networkRouterIP]` or the
  gateway) or in a `host` group, not in env.

## Still open

1. T3 → provider sessions: does a variable in T3's own env (`LAB_ROUTER`), or
   one set as a Codex provider-instance env in `settings.json`
   (`LAB_PROBE_ENV`), reach the processes Codex starts? Measured so far:
   the container env reaches PID 1, `t3 serve` and T3's resource monitor.
   With Codex installed (about 24 minutes over the capped link) but no
   session, nothing Codex-related ran in a 330 s sample past T3's re-probe
   interval ([`probe/env-sampler.sh`](probe/env-sampler.sh)). The check
   needs a signed-in Codex (or Claude) session started from T3; then
   [`probe/provider-env.sh`](probe/provider-env.sh) answers it.
2. A secret request card's file across a T3 restart.
3. The `/container` env leak on a 7.26 beta; then report it to MikroTik.
4. Seeding the CDB at first start: once, then left alone (like skills), or
   reconciled each start; what happens when the operator changes the secret
   (`/app/set secrets=`) after the CDB was keyed with the old one.
5. centrs's MCP server on the same encrypted CDB.
6. Docker/Podman equivalents (#72): `/run/secrets` from compose secrets, the
   bridge gateway, no router there.

## Reproduce

```sh
quickchr add --name credprobe --arch x86 --version 7.25.2 --cpu 2 --mem 1024 \
  --add-disk 2G --device-mode-enable container --add-package container
quickchr start credprobe
centrs execute --quickchr credprobe --yes '/disk/format *1 file-system=ext4'
centrs execute --quickchr credprobe --yes '/app/settings/set disk=pcie1'
centrs api --quickchr credprobe app -X PUT -f "yaml=$(cat probe/probe.tikapp.yaml)" -f use-https=no --yes
centrs execute --quickchr credprobe --yes '/app/set [find where name="credprobe"] disabled=no'
centrs transfer --quickchr credprobe upload probe/boot.sh pcie1/apps/credprobe/probe-data/boot.sh
# restart (disabled=yes, then no), then read the record:
centrs execute --quickchr credprobe ':put [/file/get "pcie1/apps/credprobe/probe-data/boots" contents]'
```

The first start finds no script and writes `no-boot-script`; every later
start appends a record. Raw records stay out of the repo (they hold
lab addresses).

The image steps use a CHR with `--boot-size 8G --add-disk 10G --mem 2048`,
the same disk and `/app/settings` setup, `probe/t3code-lab.tikapp.yaml`
instead of the probe YAML, and the `probe/*.sh` scripts uploaded to
`pcie1/apps/t3code/t3code_root/tmp/<new-name>` and run with
`/container/shell app-t3code cmd="bash /tmp/<new-name>"`.
`host-account.sh` expects the router-side `/user/group/add` and `/user/add`
above to have run.
