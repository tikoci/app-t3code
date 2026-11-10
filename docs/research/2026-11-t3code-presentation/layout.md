# Where T3 Code shows agent output

Part of the [presentation inventory](README.md), pinned to
T3 v0.1.7. Findings below are from source and exposed tool contracts, not a
recorded browser walkthrough. The later demonstration below records limited
runtime evidence separately.

## Distinguish the surfaces

| Surface | Default location / layout | Agent controls | Human/client controls |
| --- | --- | --- | --- |
| `html_render` result | Embedded in the conversation above the final reply | HTML document, title and initial height | Expand/fullscreen and zoom |
| MCP App | Embedded in the conversation as the tool result | Tool invocation; app controls its own contents | Interaction, approval prompts, fullscreen |
| Browser preview | Preview workspace alongside chat | Open/show a tab, URL/port, profile, viewport, appearance | Workspace placement, maximize, mini-player/separate-window controls where available |
| File/document preview | Existing file preview workspace | Produce and link the file; no exposed direct-open command found | Click the link to open the viewer and use its controls |
| Thread details | Card alongside chat when space permits; popover otherwise | Existing project metadata/actions and thread state | Show/hide built-in items and card visibility |
| Device preview | Existing preview/device workspace | Open a supported simulator/emulator | Preview layout controls |

An HTML document opened as a file, an inline HTML reply, and a browser pointed
at a URL may show identical content but have different ownership, lifetime,
controls and backend connections.

## For skills: which calls actually show something?

| Intended action | Direct agent action available? | Mechanism |
| --- | --- | --- |
| Display ordinary Markdown in chat | Yes | Assistant message; no extra viewer |
| Display HTML in chat | Yes | `html_preview`, then `html_render` |
| Open/show a browser page | Yes | `preview_open({url, open: true})`; `preview_navigate` navigates a chosen tab |
| Open the native Markdown/file viewer | No exposed command found | Absolute-path file link; the human activates it |
| Make an HTML file the active right-side file-viewer tab | No exposed command found | Rendering support exists, but opening the viewer and selecting its tab are client UI actions |
| Place a browser in a chosen popout/right-side arrangement | No placement argument exposed | Human/client layout controls |
| Display an MCP App | Conditional | Invoke an app-enabled tool through a supported provider; it appears in chat |
| Display a supported mobile device | Yes | `device_open` |

“Show the user X” in a skill should invoke a direct presentation action when
that is what is intended. A sentence asking the user to click a file link
must be identified as a navigation fallback. The native viewer's existence
does not imply agents have an API for opening or focusing it.

## Limited runtime demonstration, 2026-11-09

1. Converted the full MCP Apps research Markdown note to self-contained HTML,
   previewed it, then published it with `html_render`. That demonstrated the
   HTML-in-chat path, not a special native Markdown viewer. Chat messages
   themselves already render Markdown.
2. Emitted an absolute-path link to the original `.md` file. This only offered
   the human a way to open the native viewer; it did not change views automatically.
3. Called `preview_open` for the [same note on GitHub][demo-file] with
   `open: true`. The host returned `available: true`, `visible: true` and
   the expected page title/URL. The user took browser control before further
   agent scrolling/content inspection, so those actions stopped. This is a
   browser tab displaying a hosted document, not T3's native file viewer.

No native-file-viewer direct-open API was found when rechecking the available
tools and the pinned server MCP toolkit. No unsupported internal UI calls or
desktop automation were used to manufacture one. This includes both opening
the right-side viewer itself and activating a particular file tab, whether
the file contains Markdown or actual HTML.

### User-observed floating preview and cleanup

The user's subsequent screenshot showed the browser as a small floating
preview with **Agent has control / Take control**, rather than the desired
right-side file-viewer tab. The user reported that resizing worked, but
moving it, converting it to a tab and dismissing it were not available or
apparent in that client. These are observations of this demonstration, not
a claim that every T3 client lacks those controls.

The agent subsequently closed its browser preview successfully with
`t3_preview_close`. This tool controls the browser preview; it does not open,
close or focus the native file viewer. No native HTML-file tab was opened
or activated by the agent during the demonstration. The user's screenshot
is not included in the public research files.

## HTML in chat

The answer to “is `html_render` HTML in the chat view?” is **yes**.
Its input is a complete HTML string, a title and an initial height. There is no
argument selecting a right-side tab or floating window.

