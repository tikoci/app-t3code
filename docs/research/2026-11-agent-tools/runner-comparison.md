# Agent image packages compared with GitHub Ubuntu runners

**Evidence appendix: initial comparison.** The authoritative approved split
and review questions are in [REVIEW.md](REVIEW.md). Cost scenarios here
describe the initial small baseline; they do not put quickchr/QEMU or all
later candidates in core. The [research index](README.md) links all evidence.

Research date: **2026-11-05, America/Los_Angeles** (some captures are dated
2026-11-06 UTC). Package additions are proposals for a follow-up decision;
this change adds inventory generation and documentation only.

Discussion and embedded raw tables: [GitHub issue #5](https://github.com/tikoci/app-t3code/issues/5).

The owner accepted this baseline and refined the goal toward richer Linux
networking counterparts for RouterOS plus Node/Python/Bun development.
See the [networking and agent-tool follow-up](network-and-agent-tools.md)
for packet analysis, IPsec, protocol clients, and tsc/CSpell/Markdownlint/Biome.
Its broader networking estimate supersedes the small baseline's cost for
the expanded scope. Other general language runtimes are excluded.

The subsequent [optional tool-group design](optional-tool-groups.md) examines
ENV-selected groups, starting T3 before downloads, cache persistence across
replacement, and quickchr's complete runtime dependency contract. It is a
proposal; startup/user/YAML behavior has not been changed.

The [uv and core-scope follow-up](uv-and-core-scope.md) records the owner's
preference for persistent payloads under `/data`, proves uv/Python tools
working after an offline container replacement, and measures candidates
for the labs/browser/provider groups. Proposed group definitions are also
listed in the repository README.

## Initial baseline: measurement context

Align a small Debian command-line baseline with common GitHub runner tasks.
Keep our Debian base and its supported versions; matching Ubuntu package
versions would create work without making this a GitHub-hosted runner.

The original candidate categories were:

| Group | Packages to add | Extra installed size | Apt download |
| --- | --- | ---: | ---: |
| File, archive, patch, and script basics | `patch file bzip2 xz-utils zip zstd wget rsync tree time python-is-python3` | 19.98 MiB | 3.78 MiB |
| Network diagnostics | `iproute2 iputils-ping bind9-dnsutils netcat-openbsd socat` | 12.51 MiB | 3.79 MiB |
| Python environments | `python3-venv` | 2.82 MiB | 2.65 MiB |
| Database/byte inspection | `sqlite3 xxd bsdextrautils` | See individual costs below | See individual costs below |

The first group supports routine download/extract/patch/copy workflows.
The second provides `ip`, `ss`, `ping`, `dig`, `nslookup`, `nc`, and `socat`
for agent diagnostics and RouterOS labs. The third fixes an existing gap:
`python3` is present, but normal `python3 -m venv` fails because ensurepip is
missing. Venv support permits pip inside a project environment without
adding system-wide pip, pipx, or a second Python distribution. The fourth
adds the SQLite CLI and byte tools (`xxd`, `hexdump`, `column`) useful when
inspecting application state and protocol data.

These are independent apt scenarios against the same baseline, with
`--no-install-recommends`. Shared dependencies mean individual/group
estimates should not simply be added. The combined proposal adds **36.37 MiB
installed, 10.77 MiB of apt downloads, and 42 packages**. It is recorded as
`recommended-baseline` in [the cost data](package-costs-amd64.json).
Installed size is Debian metadata, not an OCI layer measurement. No
candidate packages were installed for these apt cost simulations. Separate
functional probes installed tools only in disposable containers, as noted
in the evidence index.

## Additional candidate costs (catalog only)

| Candidate | Extra installed size | Recommendation |
| --- | ---: | --- |
| `gh` | 33.85 MiB | Strong agent utility for GitHub work; decide explicitly. GitHub runners have it, but it is larger than the entire first group. Authentication remains user-provided. |
| `shellcheck` | 33.97 MiB | Useful shell linting, but sizeable. Consider a second wave or install per project. |
| `shfmt` | 2.79 MiB | Small optional companion for shell work; not listed in the selected runner apt tables. |
| `git-lfs` | 12.31 MiB | Include only if LFS repositories are a common target. Ordinary Git already works. |
| `gnupg` | 12.55 MiB | Optional signing/repository-key workflows. TLS downloads already have CA certificates and OpenSSL. |
| `build-essential pkg-config` | 270.19 MiB | A real portability gap for source builds and Node native addons; choose based on workloads. `make` alone is not a compiler. |
| `cmake` / `ninja-build` | 53.33 / 0.39 MiB | Follow the native-build decision. Ninja alone does not provide a compiler. |
| `python3-pip` / `pipx` | 10.27 / 7.39 MiB | Prefer project venvs initially. Avoid duplicating package-manager paths without a need. |
| `locales` | 20.03 MiB | Add only for workloads requiring generated regional locales; check existing `C.UTF-8` support first. |
| `sudo` | 6.66 MiB | A privilege-policy decision. Installing the package alone does not give the node user useful passwordless package installation. |
| `yq` | 1.18 MiB | Defer pending implementation choice: Debian's package wraps jq; the runner's yq is a different implementation and CLI. |

Do not mirror multiple SDK versions, JDKs, .NET, Android, browsers/drivers,
cloud CLIs, database servers, Docker/Podman daemons, or Kubernetes tooling
by default. Node.js, Python, and Bun are the agreed development runtimes;
Go, Rust, Ruby, JVM, .NET, and other general language runtimes/toolchains
are excluded from the default scope. Keep the QEMU/quickchr/
centrs tools we already ship for this image's RouterOS purpose.

Our image runs as the non-root `node` user and has no sudo. npm/Bun/native
tools installed under `/data` can persist; apt packages need root/build-time
installation and changes to the container's writable system layer do not
survive image replacement. An eventual on-demand ecosystem-install guide
needs to account for that distinction.

## Evidence and scope

The inspected local image is `app-t3code:agent-tools`, **amd64**, created
2026-11-05T13:07:22-08:00, image ID
`sha256:adf7208978175c2d732aa88d7a50f331d3a683a59b0f39d9eef15530d02e2200`.
It has no recorded registry RepoDigest; this is an observed local build,
not proof of a particular published GHCR manifest or ARM64 build. The
repository was at `a84d1f0ecfc90071475c119bfcdaf6e6c7cb2027` when research
started. Its Dockerfile was clean then; the image's exact source provenance
was not independently established.

The image is Debian 13/trixie and contains **227 installed Debian packages**,
including dependencies. Its image size is 4,076,909,402 bytes (about 3.80 GiB);
dpkg's Installed-Size sum is about 1.04 GiB. The difference includes software
installed outside dpkg and image layers, so the package-size sum cannot
describe the whole image. **56 of 113 curated executable probes** succeeded;
this deliberately broad list includes optional ecosystems and does not
define a target score or a complete POSIX conformance check.

Already present: Bash/Dash, mawk (`awk`), coreutils, findutils, grep, sed,
diffutils, tar/gzip, Git/OpenSSH client, curl, jq, ripgrep, less, procps,
make, Python 3, Node/npm, Bun, QEMU, and agent/RouterOS CLIs. Libraries such
as libsqlite3, liblzma, and libzstd do not supply the corresponding CLI
executables. Bash's `time` keyword is present even though `/usr/bin/time`
is missing. Yarn is present as a Corepack shim, which can require a
download; command discovery is not proof of offline functionality.

| Tool | Inspected image | Ubuntu runner context |
| --- | --- | --- |
| Node.js | 24.22.2 | 24.04 defaults to Node 22; 26.04 toolset defaults to Node 24. Toolcaches provide other versions. |
| npm | 11.19.1 | Provided by our Node base; not expected to match runner npm. |
| Bun | 1.4.4 | Explicit image requirement; runner parity is not the reason we ship it. |
| Python | 3.13.5; no ensurepip/pip | Runners include pip and multiple cached Python versions. |
| Git | 2.47.3 | Runner Git is newer; align functionality rather than pinning to its version. |
| T3 / Codex / opencode / Muse | 0.1.6 / 0.166.0 / 1.19.5 / 1.4.14 | Image-specific agent tools. |
| quickchr / centrs | 0.5.5 / 0.1.10 | Resolved versions of the image's intentionally floating `next` installs. |

Runner evidence is pinned to actions/runner-images commit
[`42d27e4a2c1232e5640a88ed42a974c8918ecd28`](https://github.com/actions/runner-images/commit/42d27e4a2c1232e5640a88ed42a974c8918ecd28):

| Runner | Published image version | Published apt rows |
| --- | --- | ---: |
| [Ubuntu 24.04 x64](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/Ubuntu2404-Readme.md) | 20261026.354.1 | 74 |
| [Ubuntu 24.04 ARM64](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/Ubuntu2404-Arm64-Readme.md) | 20261026.166.1 | 75 |
| [Ubuntu 26.04 x64](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/Ubuntu2604-Readme.md) | 20261026.180.1 | 71 |
| [Ubuntu 26.04 ARM64](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/Ubuntu2604-Arm64-Readme.md) | 20261026.168.1 | 72 |

These are selected published apt tables, **not complete runner dpkg lists**.
The union has 79 package names. NOT LISTED in a table cannot prove a tool
is absent. [Ubuntu 24.04's toolset](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/toolsets/toolset-2404.json)
and [Ubuntu 26.04's toolset](https://github.com/actions/runner-images/blob/42d27e4a2c1232e5640a88ed42a974c8918ecd28/images/ubuntu/toolsets/toolset-2604.json)
also show intentional package selections and non-apt tools.
GitHub's [ubuntu-latest transition announcement](https://github.com/actions/runner-images/issues/14748)
places migration between October 19 and November 19, 2026. Our general CI
uses `ubuntu-latest`; CHR integration explicitly uses 24.04 and 24.04-arm.
The full actual CI host dpkg inventory will be captured in future artifacts
alongside ImageOS/ImageVersion instead of assuming what `latest` selected.

Explicit Debian aliases in the comparison handle `dnsutils` →
`bind9-dnsutils`, `gnupg2` → `gnupg`, `netcat` → `netcat-openbsd`, and the
p7zip → 7zip rename. Mapping `ssh` to `openssh-client` compares client
capability only, not an SSH server. Version equality is not evaluated.

## Raw data and reproduction

- [Image inventory JSON](image-amd64/inventory.json), [installed packages TSV](image-amd64/packages.tsv), and [command probes TSV](image-amd64/commands.tsv).
- [Runner source data](runner-packages.json): source URLs and blob SHAs, OS/image versions, every published apt row, and runtime/tool summary sections for all four runners.
- [Full apt comparison](apt-comparison.md) and [TSV](apt-comparison.tsv): all 79 published package names and observed versions.
- [Individual and grouped package costs](package-costs.md) and [raw JSON](package-costs-amd64.json): apt sources/update output, simulated dependency changes, exact candidate versions, archive bytes, and installed-size deltas.
- [Actual default venv failure](python-venv-probe.txt): captured from a disposable container.

Recollect the local image without its entrypoint or network:

```sh
bun scripts/image-inventory.ts --image app-t3code:agent-tools \
  --output docs/research/2026-11-agent-tools/image-amd64
bun scripts/compare-runner-packages.ts docs/research/2026-11-agent-tools
```

Cost simulation needs network access for apt indexes and a disposable root
container. It only updates indexes and runs apt simulation/metadata reads:

```sh
docker run --rm --user root \
  --mount "type=bind,src=$PWD/scripts/research-package-costs.ts,dst=/tmp/research.ts,readonly" \
  --entrypoint bun app-t3code:agent-tools /tmp/research.ts \
  > /tmp/package-costs-amd64.json
```

Apt repositories and floating image tags move, so a later rerun can differ.
The saved JSON records the versions and simulation output used here.
Only amd64 sizes were estimated; ARM64 packages can differ.

## Continuing inventories

The Dockerfile generates `/usr/share/t3code/inventory/` from the completed
runtime stage as the normal node user, before the entrypoint. The default
final stage remains runnable. A separate `inventory` scratch target exports
only these files. CI exports both architectures from the shared build cache
using [BuildKit's platform-split local exporter](https://docs.docker.com/build/exporters/local-tar/),
then uploads `image-inventory-<source SHA>` with build metadata and source
commit. Published builds include the image digest. PR builds do not publish
a registry manifest. CI also captures the actual x64 runner's full installed
package list under `runner/`; it does not capture a live ARM64 runner yet.
Artifacts expire after 90 days. The inventory is also inside the image, so
it remains available after artifact expiry. It is a package/tool inventory,
not a full dependency/license/security SBOM.

Curate the README around useful capabilities and meaningful limitations.
Use the per-build inventories for exact versions and dependency details.
Claude's first-boot install, the downloaded browser, and user-installed
tools under `/data` are intentionally outside the build inventory.

Validation for this pass: lint/typecheck and all nine offline YAML tests;
Dockerfile build checks; real inventory collection from the existing image
with a read-only root filesystem and no network; build-time generation as
node plus scratch-target export; equality of exported and independently
collected package/command/runtime/global-package data; and the CI-host
collector exercised in a Debian container. A full new multi-architecture
image build and hosted CI artifact upload have not been run locally.
