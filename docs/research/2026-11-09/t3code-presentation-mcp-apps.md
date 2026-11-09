# T3 Code MCP Apps: support, placement and callbacks

Part of the [presentation inventory](t3code-presentation-menu.md). This note
concerns T3's implementation, not MCP Apps compatibility across other hosts.
Baseline: v0.1.7, commit `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`.

## Finding: Codex-only is a T3 adapter limitation at this revision

The upstream [visual-replies guide][guide] explicitly limits interactive MCP
Apps to Codex. A separate Claude Opus 5.5 research pass checked the adapters
and confirmed this is implemented in source, rather than merely an absence
of Claude testing.

| Provider / output | T3 support at this pin | Evidence |
| --- | --- | --- |
| Codex MCP App | Capture and interactive callbacks implemented | `CodexAdapterV2` supplies `runtime.mcpApps` |
| Claude MCP App | Ordinary tool-call presentation; no app callback implementation found | `ClaudeAdapterV2` does not supply that runtime field |
| ACP MCP App | No app callback implementation found | ACP adapter does not supply that field |
| Claude or other provider using `html_render` | Supported independently of MCP Apps | T3 HTML MCP tools and shared render detection; docs say every provider |

The optional [provider runtime interface][adapter] defines app `listTools`,
`callTool` and `readResource` operations. The [Codex adapter][codex] reads app
resource metadata from Codex app-server tool items, retrieves the HTML
resource and writes the captured app reference into the tool output.
The [Claude adapter][claude] routes MCP servers through its SDK but lacks
this T3 capture/callback path. This research does not claim that Claude or
its SDK could never support MCP Apps; additional T3 adapter work is required.

The [server request service][requests] rejects callbacks when the runtime
does not provide `mcpApps`. It is not enough for an arbitrary MCP result to
include a blob of HTML and expect T3 to make it an interactive app.

Claude's research session also observed T3's HTML/preview tools and injected
visual-reply guidance in its available tool/instruction inventory. It did
not invoke a render or app tool. The provider conclusion is source-confirmed,
not an end-to-end two-provider demonstration.

## Human placement: a result in chat, with fullscreen

T3 puts the app **inside the conversation timeline, in place of the tool
row**, not into a right-side browser tab or the Thread details card.
The [timeline renderer][timeline] and [app frame][frame] implement that path.

The app follows the T3 theme and controls its own interactive content. It
can request fullscreen after genuine user interaction. Fullscreen uses a
popover on web/desktop; approval requests return it inline. The guide
documents different mobile fullscreen lifecycle behavior, where reopening
can reset state the app did not save.

No app-tool argument was found that selects the Thread details card or
right-side tab as its destination. Those are separate
[layout surfaces](t3code-presentation-layout.md).

## What interaction can do

| App action | T3 behavior / boundary |
| --- | --- |
| Call a tool | Calls tools on the originating MCP server through the live provider session |
| Call a read-only tool | T3 can skip the host confirmation when the server marks it `readOnlyHint` |
| Call another visible tool | Host asks for confirmation; hidden/model-only tools are rejected |
| Send a message to the thread | User confirmation required |
| Update model context | Latest app note is included with the next user message/turn; does not itself start an agent turn |
| Open a link | Real user interaction required; mobile adds a confirmation per upstream docs |
| Offer a file | Host-controlled download behavior; mobile asks before saving |
| Navigate the app away | T3 stops the app |

Server annotations inform confirmation behavior; they are not a substitute
for centrs authentication or RouterOS write validation. A future RouterOS
app must preserve those backend controls.

The [app protocol definitions][protocol] and frame enforce a sandbox without
same-origin access to T3. App-declared CSP origins constrain connections and
resources; permissions such as clipboard/camera/microphone/geolocation have
explicit declarations. This is not arbitrary privileged JavaScript in T3's
desktop process.

## Session and persistence limits

- T3 stores a snapshot of the app HTML, so it can remain viewable after the
  originating agent session stops.
- Tool/resource callbacks require that provider session to be available.
  The server returns `session-stopped` rather than silently starting an agent.
  The guide tells the user to send a message in the originating thread first.
- Selected app context is stored for the conversation and passed on the next
  turn. The inspected implementation bounds it to 16 KiB.
- A failed app-resource capture can fall back to an ordinary tool row. Seeing
  a plain result is therefore not enough on its own to diagnose provider
  support; capture failures also need checking.
- Switching a thread between providers and resuming a previous provider's
  app was not tested. Do not promise that an app survives provider changes
  with working callbacks.

## Why centrs should investigate this

An interactive table/topology/inspector could reuse centrs's existing MCP
server operations and return user selection context to the agent, instead
of requiring the agent to reconstruct that state from chat. That is the
reason to flag this on #29. It is an exploratory capability, not a centrs bug
or a commitment to implement an app.

For an ordinary snapshot, a hypothetical CLI HTML-output option remains
useful independently: the agent can pass that HTML through `html_preview`
and `html_render`, including from Claude. CLI-generated HTML does not gain
the MCP App tool/context bridge merely by being rendered.

## Follow-up questions

1. On the deployed T3 pin, exercise a small app through Codex and Claude;
   record chat placement, fullscreen, approvals and session-stop behavior.
2. Check newer T3 releases for a Claude capture/callback implementation before
   continuing to describe the provider limitation as current.
3. Investigate whether centrs should supply app resources, a CLI HTML snapshot,
   or both. Keep these as separate output contracts.
4. Establish backend read-only/write annotations and selected-context behavior
   before implementing an interactive RouterOS action.

[guide]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/html-renders.md
[adapter]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/packages/provider-core/src/server/ProviderAdapter.ts
[codex]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
[claude]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
[requests]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/server/src/mcpApps/McpAppRequests.ts
[timeline]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/TimelineAssistantRows.tsx
[frame]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/chat/McpAppFrame.tsx
[protocol]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/packages/shared/src/mcpApp.ts
