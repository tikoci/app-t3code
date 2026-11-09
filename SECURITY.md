# Security Policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/tikoci/app-t3code/security/advisories/new).
Do **not** open a public issue for an undisclosed vulnerability.

Include the image tag or `sha-<commit>`, the RouterOS version and
architecture, reproduction steps and the impact. The first response comes
within a few business days, and fixes land on `main` and ship in the next
promoted image (see [Tags](README.md#tags)).

A vulnerability in T3 Code itself belongs upstream at
[pingdotgg/t3code](https://github.com/pingdotgg/t3code). Report one in a
provider CLI (Claude Code, Codex, OpenCode and others) to its vendor. If it
affects this image in a particular way, tell us as well.

## Security model

app-t3code follows **T3 Code's security model** and adds no access-control
layer of its own. T3 decides who can connect and what a paired client can
do; this repo packages T3 for RouterOS `/app` and documents what that
packaging exposes. If T3 logs something, the container logs it too.

The trust boundaries, from the outside in:

- **RouterOS access implies container access.** A RouterOS user with write
  access to `/container` or `/app` can run commands in the container
  (`/container/shell`), mint a pairing token (`t3-pairing-link`), change its
  environment, or replace its image. Treat router admin accounts as admin
  accounts for T3 and everything in `/data`.
- **Treat a paired T3 client as a full T3 admin.** The startup pairing token
  grants T3's administrative scopes, including terminals, file writes and
  provider management. Anyone paired with a terminal can run any command
  the container user can.
- **Agents run as the container user.** T3, its agents and its terminals run
  as `node` (uid 1000) with no `sudo`. They can read everything in `/data`,
  including provider logins, `gh` tokens and API keys passed in the
  environment. The container is not `privileged` by default. Which Linux
  capabilities and devices a RouterOS container gets is still being measured
  ([#7](https://github.com/tikoci/app-t3code/issues/7)).
- **The network listener is T3's.** T3 serves HTTP on port 3773, and the
  `/app` YAML maps it through RouterOS. Use `use-https=yes` (RouterOS
  `/ip/cloud` or your own domain) for anything beyond a lab. `use-https=no`
  is for CHR labs, where there is no `/ip/cloud`.

## Known exposures

### The startup pairing token in `/container/log`

On every start, T3 prints a one-time pairing token, a pairing URL and a QR
code to the container's output. RouterOS keeps that output in
`/container/log` (WinBox **Container → Log**) whether or not the container
has `logging=yes`. Until it is used or expires, about **5 minutes** after the
start, that token pairs a browser as a full T3 admin.

Measured on RouterOS 7.25: a user in the built-in **`read`** group can see
the token through `/container/log` (REST `GET /rest/container/log`), but
cannot use `/container/shell`. So for about 5 minutes after each start, a
read-only RouterOS account can gain control of T3, and through it a shell in
the container.

This image does not suppress or filter the banner. T3 has no option to turn
it off, and filtering T3's still-changing output would be fragile. Until that
changes, treat `read`-group access to a router running this app as access to
T3 for the first 5 minutes after every start. Every start prints a new
token: a router reboot, `/app/update`, or toggling the app. RouterOS user
group policies are per protocol, not per menu, and skins hide menus only in
WebFig and WinBox, not over the API or REST. So no group setting hides
`/container/log` from a `read` user. MikroTik's own
[User](https://manual.mikrotik.com/docs/authentication-authorization-accounting/user)
page already warns against giving the built-in `read` group to untrusted
users (it includes `reboot` and `sensitive`).

The supported way to pair is still `t3-pairing-link` (see
[Pairing with the web UI](README.md#pairing-with-the-web-ui)), which needs
`/container/shell`, so it needs write access.

### Software installed at runtime

The image installs some software into `/data` after it starts, so its
version is not fixed by the image:

| What | Source | Check |
|---|---|---|
| Claude Code (`T3CODE_PROVIDERS`) | Anthropic's release manifest, stable channel | size and SHA-256 from the manifest; the manifest's signature is not yet checked ([#13](https://github.com/tikoci/app-t3code/issues/13)) |
| Codex, OpenCode, Pi (`T3CODE_PROVIDERS`) | npm registry, latest | npm's registry integrity; not pinned, by design, so T3's **Update now** can manage them |
| Grok, Muse (`T3CODE_PROVIDERS`) | the vendor's `install.sh` over HTTPS | whatever the vendor's installer checks |
| `dev` tool group | npm, from a committed lockfile | lockfile integrity hashes |
| `capture`, `labs`, `vpn`, `routing` tool groups | Debian packages pinned at image build | size and SHA-256 from apt's signed indexes |

Provider CLIs update through T3 or their own updaters after install, the
same as on any T3 host. Set `T3CODE_PROVIDERS=none` and
`T3CODE_TOOL_GROUPS=none` to install nothing at runtime.

### File modes in `/data`

RouterOS starts containers with umask 0000. Since the 2026-11-09 image the
entrypoint sets umask 022 before starting T3, so new files in `/data` are no
longer world-writable. Files created by older images keep their modes:
`chmod -R go-w /data` from a T3 terminal fixes them. Commands run directly
through RouterOS `/container/shell` bypass the entrypoint and still use
0000.

### Telemetry

The image sets `T3CODE_TELEMETRY_ENABLED=false`. Set it to `true` to opt back
in to T3's telemetry. Provider CLIs have their own telemetry settings.

## Build and CI

- Images are built by GitHub Actions and published to
  `ghcr.io/tikoci/app-t3code`. CI pushes only `:sha-<commit>` from `main`.
  Release tags (`:0.1.7`, `:0.1`, `:0`, `:latest`) move to that digest only
  after the arm64 container-replacement test passes.
- Build-time downloads are pinned: T3 Code by version, `gh` and the CI linters
  (hadolint, ShellCheck, actionlint) by version and SHA-256, and `uv` by image
  tag.
- Workflow actions are pinned by tag, not yet by commit SHA (tracked on the
  [Roadmap](https://github.com/tikoci/app-t3code/issues/30)).
- A ruleset on `main` blocks force-pushes and deletion and requires CI's
  `lint-test` and `build` jobs. `build` skips changes that can't reach the
  image (docs, `.agents/`, `.claude/`), and GitHub counts a skipped job as
  passing, so the image build gates only image changes. Repository admins
  can bypass it, for small doc fixes straight to `main`.
- Daily freshness checks (`.github/workflows/freshness.yml`) flag a new
  upstream T3 release or a change in Claude Code's download contract.

## Code scanning

The [Security tab](https://github.com/tikoci/app-t3code/security) is the
live source of alerts and advisories. What runs today:

- **CodeQL**: GitHub default setup, `default` query suite, for
  `javascript-typescript` and `actions`.
- **Dependabot**: alerts and security-update PRs, enabled. Security PRs on
  `scripts/groups/dev/package-lock.json` change the `dev` payload id, so
  every home re-downloads it on its next start, which is the intended
  security refresh. Version-update PRs are not configured.
- **Secret scanning** with **push protection**: enabled.
- **Private vulnerability reporting**: enabled.

## Supported versions

| Version | Supported |
|---|---|
| The current `:0.1` (newest promoted build) | ✅ |
| Older builds and `sha-<commit>` candidates | ❌ |

Update with `/app/update` (see [Install](README.md#install)). The image
version is the upstream T3 Code version; see [CHANGELOG.md](CHANGELOG.md)
for what each build changed.
