# T3 private secret cards and a future centrs handoff

Part of the [presentation inventory](README.md). This records
the T3 v0.1.7 implementation for future skills and `SECURITY.md` work. It does
not configure credentials or claim that a centrs handoff has been tested.

## Human and agent interfaces

An agent calls `request_secret` with a label, reason and optional placeholder.
T3 displays a dedicated masked-input card **in the conversation**, with save
and decline controls. The request needs an active originating provider run.
Timeout, interruption or run termination closes a pending card.

The client sends the value through T3's secret-answer operation, rather than
as an ordinary user message. T3 records card metadata/status in the thread;
the secret itself is stored separately. The input is visually masked and
password-manager/autocomplete behavior is discouraged by the component.
See the [card][card], [client helper][client] and [request handler][handler].

| Delivery mode | Agent receives | Consumer | Important boundary |
| --- | --- | --- | --- |
| Default `secretRef` | Opaque `secret-ref:…` identifier | A T3 tool implemented to consume that reference | Value is not returned to the model; reference is one-use and project-scoped |
| `file` | Absolute path to an owner-only file on the T3 server | The agent's shell command / CLI process | Commands can read the value; the file is reusable until deleted/cleaned |

The modes have different guarantees. “The model never sees the value” is the
intended reference-mode flow; file delivery explicitly permits shell access.
An agent printing or reading that file into model-visible output would defeat
the latter mode's transcript protection.

The concrete reference consumer identified at this pin is
[`schedule_task` webhook-signature configuration][ref-consumer]. This is an
example of a tool explicitly wired to redeem the reference; it is not a
general-purpose secret resolver exposed to arbitrary CLIs.

## Storage, expiry and deletion

The [server path derivation][paths] places secrets under the environment's
`userdata/secrets` directory. With this image's `T3CODE_HOME=/data/.t3`, the
normal path is `/data/.t3/userdata/secrets`.

The [secret store][store] writes raw bytes to permission-restricted files;
there is **no encryption layer in this implementation**. Request values are
JSON containing the project ID, value and save timestamp, in files named
`secret-request-<opaque-id>.bin`. The directory is mode `0700`, and files are
mode `0600`. This protects against other Unix users, not the T3 service user,
root, RouterOS/container administrators, or a backup reader.

The [request service][requests] implements the following lifecycle:

| Item | Lifetime / scope | Cleanup |
| --- | --- | --- |
| Saved reference | Project checked when consumed; expires after 24 hours from save | Successful consumption removes stored value before returning it; expired reads reject |
| Delivered file | `secrets/files/<opaque-id>`, mode `0600`, directory `0700` | Stored request copy removed after file creation; file itself remains |
| Unused request/file | Startup sweep and hourly sweeps | Request age or file modification time older than 24 hours makes it eligible |
| Thread record | Label, reason, status and delivery metadata | Ordinary thread lifecycle; value is not part of that record |

“One-use” applies to redeeming a reference, **not** to reading a delivered
file. The file is not removed after the first CLI invocation or at turn end.
The sweep is periodic and deletion can fail, so 24 hours is not a precise
physical deletion deadline. File expiry is based on modification time; there
is no per-read expiry check on shell access. Unlinking is not secure erasure
and does not remove copies from backups/snapshots.

These paths are under persistent `/data` in this container. An offline home
backup can therefore include unexpired secret-request files and delivered
plaintext files. The request card should not be described as a memory-only
credential store or an encrypted vault.

## What the T3 path does and does not protect

- The ordinary conversation and model-facing result carry metadata and a
  reference/path rather than the submitted value. Client error reporting is
  deliberately restricted to avoid exposing request payloads.
- The submitted value still crosses the client-to-T3 connection. Use the
  deployment's authenticated HTTPS/T3 Connect path when confidentiality on
  that connection matters. This research did not audit transport or proxies.
- A shell that consumes a private file can expose its content through stdout,
  tracing, child environment/arguments, crash dumps or application logging.
  The card does not prevent those downstream disclosures.
- Same-UID processes and administrators remain in the trust boundary. File
  mode `0600` is not isolation between agents using the same service account.
- The client helper **trims leading/trailing whitespace** before submission.
  A synthetic-value probe confirmed this. Passwords requiring that whitespace
  would change; resolve this limitation before promising arbitrary password
  fidelity. No real password was submitted for the probe.

The whitespace behavior already has an open upstream report,
[pingdotgg/t3code#31690][whitespace-issue]. Its reported UI reproduction uses
a whitespace-only secret; this research additionally confirms surrounding
whitespace removal in the client helper with a synthetic value.

## What this means for centrs

The inspected local centrs package was `0.1.9-next.24`. Its documented inputs
include `CENTRS_PASSWORD` and `CENTRS_CDB_PASSWORD`, or corresponding flags.
T3's opaque `secretRef` is not a router password and cannot simply be passed
as one. No direct centrs redemption mechanism for a T3 secret reference was
identified.

File delivery supplies an existing bridge to a CLI: the agent can have a
command read the returned path without returning the content to the model.
For today's centrs inputs, that can mean a **command-scoped** password
environment variable. It avoids asking the human to put the value in chat
or saving it in the app's persistent environment list; it does not eliminate
environment-variable exposure in the consumer process. A future direct
file/stdin input could have different tradeoffs and needs centrs-side work.

The CDB decryption password and a router's login password are separate
credentials. Supplying either through a private card does not decide whether
centrs should persist a router entry, encrypt a CDB, or retain anything after
the command. The centrs docs explicitly reserve `CENTRS_CDB_PASSWORD` against
being persisted in `centrs.env`. Those policies must remain explicit in a
future recipe.

No shell recipe with real credentials was run here. Before documenting a
production path, validate it with disposable values and check both T3 and
centrs output for accidental disclosure.

## Questions for skills and SECURITY.md follow-up

1. Confirm behavior on the actual container/server version, including
   persistence after restart and cleanup after success/failure.
2. Decide who removes a delivered file promptly and how backups treat the
   secret directory. Do not rely on the hourly expiry sweep as immediate cleanup.
3. Verify centrs log/output redaction, scoped process environment and CDB
   persistence policy for the chosen command.
4. Resolve the whitespace-trimming limitation before general password use.
5. State the same-UID/admin trust boundary, persistent plaintext storage and
   transport assumptions accurately in `SECURITY.md`.

[card]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/SecretRequestCard.tsx
[client]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/packages/client-runtime/src/secretRequest.ts
[handler]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/mcp/OrchestratorMcpService.ts
[paths]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/config.ts
[store]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/auth/ServerSecretStore.ts
[requests]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/secrets/SecretRequests.ts
[ref-consumer]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/scheduledTasks/ScheduledTaskService.ts
[whitespace-issue]: https://github.com/pingdotgg/t3code/issues/31690
