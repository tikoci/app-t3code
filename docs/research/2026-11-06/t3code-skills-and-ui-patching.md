# T3 Code skills and container UI patching

Research assignment, 2026-11-06 PT. This records integration options for
`app-t3code`; it does not install skills or change the shipped UI.

**Both requests are feasible.** Install skills in the providers' user-home
locations under `/data`, and provision them before T3 starts. For the immediate
pairing-page need, the image can add a small JavaScript helper to the existing
web client. A source patch and web-client rebuild is available when changes
need to participate directly in React's layout and state.

## Baseline and evidence

The repository's Dockerfile defaults to **T3 Code 0.1.6**, downloads its release
archive with SHA256 verification, and extracts it to `/opt/t3code`. Research
uses upstream tag `v0.1.6`, commit
`2359643cffa6ba9ee84d6f2694b935de54a8013e`, and local amd64 image
`app-t3code:slice4`, image ID
`sha256:746a51bded93aafb5db4f638412564989e1a583cf0814b77aa13595ceb51b914`.
This is a local image, not a verification of the currently published GHCR tag.

GitHub's latest-stable endpoint returned **0.1.7**, commit
`322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`, during this research. Its pairing
component, static-directory resolver, and archive builder match 0.1.6 exactly.
The HTTP handler and Claude discovery file changed; the inspected changes
retain the relevant static-serving and skill-root behavior. This is a targeted
comparison, not a recommendation to update the image or a claim about later
releases. [Source pins and file blob IDs](t3code-integration-sources.json)
make the baseline recoverable.

The [offline probe](t3code-integration-probe.ts) and
[saved results](t3code-integration-probe.json) exercise the packaged executables
and HTTP server in a disposable Docker container with `--network none`, no
host mounts, and no published ports. They make no inference/model calls and
use a fresh home without credentials. Root is used only inside this disposable
container to edit an image-owned HTML file; production still runs as `node`.

## 1. Where user skills go

T3 Code exposes a **provider-specific skill inventory**, rather than loading a
single `~/.t3/skills` directory for every model. A skill belongs in a directory
containing `SKILL.md`, normally with YAML front matter containing `name` and
`description`. A loose `~/SKILL.md` is not the user-level layout to use.

Both the [Dockerfile](../../../Dockerfile) and
[/app YAML](../../../app/t3code.tikapp.yaml) set `HOME=/data` and
`T3CODE_HOME=/data/.t3`; the existing named volume mounts the whole `/data` home.
T3's home setting selects its application state. It is not a replacement for
the agent providers' configuration directories.

