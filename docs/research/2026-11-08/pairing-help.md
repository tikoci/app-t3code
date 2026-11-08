# Pairing screen help from RouterOS (#18)

2026-11-08, Habitat C (orca, x86_64). T3 Code **0.1.7** (tag `v0.1.7`,
release archive `t3-0.1.7-linux-x64.tar.gz`). Builds on the fork-less UI
research from 2026-11-06, recovered from orca's checkout in this PR:
[t3code-skills-and-ui-patching.md](../2026-11-06/t3code-skills-and-ui-patching.md).

**Result:** a fork-less helper works. The image adds one `<script>` tag to the
upstream client's `index.html`; the script puts a "Running on MikroTik
RouterOS?" panel with the token command under T3's pairing form. The managed
policy cannot do this: nothing from it reaches the pairing screen.

## 1. Managed policy: does not reach the pairing screen

The question in #18 was whether `organization`/`supportUrl` from
`/etc/t3code/policy.json` show up before pairing. They don't, by construction:

- The pairing screen (`apps/web/src/components/auth/PairingRouteSurface.tsx`)
  renders from the unauthenticated session state only. Its text comes from
  `describeAuthGate(auth.bootstrapMethods)` and
  `describeSupportedMethods(auth.bootstrapMethods)`, fixed strings chosen by
  bootstrap method.
- That pre-auth state is `AuthSessionState` (`packages/contracts/src/auth.ts`):
  `authenticated`, `auth` (`policy`, `bootstrapMethods`, `sessionMethods`,
  `sessionCookieName`, `serverUpdateScope`), scopes and expiry. No policy
  summary, label or free text.
- The policy summary is `ServerConfig.managedPolicy`
  (`packages/contracts/src/server.ts`), read in the web app through
  `useServerConfigs()` (`apps/web/src/state/managedPolicy.ts`). Server config
  arrives only after authentication. Every use is in Settings, the composer and
  update controls.

So a policy file would add `organization`/`supportUrl` text in Settings after
pairing, and nothing before. It also brings the risks noted on #18 (a
`clients` list without `remote` stops pairing links and revokes paired
devices). **Not used.**

## 2. What ships

| Piece | Where | What it does |
| --- | --- | --- |
| Helper | `client/routeros-pairing.js` → `/opt/t3code/client/` | Watches the DOM (`MutationObserver`, batched per animation frame). When `#pairing-token` is on screen, adds its own `<section>` after the token form; removes it when the input goes away. Text nodes only, never HTML. Copy button uses the Clipboard API on HTTPS and selects the text on plain HTTP (`use-https=no`). |
| Wiring | `Dockerfile`, right after the release archive is extracted | `COPY` plus one `sed` before `</head>`. The build **fails** if `index.html` doesn't have exactly one `</head>`, if no bundle asset contains `pairing-token`, or if the tag isn't inserted exactly once. A T3 bump that renames the input breaks the build instead of silently dropping the help. |
| Log line | `docker-entrypoint.sh` | Prints the same command at every start, before `exec t3 serve`. |
| Contract test | `test/pairing-help.test.ts` (in `bun run test`) | Same command in the helper, README and entrypoint; Dockerfile guards present; helper parses; no HTML sinks. |

The command on screen is the short form, since the browser is already at the
app's URL:

```routeros
:put [/container/shell app-t3code cmd="t3-pairing-link" as-value]
```

The README keeps the longer `:put "...$[/app/get t3code ui-url]..."` form for
getting the URL too. The panel names `app-t3code` and tells a user with a
renamed app to look it up with `/container/print`: the browser can't learn the
RouterOS object names.

Why the panel goes *after* the form, inside T3's card: React never touches a
node it didn't create, so a foreign sibling is left alone; when React
unmounts the card the panel goes with it, and the observer removes it on any
other path. The 2026-11-06 research considered and rejected compiled-JS string
patches (fragile) and a TSX rebuild (needs upstream's Node 26 + pnpm toolchain
and ties the web build to `T3CODE_VER`). The helper is ~120 lines and touches
one upstream file.

## 3. Verification

### Against the release archive (outside Docker)

The 0.1.7 x64 archive, extracted to a scratch dir with the helper copied and
the tag inserted, `t3 serve` on `127.0.0.1:3799` with a throwaway home:

- `GET /routeros-pairing.js` → `200 text/javascript`; `GET /pair` HTML carries
  the tag. Static files beside `client/index.html` are served before auth, as
  the 2026-11-06 probe found on 0.1.6.
- Headless Chromium screenshots of `/pair` in light and dark: the panel sits
  between the form and T3's "accepts one-time pairing tokens" note, using the
  card's colors (`currentColor`/`color-mix`, no theme hooks).
- [pairing-help-probe.mjs](pairing-help-probe.mjs), driving the real page:

  ```text
  panel shown before pairing: true
  command: :put [/container/shell app-t3code cmd="t3-pairing-link" as-value]
  panels after a rejected token (want 1): 1
  panels after pairing (want 0): 0
  path after pairing: /welcome
  ```

### In the built image

`docker buildx build --load --platform linux/amd64 -t app-t3code:pairing-help .`
passed all three Dockerfile guards. A container from it (fresh volume,
`T3CODE_TOOL_GROUPS=none`, port 3773 published on loopback):

- Container log line 2: `t3code: to pair a browser, open the app URL and run
  in a RouterOS terminal: :put [/container/shell app-t3code
  cmd="t3-pairing-link" as-value]`.
- `/pair` HTML carries `<script defer src="/routeros-pairing.js"></script>`.
- Probe with a token from `docker exec … t3-pairing-link` (the wrapper
  RouterOS runs): the same five lines as above, ending on `/welcome`.

### One unexplained rejection

On the first scratch server, tokens from `t3 auth pairing create` (what
`t3-pairing-link` runs) were rejected with `401 invalid_credential`, though
their rows were in that server's `auth_pairing_links` with no `consumed_at`,
`revoked_at` or proof key, and unexpired. After restarting that server, and on
three fresh homes (including the same browse-then-create order), CLI tokens
were accepted every time. Not reproduced; noted in case it shows up on a
router. If it does, restarting the server cleared it here.

## 4. T3's own startup token in the log

T3 0.1.7 mints a startup pairing link at every non-desktop start. In the
container (no TTY, so the headless presentation) it prints this to **stdout**,
followed by a QR code:

```text
T3 Code server is ready.
Connection string: http://172.17.0.2:3773
Token: <12-character one-time token>
Pairing URL: http://172.17.0.2:3773/pair#token=<same token>
App link: t3code://pair?pairingUrl=…
```

The address is the container's own IP, which a router admin's browser can't
reach through `/app`'s dst-nat. The token is live until used or expired.
If the `/app` container's output reaches RouterOS `/log`, any RouterOS user
who can read the log can read that token while it's valid. That's a reason
**not** to point users at the log for a token, and our log line names the
command instead. Whether this output reaches `/log` on RouterOS is a CHR
check below; if it does, it's worth a README note and maybe an upstream
option to suppress the startup token.

## Open items

- **CHR checks (pending):** the log line in RouterOS `/log` (and whether T3's
  own startup `Token:` line lands there too), and the panel on a router-served
  page. Needs an image pushed to a registry the CHR can pull (`:sha-<commit>`
  from CI) and the `chr-app-lab` recipe.
- **Upstream request:** a server-configurable pairing hint (env or policy
  field) would replace the helper. Our case is a headless server whose shell
  is another device's CLI. Not filed yet.
- The hosted T3 web app, the mobile app and the desktop client render their
  own pairing screens; the helper only covers the browser UI this container
  serves.
