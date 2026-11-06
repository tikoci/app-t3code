# `/app/set environment=` as the tool-group control: lab results

**Measured 2026-11-05 PT (2026-11-06 UTC), habitat C (orca, KVM CHRs).**
This closes REVIEW.md's question about whether operators can change ENV-based
tool groups without the destructive YAML path. Disposable quickchr CHRs:
**7.25.1** x86 (current stable, where the YAML wipe was first seen) and
**7.26beta5** x86, each with `container` package, device-mode
`container=yes`, a 2 GiB ext4 app disk, and an Alpine 3.20 probe app.

The probe ([probe.tikapp.yaml](app-set-probe/probe.tikapp.yaml)) mounts a
named volume at `/data`, writes `/data/seed` **once** (first start only),
and appends its `TOOL_*` env plus a timestamp to `/data/boots` on **every**
start. If the seed changes, the volume was recreated. Each new `boots`
entry is one container restart. [read.sh](app-set-probe/read.sh) reads both
files through `/file/get` on the router.

## Results

| # | Operation | RouterOS | Volume (seed) | Container | Effective env |
| --- | --- | --- | --- | --- | --- |
| A | `/app/set wipeprobe environment=([/app/get wipeprobe environment],"probe:TOOL_GROUPS=labs")` (append) | 7.25.1 | **kept** | restarted, no re-pull | both entries kept (`none;labs`); last value wins at runtime |
| B | `environment="probe:TOOL_GROUPS=capture,labs"` (CLI string) | 7.25.1, 7.26beta5 | kept (no change) | — | **rejected**: `environment container name can be empty for all or probe`. The comma splits the list |
| B′ | Same value via REST PATCH (`centrs api … app/*1 -X PATCH`) | 7.25.1 | kept | — | same rejection |
| B″ | `("probe:TOOL_GROUPS=capture,labs")` array literal | 7.25.1 | kept | — | same rejection |
| C | `environment="probe:TOOL_GROUPS=capture labs"`, `…=capture+labs`, `…=capture:labs`, three in a row | 7.25.1 | **kept** | restarted on each set | values arrive intact |
| D | `yaml=` changing only `TOOL_GROUPS: "capture,labs"` (control) | 7.25.1, 7.26beta5 | **WIPED** (new seed, boots reset) | removed; app left **disabled** until `disabled=no` | YAML comma value arrives intact (`capture,labs`) |
| E | Append another key when the existing list already holds a comma value from YAML (array round-trip) | 7.25.1 | kept | restarted | the comma value survives the round-trip; only *string literals* get split |
| F | `/app/update` after an operator env override (unchanged image digest) | 7.25.1 | kept | restarted | **override kept** (`vpn`) |
| G | `/system/reboot` after an operator override | 7.25.1 | kept | started on boot | **override kept** |
| H | YAML with two keys, then `environment="probe:TOOL_GROUPS=labs"` (single entry) | 7.25.1 | kept | restarted | **the other key is gone**: `environment` is the whole list |
| I | `environment=""` | 7.25.1 | kept | restarted | **no YAML env at all**; YAML values do not return as defaults |
| J | Replace-one-key script ([setgroups.rsc](app-set-probe/setgroups.rsc)), run twice with different values | 7.25.1 | kept | restarted | target key replaced, the other key kept; idempotent |

7.26beta5 reproduced A, B, and D identically. F used an unchanged image
digest. A real image swap with an override still needs one run with the
actual app image (see "Still open").

## Conclusions for the tool-group design

1. **ENV groups through `/app/set environment=` are viable.** On both
   versions, changing the selection is a plain stop/start: no re-pull, no
   volume recreation. The override survives `/app/update` and reboot. One
   app, one image, and ENV selection stay sound; this does **not** push the
   design toward multiple images.
2. **The YAML path stays destructive on 7.26beta5 too.** Group selection must
   never be documented as a YAML edit. `/app/set yaml=` also leaves the app
   disabled with its container removed.
3. **Commas are unusable from the operator CLI/REST.** RouterOS splits
   `environment` on commas, so `T3CODE_TOOL_GROUPS="capture,labs"` cannot be
   *set* by an operator. It can only come from YAML, which is the destructive
   path. Decision: **the parser accepts space, `+`, and comma as
   separators; docs show space** (`"capture labs"`). Comma stays tolerated
   for Docker/compose users.
4. **`environment=` replaces the entire env list.** The YAML `environment:`
   block is only its initial value. A naïve single-key set silently drops
   every other key, which for t3code includes `T3CODE_TELEMETRY_ENABLED=false`.
   Consequences:
   - Every setting needed for correct operation must also be an image `ENV`
     default (HOME, T3CODE_HOME, host/port already are; **telemetry-off is
     not**). Then losing the YAML env degrades to the image defaults.
   - The README must give the replace-one-key script (J), not the append
     idiom or a single-key set:

     ```routeros
     :local app "t3code"; :local key "t3code:T3CODE_TOOL_GROUPS="; :local val "capture labs"
     :local keep ({}); :foreach e in=[/app/get $app environment] do={ :if ([:find $e $key] != 0) do={ :set keep ($keep, $e) } }
     /app/set $app environment=($keep, ($key . $val))
     ```
   - The append idiom (A) works but accumulates duplicate keys, and the
     last one wins. It is fine once, but messy as a documented procedure.
5. **Corollary for the Morpheus incident:** any YAML assignment, including
   reinstalling from the published YAML to pick up new groups, recreates
   the volume. Volumes survive env/device changes, `/app/update`, and reboots.

## Still open

- F/G with a *changed* image digest (a real `auto-update=yes` adoption) and
  the full t3code image. The scenario is: set override, publish a new tag,
  then reboot with `auto-update=yes`.
- Whether `/app/set devices=` (tier-A passthrough from the protocol map)
  behaves like `environment=` (expected, unmeasured).
- Physical ARM/ARM64 hardware: not tested.