| Provider / scope | Path in this container | Evidence and qualification |
| --- | --- | --- |
| Codex, user | `/data/.agents/skills/<name>/SKILL.md` | Preferred shared user location in [official documentation](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills); discovered by packaged Codex 0.166.0 in the offline probe. |
| Codex, provider home | `/data/.codex/skills/<name>/SKILL.md` | Also discovered in the probe. Useful compatibility location; follows a configured Codex home, so do not assume every provider instance uses the default. |
| Claude, user | `/data/.claude/skills/<name>/SKILL.md` | T3's [Claude discovery code](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/provider/Drivers/ClaudeSkills.ts#L415) resolves provider `homePath`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. Source-confirmed; no live Claude CLI was installed or exercised here. |
| OpenCode, user | `/data/.config/opencode/skills/<name>/SKILL.md` | Native location; packaged OpenCode 1.19.5 discovered it offline. |
| OpenCode, shared compatibility | `/data/.agents/skills/<name>/SKILL.md` and `/data/.claude/skills/<name>/SKILL.md` | Both discovered offline; also described in [OpenCode's documentation](https://opencode.ai/docs/skills/). External-skill settings can disable compatibility discovery. |
| Codex / OpenCode, project | `<checkout>/.agents/skills/<name>/SKILL.md` | Discovered offline. Scope follows the selected workspace and provider, not the browser computer. |
| Claude, project | `<checkout>/.claude/skills/<name>/SKILL.md` | T3's discovery scans the current workspace and explicit `--add-dir` roots, plus enabled plugin skill roots. Do not generalize this scanner to every ancestor behavior supported by newer Claude versions. |

In the same probe, Codex did **not** list the loose home `SKILL.md`, a skill under
`~/.t3/skills`, or the Claude/OpenCode-only locations. OpenCode did **not** list
the loose home file, `.t3/skills`, or `.codex/skills`. Both discovered a skill
directory symlinked from `.agents/skills` to a separate image-style location.
These are discovery results, not proof that an agent followed an instruction.

For a shared RouterOS bundle, use `.agents/skills` for Codex/OpenCode and expose
the same curated directories through `.claude/skills` for Claude. Preserve the
whole skill tree, including relative references and scripts. Avoid installing
two copies with the same name in multiple roots read by the same provider:
duplicate handling varies. T3's [composer inventory](https://github.com/pingdotgg/t3code/blob/v0.1.6/packages/client-runtime/src/providerSkills.ts)
also deduplicates names and filters disabled or non-user-invocable skills.

### How T3 applies them

1. **Discover for the selected provider and workspace.** For Codex, T3 asks the
   Codex app-server for `skills/list` with `cwds: [cwd]`; it does not implement
   its own filesystem scan. See [CodexProvider](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/provider/CodexProvider.ts#L647).
   Claude uses T3's filesystem/settings scanner. OpenCode discovery delegates
   to its runtime (`app.skills` in the existing path, `skill.list` for the v2
   path): [driver](https://github.com/pingdotgg/t3code/blob/v0.1.6/packages/provider-opencode/src/server/driver.ts),
   [runtime](https://github.com/pingdotgg/t3code/blob/v0.1.6/packages/provider-opencode/src/server/OpenCodeRuntime.ts#L792).
2. **Offer explicit selection.** Type `$` in the composer; skills can also
   appear in the slash menu, controlled by **Settings → Chat → Show skills in
   slash menu**. Selection follows the environment/provider/workspace. See
   upstream's [composer guide](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/composer.md#commands-and-skills).
3. **Let the provider execute the skill semantics.** Codex receives `$name`
   mentions. T3 translates Claude mentions into its native `/name` form; only
   the final named skill gets native expansion, with special handling for
   earlier user-invocation-only skills. See [Claude dispatch](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts).
   Automatic selection and reading supporting files remain provider behavior.
   Installation does not mean every skill body is inserted into every turn.
4. **Refresh running agents after changes.** Upstream documents **Restart agent
   session** after changing skills, plugins, or MCP servers. The composer also
   caches workspace snapshots; a list refresh alone should not be treated as
   proof that an existing agent session loaded new instructions.

Claude skills with `disable-model-invocation` can still be manually invoked;
`user-invocable: false` hides a skill from user selection. Config-directory
skills win over same-named project skills in the inspected T3 scanner. These
are provider-specific controls, not a universal distribution selection API.
See [T3's Claude guide](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/providers-claude.md#skills)
and [Claude's skill documentation](https://code.claude.com/docs/en/skills).

The image also ships Muse. A common skill-discovery contract for Muse was not
established by this research: its inspected [driver](https://github.com/pingdotgg/t3code/blob/v0.1.6/packages/provider-muse/src/server/driver.ts)
does not expose the Codex/Claude-style workspace skill inventory. Do not promise
that the shared layout covers every provider.

### Recommended distribution design (proposed, not implemented)

Keep versioned, curated skill trees in an image path such as
`/usr/share/t3code/skills/`, outside `/data`. At startup, as `node`, create
per-skill links in the appropriate provider homes before `exec t3 serve`.
The entrypoint already prepares the persistent home before starting T3.
**Do not just `COPY` skills into `/data` in the Dockerfile:** the mounted home
hides image contents there, and existing installations already have a volume.

Use an ownership manifest for the links created by the distribution. Preserve
user-created directories and files, report name collisions, remove only links
owned by the installer when deselected, and repair those links on replacement.
Image-backed links pick up new content on an image update; recorded content
hashes can make that update visible. An operator wanting a customized copy
should be able to replace a managed link with a real directory that wins.
The probe establishes symlink discovery for Codex/OpenCode; validate the same
layout with the installed Claude version before claiming coverage there.

An optional **new** `T3CODE_SKILLS` selector could choose curated groups, using
a space-separated value such as `routeros lab`, with an explicit `none` value.
There is no such selector in the current image. Keep this independent of
`T3CODE_TOOL_GROUPS`: knowledge can be useful when an optional executable group
is not installed. A selected skill should inspect `t3code-tools status --json`
and available commands instead of assuming all tools are ready.

The initial context skill should explain the container/host distinction,
`/data` persistence, the preferred centrs device-access path, disposable CHR
labs, and tool readiness. Point to the specific RouterOS skill trees for
commands and workflows. Skills supply instructions; they do not provision
router credentials, configure an MCP server, or grant capture/kernel privileges.
Provider-specific homes configured in T3 settings must also be accounted for;
a default-home installer cannot silently cover arbitrary future instances.

For `/app`, this can ship through an ordinary image update with **no YAML
change**. If a selector is later added to YAML, give it the same Dockerfile
`ENV` default. Operator `environment=` updates replace the entire environment
list and split on commas: use the already documented update procedure, not a
YAML edit. The [environment research](../2026-11-05/app-set-environment.md)
records these facts and the YAML volume-reset reproduction on 7.25.1 and
7.26beta5. If YAML ever must change, follow the complete offline backup/restore
procedure in the [README](../../../README.md#what-survives-an-image-replacement),
including external projects and all app-owned volumes. Regenerate the README's
embedded YAML-editor link as required by `AGENTS.md`.

## 2. What can be patched in the packaged UI

The browser frontend is **React with TanStack Router, built by Vite+**. The
release server is a Node single-executable application, with separately shipped
runtime dependencies. The image's Node 24 installation does not mean T3 itself
is an editable Node source tree or runs using that particular Node binary.
Upstream's [server build configuration](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/vite.config.ts)
describes the executable packaging.

The important separation is visible in the release archive:

```text
/opt/t3code/
  t3                       # server/CLI executable
  client/
    index.html             # SPA entry document
    assets/*.js, *.css      # compiled browser code, styles and other assets
    ...icons and notices
  node_modules/            # external runtime dependencies
  lib/
  resource-monitor/
```

Upstream [copies the web build](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/scripts/cli.ts#L91)
into `dist/client`, and the [archive builder](https://github.com/pingdotgg/t3code/blob/v0.1.6/scripts/build-cli-archive.ts#L501)
stages that directory beside `t3`, removing source maps. The [static resolver](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/config.ts#L268)
looks for adjacent `client/index.html`. Thus frontend files can be changed
after archive verification and extraction, before completing our image.
Preserve upstream copyright and third-party notices when distributing changes
([upstream MIT license](https://github.com/pingdotgg/t3code/blob/v0.1.6/LICENSE)).

No supported arbitrary HTML/JS injection setting or frontend plugin loader was
identified in the inspected startup, static-serving, build, and pairing code.
Provider plugins and MCP integrations are separate capabilities: they do not
provide an unauthenticated pairing-page UI slot. A distro overlay would be our
own maintained patch.

| Method | Suitable changes | Cost and limits |
| --- | --- | --- |
| Add a script/style reference to `client/index.html`, ship helper assets alongside it | Pairing help, a copy-command button, small deployment-specific text; limited CSS hiding | Smallest initial change; keeps the upstream web build. A helper must observe React mounting/navigation and keep additions scoped and idempotent. DOM structure is an upstream dependency. |
| Replace an exact string in compiled JS | A narrow wording replacement/removal | Feasible but fragile. Assert the expected match count and fail the build on drift. Minified identifiers and chunk names change. Plain text substitution does not create a proper code block or React component. |
| Patch upstream TSX and rebuild only the web client | Changes to component layout, conditional content, buttons, or several pages | Cleaner React integration and hashed assets; requires pinned upstream source, its package manager/toolchain, and a reproducible web build. Keep the matching released server binary. |
| Rebuild server and client from patched upstream source | New server-supplied deployment metadata, APIs, or changed backend behavior | Largest maintenance scope and per-architecture executable/native-dependency work. Unnecessary for static pairing instructions. |

CSS hiding changes presentation only. It is not an authorization mechanism.
A reverse proxy could also rewrite HTML, but adds response-rewriting/compression
and deployment complexity without improving this single-container use case.

### Exact pairing-page patch location

Use [apps/web/src/components/auth/PairingRouteSurface.tsx](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/web/src/components/auth/PairingRouteSurface.tsx).
`PairingRouteSurface` renders the **Pair with this environment** heading,
`<Input id="pairing-token">`, submit/reload buttons, and the explanatory panel
from `describeSupportedMethods`. The natural source-level insertion point is
after the form and before that explanatory panel. Its parent route is
[apps/web/src/routes/pair.tsx](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/web/src/routes/pair.tsx).

That file also contains `HostedPairingRouteSurface`, which handles a hosted
client's backend-link flow. The separately named
[ConnectAgentSurface](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/web/src/components/auth/ConnectAgentSurface.tsx)
is MCP OAuth approval. Neither is the initial local browser token-entry form.
Patch the intended surface explicitly. Changes to this container's web files
also cannot change T3's separately hosted web app, native mobile app, or desktop
client when those clients render their own screens.

In the measured release, the heading text was in
`client/assets/main-D6TScBsg.js`. That filename is evidence, **not an interface
to hard-code for future releases**. `index.html` is mostly the SPA boot shell;
there is no standalone pairing HTML template there to edit.

### Immediate recommendation: a small pairing-help overlay

For the current requirement, add a versioned, self-contained helper to the
verified archive during image build, with one guarded insertion into
`client/index.html`. Use `#pairing-token` as the initial presence check rather
than a generated CSS class or an English heading. The helper can wait for React
using `MutationObserver`, add the help once, remove it when the gate disappears,
and disconnect/avoid observation loops. Keep its added DOM under its own control
and avoid competing with React for existing nodes. If fitting the native card
requires brittle DOM restructuring, use the TSX rebuild approach instead.

Proposed page copy:

> **Running this app on MikroTik RouterOS?** Open the router's Terminal in
> WinBox, WebFig, or SSH and run the command below. Copy the value after
> `Token:` into the Pairing token field above. If the output contains a pairing
> URL, open that link instead. Run the command again if the token expires.

Use the existing [README command](../../../README.md#pairing-with-the-web-ui)
as the initial command payload, reproduced without changing its RouterOS syntax:

```routeros
:put "** Using T3Code **\r\n\r\nIn your browser go to: $[/app/get t3code ui-url]\r\n\r\nThen, use the Token below in your browser to connect it with this container:\r\n$[/container/shell app-t3code cmd="t3-pairing-link" as-value]"
```

Present it in a selectable, wrapping or horizontally scrollable code block
with a copy button. Keep the default names `t3code` (app) and `app-t3code`
(container) explicit; customized/multiple installations must adjust them.
The hostname in the browser is not a reliable source of the RouterOS object
names. Clipboard APIs can fail on plain HTTP; leave manual selection usable.
Render command text with `textContent`/normal JSX escaping, preserving literal
`$`, quotes, and `\r\n`; do not interpolate it in a shell or decode the escapes
into physical newlines. Ideally maintain one command source and check it against
the README so documentation and on-screen help cannot silently diverge.

The existing [t3-pairing-link](../../../bin/t3-pairing-link) wrapper invokes
`t3 auth pairing create --label RouterOS`. If `PUBLIC_URL` is set it also passes
`--base-url`, yielding a full pairing link; otherwise it prints token details.
It uses the mounted home's existing authentication state. The page should show
instructions, not a pre-generated token, and must not gain an unauthenticated
endpoint that executes the wrapper or creates grants. RouterOS terminal access
is what authorizes the human to request a fresh credential. Keep the existing
exchange/expiry/one-time-token behavior intact; see upstream's
[authentication design](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/internals/environment-auth.md).

### What the HTTP probe establishes

After inserting an external script reference into the disposable container's
`index.html`, unauthenticated GETs to `/` and `/pair` both returned HTTP 200
with the reference. `/routeros-research.js` returned the added marker file.
`/api/auth/session` reported `authenticated: false` and `one-time-token`
bootstrap support. The pairing-bearing JS asset was also publicly served.
This proves the packaged server can deliver our addition before authentication;
**it does not prove browser execution, visual placement, clipboard behavior, or
successful pairing**. The probe script intentionally contains only a marker.

The observed responses had no CSP header and used `Cache-Control: no-cache`
for HTML, the helper, and that JS asset. This archive lacked
`.vite/manifest.json`. Upstream's [HTTP handler](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/http.ts#L515)
can instead give assets a one-year immutable cache lifetime when both their
name and the build manifest qualify. Therefore, never assume a compiled-file
edit under the same hashed URL will refresh for existing clients. Prefer a
versioned helper URL or correctly rebuilt content-hashed assets; account for
proxy caches too. Recheck CSP if the server or reverse-proxy setup changes.

### When to switch to a source patch

For a maintained React help panel, patch the TSX file at the matching upstream
tag and build `@t3tools/web`; copy the **complete** resulting `apps/web/dist/`
into `/opt/t3code/client/` in our image. Keep all chunks, workers, styles, icons,
licenses, and manifest data together. Mixing web and server releases risks
contract mismatches, so tie the source ref to `T3CODE_VER`.

The inspected [upstream package](https://github.com/pingdotgg/t3code/blob/v0.1.6/package.json)
declares Node **26.12.1** and pnpm **12.14.0**, while this repository's own
scripts use Bun. Use those upstream pins in an isolated web-builder stage;
do not assume `bun install` or the runtime image's Node 24 reproduces its build.
The root command pattern is `vp run --filter @t3tools/web build`, after a
frozen-lockfile install. Build configuration, including `APP_VERSION` and
`VITE_*` public endpoints, is defined in the [web Vite config](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/web/vite.config.ts).
Changing runtime container env does not rewrite already-compiled browser
constants. A web-only build was not attempted here; the source and archive
boundaries establish the route, not its measured build cost.

## Follow-up implementation checks

For skills, exercise a fresh home and an existing home, offline replacement,
user overrides, deselection, custom provider homes, and every provider claimed
supported. Confirm the composer inventory and an explicit harmless skill
invocation after restarting the agent. Preserve relative-reference paths.

For pairing help, require a build-time assertion that the patch applied once.
Verify direct `/` navigation and `/pair`, rendering on desktop/mobile widths,
literal command copying, normal token entry, expired-token retry, successful
pairing, and help removal after authentication. Use a disposable CHR for the
RouterOS command/end-to-end check; this research did not rerun the README
command on a router or boot a CHR. Neither native ARM64 nor hosted/native-client
UI behavior was tested here. On upstream version changes, recheck the pinned
source locations and rerun the probe before accepting the patch.

To reproduce the measured offline subset with an available local image:

```sh
docker run --rm -i --network none --user 0 \
  -e T3CODE_RESEARCH_DISPOSABLE=1 --entrypoint bun app-t3code:slice4 - \
  < docs/research/2026-11-06/t3code-integration-probe.ts
```

Do not attach an operator's home to that command: the fixture deliberately
modifies an image-owned HTML file in a disposable writable layer. Substitute
a newly built image when checking a future release and save its version/image
identity with the results.