The published page runs scripts in a sandbox and receives T3 theme variables.
It has no general bridge for executing agent tools. An interactive filter over
data already embedded in the page is different from an authenticated live
RouterOS inspector. Local images are embedded when published. Thread deletion
deletes the published pages. See [visual replies][visuals].

The current tool schema accepts an initial height of 80–2000 CSS pixels; its
description separately documents automatic fitted height up to 20,000 pixels.
These are different limits. The contract asks for fluid, theme-aware content
without a whole-page card/background and rejects viewport-height layouts.

## Browser preview and popouts

`preview_open` accepts a URL or an environment-port target, `open`/`show`,
tab reuse and a browser profile. **It has no panel-placement parameter.**
`preview_resize` changes the page viewport, not where the workspace panel sits.

The [panel shell][shell] has inline, sheet, sidebar and embedded modes;
the [mini-player store][mini] separately tracks a floating browser/device
preview and its position/size. The [preview menu][preview-menu] also includes
an “Open separate preview window” action when supported by the host.
These establish layout variants in the pinned source, not a guarantee that
all controls are available on the user's current browser-control overlay.
The demonstrated client showed the floating preview described above. An
`available: true` / `visible: true` tool response confirms visibility, not
that the result occupies a right-side tab. These are not extra `html_render`
destinations exposed to an agent.

Browser automation has a separate ownership boundary: the agent may act on its
own or unclaimed tab, while reading a human-driven tab has narrower behavior.
Some tabs belong to the local desktop runtime and cannot be automated by the
server environment's tools.

## The floating card with the server, editor and scripts

The card containing the environment/server, **Open in VS Code**, **Add project
script**, and Git controls is **Thread details**. [Its implementation][details]
places it beside chat when the layout has room and uses a popover otherwise.

Its [content component][details-panel] renders built-in Workspace and Version
Control sections. Workspace includes the environment/worktree picker, editor
picker and project scripts. These rows are internal React components, not
arbitrary HTML or an MCP resource slot.

There is already a human setting to reduce Git clutter: the card's context menu
has **Show in thread details**, with independent visibility choices for
**Branch and pull request**, **Git actions**, **Changes**, and other rows.
The [fixed item list][items] also includes servers, automations, lineage,
side chats, usage limits and context. This is client-side visibility, not
disabling T3's source-control integration. No settings were changed here.

No exposed agent tool or supported extension-registration API was found to
add a custom “target router / identity / connection” row to this card. The
existing tools update known project/thread fields; they do not define new
Thread details sections. A native router-status row would need an upstream
extension point or a maintained frontend change.

There is a narrower existing route: the built-in [Servers row][servers]
lists discovered listening ports associated with the thread and opens them
in preview. A local status page or proxy started by a project action is a
possible experiment using that row; port discovery and naming would need
verification. It would still be a server entry, not a custom router-status
component. Side chats and automations likewise have predefined rows rather
than app-defined sections.

## Project scripts are persistent command entry points

`t3_project_update.scripts` defines named actions, commands, icons and optional
`previewUrl` / `autoOpenPreview`. The same project actions can be imported
from `t3.json`. These are exposed in the existing project-script UI, including
Thread details. See [project settings][settings].

An action's browser preview URL is **different from `html_render`**: it opens a
browser destination associated with running the action. The action can be a
terminal command without a preview. It does not publish HTML into chat and
does not create a custom status row in the card.

## Follow-up questions

- Confirm the precise layout labels and available popout controls on the
  deployed RouterOS-hosted server and the user's connected desktop client.
- Evaluate existing project actions for convenient human entry points before
  requesting a native router-context row.
- If asking upstream for a new row, distinguish a context/status extension
  from a browser tab, MCP App, or arbitrary HTML injection.
- The device workspace is a plausible future home for a VM/console display,
  but its current API only opens supported mobile devices. CHR/QEMU console
  registration was not found.

[visuals]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/html-renders.md
[shell]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/preview/PreviewPanelShell.tsx
[mini]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/previewMiniPlayerStore.ts
[preview-menu]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/preview/PreviewMoreMenu.tsx
[details]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/ThreadDetailsCard.tsx
[details-panel]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/ThreadDetailsPanel.tsx
[items]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/threadDetailsItems.ts
[servers]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/ThreadServersPanel.tsx
[settings]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/project-settings.md
[demo-file]: https://github.com/tikoci/app-t3code/blob/cd183c1ee9c89e97bcf241f478d46ddefcfa722f/docs/research/2026-11-t3code-presentation/mcp-apps.md
