# Review brief: persistent optional tools for app-t3code

**Status: direction approved; implementation design ready for review.**
The next Claude pass should look for implementation gaps. This handoff
does not start that review or implement the runtime group manager.

Tracking: [groups/inventories #5](https://github.com/tikoci/app-t3code/issues/5),
[automatic delivery #6](https://github.com/tikoci/app-t3code/issues/6),
[project/configuration persistence #3](https://github.com/tikoci/app-t3code/issues/3).

## Approved decisions

- One small, working core image and one app/operator installation path.
  ENV groups select optional tools; profile-specific tags/apps are not needed.
- Keep T3, Node/npm, Python, Bun, Git/SSH, certificates/TLS, centrs, small
  file/process/data/network tools, sqlite3, and a chosen provider CLI ready.
  Add uv/uvx as Python bootstrap tools. Other general language SDKs/runtimes
  stay outside the default scope.
- Prefer actual optional payloads in the existing `/data` home. Preserve
  the working core and node identity while prototyping. A privileged apt
  worker is a fallback backend, not an approved requirement.
- Start T3 before optional downloads finish. Failures leave core usable;
  agents can discover selected tools and their pending/ready/error state.
- **quickchr and QEMU come together in `labs`**, including qemu-img,
  firmware, data, libraries, and helper dependencies. An installed CLI alone
  is not a ready lab environment.
- Preserve **RouterOS `auto-update=yes`** as a deployment requirement.
  Slow downloads and frequent image replacement are expected. Reuse
  compatible payloads without downloads and refresh security/ABI revisions.
- Keep the `/app` description to group names; the README defines contents,
  defaults, selection, readiness, persistence, and cleanup.

## Group contract

Proposed control: `T3CODE_TOOL_GROUPS="capture labs"` (space, `+`, or comma
separated; operators cannot set commas through `/app/set environment=`, see
[the `/app/set` environment research](../2026-11-app-set-environment/README.md)); `none` is core only,
and `all` selects every defined group. Defaults and ENV/settings precedence
remain implementation questions.

| Group | Contents / boundary |
| --- | --- |
| `capture` | tcpdump, TShark, capture-file tools, dependencies |
| `labs` | quickchr + QEMU emulators, qemu-img, firmware/data/libraries and discovery/storage/OpenSSH helpers; one readiness contract |
| `vpn` | strongSwan peer/certificate tools and WireGuard; no default tunnel/service startup |
| `dev` | TypeScript, CSpell, markdownlint-cli2, Biome fallbacks; project lockfiles remain authoritative |
| `browser` | Native support integrated with T3's existing browser setup/download |
| `agents-extra` | Optional provider CLIs beyond the deliberately chosen core provider |

Intended short YAML wording, when the controls exist:

```yaml
descr: "T3 Code — optional groups: capture, labs, vpn, dev, browser, agents-extra"
```

The current YAML/entrypoint do not implement the controls; this handoff does
not advertise nonfunctional options there. Tracked YAML also does not yet
declare `auto-update`. The owner reports it enabled in deployment; the
implementation must preserve that behavior and express the required setting.

## Persistence, updates, startup

Use versioned payload directories and manifests recording architecture,
runtime/ABI compatibility, dependencies, digests, and desired tool versions.
Check real files/capabilities before reuse. Persistent markers alone cannot
establish readiness after base/Python changes. Download only missing/changed
content; a T3 patch should not automatically re-fetch every compatible group.

Persistence needs a security-refresh policy: an old payload must not remain
indefinitely just because it still runs. Define manifest refresh, activation,
interruption recovery, last-known-good fallback, and cleanup while jobs may
still use old versions. Core auto-update alone does not update `/data` tools.

Keep synchronous init small. A separate manager handles sequential background
work, locking, space budgets, bounded retries, and shutdown. Expose per-group
status and a JSON runtime inventory alongside immutable build inventories.
Server health and group readiness are separate; ordinary startup must not
boot a CHR just to check an installation.

uv/Python persistence is proven; Node tools and suitable standalone providers
fit the same direction. Ordinary Debian installation into `/usr` instead
loses installed files on replacement, leaving only a home-backed archive
cache. Native bundles must solve loaders, libraries, plugins, firmware,
data, and config paths in a persistent prefix. Avoid a global LD_LIBRARY_PATH
or mounting `/usr`/`/lib` over an upgraded image. Quickchr currently searches
system firmware paths, so a persistent labs bundle needs explicit integration.

## Automatic delivery boundary

[Issue #6](https://github.com/tikoci/app-t3code/issues/6) covers detecting
stable T3 releases, testing/publishing both image architectures, and base/tool
security refreshes. RouterOS consumes published images; it does not build
new upstream releases itself. Current `:0.1` follows that minor line; tracking
stable releases across minors needs an explicit rolling-channel policy.
Tool profiles must not require operator tag/app changes.

Keep updates away from reapplying YAML: CHR 7.25.1 has a documented destructive
YAML-reapply path. The [RouterOS manual](https://manual.mikrotik.com/docs/containers/apps/)
currently describes automatic image updates as triggered on device reboot;
verify supported-version behavior instead of promising immediate adoption
after publication. No live deployment setting was audited here.

## Evidence established

| Finding | Proof and limit |
| --- | --- |
| Baseline / runners | 227 installed Debian packages; four pinned Ubuntu 24.04/26.04 published inventories. Runner tables are selective; local image provenance is recorded. |
| Packet analysis | node decoded synthetic pcapng/TZSP DNS into fields/JSON, without live capture or added capabilities. |
| Labs | Existing amd64 image booted/provisioned x86 and ARM64 CHR 7.25.1 under TCG, used qcow2 boot/extra disks, answered centrs reads. No native ARM64, nested RouterOS, snapshot, or transfer proof here; test-only storage reserve was explicitly reduced. |
| Persistence | uv/uvx + yamllint + project venv worked after fresh-container replacement with the same home, no network, read-only root. Same-base amd64 proof, not arbitrary ABI upgrades. |
| Footprint | Dependency-aware labs/browser simulations and actual provider/tool sizes. Different size methods, overlapping scenarios; not compressed OCI deltas. |
| Optimizations | Identical opencode payloads at different inodes; unused ARM firmware variants. Not applied; dispatch/boot/snapshot validation on both architectures remains needed. |

The [evidence index](README.md#raw-evidence) links raw results and helpers.
This brief takes precedence over earlier evidence narratives.

## Questions for the next review

1. Which native bundle format can prove complete labs under `/data` as node,
   including firmware paths, without altering the working core model?
   What changes on native ARM64 or nested RouterOS hosts?
2. What manifest, compatibility/security refresh, atomic activation, rollback,
   and environment-recreation contract handles updates during active jobs?
3. What are group defaults, core provider, ENV/settings precedence, and the
   behavior of disabling a group whose payload is already present?
4. How are discovery/status, low disk, interrupted work, registry outages,
   retries, and cache cleanup handled without deleting projects/VMs?
5. What live-capture/VPN/KVM/TAP permissions do supported hosts provide?
   Package installation must not imply those runtime capabilities.
6. Does #6 meet the stable/security update goal without repeated large
   downloads or operator profile/tag changes?

## Acceptance and current state

Require core startup with downloads blocked; compatible offline replacement;
changed security/ABI revisions; interrupted installation recovery; truthful
status/cleanup; and native amd64/ARM64 tests. Labs cover managed login and
transfer, qcow2 disks, firmware, snapshots, cleanup, and advertised guest
architectures. Preserve the entire home and selections without YAML reapply.
Future YAML changes synchronize the store and regenerate/verify the README
editor snapshot.

The working tree contains research/helpers and prepared build/CI inventory
generation/export. Lint/typecheck and nine offline YAML tests pass; actual
probes above are saved. Hosted multi-arch artifact publication/native ARM64
group tests have not run. No runtime group manager, package removal, uv core
install, USER/startup/YAML/deployment change, or release watcher is implemented.
Changes are uncommitted; the pre-existing integration-test edit is outside
this work.
