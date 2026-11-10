# Morpheus CHR upgrade and linking investigation

Live run on Intel macOS, 2026-11-07. Checkout fast-forwarded to
`98cbd4b0108e79f6511d268563527dc1c7c40472`.

- Existing quickchr `t3code`: RouterOS 7.25, HVF, 1 CPU, 1024 MiB RAM.
  User networking plus bridged en0 through socket_vmnet's QEMU stream
  backend with `reconnect-ms=1000`; no network migration performed.
- Router LAN address: `192.168.74.133`; app HTTP on port 3773. Morpheus
  also forwards `127.0.0.1:9156` to guest port 3773. Both returned 200.
- T3 environment `CHR`: `b23b5799-783c-46f6-bc8b-afd00c6993b9`, T3 0.1.6.
  Morpheus and Orca report 0.1.7. App image replacement does not itself
  change the upstream T3 version pinned by this repository.

## Storage and replacement

Gracefully shut down using quickchr. Copied machine.json, boot.qcow2 and
disk1.qcow2 into owner-only local directory
`~/.local/share/quickchr/backups/t3code-20261107-155449`.

The 8 GiB boot disk was left intact. The separate 4 GiB app disk had about
750 MiB free. Converted a staged copy to raw, ran e2fsck (journal recovery
and free-counter repairs), expanded to 24 GiB, grew ext4 with resize2fs,
and ran e2fsck again successfully. Converted back to qcow2; qemu-img check
passed before replacement. Recorded extraDisks as 24G in stopped machine
state. Restarted with quickchr; filesystem UUID and mount point survived.

Replaced duplicate test T3CODE_TOOL_GROUPS entries using `/app/set
environment=` with the explicit five-group default, preserving the other
three existing environment settings. Updated through `/app/update`, never
through `yaml=`. Image ID changed from `ccdbfdd929e62ff5a21afeb5211313541fce5a1082a2322b295f97900912e4a8`
to `9498bff52b556e5fb73e4fbcdd78b7b06e0e8854465fc6bfe73bc4b54fd20db3`.
After replacement, the environment ID and `/data` mount were unchanged,
the UI returned 200, and core plus capture/labs/vpn/routing/dev all reported
ready. About 19.5 GiB app storage remained free.

This verifies identity and mount retention, not authenticated provider
requests or complete project/auth content comparison.

## Why linking rejected LAN HTTP

Local upstream source `apps/server/src/peer/PeerLinks.ts`, function
`peerOrigin`, explicitly rejects HTTP except loopback and Tailscale hosts.
`PeerLinks.test.ts` explicitly tests rejection of LAN HTTP. Separately,
`environment/DirectEndpoints.ts` advertises LAN HTTP client endpoints.
Client connections and linked-agent credentials therefore have different
transport rules; the version difference has not been established as causal.

Read-only inspection of Morpheus's saved peer URL confirmed Orca uses an
HTTPS t3coderelay.com endpoint. CHR's `t3 connect status --json` reported
desired/authenticated/linked all false and the relay client missing.
Owner selected T3 Connect for CHR too. Device authorization and subsequent
authenticated linking remain outstanding; no transport policy was weakened.

Installed the T3 relay client (cloudflared 2026.10.4), verified by T3's
installer. Started `t3 connect link --headless` as a RouterOS `:execute`
job running `/container/shell`; Linux background children of a completed
container shell did not survive, including a nohup attempt. The persistent
RouterOS job reached device authorization and is waiting for account
approval (10-minute expiry). No account credentials were copied from
Morpheus or Orca. After authorization, restart the app to activate the
managed relay, then complete the linked-environment card and test a read.

Follow-up: device authorization completed with the owner's T3 account.
Restarted the app by toggling disabled yes/no. CHR then reported
authenticated/linked true and reachability reachable (four QUIC connections).
Its cloudUserId exactly matched Morpheus's existing cloudUserId, confirming
the same T3 account. This establishes T3 Connect registration and tunnel
readiness; the separate agent peer link and provider requests remain untested.

## Validation limits

`bun run check` passed with Biome warnings. YAML contract: 23 pass, 0 fail.
Full `bun run test`: 70 pass, 28 fail, 14 errors on macOS; reproduced missing
`flock`, `/proc` assumptions and payload-test timeouts. No tests disabled or
changed. These failures remain a Mac portability gap; Linux CI was green
at the current commit. No local Docker executable was available, so this
run adopted the published image rather than building it on Morpheus.

Issues #5, #6 and #7 remain open. Provider authentication, relay linking,
the remaining nested-lab matrix and capability/protocol tests are not
claimed complete by this run.

Correction after live GitHub refresh: #5 was already closed at
2026-11-07T17:53:18Z; earlier statements that it remained open were wrong.
Subsequent Morpheus-to-CHR linking succeeded. A real delegated Codex run
on CHR completed local operation probes; see `chr-codex-review.md`.
Core/five-group tooling passed; Claude was absent and the full acceptance
matrix remained partial. No issue state or GitHub comments were changed.

Owner follow-up, 2026-11-07: Claude and Codex both now run turns through
T3 on this CHR. Claude was logged in from a T3 terminal; its OAuth URL was
truncated or broken by a newline on copy and had to be repaired by hand
(tracked in #15). Why `claude` was absent at the time of the review above
was not diagnosed; late harness discovery belongs to #13.
