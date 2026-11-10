# uv/uvx, persistent additions, and candidates to move out of core

**Evidence appendix.** Approved decisions and remaining implementation
questions are consolidated in [REVIEW.md](REVIEW.md). Measurements and the
offline persistence proof below remain supporting evidence.

The owner prefers a working small base, with optional tools installed into
the existing `/data` home where practical. Keep the `/app` description to a
brief list of group names; the README should define the contents. This is
the refined design in [issue #5](https://github.com/tikoci/app-t3code/issues/5),
not a production package removal or an implemented group installer.

## uv and uvx

Neither command is on PATH in the inspected image. Recommend **both in the
future core bootstrap toolset**, alongside the existing Python 3, Node, and
Bun. `uv` handles project environments/dependencies; `uvx` is the convenience
entrypoint for isolated Python CLI tools (`uv tool run`). These serve the
same common agent need as npm/Bun's tool runners without adding Rust, pipx,
or another general language runtime. See [Astral's tool guide](https://docs.astral.sh/uv/guides/tools/).

An actual test used the verified standalone uv 0.13.7 release for Linux
x86_64: **15.90 MiB downloaded**, **36.09 MiB for uv plus uvx executable
file bytes**. This excludes future package caches, Python tool environments,
filesystem allocation overhead, and optional Python downloads. The checksum
and source URL are in [uv-persistence-probe.json](uv-persistence-probe.json).
The corresponding ARM64 release exists, but was not executed in this test.
Standalone installation requires no Rust toolchain; the
[official installation guide](https://docs.astral.sh/uv/getting-started/installation/)
documents the distribution options.

The test created a fresh container with a **read-only root filesystem**,
installed uv/uvx and yamllint 1.38.0 as node under `/data`, created a venv
using the existing `/usr/bin/python3`, then removed that container. A new
container with the same home and **no network** successfully ran uv, uvx,
the installed yamllint command, and the venv Python without installing
anything. The temporary home was removed afterward. The original image
was unchanged. No managed Python was downloaded: the test set
`UV_PYTHON_DOWNLOADS=never` for uv subprocesses.

Observed paths:

| Content | Path |
| --- | --- |
| Standalone commands and installed tool launchers | `/data/.local/bin` |
| Python CLI tool environments | `/data/.local/share/uv/tools` |
| uv/uvx dependency cache | `/data/.cache/uv` |
| Project environment | `/data/projects/uv-runtime-proof/.venv` |

Astral documents these defaults in its [storage reference](https://docs.astral.sh/uv/reference/storage/).
Use existing system Python by default to control disk usage, with an
explicit policy for projects needing other Python versions. This does not
require banning additional Python versions, but they should not appear
unexpectedly during core initialization. The
[Python-download setting](https://docs.astral.sh/uv/reference/environment/#uv_python_downloads)
provides the control. Venvs/native wheels may require recreation after
Python minor-version or ABI changes; persistence alone does not guarantee
compatibility with an upgraded base.

## What can move out of core

The candidate sizes below come from the existing amd64 image. Apt values
use copied auto/manual state plus simulated autoremove, retaining packages
still needed by other core roots such as Python. Native program sizes use
`du`, so the two methods are distinct. These are **independent candidates,
not compressed-image measurements or values to add together**.

| Candidate | Proposed group | Current footprint / estimated reduction | Recommendation |
| --- | --- | ---: | --- |
| QEMU emulators, qemu-img, ARM firmware, unneeded dependencies | `labs` | 564.78 MiB from apt metadata; 33 packages | First substantial optional-runtime candidate. Keep quickchr availability tied to the whole group being ready. |
| Browser's explicit system dependencies and unneeded libraries | `browser` | 215.24 MiB from apt metadata; 44 packages | Useful new group. T3 itself must still start and serve without it; browser readiness requires its full native dependency set. |
| QEMU and browser dependencies together | `labs` + `browser` | 792.15 MiB from apt metadata; 85 packages | Shared dependencies make the combined result differ from adding the rows above. |
| opencode | `agents-extra` or provider-specific selection | 408.94 MiB allocated under its npm installation | Strong candidate if not the chosen default provider. Preserve its CPU/platform dispatch support. |
| Muse | `agents-extra` or provider-specific selection | 395.71 MiB allocated | Strong candidate if optional; its existing standalone installation path is a good candidate for a persistent home bundle. |
| Codex | chosen default provider, or a provider group | 435.14 MiB allocated | Keep at least one provider CLI immediately usable; choose the default deliberately before moving all providers. |

`browser` covers the native support libraries; T3 already downloads its
browser runtime on first use. It needs a tested integration with that
existing browser setup, rather than an independent duplicate browser
download. The apt solver does not know dependencies of binaries installed
outside dpkg, so browser/native-provider startup tests are required before
removing libraries. It is unsafe to remove every library merely because
it appears in the Dockerfile's browser list: Python also needs libexpat,
and QEMU consumes some shared libraries.

Keep T3, Node/npm, Python, Bun, Git/SSH, certificates/TLS, shell/process/file
basics, and the agreed small data/network tools in core. Moving make,
unzip, less, or jq into separate download groups gives little benefit for
the loss of immediate agent usability. Keep centrs immediately usable for
real-router work. If quickchr's CLI moves with labs, leave discoverable
group status so agents know a complete lab environment can be enabled.

Claude already installs into the persistent home in the background; no new
redistribution path is proposed for it. Global lint/typecheck tools belong
in `dev`; normal repositories can keep using their local lockfiles.

## One optimization before removing features

The current amd64 opencode install contains standard and baseline CPU
executables with **identical SHA256 digests**, each roughly 204 MiB. They
are candidates for deduplication in the npm-install build step while
retaining both dispatch paths. The audit records file sizes, inodes/link
counts, and hashes in [core-footprint-audit.json](core-footprint-audit.json).
This needs a build/runtime proof on both image architectures and should
only deduplicate verified identical files. Do not discard the baseline
path or assume future versions remain identical. Do this in the same layer
as installation if the goal is to reduce image bytes.

The previously identified unused ARM firmware variants are another
candidate for reducing extracted space without changing advertised tools.
Keep the selected code/variables pair and validate boots/snapshots before
pruning. Neither optimization has been applied to the production Dockerfile.

## Persistent payloads are preferred; native groups still need proof

For uv, Node tools, and suitable standalone provider programs, actual
installed payloads under `/data` can survive replacement. The uv test
demonstrates this with the core untouched and the ordinary node identity.
This is now the preferred direction over adding a privileged apt worker
simply to install optional tools on every replacement.

QEMU, TShark, and browser dependencies need more than moving executables:
their loaders/libraries, plugins, firmware, data, and configuration paths
must work from a stable persistent prefix. For example, the current
quickchr firmware finder checks `/usr/share/AAVMF`; a `/data` lab pack
needs a deliberate firmware-path integration. The next prototype should
prove a dependency-complete native group, an unchanged core, ordinary-user
execution, and an offline replacement. A bare extraction of Debian files
plus a global LD_LIBRARY_PATH is not a completed portable-group design.

The earlier Debian-cache/root-worker approach remains a fallback backend,
not a requirement for home-native tools. Do not change the current image's
USER or startup merely to force all groups through that backend.

## YAML and README presentation

When the feature exists, use a description along these lines:

```yaml
descr: "T3 Code — optional groups: capture, labs, vpn, dev, browser, agents-extra"
```

The README should list group contents, defaults, selection examples,
readiness, persistent storage, and cleanup. The production YAML is not
updated to advertise controls that its current entrypoint does not yet
implement. When it changes, regenerate the embedded editor share link and
keep the app-store document in sync.

Reproducible evidence helpers:

```sh
bun docs/research/2026-11-agent-tools/research-uv-persistence.ts
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount "type=bind,src=$PWD/docs/research/2026-11-agent-tools/research-core-footprint.ts,dst=/tmp/research.ts,readonly" \
  --entrypoint bun app-t3code:agent-tools /tmp/research.ts
```
