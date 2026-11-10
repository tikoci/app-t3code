# T3 Code presentation surfaces for RouterOS tooling

Research date: 2026-11-09. Refs [Roadmap #30][roadmap] and
[tooling feedback #29][feedback]. This is a capability inventory and a set of
questions for later work, not an integration specification.

## Read this by area

| Area | Reference | Main question |
| --- | --- | --- |
| Placement and persistent controls | [Layout and project actions](layout.md) | Chat, right-side tabs, floating preview, or Thread details? |
| Interactive tool results | [MCP Apps](mcp-apps.md) | What does T3 support, including Claude? |
| Existing viewers and syntax | [Files and RouterOS highlighting](files.md) | TSV, SQLite, Mermaid, TOML, and `.rsc` |
| Private credential entry | [Secret requests](secrets.md) | What reaches the model, filesystem, and centrs? |
| Evidence and version pins | [Evidence manifest](evidence.json) | Which source and exposed tool contracts support this? |

Each reference separates established behavior from untested possibilities and
has its own follow-up questions, so individual avenues can be refined without
rewriting the whole inventory.

## Baseline and limits

- Source baseline: upstream **T3 Code v0.1.7**, commit
  `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`, matching this image's T3 pin.
- The author used Codex in a T3 desktop nightly. Exposed tool schemas were
  inspected on 2026-11-09; they are not a version fingerprint for every client.
- Evidence levels: **contract** means an available tool schema; **source**
  means the pinned implementation/docs; **probe** means a small local function
  invocation. **Idea** means an avenue that has not been implemented or tried.
- The initial inventory was source/contract research. A later demonstration
  published this research note as inline HTML and used `preview_open` to open
  its GitHub copy; the host reported the browser tab visible. Native file-viewer
  opening was only a clickable link. No real credential submission, router
  operation, or container-side presentation test was performed. Source support
  does not prove that every paired client has a feature enabled.
- No dedicated T3 presentation skill was listed in the author's session. T3's
  presentation guidance came from injected agent instructions and its MCP
  tools. Provider-native skills and plugins are separate inventories.

## Capability menu

| Surface | Agent entry point | Human presentation | Evidence / qualification |
| --- | --- | --- | --- |
| HTML reply | `html_preview`, then `html_render` | Interactive document in the chat timeline; expand/zoom available | Contract + source; all providers according to upstream docs |
| MCP App | Invoke an app-enabled MCP tool | Interactive result replaces that tool's ordinary call display in chat | Source; provider limitation explained in the dedicated note |
| Shared browser | `preview_open` with a URL or environment port | Browser surface; demonstrated as a floating control preview in this desktop | Contract + source + limited demo; visibility does not imply a right-side tab, and agent cannot select placement |
| Browser evidence | `preview_snapshot`, `preview_recording_start` / `stop` | Screenshot or recording file that can be embedded in chat | Contract; captures the chosen browser tab, not an arbitrary desktop |
| File viewer | Create a file and include an absolute-path Markdown link | File/document preview after the user activates the link | Source; no exposed agent command found to open this viewer directly |
| Inline media | Markdown image syntax referencing an absolute file path | Image, video, or audio in the conversation | Injected runtime contract; create the media with appropriate tools first |
| Rich Markdown | Assistant message text | Tables, code, math, Mermaid and collapsible details | Source; rendering does not imply RouterOS language intelligence |
| Questions | Provider question tool | Choices/custom-answer cards in the conversation | Source; provider-specific question support varies |
| Secret entry | `request_secret` | Dedicated masked-input card in chat | Contract + source; reference and file delivery have different guarantees |
| Project actions | `t3_project_update.scripts`, or imported `t3.json` actions | Named command buttons, terminal output, optional browser preview | Contract + source; useful existing entry point in Thread details |
| Project identity | `t3_project_update` | Title, icon, emoji, monogram, favicon | Contract; identity rather than a custom status widget |
| Thread navigation | Returned native thread links; documented prompt links | Open a thread or populate a draft prompt for review | Source; prompt links do not execute the prompt |
| Thread organization | Rename, pin, snooze, mark unread, settle | Sidebar title, grouping and attention state | Contract; not a general alert/card API |
| Scheduled reports | `schedule_task` with a destination thread or new-thread behavior | Later findings appear in an ordinary conversation; automations have a built-in details row | Contract + source; relevant as a report delivery path, not a custom display surface |
| Device display | `device_open`, `device_screenshot` | Device panel for configured iOS/Android hosts | Contract; no arbitrary CHR/QEMU display registration exposed |
| PR presentation | Link/watch tools; `write_pull_request_guides` | PR badges, status, diffs, review-tour Guide tab | Contract + source; retained for completeness, lower priority here |
| Activity and progress | Ordinary command/file/tool/plan events | Expandable activity log and live command output | Source; T3 chooses layout and grouping |
| Notifications | Agent lifecycle/input events | User-configured completion, failure or input alerts | Source; no arbitrary notification tool was exposed |
| Template compatibility | Recognized Codex artifact-template directive | Typed template card with a Use template action | Source; predefined skill/template format, not a generic card API |

Sources: [visual replies][visuals], [source control][sc],
[activity log][activity], [prompt links][prompts], [question attachments][questions],
[notifications][notifications], [Markdown renderer][markdown] and
[template format][templates]. Full relevant tool descriptions and input schemas
are preserved in the evidence manifest.

## Explicit calls versus automatic interpretation

- For a skill instruction such as **show the user X**, distinguish an action
  that displays something immediately from a link that offers navigation.
  `html_render` publishes into chat; `preview_open` with `open: true` opens and
  shows a browser tab. `device_open` shows a supported device. These are direct
  presentation actions, although browser/device layout is still client-controlled.
- A native file link is a **user-click fallback**, not an agent-driven view
  change. No tool for opening the native Markdown/file viewer or selecting its
  tab was found in the exposed catalog or pinned MCP toolkit. Do not describe
  emitting that link as having opened the viewer.
- Actual HTML files have the same opening/focus limitation. The browser
  demonstration did not open the right-side file viewer. Its floating preview
  was later closed successfully with `t3_preview_close`; that is a separate
  browser lifecycle operation, not file-viewer control.
- `html_render` explicitly publishes a visual. Printing HTML in a command's
  stdout or linking an HTML file does not make that same inline reply.
- An MCP App appears because T3 recognizes app metadata/resources on a tool
  result, and its provider adapter supports the app callback path.
- File/media links and supported message syntax are interpreted by the renderer;
  they do not need a separate publish call for each reference.
- PRs have both branch/repository discovery and explicit link tools. Upstream
  also documents automatic linking for recognized PR creation flows. A plain
  link, branch-discovered PR and explicit persistent link are distinct mechanisms.
- Commands, file changes, plans and questions become activity UI through
  provider events. A tool returning arbitrary JSON does not automatically get
  a domain-specific inspector.

## Avenues to keep on the radar

These are ideas, not accepted requirements or claims about existing centrs flags.

| Avenue | Why it may help | Question before implementation |
| --- | --- | --- |
| centrs-generated HTML (`--html` or equivalent) | Agent reuses a tool-authored visual instead of composing an entire page | Output contract, theme variables, escaping and sensitive fields; an agent still invokes T3's HTML tools |
| centrs MCP App | Interactive RouterOS findings with callbacks and selected-context handoff | T3 provider support, session lifetime and read/write confirmation behavior |
| TSV/SQLite/Mermaid outputs | Reuse native viewers with little presentation code | Snapshot schema, file sizes and refresh behavior |
| RouterOS syntax presentation | Preserve RouterOS-specific token colors and diagnostics | Render existing token data into HTML, or add upstream native syntax/LSP support? |
| Router context in Thread details | Keep the target router visible beside chat | Existing project actions and discovered local servers versus a future custom status-row extension point |
| Private centrs credentials | Avoid putting passwords into prompts or container-wide persistent environment configuration | File delivery, process exposure, cleanup and credential persistence policies |
| Images or ffmpeg-generated sequences | Alternative for static diagrams, text animation, timelapses or recorded interaction | Useful experiment outside RouterOS too; no such artifact generated here |

The existing [skills/UI patching research](../2026-11-t3code-integration/README.md)
addresses deployment and frontend overlays. A maintained frontend patch is a
different avenue from the supported agent presentation calls catalogued here.

[roadmap]: https://github.com/tikoci/app-t3code/issues/30
[feedback]: https://github.com/tikoci/app-t3code/issues/29
[visuals]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/html-renders.md
[sc]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/source-control.md
[activity]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/activity-log.md
[prompts]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/prompt-links.md
[questions]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/question-attachments.md
[notifications]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/docs/user/mobile-notifications.md
[markdown]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/ChatMarkdown.tsx
[templates]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/packages/shared/src/codexArtifactTemplates.ts
