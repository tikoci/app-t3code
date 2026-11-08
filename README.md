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

[See in /app YAML Editor](https://tikoci.dev/restraml/tikapp.html?version=latest&yaml=%23+yaml-language-server%3A+%24schema%3Dhttps%3A%2F%2Ftikoci.dev%2Frestraml%2Frouteros-app-yaml-schema.latest.json%0A%23+tikoci%2Fapp-t3code+%E2%80%94+RouterOS+%2Fapp+definition+for+the+T3+Code+server.%0A%23%0A%23+Install+on+the+router+%28production%2C+HTTPS+via+%2Fip%2Fcloud+or+your+own+domain%29%3A%0A%23+++%2Fapp%2Fadd+yaml%3D%3Ccontents-of-this-file%3E+use-https%3Dyes%0A%23+On+CHR+%28including+tikoci%2Fquickchr+labs%29%2C+use+use-https%3Dno+instead.%0A%23%0A%23+Image+tags+track+upstream+T3+Code+stable+releases+only+%28no+nightlies%29%3A%0A%23+ghcr.io%2Ftikoci%2Fapp-t3code%3A%3CT3CODE_VER%3E+with+%3A0.1+%2F+%3A0+%2F+%3Alatest+as%0A%23+stability+aliases.+Pin+the+full+version+in+production%3B+%3A0.1+follows%0A%23+patch+releases.%0A%0Aname%3A+t3code%0Adescr%3A+T3+Code+server+%E2%80%94+agentic+coding+in+the+browser+%28GHCR+build+for+RouterOS%29%0Apage%3A+https%3A%2F%2Fgithub.com%2Ftikoci%2Fapp-t3code%0Acategory%3A+development%0Aurl-path%3A+%2F%0Aservices%3A%0A++t3code%3A%0A++++image%3A+ghcr.io%2Ftikoci%2Fapp-t3code%3A0.1%0A++++ports%3A%0A++++++-+%223773%3A3773%3Aweb%3Atcp%22%0A++++environment%3A%0A++++++HOME%3A+%2Fdata%0A++++++T3CODE_HOME%3A+%2Fdata%2F.t3%0A++++++T3CODE_HOST%3A+0.0.0.0%0A++++++T3CODE_PORT%3A+%223773%22%0A++++++T3CODE_TELEMETRY_ENABLED%3A+%22false%22%0A++++++%23+Optional+tool+groups%2C+installed+into+%2Fdata+in+the+background+after%0A++++++%23+start.+Remove+names+to+skip+them%3B+%22none%22+is+core+only.+On+an+installed%0A++++++%23+app+change+this+with+%2Fapp%2Fset+environment%3D+%28README%29%2C+never+yaml%3D.%0A++++++T3CODE_TOOL_GROUPS%3A+%22capture+labs+vpn+routing+dev%22%0A++++volumes%3A%0A++++++%23+Keep+this+name+and+destination+when+upgrading%3A+the+whole+home%2C%0A++++++%23+including+.t3%2Fuserdata%2C+projects%2C+worktrees%2C+and+provider+logins.%0A++++++-+t3code-data%3A%2Fdata%0A++++restart%3A+unless-stopped%0Avolumes%3A%0A++t3code-data%3A+%7B%7D%0A) to inspect, validate, or customize
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
The image is about 0.8GB compressed and 3GB extracted (amd64 build,
2026-11-07). The default tool groups add about 0.7GB in `/data` after the
first start (see [Optional tool groups](#optional-tool-groups)), and up to
about twice that after an image update that refreshes them, because the
previous payloads are kept until `t3code-tools prune`. Allow at
least an 8GB app disk, plus space for projects, browser downloads, and any
quickchr lab disks. Builds need extra space for intermediate layers and
loading the finished image.

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
[storage cleanup settings](https://github.com/pingdotgg/t3code/blob/v0.1.7/docs/user/project-settings.md#storage-cleanup)
to manage disk use. The paths above are grounded in upstream's
[server path definitions](https://github.com/pingdotgg/t3code/blob/v0.1.7/apps/server/src/config.ts)
and [workspace folders](https://github.com/pingdotgg/t3code/blob/v0.1.7/docs/user/thread-sidebar.md).

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
| `T3CODE_TOOL_GROUPS` | `capture labs vpn routing dev` (image default and YAML) | optional tool groups; remove names to skip them, `none` for core only; see [below](#optional-tool-groups) |
| `UV_PYTHON_DOWNLOADS` | `manual` (image default) | uv uses the image's Python 3 and downloads another only on `uv python install` |
| `PUBLIC_URL` | unset | base URL baked into pairing links |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | inherited | agents see container env |
| `T3CODE_*` | passthrough | e.g. `T3CODE_SERVER_BROWSER_SANDBOX=0` |

Provider CLIs in this image:

| Provider | How it arrives | Updates |
|---|---|---|
| Codex (`codex`) | npm global in the image (`/usr/local`) | with each image replacement |
| opencode (`opencode`) | npm global in the image (`/usr/local`) | with each image replacement |
| Claude Code (`claude`) | downloaded in the background at the first start into `/data/.local/bin`, SHA256-checked against Anthropic's manifest (its license forbids redistributing it, so it cannot be baked in); skipped when a `claude` is already on PATH | not by image updates: it lives in the home |
| [Meta Muse Code](https://dev.meta.ai/docs/muse-code) (`muse`) | **not bundled** since the final #5 slice (it added about 396 MiB to every image) | — |

T3's own provider drivers are unchanged, including Muse's. To use Muse,
run Meta's [installer](https://dev.meta.ai/docs/muse-code) from a T3
terminal. Its default install directory is `$HOME/.local/bin`, which is
`/data/.local/bin` here: first on PATH and kept across image replacement.
Muse configuration, logins and history already in `/data` stay where they
are; an image update removes only the binary the image used to carry. Run `muse` to authenticate, or supply `META_API_KEY`. Provider
logins and sessions for every harness live in the home.

Do not assume that upstream T3 Code installs the same provider set as this
image. A per-harness selector (one explicit token per supported harness, a
separate ENV control), late installation and rediscovery, authentication and
active-session behavior are
[issue #13](https://github.com/tikoci/app-t3code/issues/13); this image
keeps the delivery above until then.

### Installed package inventory

The image includes Debian command-line basics (`bash`, `awk`, `sed`, `grep`,
`find`, `diff`, `tar`, `gzip`), Git/SSH, the GitHub CLI (`gh`), curl, jq,
ripgrep, make, the `sqlite3` CLI, Python 3 with
[uv](https://docs.astral.sh/uv/) and `uvx`, and Node.js/npm in addition to
the agent and RouterOS tools below. This is a selected toolset; `make` does
not imply a C/C++ compiler, and other language SDKs are out of scope. The
native libraries for T3's built-in browser are core too (T3 downloads the
browser itself on first use).

`gh` enables T3's GitHub source-control provider. Log in once with
`gh auth login` from a T3 terminal, or set `GH_TOKEN`. The container has no
keyring, so `gh auth login` stores the token in a file under gh's default
config directory, `/data/.config/gh`, which survives image replacement. If
you set `GH_CONFIG_DIR`, keep it under `/data`, or the login is lost on the
next update. T3's other providers
(GitLab, Forgejo/Gitea, Azure DevOps, GitCafe) need CLIs this image does not
bundle yet; see [issue #15](https://github.com/tikoci/app-t3code/issues/15).
Plain `git` over HTTPS or SSH works with any forge.

Python has no pip or `python3 -m venv`; use uv instead. `uv venv` and
`uv sync` create project environments with the image's Python, `uvx <tool>`
runs a Python CLI in an isolated environment, and `uv tool install` puts its
command in `/data/.local/bin`. uv's cache (`/data/.cache/uv`) and tool
environments (`/data/.local/share/uv/tools`) are in the home, so they survive
image replacement. `UV_PYTHON_DOWNLOADS=manual` keeps uv from fetching a
managed Python unless you run `uv python install`. A venv built against one
Python minor version may need recreating after an image update changes it.
The image pins uv with the `UV_VER` build argument.

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
use spaces on a router. Names are case-insensitive. An unknown name is
logged as a warning and ignored. T3 always starts, whatever the selection
says.

| Value | Selects |
|---|---|
| `capture labs vpn routing dev` | the default: every current group, as an explicit list (the image `ENV` and the YAML both set it) |
| unset or empty | the same default (a key dropped by `/app/set environment=` falls back to it) |
| a shorter list, e.g. `"capture labs"` | only those groups |
| `none` | core only |
| `all` | every group, **including groups added in later images** |

The default is a list rather than `all` so that a group added in a later
image never starts downloading on an existing install by itself: you opt in
by adding its name. Remove names to skip groups.

All five groups are delivered as persistent payloads in the home (`dev` from
npm, the others from Debian packages; see
[Persistent payloads](#persistent-payloads)). They install one at a time in
the background after T3 starts. With the default, the first start downloads
about 120 MiB (about 75 MiB of `.deb` files plus the `dev` npm packages) and
needs roughly 660 MiB more in `/data` once all five are installed (amd64
measurements in the table below), plus 256 MiB of headroom while installing.
After an image update that changes the package pins, the refreshed payloads
install next to the previous ones, which are kept (an offline fallback)
until `t3code-tools prune`: budget about twice that. On a fast
link that takes a few minutes; at 1 Mbit/s plan for about 15 minutes. With
too little space a group fails with a `low disk` error and T3 keeps
running.

> [!IMPORTANT]
> **Upgrading from an image before the five-group default.** Older images
> treated an unset `T3CODE_TOOL_GROUPS` as core only. After `/app/update` to
> this image, an install that never set the key starts downloading all five
> groups in the background. To keep core only, set `none` first (see
> [Changing groups on RouterOS](#changing-groups-on-routeros)); the setting
> survives `/app/update`. Never reapply the YAML to change it.
>
> The same update removes the bundled `muse` binary. Muse logins and history
> in `/data` stay; install Muse into the home again to keep using it (see
> [Environment and providers](#environment-and-providers)).

`browser` and `agents-extra` are no longer groups. T3's browser libraries
are core, and the provider CLIs are described in
[Environment and providers](#environment-and-providers). A selection that
still names them logs an unknown-group warning and otherwise works.

| Group | Contents | Download → on disk (amd64, this image's locks) |
|---|---|---|
| `capture` | tcpdump, TShark (`dumpcap`, `capinfos`, `editcap`, `mergecap`, `text2pcap`), nfdump (`nfcapd`) | 31.1 MiB → 156 MiB (46 packages) |
| `labs` | quickchr, QEMU x86/ARM64 emulators, qemu-img, SeaBIOS and ARM64 UEFI firmware | 32.7 MiB → about 309 MiB after pruning firmware (32 packages); quickchr is in the image |
| `vpn` | WireGuard tools (`wg`, `wg-quick`), strongSwan (`pki`, `swanctl`, charon), OpenVPN, ike-scan; no tunnel or service starts by default | 3.6 MiB → 12 MiB (15 packages) |
| `routing` | BIRD 2 (`bird`, `birdc`), ndisc6, arping, arp-scan, nftables, conntrack, nmap | 8.3 MiB → 33 MiB (21 packages) |
| `dev` | TypeScript, CSpell, markdownlint-cli2 and Biome fallbacks; project lockfiles win | npm packages → about 154 MiB |

Installing a tool does not grant the privileges to use it, and a group
being `ready` means its files are installed and load, not that every
operation is allowed. Live capture, raw-socket peers, tunnels and firewall
changes need capabilities or devices that a RouterOS container may not have;
see [Privileges by tool](#privileges-by-tool). Each group's `privileges`
field (and `core.privileges`) in the status output says the same. Granting
them is an operator deployment choice: nothing in this image changes RouterOS
settings, starts a privileged helper, or ships an alternate YAML.

At a glance, by what the operation needs beyond installation:

| Needs | Core | `capture` | `labs` | `vpn` | `routing` | `dev` |
|---|---|---|---|---|---|---|
| Nothing | client tools, UDP traceroute, `ip`/`ethtool` queries | capture files, `dumpcap -D`, `nfcapd` ≥1024 | TCG guests, user networking, `qemu-img` | keys, certificates, `ike-scan --sport=0` | BIRD ≥1024, `nmap -sT`, ARP decode from files | everything |
| `CAP_NET_RAW` | `traceroute -T`/`-I`, `radsniff` live, `mtr` (bounding set), `ping` without `ping_group_range` | live capture | — | — | ARP/ND probes, raw scans, OSPF | — |
| `CAP_NET_ADMIN` | `ip`/`ethtool` changes | — | TAP (with `/dev/net/tun`) | WireGuard and OpenVPN tunnels (OpenVPN with `/dev/net/tun`) | `nft`, `conntrack`, kernel route sync | — |
| `CAP_NET_BIND_SERVICE` (ports <1024, where restricted) | low-port listeners | — | — | `ike-scan` source port 500 | BGP on 179 | — |
| A device | — | — | `/dev/kvm` for acceleration | `/dev/net/tun` for OpenVPN | — | — |
| Root | — | — | — | `wg-quick`, charon | — | — |

RouterOS 7.25 added a per-service privileged mode to app YAML. That is a
deployment control; which effective capabilities the non-root app process
then receives, and which devices and kernel features a given router
provides, is unproven and tracked in
[#7](https://github.com/tikoci/app-t3code/issues/7).

#### Privileges by tool

The app runs as `node` (UID 1000) with no capabilities. "None" means the
operation works that way. Other entries name what it needs: a host or
namespace setting (such as `net.ipv4.ping_group_range` for `ping`), a
capability, a device, or root. Most of those mean a privileged container.
Whether RouterOS can provide any of them is
[#7](https://github.com/tikoci/app-t3code/issues/7). **Tested** means
run here as `node` with `CapEff 0` under Docker (habitat C): *works* or
*refused* (with a permission error). *Expected* means not demonstrated.

| Where | Tool / operation | Needs | Tested |
|---|---|---|---|
| core | `dig`, `whois`, SNMP, RADIUS (`radclient`) and MQTT clients, `curl`, `ssh`, `centrs` | None | expected |
| core | `nc`, `socat`, `iperf3` | None on ports ≥1024; `CAP_NET_BIND_SERVICE` below that where the namespace restricts it | expected |
| core | `ip`, `ethtool` | None to query; `CAP_NET_ADMIN` to change anything | expected |
| core | `traceroute` (UDP, default) | None | expected |
| core | `traceroute -T`/`-I` | `CAP_NET_RAW` | refused |
| core | `ping` | ICMP echo sockets allowed by `net.ipv4.ping_group_range` (Docker allows all groups); otherwise `CAP_NET_RAW`. The image's `ping` has no file capability | works under Docker |
| core | `mtr` | Its helper `mtr-packet` has a `cap_net_raw` file capability: `CAP_NET_RAW` must be in the container's bounding set | works under Docker |
| core | `radsniff` (from `freeradius-utils`) | None for files; `CAP_NET_RAW` to capture | refused |
| `capture` | `tshark -r`, `tcpdump -r`, `capinfos`, `editcap`, `mergecap`, `text2pcap`, `nfdump`, `dumpcap -D` | None | works |
| `capture` | `nfcapd` on a port ≥1024 | None | works (NetFlow v5) |
| `capture` | `tcpdump -i`, `dumpcap -i`, `tshark -i` | `CAP_NET_RAW` | refused |
| `vpn` | `wg genkey`/`pubkey`, `pki` keys/CA/certificates, `openvpn --genkey`, `ike-scan --sport=0` | None | works |
| `vpn` | `swanctl` | A running charon's VICI socket | no charon (reported, not refused) |
| `vpn` | WireGuard interface (`ip link add … type wireguard`, `wg set`) | `CAP_NET_ADMIN` and the kernel module (no `/dev/net/tun`) | expected |
| `vpn` | `wg-quick up` | **Root**: it re-runs itself with `sudo`, which the image lacks | fails as `node` (`sudo: not found`) |
| `vpn` | OpenVPN tunnel | `CAP_NET_ADMIN` and `/dev/net/tun` | expected |
| `vpn` | charon (IKE daemon) | **Root**; shipped but not wired or proven | expected |
| `vpn` | `ike-scan` default source port 500 | `CAP_NET_BIND_SERVICE` where ports below 1024 are restricted | expected |
| `routing` | `bird -p`, BGP on ports ≥1024, `birdc` on its socket | None | works (eBGP prefix exchange) |
| `routing` | BGP on port 179 | `CAP_NET_BIND_SERVICE` where ports below 1024 are restricted (Docker sets `ip_unprivileged_port_start=0`) | expected |
| `routing` | BIRD OSPF; kernel route sync | `CAP_NET_RAW`; `CAP_NET_ADMIN` | expected |
| `routing` | `nmap -sT`, NSE script data | None | works |
| `routing` | `nmap -sS` and other raw scans, raw NSE scripts | `CAP_NET_RAW` | refused (`-sS`) |
| `routing` | `arping`, `arp-scan` on an interface | `CAP_NET_RAW` | refused |
| `routing` | `arp-scan --readpktfromfile` (decode a capture, with vendor names) | None | works |
| `routing` | `rdisc6`, `ndisc6` | `CAP_NET_RAW` | expected |
| `routing` | `nft` (even `nft -c`), `conntrack -L` | `CAP_NET_ADMIN` and netfilter netlink | refused |
| `labs` | quickchr / QEMU with TCG and user networking, `qemu-img` | None | works (CHR 7.25.1 x86 and arm64 guests booted from the payload on amd64; ARM64 firmware discovery shipped in [quickchr 0.5.6](https://github.com/tikoci/quickchr/releases/tag/v0.5.6)) |
| `labs` | KVM acceleration | `/dev/kvm` readable and writable by `node`, and host support | fails without the device under Docker ("Could not access KVM kernel module"); untested with one |
| `labs` | TAP networking | `CAP_NET_ADMIN` and `/dev/net/tun` (or a TAP pre-created for `node`) | fails without the device under Docker (`could not open /dev/net/tun`); untested with one |
| core | T3's built-in browser sandbox | User namespaces, if the host allows them | expected |
| core | Provider CLIs (`codex`, `opencode`, `claude`) | None | expected |
| `dev` | everything | None | works |

Tools changed or moved because of privileges, not size:

- **Moved to a Linux guest under `labs`**: `pppd`, `xl2tpd`, `sstpc`,
  `pppoe` and `lldpd`. They cannot work from a payload under `/data` even
  in a privileged container. Selecting `labs` does not create that guest or
  install them: boot a Linux VM with QEMU yourself, then install them in it
  with its own package manager (as root, in the guest). `pppd` needs root and reads `/etc/ppp/options`
  before its arguments. `xl2tpd` and `sstpc` start `/usr/sbin/pppd` by a
  compiled-in path. `lldpd` needs root and a `_lldpd` user for privilege
  separation (`no _lldpd user for privilege separation`).
- **Shipped, but needs root**: `wg-quick` and charon. As `node`, use `wg`
  with `ip link` for WireGuard, and `pki` for IKEv2 certificates.
- **Unprivileged defaults in tests and docs**: `ike-scan --sport=0`, BIRD
  BGP on ports ≥1024, `nmap -sT`, NetFlow collection on ports ≥1024.
- **Readiness does not depend on privileges**: `nft` and `conntrack` open
  a netfilter netlink socket even for `--version`. If a kernel (or QEMU
  user-mode emulation) lacks it, their probe still counts the tool as
  loaded, so one missing kernel feature does not fail `routing`.

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
| `installing` | The background installer is working on it, including waiting to retry (`retrying at …` in `t3code-tools status`) |
| `ready` | Selected, and every check passed |
| `failed` | Selected, and checks failed for tools the image should provide, or the last install failed and nothing usable is active |
| `not-implemented` | Selected, but this image has no way to provide the group yet (no group today) |

The selector reports `defaulted: true` when an unset or empty value selected
the default list.

Checks are presence probes (PATH, files, `ldconfig`), not functional tests.
Payload groups are checked at their own shims and manifest instead, so the
result does not depend on the caller's PATH.
`labs` never boots a CHR to check readiness; its install-time smoke tests
boot firmware only (SeaBIOS to "No bootable device", and a 16-byte aarch64
program that powers the machine off). For a payload group, a file check is a
path inside the payload, reported through `groups/<group>/current/root/…`.
Core checks (`t3`, Node, Bun,
Python with uv/uvx, sqlite3, Git/SSH, `gh`, centrs, the core network tools, the
baked `codex` and `opencode`, and the browser's native libraries) are
reported separately as `core.state`. At each start the entrypoint logs warnings and a summary to
the container log and writes the same JSON to `/tmp/t3code-tools/status.json`.
The output also points at the immutable build inventory in
`/usr/share/t3code/inventory`.

#### Persistent payloads

A payload group installs into the home volume, not the image, so it costs
nothing in the image (it downloads only while selected) and survives image
replacement and `auto-update`.
`dev` is built from an npm lockfile; `capture`, `labs`, `vpn` and `routing`
from pinned Debian packages (see
[Debian-package payloads](#debian-package-payloads)). All share the same
lifecycle:

- **Start never waits.** At each start the entrypoint relinks payloads that
  are already in the home (offline, no download) and then runs
  `t3code-tools install` in the background. T3 is serving while a first
  install is `pending` or `installing`.
- **Pinned and verified.** For `dev`, the image ships the group's
  `package.json` and `package-lock.json` (with npm integrity hashes); the
  installer runs `npm ci --ignore-scripts` from them. Each command must answer
  `--version` (or its group's declared probe) before the payload gets a
  `manifest.json` and is activated. The Debian groups also run functional
  smoke tests: `capture` decodes a test capture, `vpn` generates a strongSwan
  key and a WireGuard key, `routing` loads nmap's NSE help and parses a BIRD
  BGP config. A payload without a manifest is never trusted.
- **Versioned and atomic.** The payload id is derived from the lock and the
  runtime: CPU architecture and Node's module ABI for `dev`, dpkg
  architecture and Debian release for the Debian groups. Payloads live in
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
  dies; the next run also stops an npm or dpkg-deb left behind by a killed
  installer before reclaiming its files). Retries run in rounds: each
  round tries every group still missing once, so one failing group never
  holds up the others, and the lock is released while waiting (a round
  that finds it taken, say by a prune, waits and tries again without using
  an attempt). The
  entrypoint's background run (`install --keep-trying`) keeps retrying for
  about a day (15 s, 1, 5, 15 and 30 minutes, then hourly), because a router
  often starts the container before its uplink or DNS is up; verified
  `.deb` files are kept between attempts. Each attempt is capped at 30
  minutes. `t3code-tools install` from a terminal makes three attempts in
  about 75 s. The installer needs room for the
  payload and its downloads (for `dev`, twice the payload size; for the
  Debian groups, the pinned `.deb` sizes not already verified in the cache,
  plus their unpacked sizes) plus 256 MiB,
  and otherwise fails with a `low disk` error rather than filling the
  volume. It never deletes projects, VMs or other home data. Interrupted
  installs (`.staging-*`) are removed on the next run.
- **Deselecting** a group removes its shims at the next start but keeps its
  payload, so selecting it again needs no download. `t3code-tools prune`
  deletes payloads that no selected group uses, and any kept `.deb`
  downloads. Switching to `none` therefore frees no space until you run
  `t3code-tools prune` in a T3 terminal; prune touches only
  `/data/.local/share/t3code-tools`.

`t3code-tools status --json` reports `payload.desired`, `payload.active`,
`stale`, `installed`, the verified `activeVersions` and the last installer
result with its error. The installer log is
`/data/.local/share/t3code-tools/install.log`. Run `t3code-tools install` in
a terminal to retry now, including while the background installer waits;
otherwise the next start retries a group that ran out of attempts.
`t3code-tools help` is the command reference (commands, selection syntax,
files, exit codes). `install`, `prune` and `init` run as the home's owner:
started as root (for example from RouterOS `/container/shell`), they
re-execute as `node` with `setpriv`, so no payload file becomes root-owned.

The `dev` payload is about 154 MiB on amd64 (TypeScript 7.0.2, CSpell 10.4.0,
markdownlint-cli2 0.24.0, Biome 2.6.5). Maintainers refresh the pins with
`make dev-lock` after editing `scripts/groups/dev/package.json`.

#### Debian-package payloads

`capture` is too big to bake into every image (about 157 MB more on disk and
42 MB more to pull on every image update, measured on amd64), so it is a
payload too. `vpn` and `routing` are smaller, but use the same machinery
rather than adding 13 MB to every image pull for routers that never select
them ([write-up](docs/research/2026-11-06/vpn-routing-payloads.md)). `labs`
took 565 MiB of QEMU and firmware out of every image
([write-up](docs/research/2026-11-06/labs-qemu-payload.md)). Each installs as
the app user with no root at runtime:

- **Pinned at image build.** The Dockerfile runs `t3code-tools deb-lock` after
  the last apt layer. It asks apt for the group's dependency closure that the
  image does not already have, and records each package's version,
  architecture, size and SHA256 from the apt indexes. apt has already checked
  those indexes against Debian's signing keys. The lock is
  `/usr/local/lib/t3code/groups/<group>/debs.lock.json` (also in the build
  inventory as `<group>-debs.lock.json`). Every image rebuild picks up Debian
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
  downloads survive an interrupted install in `groups/<group>/.cache-debs`,
  so a slow link resumes rather than starting over. They are removed once
  the payload is ready.
- **No global library path, no `/usr` overlay.** Each command gets a small
  wrapper in the payload's `bin/` that sets `LD_LIBRARY_PATH` to the
  payload's own library directory for that process and its children only,
  then runs the real binary from the payload. The payload holds only
  packages the image lacks, so it does not replace the image's copies. If
  apt would upgrade one of a group's root packages (for `capture`: `tcpdump`,
  `tshark`, `wireshark-common` or `nfdump`) already in the image, lock
  generation fails: update that image package before rebuilding. An older tool answering `--version` is not proof
  that its security update was applied. For other image dependencies, the
  lock records proposed upgrades under `imageUpgrades` and the build log
  warns, but the package is not extracted. Version probes and smoke tests
  catch a tool that cannot load at all, but they do not cover every
  operation, so a payload can be activated and still fail later for want of
  a newer image library. If `imageUpgrades` lists a library the tools use,
  rebuild the image.
  Wireshark finds its data files and plugins relative to the binary, so
  `tshark` decodes with its full dissector set, RADIUS dictionaries and
  plugins from the payload; nmap finds its NSE scripts and service names the
  same way. BIRD takes its config and socket paths as arguments
  (`bird -c … -s …`, `birdc -s …`); the image has no `/etc/bird` or
  `/run/bird`. strongSwan only knows compiled-in paths
  (`/etc/strongswan.conf`, `/usr/lib/ipsec/plugins`), so the wrappers of
  `pki`, `swanctl` and `pt-tls-client` default `STRONGSWAN_CONF` and
  `SWANCTL_DIR` to the payload's copies (set either yourself to use your own
  config; put it outside the payload, which a refresh replaces) and
  `LD_PRELOAD` the payload's plugins by file name. Only plugins that
  load against libstrongswan alone are preloaded (the crypto, encoding and
  credential ones; checked at install time and recorded in the manifest
  under `deb.wired`); strongSwan finds a preloaded plugin by symbol before
  it searches its plugin directory. Like a stock Debian install, `pki` and
  `swanctl` still print `failed to load` lines for plugins Debian builds
  elsewhere or that need charon. `arp-scan` only looks for its vendor files
  in the current directory and at compiled-in paths, so its wrapper passes
  the payload's `--ouifile` and `--macfile` first; your own options come
  later and win. Debian's QEMU looks for its BIOS, option ROMs and keymaps
  only in directories compiled into it (`/usr/share/qemu`,
  `/usr/share/seabios`, `/usr/lib/ipxe/qemu`), so the wrappers of the
  `qemu-system-*` emulators pass the payload's copies with `-L` first (QEMU
  searches `-L` dirs in order, so a `-L` of your own comes after them) and
  default `QEMU_MODULE_DIR` to the payload's module directory (display, USB
  and virtio-gpu modules). quickchr finds the ARM64 UEFI images by asking
  that QEMU for its data dirs (`qemu-system-aarch64 -L help`, shipped in
  [quickchr 0.5.6](https://github.com/tikoci/quickchr/releases/tag/v0.5.6),
  available on `@next`). Images built with older quickchr need rebuilding
  to gain ARM64 guest support with this payload. A group
  can also prune files it never uses after extraction: `labs` drops the
  secure-boot AAVMF variants (four 64 MiB images) and keeps the pair quickchr
  boots (`AAVMF_CODE.fd`, `AAVMF_VARS.fd`). The prune list is part of the
  payload id and recorded in the manifest under `deb.pruned`. A payload
  command never shadows a command of the
  same name in the image, including one the image gains later. A required
  command that the image already provides (`quickchr` in `/opt/bun/bin`) is
  checked and used from the image.
- **Stale native payloads are checked.** While a refresh is pending after an
  image update, the previous payload stays linked only if every required
  command it still provides passes its version probe against the new image.
  Commands now provided by the image use the image copy instead.

Measured on amd64 (habitat C, Debian trixie, Wireshark 4.4.19, tcpdump
4.99.5, nfdump 1.7.5): 42 packages, 30.5 MiB to download, 152 MiB unpacked,
about 5 s to install on a fast link (computed: about 4.3 minutes at 1 Mbit/s). Wrapper
overhead is about 1 ms per command. On arm64 the same code installed and
passed the decoding, capture-file and NetFlow checks under QEMU user-mode
emulation on an amd64 host. That is not native hardware, and interface
listing and the live-capture refusal could not be tested there. See the
[spike write-up](docs/research/2026-11-06/capture-native-bundle.md).

Measured on amd64 for the other two (same image): `vpn` is 14 packages, 3.5
MiB to download and 11.4 MiB on disk; `routing` is 21 packages, 8.3 MiB and
32.5 MiB. `labs` is 32 packages, 32.7 MiB to download, 564 MiB unpacked and
309 MiB on disk after pruning 256 MiB of firmware, about 6 s to install on a
fast link (computed: about 4.6 minutes at 1 Mbit/s). Removing QEMU from the
image also moved a few libraries it used to supply into the `capture` and
`vpn` closures, so homes with those payloads download them once more after
that image update.

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

`vpn` and `routing` grant nothing either. Without privileges, the strongSwan
`pki` CA and certificate workflow (the same certificates RouterOS IKEv2
imports), WireGuard and OpenVPN keys, `ike-scan --sport=0`, a BIRD BGP
session on ports of 1024 or above (two BIRDs exchanged a prefix over eBGP on
loopback), and nmap connect scans all work. The rest is in
[Privileges by tool](#privileges-by-tool), including the PPP peers and
`lldpd`, which moved to a Linux guest you provision under `labs`.

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
| `vpn` | `wireguard-tools`, `strongswan-swanctl`, `strongswan-pki`, `strongswan-charon`, `openvpn`, `ike-scan` |
| `routing` | `bird2`, `ndisc6`, `arping`, `arp-scan`, `nftables`, `conntrack`, `nmap` |
| A Linux guest you boot under `labs` and provision yourself (not shipped) | FRR, keepalived, a FreeRADIUS server, `lldpd` (needs root and a `_lldpd` user), and the PPP-based peers `sstp-client`, `ppp`, `xl2tpd`, `pppoe` (they need root and `/usr/sbin/pppd`) |
| not shipped | `pptp-linux` (legacy), `zerotier-one` (not in Debian main), `smbclient` (large Samba dependencies), `snmptrapd` (port 162 needs bind privilege; use a uvx `pysnmp` receiver), `eapoltest` and `ntpsec-ntpdate` (on request) |

Core gets only small user-space clients. With dependencies, their image
layer measured 29.3 MB uncompressed on amd64. The largest are `snmp` (9 MiB
with libsnmp and `pci.ids`) and `bind9-dnsutils` (6 MiB), per the apt
estimates in the [cost data](docs/research/2026-11-05/network-package-costs-amd64.json).
Ordinary client use needs no privileges, with two exceptions worth knowing:
`ping` relies on ICMP echo sockets being allowed (`net.ipv4.ping_group_range`)
and `mtr` on a `cap_net_raw` file capability; see
[Privileges by tool](#privileges-by-tool). centrs already covers MikroTik
btest, MNDP, MAC-Telnet and RoMON.

`routing` is its own group rather than part of `labs`. `labs` is about
310 MiB of QEMU and firmware (a 33 MiB download) with one readiness
contract: quickchr can boot a CHR. The routing peers are a few MiB, and they are most useful without
QEMU, peering with the host router from a privileged container. Folding
them into `labs` would make a small router download QEMU to get `bird`. It
would also mix tools that need `CAP_NET_RAW`/`CAP_NET_ADMIN` into a group
whose default mode (TCG, user networking) needs no privileges. `nftables` and `conntrack` join `routing` for the
same reason: they are Linux router tools that need `CAP_NET_ADMIN`.

#### Roadmap

`dev`, `capture`, `labs`, `vpn` and `routing` already install as persistent
payloads under `/data` in the background, after T3 starts, and reuse
compatible payloads across image replacements (write-ups:
[capture](docs/research/2026-11-06/capture-native-bundle.md),
[vpn and routing](docs/research/2026-11-06/vpn-routing-payloads.md),
[labs](docs/research/2026-11-06/labs-qemu-payload.md)). The image default
selects all five by name. `browser` is not a group (its libraries stay in
core, and T3's browser setup is unchanged), and provider CLIs are not a
group either: per-harness selection is
[issue #13](https://github.com/tikoci/app-t3code/issues/13). Still open
under [issue #5](https://github.com/tikoci/app-t3code/issues/5): a full image
build exercised on a CHR with Claude and Codex connected, and the labs
matrix (native ARM64 hosts, nested RouterOS, transfer, snapshots and
cleanup); see the
[final-slice notes](docs/research/2026-11-07/final-tooling-slice.md).
RouterOS privileges and devices are
[issue #7](https://github.com/tikoci/app-t3code/issues/7); automatic
upstream-release and security delivery is
[issue #6](https://github.com/tikoci/app-t3code/issues/6).

### Bun and RouterOS tools for agents

The image includes [Bun 1.4.4](https://bun.sh/docs/installation), `bunx`, and
global installations of:

- [`@tikoci/quickchr@next` — README](https://github.com/tikoci/quickchr/blob/main/README.md): create disposable RouterOS CHR labs. QEMU for x86 and ARM64, `qemu-img`, and the firmware come with the `labs` group, not the image.
- [`@tikoci/centrs@next` — README](https://github.com/tikoci/centrs/blob/main/README.md): inspect and drive RouterOS through validated commands and structured results.

They are available to agents and login shells without a first-run install:

```sh
bun --version
quickchr --help
centrs explain '/ip/address print' --json
uv --version
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

- `ghcr.io/tikoci/app-t3code:0.1.7` — exact release
- `ghcr.io/tikoci/app-t3code:0.1`, `:0`, `:latest` — stability aliases
- `ghcr.io/tikoci/app-t3code:sha-<commit>` — the candidate CI pushes from
  `main`; not for deployment

A `main` push publishes only the candidate. Its arm64 image then runs the
container replacement test natively on a GitHub arm64 runner (amd64 already
ran it before the push), and only then does CI move the release tags onto the
same manifest, by digest. A failed arm64 run leaves `:0.1` where it was,
and a run that finishes after `main` has moved on skips promotion, so the
tags never go back to an older build.

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
one with only the same home volume. Every container sets its selection
explicitly, except one that checks the image default. It installs the `dev`,
`capture`, `labs`, `vpn` and `routing` payloads under `all`, runs each Debian group's tools as
the unprivileged user ([capture](test/capture-tools.sh),
[labs](test/labs-tools.sh), [vpn](test/vpn-tools.sh),
[routing](test/routing-tools.sh)), and relinks the payloads in later
containers, including with no network, then relinks the image default
offline and checks that `none` leaves only core. Against an emulated (QEMU user-mode)
image, set `CAPTURE_TOOLS_QEMU_USER=1`, `ROUTING_TOOLS_QEMU_USER=1` and/or
`LABS_TOOLS_QEMU_USER=1` for the test; they are forwarded to the scripts,
which then skip only the checks emulation breaks (or makes too slow) before
any permission check. It checks tool discovery in
ordinary and login shells, a real T3 project record and environment identity, settings
(including the restarted server's effective preference through read-only MCP),
uncommitted worktree/project files, a user-installed Bun CLI, provider
configuration in the home, and that a user-installed `muse` in
`/data/.local/bin` wins on PATH. CI runs
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
working around it silently. CI (`ci.yml`) lints, tests, builds both arches,
runs the replacement test on amd64 (every build) and natively on arm64
(`main` and dispatch only), then promotes the tags (see [Tags](#tags));
`integration.yml` runs the CHR matrix weekly and on demand (against `:0.1`),
and after each successful `main` publish (against that commit's
`:sha-<commit>` candidate, via `APP_T3CODE_IMAGE`).

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
