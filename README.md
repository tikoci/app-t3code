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

1. RouterOS 7.24.6 or newer (the minimum supported version).
2. The `container` extra package installed.
3. Device-mode with `container=yes` (RDS ships `rose` mode with it on;
   other hardware needs one physical confirm).
4. A formatted disk for apps (see [Storage](#storage)).

Then install the app for production (HTTPS via `/ip/cloud` or your own domain):

```routeros
/app/add yaml=([/tool/fetch url="https://tikoci.dev/app-t3code/app/t3code.tikapp.yaml" check-certificate=yes output=user as-value]->"data") use-https=yes
/app/set [find where name="t3code"] disabled=no
```

> [!NOTE]
> When using CHR, such as with [tikoci/quickchr](https://github.com/tikoci/quickchr),
> change `use-https=yes` to `use-https=no`. Free-license CHR has no `/ip/cloud`
> for certificate provisioning. CI and the test commands below use this setting.

Once the container is running, follow [Pairing with the web UI](#pairing-with-the-web-ui)
to get its browser URL and a one-time pairing token. Storage persists on the
app disk, so logins, the T3 database, and `~/projects` survive reboots.

### Preview or edit the YAML

[See in /app YAML Editor](https://tikoci.dev/restraml/tikapp.html?version=latest&yaml=%23+yaml-language-server%3A+%24schema%3Dhttps%3A%2F%2Ftikoci.dev%2Frestraml%2Frouteros-app-yaml-schema.latest.json%0A%23+tikoci%2Fapp-t3code+%E2%80%94+RouterOS+%2Fapp+definition+for+the+T3+Code+server.%0A%23%0A%23+Install+on+the+router+%28production%2C+HTTPS+via+%2Fip%2Fcloud+or+your+own+domain%29%3A%0A%23+++%2Fapp%2Fadd+yaml%3D%3Ccontents-of-this-file%3E+use-https%3Dyes%0A%23+On+CHR+%28including+tikoci%2Fquickchr+labs%29%2C+use+use-https%3Dno+instead.%0A%23%0A%23+Image+tags+track+upstream+T3+Code+stable+releases+only+%28no+nightlies%29%3A%0A%23+ghcr.io%2Ftikoci%2Fapp-t3code%3A%3CT3CODE_VER%3E+with+%3A0.1+%2F+%3A0+%2F+%3Alatest+as%0A%23+stability+aliases.+Pin+the+full+version+in+production%3B+%3A0.1+follows%0A%23+patch+releases.%0A%0Aname%3A+t3code%0Adescr%3A+T3+Code+server+%E2%80%94+agentic+coding+in+the+browser+%28GHCR+build+for+RouterOS%29%0Apage%3A+https%3A%2F%2Fgithub.com%2Ftikoci%2Fapp-t3code%0Acategory%3A+development%0Aurl-path%3A+%2F%0Aservices%3A%0A++t3code%3A%0A++++image%3A+ghcr.io%2Ftikoci%2Fapp-t3code%3A0.1%0A++++ports%3A%0A++++++-+%223773%3A3773%3Aweb%3Atcp%22%0A++++environment%3A%0A++++++HOME%3A+%2Fdata%0A++++++T3CODE_HOME%3A+%2Fdata%2F.t3%0A++++++T3CODE_HOST%3A+0.0.0.0%0A++++++T3CODE_PORT%3A+%223773%22%0A++++++T3CODE_TELEMETRY_ENABLED%3A+%22false%22%0A++++volumes%3A%0A++++++%23+Keep+this+name+and+destination+when+upgrading%3A+the+whole+home%2C%0A++++++%23+including+.t3%2Fuserdata%2C+projects%2C+worktrees%2C+and+provider+logins.%0A++++++-+t3code-data%3A%2Fdata%0A++++restart%3A+unless-stopped%0Avolumes%3A%0A++t3code-data%3A+%7B%7D%0A) to inspect, validate, or customize
the single-app definition in our sister project, [tikoci/restraml](https://github.com/tikoci/restraml).
The share link embeds the YAML as a snapshot; the downloads below track the
current published files. Both YAML files include schema comments for editor validation.

### YAML downloads and app store

GitHub Pages mirrors the repository paths for Markdown and the two app YAML
formats, serving the original files without rendering or rewriting them:

- [App YAML](https://tikoci.dev/app-t3code/app/t3code.tikapp.yaml)
- [App store YAML](https://tikoci.dev/app-t3code/app/t3code.tikappstore.yaml)
- [README.md](https://tikoci.dev/app-t3code/README.md)

The install command above fetches the app YAML into memory and passes its
contents to `/app/add yaml=` for a one-time installation.

> [!TIP]
> Alternatively, add our app store to the router's catalog. This appends to
> `app-store-urls`, preserving existing stores. Before you install the app,
> the catalog can pick up changes to our template so installation uses the
> latest YAML we publish.

```routeros
/app/settings/set app-store-urls=([get app-store-urls],"https://tikoci.dev/app-t3code/app/t3code.tikappstore.yaml")
```

The store requires a YAML **array**, so use `.tikappstore.yaml` for
`app-store-urls`, and `.tikapp.yaml` for a single app installation.
See MikroTik's [custom app store documentation](https://manual.mikrotik.com/docs/containers/apps/#custom-app-store).

## Storage

Use a separate disk for apps; the RouterOS root volume cannot be used.
Format the app disk as **ext4** or **btrfs**, then set its mount point in
`/app/settings`. `/app` refuses to enable anything until this is configured:

```routeros
/disk/print            # find the extra disk, e.g. *1
/disk/format *1 file-system=ext4
/app/settings/set disk=<mount-point>
```

The disk can be any supported storage type with enough space for the image
and persistent data. On CHR, attach a second virtual disk. The app then lives
under `<disk>/apps/t3code/`.
The image with bundled agent tools is approximately 1GB compressed and 4GB
extracted; allow at least an 8GB app disk for installation, plus space for
projects, browser downloads, and any quickchr lab disks. Builds need extra
space for intermediate layers and loading the finished image.

### What survives an image replacement

The existing named volume **`t3code-data:/data`** holds the entire home.
Both the image and app YAML explicitly set `HOME=/data` and
`T3CODE_HOME=/data/.t3`. Keep the app name, volume name, and mount destination
when upgrading. The executable in `/opt/t3code` comes from the new image;
your home comes from the existing disk volume.

| Container path | Contents |
|---|---|
| `/data/.t3/userdata` | T3 databases, settings, environment identity, pairing/auth state, secrets, attachments, browser profiles |
| `/data/.t3/projects`, `/data/.t3/scratch`, `/data/.t3/worktrees` | T3-managed projects, projectless threads, and worktrees (including uncommitted files) |
| `/data/projects` | Repositories you create or clone here |
| `/data/.config`, `/data/.local/share`, provider homes | Provider configuration, logins, and session history |
| `/data/.local`, `/data/.bun` | User-installed tools and Bun global packages |

Projects outside `/data` need their own persistent mount. A project record
in the database does not preserve a checkout stored in the container's
writable layer. Provider settings that override a home or XDG path must also
point inside persistent storage.

Keep one home volume: splitting only `userdata` from the rest of `.t3` can
preserve project records while losing their worktrees or scratch files.
Do not clear `.t3` during upgrades. Its `runtime`, `tools`, and `caches`
directories contain downloadable runtimes and caches, but worktrees and
userdata contain user work. Use T3's
[storage cleanup settings](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/project-settings.md#storage-cleanup)
to manage disk use. The paths above are grounded in upstream's
[server path definitions](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/config.ts)
and [workspace folders](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/thread-sidebar.md).

Back up the complete `/data` volume with the app stopped before upgrading
(databases and their sidecars must be copied together). Keep external project
volumes in the same backup. Update the installed app in place:

```routeros
/app/update [find where name="t3code"]
```

If the registry image is unchanged, this may retain the existing root
filesystem. Existing installations receive the new image's home defaults
and tools through this command; they do **not** need the YAML reapplied.

> [!WARNING]
> On CHR **7.25.1**, assigning `/app/set ... yaml=...` recreated the app
> storage and deleted the existing named-volume contents. This reproduced
> with a comment-only YAML change on a running app. Treat any YAML change as
> a migration: stop the app and back up the complete `/data` volume, external
> project volumes, and every other app-owned volume somewhere outside
> `<disk>/apps/t3code/`. Record each volume's source and container destination.
> Apply the YAML, then keep the app stopped while restoring the home and other
> app-owned volumes into their newly selected mount sources. Verify external
> project volumes are mounted at their recorded destinations; restore their
> backups if their data was removed or their storage moved. Verify ownership
> and mount mappings for every volume before enabling the app.
> Splitting the home into more app-owned volumes does not avoid this reset.

RouterOS
[`/app cleanup`](https://manual.mikrotik.com/docs/containers/apps/#cleanup-command)
deletes app data as well as the image; it is a factory reset, not an upgrade.
Deleting/recreating the app or changing the app disk also requires a backup
and an explicit restore to the intended home volume.

If an upgrade appears to have lost projects, stop the app and check its
`/container` mount mapping and the old app disk before creating new projects.
Check whether the original `.t3/userdata/statev2.sqlite` and checkout folders
still exist. A new mount, changed home, or a checkout outside `/data` can
look like data loss even when the original files are still on disk.

## Using T3 Code

The container serves plain HTTP on **3773** (`T3CODE_HOST=0.0.0.0`,
`T3CODE_PORT=3773`). Put HTTPS in front for anything beyond localhost —
the hosted web/mobile T3 apps require it.

### Pairing with the web UI

The browser needs a one-time token to connect to this container. Once the
app is running, run this command in the **RouterOS terminal** to print both
the app's browser URL and a fresh token from `t3-pairing-link` inside the
`app-t3code` container:

```routeros
:put "** Using T3Code **\r\n\r\nIn your browser go to: $[/app/get t3code ui-url]\r\n\r\nThen, use the Token below in your browser to connect it with this container:\r\n$[/container/shell app-t3code cmd="t3-pairing-link" as-value]"
```

For example (illustrative token):

```text
** Using T3Code **

In your browser go to: http://10.0.2.15:3773/

Then, use the Token below in your browser to connect it with this container:
Issued client pairing token 00000000-0000-4000-8000-000000000000.
Token: EXAMPLEONLY
Expires at: 2026-11-03T14:07:30.038Z
```

Open the printed URL and enter the value on the `Token:` line in the browser's
pairing prompt. Tokens expire after about five minutes; run the command again
if you need a fresh one.

> [!NOTE]
> `ui-url` reflects the app's `use-https` setting. With `use-https=yes`, it
> reports the HTTPS URL (including the MikroTik hostname when using `/ip/cloud`).
> With `use-https=no`, it reports an HTTP URL like the CHR example above.

If `PUBLIC_URL` is set in the container, `t3-pairing-link` can print a full
pairing URL instead of a raw token.

### Environment and providers

| Env | Default | Notes |
|---|---|---|
| `T3CODE_HOST` / `T3CODE_PORT` | `0.0.0.0` / `3773` | server bind |
| `T3CODE_TELEMETRY_ENABLED` | `false` (image default and YAML) | set `true` to opt back in |
| `T3CODE_TOOL_GROUPS` | unset (core only) | optional tool groups; see [below](#optional-tool-groups) |
| `PUBLIC_URL` | unset | base URL baked into pairing links |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | inherited | agents see container env |
| `T3CODE_*` | passthrough | e.g. `T3CODE_SERVER_BROWSER_SANDBOX=0` |

Codex, opencode, and [Meta Muse Code](https://dev.meta.ai/docs/muse-code) ship in the image;
Claude Code installs itself to the persistent volume on first boot
(its license forbids redistributing it, so it cannot be baked in).
Muse uses the native binary downloaded and verified by Meta's official
installer during the image build. Run `muse` to authenticate, or supply
`META_API_KEY`; its default Linux configuration and history live under
`/data`. Baked tools update when you replace the image.

### Installed package inventory

The image includes Debian command-line basics (`bash`, `awk`, `sed`, `grep`,
`find`, `diff`, `tar`, `gzip`), Git/SSH, curl, jq, ripgrep, make, Python 3,
and Node.js/npm in addition to the agent and RouterOS tools below. This is
a selected toolset; `make` does not imply a C/C++ compiler, and Python does
not currently include pip or working default virtual environments.

Every image build records its installed Debian packages (including transitive
dependencies), versions, architecture, installed sizes, selected executable
availability, runtime versions, and top-level global npm/Bun packages in
`/usr/share/t3code/inventory/`. Read `README.md`, `packages.tsv`,
`commands.tsv`, or `inventory.json` there. `tool-groups.json` holds
`t3code-tools status --json --groups all` as evaluated at build time. These describe the image before
first boot; Claude, browser downloads, and tools installed in your home are
outside this inventory. A command on PATH can also be a downloader shim.

The [CI workflow](https://github.com/tikoci/app-t3code/actions/workflows/ci.yml)
uploads `image-inventory-<source SHA>` with separate `linux_amd64/` and
`linux_arm64/` directories, build metadata, the source commit, and the actual
CI host's full Debian/Ubuntu package inventory under `runner/`. Artifacts
are retained for 90 days. Published builds also record the image digest;
PR builds have no published registry digest. Curated documentation should
cite the build/architecture it describes rather than copying a timeless
package list into this README.

To inspect a local build without starting T3 or running the first-boot installer:

```sh
bun scripts/image-inventory.ts --image app-t3code:test --output image-inventory
```

See the [GitHub runner comparison and package recommendations](docs/research/2026-11-05/README.md)
for a dated amd64 snapshot, pinned Ubuntu 24.04/26.04 runner data for both
architectures, dependency-cost estimates, and the proposed additions. Package
choices are tracked in [issue #5](https://github.com/tikoci/app-t3code/issues/5);
the core network tools and group assignment are in [Optional tool groups](#optional-tool-groups).

### Optional tool groups

`T3CODE_TOOL_GROUPS` selects optional tool groups from the same image and
the same `/app` YAML. There are no profile tags or separate apps. Separate
names with spaces, for example `"capture labs"`. The parser also accepts `+`
and commas, but RouterOS splits `/app/set environment=` values on commas, so
use spaces on a router. Names are case-insensitive. Unset, empty, or `none`
means core only; `all` selects every group. An unknown name is logged as a
warning and ignored. T3 always starts, whatever the selection says.

The selection is parsed, logged, and reported to agents. `dev` (npm packages)
and `capture` (Debian packages) are delivered as persistent payloads in the
home (see [Persistent payloads](#persistent-payloads-dev-capture)). Other
selected groups whose tools are not in the image report `not-implemented`.
`labs`, `browser` and `agents-extra` are still baked into the image, so their
tools are present whether or not you select them.

| Group | Contents | In this image |
|---|---|---|
| `capture` | tcpdump, TShark (`dumpcap`, `capinfos`, `editcap`, `mergecap`, `text2pcap`), nfdump (`nfcapd`) | installs into `/data` when selected |
| `labs` | quickchr, QEMU x86/ARM64 emulators, qemu-img, firmware | baked in |
| `vpn` | WireGuard tools, strongSwan (`swanctl`, `pki`, charon), OpenVPN, sstp-client, ppp, xl2tpd, pppoe, ike-scan; no tunnel or service starts by default | not yet |
| `routing` | BIRD 2, lldpd, ndisc6, arping, arp-scan, nftables, conntrack, nmap | not yet |
| `dev` | TypeScript, CSpell, markdownlint-cli2 and Biome fallbacks; project lockfiles win | installs into `/data` when selected |
| `browser` | Native libraries for T3's built-in browser (the browser downloads itself on first use) | baked in |
| `agents-extra` | Provider CLIs beyond the core provider (Codex, opencode, Muse today; core provider not chosen yet) | baked in |

Installing a tool does not grant the privileges to use it. Live capture,
raw-socket peers, tunnels and firewall changes need capabilities or devices
that a RouterOS container may not have. Each group's `privileges` field in
the status output says what it needs.

#### Group status for agents

```sh
t3code-tools status            # one line per group
t3code-tools status --json     # runtime inventory for agents
t3code-tools status --groups "vpn routing"   # evaluate another selection
t3code-tools groups            # definitions and the network package assignment
```

Each group reports `selected`, a `state`, and whether its checks found the
files (`present`, `missing`). The states are:

| State | Meaning |
|---|---|
| `not-selected` | Not in `T3CODE_TOOL_GROUPS` |
| `pending` | Selected; waiting for the background installer |
| `installing` | The background installer is working on it, including retry back-off |
| `ready` | Selected, and every check passed |
| `failed` | Selected, and checks failed for tools the image should provide, or the last install failed and nothing usable is active |
| `not-implemented` | Selected, but this image has no way to provide the group yet |

Checks are presence probes (PATH, files, `ldconfig`), not functional tests.
Payload groups are checked at their own shims and manifest instead, so the
result does not depend on the caller's PATH.
`labs` never boots a CHR to check readiness. Core checks (`t3`, Node, Bun,
Python, Git/SSH, centrs and the core network tools) are reported separately
as `core.state`. At each start the entrypoint logs warnings and a summary to
the container log and writes the same JSON to `/tmp/t3code-tools/status.json`.
The output also points at the immutable build inventory in
`/usr/share/t3code/inventory`.

#### Persistent payloads (`dev`, `capture`)

A payload group installs into the home volume, not the image, so it costs
nothing until selected and survives image replacement and `auto-update`.
`dev` is built from an npm lockfile; `capture` from pinned Debian packages
(see [Debian-package payloads](#debian-package-payloads-capture)). Both share
the same lifecycle:

- **Start never waits.** At each start the entrypoint relinks payloads that
  are already in the home (offline, no download) and then runs
  `t3code-tools install` in the background. T3 is serving while a first
  install is `pending` or `installing`.
- **Pinned and verified.** For `dev`, the image ships the group's
  `package.json` and `package-lock.json` (with npm integrity hashes); the
  installer runs `npm ci --ignore-scripts` from them. Each command must answer
  `--version` before the payload gets a `manifest.json` and is activated
  (`capture` also has to decode a test capture). A payload without a
  manifest is never trusted.
- **Versioned and atomic.** The payload id is derived from the lock and the
  runtime: CPU architecture and Node's module ABI for `dev`, dpkg
  architecture and Debian release for `capture`. Payloads live in
  `/data/.local/share/t3code-tools/groups/<group>/<id>/`; a `current` link is
  swapped atomically, and shims in `/data/.local/share/t3code-tools/bin` are
  on PATH after `/data/.local/bin` and `/data/.bun/bin`. A tool you install
  yourself wins, and a project's own `node_modules/.bin` (`bun run`, `npx`)
  still wins.
- **Refresh without downtime.** A new image with a changed lock (a
  security refresh) or a different Node ABI wants a new payload. The previous
  one stays active and the group stays `ready` (`payload.stale: true`) until
  the new one is verified. If the refresh fails, the previous payload keeps
  working. The installer keeps the active payload and the one before it and
  deletes older ones.
- **Bounded.** Groups install one at a time under a lock
  (a kernel `flock` on `install.lock`, released automatically if the holder
  dies; the next run also stops an npm left behind by a killed installer
  before reclaiming its files). Each group gets three
  attempts with back-off (30 minute cap per attempt); with no network at all
  npm needs about five minutes to give up. The installer needs room for the
  payload and its downloads (for `dev`, twice the payload size; for
  `capture`, the pinned `.deb` sizes not already verified in the cache, plus
  their unpacked sizes) plus 256 MiB,
  and otherwise fails with a `low disk` error rather than filling the
  volume. It never deletes projects, VMs or other home data. Interrupted
  installs (`.staging-*`) are removed on the next run.
- **Deselecting** a group removes its shims at the next start but keeps its
  payload, so selecting it again needs no download. `t3code-tools prune`
  deletes payloads that no selected group uses, and any kept `.deb`
  downloads.

`t3code-tools status --json` reports `payload.desired`, `payload.active`,
`stale`, `installed`, the verified `activeVersions` and the last installer
result with its error. The installer log is
`/data/.local/share/t3code-tools/install.log`. Run `t3code-tools install` in
a terminal to retry a failed group now; otherwise the next start retries it.

The `dev` payload is about 154 MiB on amd64 (TypeScript 7.0.2, CSpell 10.4.0,
markdownlint-cli2 0.24.0, Biome 2.6.5). Maintainers refresh the pins with
`make dev-lock` after editing `scripts/groups/dev/package.json`.

#### Debian-package payloads (`capture`)

`capture` is too big to bake into every image (about 157 MB more on disk and
42 MB more to pull on every image update, measured on amd64), so it is a
payload too. It installs as the app user with no root at runtime:

- **Pinned at image build.** The Dockerfile runs `t3code-tools deb-lock` after
  the last apt layer. It asks apt for the group's dependency closure that the
  image does not already have, and records each package's version,
  architecture, size and SHA256 from the apt indexes. apt has already checked
  those indexes against Debian's signing keys. The lock is
  `/usr/local/lib/t3code/groups/capture/debs.lock.json` (also in the build
  inventory as `capture-debs.lock.json`). Every image rebuild picks up Debian
  security updates, and a changed lock is a new payload id, which refreshes
  as described above. An unchanged lock keeps the same id, so nothing is
  downloaded again.
- **Verified before extraction.** Each `.deb` is downloaded from
  `deb.debian.org` (https first) and must match its pinned size and SHA256.
  A download is cut off as soon as it exceeds the pinned size.
  Its control fields must also name the pinned package, version and
  architecture. Only then is it unpacked with `dpkg-deb -x`. Maintainer
  scripts never run. If a superseded version has left the mirror, it is
  fetched from `snapshot.debian.org` and checked the same way. Verified
  downloads survive an interrupted install in `groups/capture/.cache-debs`,
  so a slow link resumes rather than starting over. They are removed once
  the payload is ready.
- **No global library path, no `/usr` overlay.** Each command gets a small
  wrapper in the payload's `bin/` that sets `LD_LIBRARY_PATH` to the
  payload's own library directory for that process and its children only,
  then runs the real binary from the payload. The payload holds only
  packages the image lacks, so it does not replace the image's copies. If
  apt would upgrade a package the image already has, the lock records that
  under `imageUpgrades` and the build log warns, but the package is not
  extracted. If a tool really needs the newer version, its version check
  fails and the payload is never activated; an image rebuild fixes that.
  Wireshark finds its data files and plugins relative to the binary, so
  `tshark` decodes with its full dissector set, RADIUS dictionaries and
  plugins from the payload. A payload command never shadows a command of the
  same name in the image, including one the image gains later. A required
  command that the image already provides is checked and used from the image.
- **Stale native payloads are checked.** While a refresh is pending after an
  image update, the previous payload stays linked only if `tshark --version`
  still runs against the new image.

Measured on amd64 (habitat C, Debian trixie, Wireshark 4.4.19, tcpdump
4.99.5, nfdump 1.7.5): 42 packages, 30.5 MiB to download, 152 MiB unpacked,
about 5 s to install on a fast link (computed: about 4.3 minutes at 1 Mbit/s). Wrapper
overhead is about 1 ms per command. On arm64 the same code installed and
passed the decoding, capture-file and NetFlow checks under QEMU user-mode
emulation on an amd64 host. That is not native hardware, and interface
listing and the live-capture refusal could not be tested there. See the
[spike write-up](docs/research/2026-11-06/capture-native-bundle.md).

Installing `capture` grants no capture privileges. Offline decoding
(`tshark -r`, `tcpdump -r`, `capinfos`, `editcap`, `mergecap`, `text2pcap`),
`dumpcap -D` (listing interfaces) and an `nfcapd` NetFlow collector on a port
of 1024 or above (tested with NetFlow v5) all work as the unprivileged app
user. Live capture with `tcpdump -i`/`dumpcap -i` needs `CAP_NET_RAW` and is
refused without it. Without privileges, save a capture on the router
(`/tool/sniffer` with `file-name=`) and copy the file over, or point
`/ip/traffic-flow` at `nfcapd`. Receiving a live TZSP stream without
privileges needs a UDP listener in front of the decoder and is not tested
here.

#### Changing groups on RouterOS

Use `/app/set environment=`. Never reapply or edit the YAML to change
groups. On 7.25.1 and 7.26beta5, assigning `yaml=` recreates the app's
volumes, which wipes the home, and leaves the app disabled
([lab results](docs/research/2026-11-05/app-set-environment.md)).
`environment=` restarts the container and keeps its volumes. The setting
survives `/app/update` and reboots.

`environment=` replaces the **whole** environment list. The YAML's
`environment:` block is only the initial value, and it does not come back as
a default. A single-key set like `environment="t3code:T3CODE_TOOL_GROUPS=vpn"`
silently drops every other key. Every setting the app needs is therefore also
an image `ENV` default, so a dropped key falls back to the same value. Keys
you added yourself, such as API keys or `PUBLIC_URL`, are not.

To replace only the group key and keep the rest, run this script from the
RouterOS terminal (or paste it into a `/system/script`). Change `val`:

```routeros
:local app "t3code"; :local key "t3code:T3CODE_TOOL_GROUPS="; :local val "capture labs"
:local keep ({}); :foreach e in=[/app/get $app environment] do={ :if ([:find $e $key] != 0) do={ :set keep ($keep, $e) } }
/app/set $app environment=($keep, ($key . $val))
```

Check the result with `:put [/app/get t3code environment]`, then run
`t3code-tools status` in the container. Running the script again with
another value replaces the key; it does not add a duplicate. Tested on a
CHR 7.25.1 app named `t3code` with service `t3code`: the other key was kept,
the container restarted, and the volume's contents survived.

#### Network tool assignment

Every network package from the
[2026-11-05 research](docs/research/2026-11-05/routeros-protocol-map.md) is
assigned here. `t3code-tools groups` prints the same table as JSON.

| Where | Packages |
|---|---|
| core (in the image) | `iproute2`, `iputils-ping`, `bind9-dnsutils`, `netcat-openbsd`, `socat`, `traceroute`, `mtr-tiny`, `iperf3`, `ethtool`, `whois`, `snmp`, `freeradius-utils`, `mosquitto-clients` |
| `capture` | `tcpdump`, `tshark`, `wireshark-common`, `nfdump` |
| `vpn` | `wireguard-tools`, `strongswan-swanctl`, `strongswan-pki`, `strongswan-charon`, `openvpn`, `sstp-client`, `ppp`, `xl2tpd`, `pppoe`, `ike-scan` |
| `routing` | `bird2`, `lldpd`, `ndisc6`, `arping`, `arp-scan`, `nftables`, `conntrack`, `nmap` |
| QEMU Linux guest under `labs` | FRR, keepalived, a FreeRADIUS server |
| not shipped | `pptp-linux` (legacy), `zerotier-one` (not in Debian main), `smbclient` (large Samba dependencies), `snmptrapd` (port 162 needs bind privilege; use a uvx `pysnmp` receiver), `eapoltest` and `ntpsec-ntpdate` (on request) |

Core gets only small user-space clients. With dependencies, their image
layer measured 29.3 MB uncompressed on amd64. The largest are `snmp` (9 MiB
with libsnmp and `pci.ids`) and `bind9-dnsutils` (6 MiB), per the apt
estimates in the [cost data](docs/research/2026-11-05/network-package-costs-amd64.json).
Apart from ping, they work without extra privileges. centrs already covers MikroTik
btest, MNDP, MAC-Telnet and RoMON.

`routing` is its own group rather than part of `labs`. `labs` is about
565 MiB of QEMU and firmware with one readiness contract: quickchr can boot
a CHR. The routing peers are a few MiB, and they are most useful without
QEMU, peering with the host router from a privileged container. Folding
them into `labs` would make a small router download QEMU to get `bird`. It
would also mix tools that need `CAP_NET_RAW`/`CAP_NET_ADMIN` into a group
that works unprivileged. `nftables` and `conntrack` join `routing` for the
same reason: they are Linux router tools that need `CAP_NET_ADMIN`.

#### Roadmap

`dev` and `capture` already install as persistent payloads under `/data` in
the background, after T3 starts, and reuse compatible payloads across image
replacements. `vpn` and `routing` are small enough (about 4 MB and 9 MB
compressed) that baking them into the image and gating them by PATH is the
measured alternative; see the
[spike write-up](docs/research/2026-11-06/capture-native-bundle.md). Groups that are baked in today
move out only after their persistent replacement is proven. See the
[review brief](docs/research/2026-11-05/REVIEW.md) and
[issue #5](https://github.com/tikoci/app-t3code/issues/5). Automatic
upstream-release and security delivery is tracked in
[issue #6](https://github.com/tikoci/app-t3code/issues/6). `uv`/`uvx` are
approved Python bootstrap additions; neither is installed yet.

### Bun and RouterOS tools for agents

The image includes [Bun 1.4.4](https://bun.sh/docs/installation), `bunx`, and
global installations of:

- [`@tikoci/quickchr@next` — README](https://github.com/tikoci/quickchr/blob/main/README.md): create disposable RouterOS CHR labs. QEMU for x86 and ARM64, `qemu-img`, and ARM64 UEFI firmware are included.
- [`@tikoci/centrs@next` — README](https://github.com/tikoci/centrs/blob/main/README.md): inspect and drive RouterOS through validated commands and structured results.

They are available to agents and login shells without a first-run install:

```sh
bun --version
quickchr --help
centrs explain '/ip/address print' --json
muse --version
```

QEMU can use software emulation inside a RouterOS container. KVM acceleration
requires an accessible `/dev/kvm` and host support; installing quickchr does
not grant it. Size lab storage and memory for both T3 and any guest routers.

Image-owned Bun packages live in `/opt/bun`; user
[`bun install --global`](https://bun.sh/docs/pm/cli/add#global) packages live
in `/data/.bun`. PATH searches `/data/.local/bin`, `/data/.bun/bin`, then
`/opt/bun/bin` before system tools. User-installed overrides persist and take
precedence after an image upgrade. Build arguments `BUN_VER`, `QUICKCHR_VER`,
and `CENTRS_VER` can select specific releases instead of the defaults.

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
bun run test           # offline: /app YAML contract and the npm/deb payload lifecycles
APP_T3CODE_INTEGRATION=1 bun test test/integration/
# Build the image, then prove the tools and container-replacement persistence:
docker build -t app-t3code:test .
APP_T3CODE_DOCKER_IMAGE=app-t3code:test bun test test/container-replacement.test.ts
```

The integration test boots a real CHR per arch with
`@tikoci/quickchr@next`, drives it with `@tikoci/centrs@next`, and
asserts the web UI answers with the expected `serverVersion`:

```sh
APP_T3CODE_ROS=stable APP_T3CODE_ARCH=arm64 APP_T3CODE_INTEGRATION=1 \
  bun test test/integration/
```

The Docker replacement test removes the original container and starts a new
one with only the same home volume. It installs the `dev` and `capture`
payloads under `all`, runs the capture tools as the unprivileged user
([test/capture-tools.sh](test/capture-tools.sh)), and relinks both payloads in
later containers, including with no network. It checks tool discovery in
ordinary and login shells, a real T3 project record and environment identity, settings
(including the restarted server's effective preference through read-only MCP),
uncommitted worktree/project files, and a user-installed Bun CLI. CI runs
this against the built x86 image before publishing, and builds both image
architectures. It does not authenticate providers or run paid model requests.

Manual CHR 7.25.1 checks also confirmed the `/data` mount, node UID 1000,
T3 0.1.6's web endpoint, and project/environment identity through an in-place
`/app update`. The unchanged registry digest retained the root filesystem;
the Docker test proves full replacement. Separately, a fixture written
through `/data` remained on the app disk after disable and container removal,
but disappeared after assigning YAML, including a comment-only change with
the original container still present. This is a reproduced destructive path;
the original agent's precise upgrade commands are unknown.

Both helpers float on `next` on purpose: if a helper breaks, report it
to [centrs](https://github.com/tikoci/centrs/issues) /
[quickchr](https://github.com/tikoci/quickchr/issues) instead of
working around it silently. CI (`ci.yml`) lints, tests, and builds
both arches to GHCR; `integration.yml` runs the CHR matrix weekly,
post-push on `app/` + `test/integration/`, and on demand.

The `pages.yml` workflow publishes only tracked `*.md`, `*.tikapp.yaml`, and
`*.tikappstore.yaml` files, preserving their paths and contents. Automatic
deployments run only when those files change on `main`; manual dispatch is
also available. Pages must use **GitHub Actions** as its publishing source
in the repository's **Settings → Pages**. No site generator is used.

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
