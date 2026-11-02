# app-t3code

RouterOS `/app` container for [T3 Code](https://github.com/pingdotgg/t3code) —
the agentic coding tool that runs as a server with a web UI. This repo builds
multi-arch (`linux/amd64` + `linux/arm64`) OCI images to
`ghcr.io/tikoci/app-t3code`, ships the `/app` YAML to install them, and
proves the whole path on real CHR VMs (x86_64 + ARM64) with Bun tests.

Target device: MikroTik **RDS2216** (ARM64, ROSE edition — container-ready
out of the box). Anything here that says CHR also applies to RDS, except the
CHR-only workarounds are marked.

## Install

Prerequisites on the router (one time):

1. RouterOS 7.22+ (`/app/add` with custom YAML needs 7.22; colon-style
   `host:ctr:label:tcp` ports need 7.23+ — just run stable).
2. The `container` extra package installed.
3. Device-mode with `container=yes` (RDS ships `rose` mode with it on;
   other hardware needs one physical confirm).
4. A formatted disk for apps (see [Storage](#storage)).

Then install the app. **Test/CHR** (no certs available without `/ip/cloud`):

```routeros
/app/add yaml=<paste app/t3code.tikapp.yaml> use-https=no
/app/set [find where name="t3code"] disabled=no
```

**Production** (valid certs via `/ip/cloud`, or your own domain):

```routeros
/app/add yaml=<paste app/t3code.tikapp.yaml> use-https=yes
/app/set [find where name="t3code"] disabled=no
```

The only difference is the flag: `use-https=yes` drives the `[accessProto]`
placeholder to `https` and mints Let's Encrypt certs through a hidden
`/ip/reverse-proxy` SNI entry. On CHR with the free license there is no
`/ip/cloud`, so `yes` can never complete — that is why CI and all test
commands below use `no`.

Open the WebFig entry (or `https://<router-ip>:3773` / `http://...`
respectively) and pair: on the router host run the equivalent of
`t3-pairing-link` inside the container to get a one-time link
(~5 min expiry). Storage persists on the app disk, so logins, the T3
database, and `~/projects` survive reboots — one container per volume.

## Storage

`/app` refuses to enable anything until a disk is configured
(`need to configure disk to install apps to in /app settings`):

```routeros
/disk/print            # find the extra disk, e.g. *1
/disk/format *1 file-system=ext4
/app/settings/set disk=<mount-point>
```

On RDS this is an NVMe volume; on CHR attach a second virtual disk
(`extraDisks: ["4G"]` in quickchr) — the stock CHR system disk is too
small for a ~650MB image. The app then lives under
`<disk>/apps/t3code/`. There is no second YAML file for prod: the YAML
is identical, only the `use-https` flag differs.

## Using T3 Code

The container serves plain HTTP on **3773** (`T3CODE_HOST=0.0.0.0`,
`T3CODE_PORT=3773`). Put HTTPS in front for anything beyond localhost —
the hosted web/mobile T3 apps require it.

| Env | Default | Notes |
|---|---|---|
| `T3CODE_HOST` / `T3CODE_PORT` | `0.0.0.0` / `3773` | server bind |
| `T3CODE_TELEMETRY_ENABLED` | `false` in our YAML | set `true`/unset to opt back in |
| `PUBLIC_URL` | unset | base URL baked into pairing links |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | inherited | agents see container env |
| `T3CODE_*` | passthrough | e.g. `T3CODE_SERVER_BROWSER_SANDBOX=0` |

Pairing: `t3-pairing-link` inside the container prints a one-time URL
(with `PUBLIC_URL`) or token. Codex and opencode ship in the image;
Claude Code installs itself to the persistent volume on first boot
(its license forbids redistributing it, so it cannot be baked in).

Good upstream navigators (pingdotgg/t3code docs):

- install / requirements (`t3 serve`, providers) — install.md
- remote access (`t3 up`, `--lan`, T3 Connect relay, pairing) — remote-access.md
- background service (memory/OOM guidance, `t3 service`) — background-service.md
- telemetry opt-out — telemetry.md
- project settings / storage cleanup — project-settings.md
- FAQ (disk usage is worktree cleanup) — faq.md

The image only documents one requirement: *an installed, authenticated
provider*. There are no published CPU/RAM minimums; size from your
workload (agents + browser), not from a datasheet.

## Tags

Images track upstream **stable** T3 Code releases only — no nightlies
(CI still accepts any `T3CODE_VER` input for one-off builds):

- `ghcr.io/tikoci/app-t3code:0.1.6` — exact release
- `ghcr.io/tikoci/app-t3code:0.1`, `:0`, `:latest` — stability aliases

The `/app` YAML references the `:0.1`-style stability tag, and
`test/app-yaml.test.ts` fails the build if it drifts from
`package.json`'s major.minor. Bumping T3 versions = bump `T3CODE_VER`
(default in `Dockerfile` + `Makefile`), `package.json`, and the YAML
tag together.

## Developing

```sh
bun install
bun run check          # biome + tsc --noEmit
bun run test           # offline /app YAML contract (always runs)
APP_T3CODE_INTEGRATION=1 bun test test/integration/
```

The integration test boots a real CHR per arch with
`@tikoci/quickchr@next`, drives it with `@tikoci/centrs@next`, and
asserts the web UI answers with the expected `serverVersion`:

```sh
APP_T3CODE_ROS=stable APP_T3CODE_ARCH=arm64 APP_T3CODE_INTEGRATION=1 \
  bun test test/integration/
```

Both helpers float on `next` on purpose: if a helper breaks, report it
to [centrs](https://github.com/tikoci/centrs/issues) /
[quickchr](https://github.com/tikoci/quickchr/issues) instead of
working around it silently. CI (`ci.yml`) lints, tests, and builds
both arches to GHCR; `integration.yml` runs the CHR matrix weekly,
post-push on `app/` + `test/integration/`, and on demand.

Verified install flow on CHR 7.25 (x86, free license):

1. first-boot `deviceMode: { enable: ["container"] }` → `rose` mode
   (the guest-side `/system/device-mode/update` never completes);
2. `installPackage("container")` (`/app` 404s without the package);
3. `/disk/format <id> file-system=ext4` (7.25 has `ext4`, no `ext3`)
   + `/app/settings/set disk=<mount-point>`;
4. `api … app -X PUT -f yaml=… -f use-https=no --yes`
   (colon-style `3773:3773:web:tcp` ports parse as `firewall-redirects`);
5. `/app/set … disabled=no` (PUT leaves the app `disabled:true`);
6. poll `/app` + `/container` (`.running` is the string `"true"`) +
   `GET /.well-known/t3/environment` → `serverVersion`.

`routeros-app-yaml`, `routeros-container`, `routeros-centrs`,
`routeros-quickchr-cli`, and `tikoci-crossref` skills govern this repo;
`AGENTS.md` has the working notes.

## License

MIT — see [LICENSE](LICENSE).
