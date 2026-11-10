# Agent tool research — review index

**Start with [REVIEW.md](REVIEW.md).** It contains the approved direction,
implementation boundaries, remaining questions, and acceptance criteria.
Tracking: [tool groups #5](https://github.com/tikoci/app-t3code/issues/5),
[automatic release/security delivery #6](https://github.com/tikoci/app-t3code/issues/6).

Research date: 2026-11-05, America/Los_Angeles (some captures are Nov 6 UTC).
The baseline is a local amd64 image, not a verified published GHCR manifest
or native ARM64 image. The [initial comparison](runner-comparison.md) and
[image inventory](image-amd64/inventory.json) record source pins/provenance.

## Reading order

| Document | Purpose |
| --- | --- |
| [Review brief](REVIEW.md) | Authoritative approved decisions and open implementation questions |
| [Runner comparison](runner-comparison.md) | Initial baseline, source pins, package estimates, and build inventory |
| [Networking and Node evidence](network-and-agent-tools.md) | Capabilities, packet parsing, IPsec, and CLI footprints |
| [uv and core footprint evidence](uv-and-core-scope.md) | Persistent Python tool proof and core removal candidates |
| [`/app/set environment=` lab results](../2026-11-app-set-environment/README.md) | Group selection via operator env: volume kept, restart only; comma and whole-list caveats; YAML wipe reproduced on 7.26beta5 |
| [RouterOS protocol map](routeros-protocol-map.md) | Review addendum: RouterOS protocols → Linux tools, privilege tiers, vpn/capture/routing gaps |

## Raw evidence

| Evidence | Files |
| --- | --- |
| Baseline packages, commands, runtimes, global tools | [JSON](image-amd64/inventory.json), [packages](image-amd64/packages.tsv), [initial probes](image-amd64/commands.tsv), [expanded probes](network-command-probes.tsv) |
| Four pinned Ubuntu 24.04/26.04 runner inventories | [Source data](runner-packages.json), [comparison](apt-comparison.md), [TSV](apt-comparison.tsv) |
| Initial dependency-cost estimates | [Table](package-costs.md), [apt simulations](package-costs-amd64.json), [default venv failure](python-venv-probe.txt) |
| Networking / Node CLI footprints | [Tables](network-and-node-costs.md), [apt simulations](network-package-costs-amd64.json), [actual npm installs](node-tool-costs-amd64.json) |
| Unprivileged pcapng/TZSP field and JSON decoding | [Fixture/results](packet-tools-probe.json) |
| Real x86/ARM64 CHR boots inside the existing amd64 image | [Runtime](quickchr-runtime-probe.json), [doctor](quickchr-doctor-baseline.json), [firmware](quickchr-firmware-files.json) |
| uv/uvx/Python CLI working after offline replacement | [Persistence proof](uv-persistence-probe.json) |
| Dependency-aware core removal candidates / identical binaries | [Footprint audit](core-footprint-audit.json) |

Runner tables are selected published lists, not full runner package databases.
Apt metadata, disk allocation, and file bytes are different measurements;
scenarios overlap and are not additive or compressed image deltas. Each
evidence document retains its assumptions and limitations.

## Reproduction helpers

All are Bun/TypeScript files under the repository's `scripts/` directory.

| Helper | Purpose / side effects |
| --- | --- |
| `image-inventory.ts` | Collect image inventory; `--image` bypasses entrypoint with no network and a read-only root |
| `runner-inventory.ts` | Read installed CI-host packages and selected identity fields |
| `compare-runner-packages.ts` | Render saved source/image facts as Markdown and TSV |
| `research-package-costs.ts` | Refresh indexes and simulate installs in a disposable container |
| `research-node-tools.ts` | Install/measure exact-version temporary CLI prefixes in a disposable container |
| `research-packet-tools.ts` | Install packet tools in a disposable container; synthesize/decode a capture as node |
| `research-quickchr-runtime.ts` | Boot/provision/read/remove real CHRs inside a disposable container; no production router |
| `research-uv-persistence.ts` | Create two containers and a temporary home; prove offline replacement, then remove the home |
| `research-core-footprint.ts` | Copy apt selections to tmpfs, simulate autoremove, read file sizes/hashes |

Commands and pinned versions are in the relevant evidence document/helper.
Repositories and floating image tags move; saved results record what was
inspected. Pages mirrors Markdown, while raw JSON/TSV files are available
in the repository and future CI inventories, not the current Pages mirror.
