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
owner listed them on #47; the first three were measured or read here.

| # | Path | Who can read the value | Survives | Status |
| --- | --- | --- | --- | --- |
| 1 | Literal `CENTRS_*` in the app env (`/app/set environment=`) | Every process in the container; RouterOS users who can read `/container` or `/app`; `/export` | restart, `/app/update`, reboot (earlier lab) | known; not useful for passwords |
| 2 | `/app` secret via `[secret:name]` in an env value | As 1: the expanded value is in `/container` `env`, even for a group without `sensitive`, and in a plain `/export` | restart, `secrets=` change, env change, `/app/update`, reboot | **measured** |
| 3 | `/app` secret as a file (`/run/secrets/<name>`) | Every process in the container (mode 0444, root); RouterOS users who can read `/file` (`pcie1/apps/<app>/secret-<name>`), even without `sensitive` | as 2 | **measured** |
| 4 | T3 provider environment variable (value or `op://` reference) | Every process the agent starts; T3's secret store in `/data` (mode 0600, same uid as the agent) | T3 settings in `/data` | source (v0.1.12); runtime pending |
| 5 | T3 secret request card, delivered to a file | The agent's own commands | about 24 h (TTL); across a T3 restart: pending | source (v0.1.12); runtime pending |
| 6 | Project `.env` | Any `centrs` run in that directory (Bun auto-load, [centrs#666](https://github.com/tikoci/centrs/issues/666)) | the project | known bug; not a design path |
| 7 | User-level CDB in `/data` (`CENTRS_CDB_FILE`, optional `CENTRS_CDB_PASSWORD`), and centrs's MCP server on top of it | Every process that can read the file; MCP writes gated per record (`mcp=ro\|rw`) | `/data` | pending |

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
example (not yet tested), after install:
`/user/add name=t3code group=<group> password=[/file/get pcie1/apps/t3code/secret-routeros_pw contents]`.
What it is not: a value hidden from other router users. Anyone with `read`
and API or web access can read it.

## T3 Code side (source, v0.1.12)

- **Secret store:** `<T3 state>/secrets`, mode 0700, one file per secret, mode
  0600, plain text (`apps/server/src/auth/ServerSecretStore.ts`,
  `config.ts` `secretsDir`). In this image that's under `/data/.t3`, owned by
  `node`, the same uid the agent runs as, so it protects against other users,
  not against the agent.
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
- **Secret providers:** 1Password through `op`, signed in on the server's
  machine (service account or Connect for a headless server). New since the
  v0.1.7 research. `op` isn't in the image.
- **Secret request cards** (`SecretRequests.ts`): the value never enters the
  conversation; a `file` request moves it to an owner-only file for the
  agent's own shell, valid about 24 h (`SECRET_REF_TTL_MS`). This is the
  "temporary secret delivery" recipe of #47. The 2026-11-24 CHR run found the
  card refuses an empty value (#29), which matters for `admin` with no password.

## centrs side (0.2.0-next)

- Env alone can target one router: `CENTRS_HOST`, `CENTRS_PORT`,
  `CENTRS_USERNAME`, `CENTRS_PASSWORD`, `CENTRS_VIA`, `CENTRS_INSECURE`.
  Precedence: `centrs.env` → CDB comment-kv → `CENTRS_*` env → flag, and
  `meta.settings` in every envelope says which source won.
- The CDB has a reserved `__default__` record (`--default`), which is where a
  "default router" from the env could be seeded.
- No read-only switch. `ro`/`rw` exists only as a per-record MCP write policy
  (`mcp=ro` by default); the CLI's gate is `--yes` on write-shaped commands.
  A `DEFAULT_ROUTEROS_ACCESS=ro` would need a centrs feature, and the account's
  RouterOS group stays the real limit.
- Side note for #29: `centrs execute ':put [/console/inspect request=child …]'`
  was refused as write-shaped without `--yes`.

## Implications for the owner's strawman (not decisions)

From #47 (2026-11-25): a RouterOS secret mapped to centrs env, generic
`DEFAULT_ROUTEROS_*` names normalized to `CENTRS_*` at start (and perhaps read by quickchr), a
default `ro` access, and the CDB for more than one router.

- **The host's address needs no input.** `[networkRouterIP]` in the YAML env
  gives it, and the gateway gives the same address. A YAML value that is a
  placeholder can't be a Dockerfile `ENV` default, which conflicts with this
  repo's YAML ↔ `ENV` test rule. Either the rule gets an exception for
  placeholders, or startup reads the gateway (that also works under Docker,
  where it's the bridge, not a router).
- **The password can come from an `/app` secret,** but it is a convenience,
  not protection. The generated value plus a router-side `/user/add` makes a
  dedicated account without typing a password, and an operator can set it to
  an existing account's password. Either way, any `read` user can see it.
- **Normalizing at start** (`DEFAULT_ROUTEROS_*` → `CENTRS_*` or the CDB's
  `__default__` record) is small work in `t3app init`. Which one matters:
  env reaches every process, and a CDB record also covers MCP.
- **Several routers** need the CDB; env describes one. The first-run question
  is whether startup seeds `__default__` once (and leaves later user edits
  alone, like skills) or rewrites it each start.

## Still open

1. T3 provider env at runtime: `CENTRS_*` set in Settings reaches `centrs` in a
   Claude and a Codex session (needs the app-t3code image).
2. centrs in the real image against the host with only
   `CENTRS_HOST=[networkRouterIP]` (quickchr default `admin`, no password).
3. Router-side account from the generated secret: `/user/add … password=[/file/get …]`,
   a minimal group, `/ip/service` address lists covering the app network.
4. The `/container` env leak on 7.26 betas; then report it.
5. CDB in `/data`: seeding `__default__`, `CENTRS_CDB_PASSWORD`, and what MCP
   allows on it.
6. Docker/Podman equivalents (#72).

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
