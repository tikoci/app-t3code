# File viewers, TOML and RouterOS syntax

Part of the [presentation inventory](t3code-presentation-menu.md). Source
baseline: T3 v0.1.7. No GUI rendering was exercised in this research.

## Existing viewers to reuse

| Output | Existing T3 presentation | Qualification |
| --- | --- | --- |
| TSV / CSV | Delimited table view with virtualized rows | Tabular snapshots; `.tsv`/`.csv` route through table-specific UI |
| SQLite | Table selector and paginated rows | Read-only table browsing, not a general SQL workbench |
| Mermaid (`.mmd`, `.mermaid`, or a Markdown fence) | Rendered diagram | No RouterOS semantics required |
| Markdown | Rendered document and source view | Useful durable research/report format |
| HTML | Sandboxed document preview | Linking a file is separate from publishing an inline HTML reply |
| TOML | Source/text view, with TOML syntax support | No dedicated structured TOML tree/form editor found |
| RouterOS `.rsc` | Workspace text/source path for a text file | RouterOS-specific highlighting is not registered |
| PDF, office/OpenDocument, EPUB, notebooks | Document-specific preview | Format fidelity and size limits vary |
| ZIP/JAR/TAR/GZIP | Archive listing and text/image entry preview | Not every archive member can be rendered |
| Images, audio, video, fonts | Media controls or font specimen | Additional ways to present generated evidence |

The [format classifier][formats], [file panel][panel], [table viewer][table]
and [binary viewer][binary] establish these routes.

## TOML: yes as source, not a special structured visualization

`.toml` and TOML MIME types are recognized as text by the file classifier.
T3's source renderer uses `@pierre/diffs`; its selected syntax engine is
**Highlights** (`PREFERRED_HIGHLIGHTER = "highlights"`). The inspected
`@pierre/diffs` 1.6.1 extension map resolves `.toml` to `toml`, and
`@pierre/highlights` 0.2.0 includes that language.

Thus TOML has a source-preview/highlighting path. This is not evidence of a
TOML-to-table or TOML-to-tree renderer. The [read-only source component][source]
and [syntax configuration][syntax] establish the T3 side; dependency pins and
the local mapping probe are recorded in the evidence manifest.

## What happens to `PIANO.rsc`?

The referenced fixture is actually
[`test-data/complex/piano.rsc` in lsp-routeros-ts][piano]. The script defines
`PIANO`; its content is ordinary RouterOS text. It was fetched for inspection,
not executed. The pinned fixture revision and SHA-256 are in the manifest.

There are two different paths:

1. **Workspace file link:** T3 reads the file contents through its workspace
   reader and presents ordinary source/text if it passes the text checks.
   An unknown filename extension alone does not block this path. The source
   component supplies the filename to Pierre's language resolver.
2. **Attachment:** the attachment classifier also uses MIME information.
   For `piano.rsc`, the probed classifier returns `unsupported` with no MIME
   or a generic binary MIME, but `text` with `text/plain`. The attachment path
   should therefore not be assumed identical to the workspace path.

The dependency's filename resolver returns plain `text` for `piano.rsc`.
No `.rsc` custom mapping or RouterOS grammar registration was found in the
inspected T3 syntax setup. A code fence named `routeros` is not sufficient to
add a language; T3 falls back to text when highlighting cannot be resolved.
Do not present shell/Bash highlighting as RouterOS syntax support.

This is **not highlight.js** in the inspected T3 implementation. Pierre's
Highlights engine is preferred, with Shiki-related machinery also present in
the rendering stack. Neither the presence of Shiki nor T3's external-editor
picker connects the native preview to a RouterOS LSP.

## RouterOS semantic highlighting is a separate avenue

The [lsp-routeros-ts README][lsp] describes semantic tokens sourced from a live
RouterOS `/console/inspect` connection, plus completions and diagnostics.
Those are language-server capabilities; T3's ordinary source preview does not
gain them just by opening an `.rsc` file.

Possible later experiments are rendering captured RouterOS token data into
an HTML reply, using an MCP App, or pursuing native grammar/LSP integration
upstream. These are alternatives to investigate, not implementations in this
repo. Preserve the distinction between syntax coloring and live-device
validation.

## Follow-up questions

- Open the same `.rsc` as a workspace link and attachment on the deployed
  clients, recording MIME classification and actual appearance.
- Try a TSV inventory, SQLite snapshot and Mermaid topology from centrs data;
  establish useful output shapes before introducing new UI code.
- Verify TOML colors in the actual client, including theme changes and large
  files. The research establishes source support, not screenshot evidence.
- Decide whether RouterOS coloring should consume LSP semantic tokens,
  `/console/inspect` captures, or a static grammar; they have different
  dependencies and accuracy guarantees.

[formats]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/packages/shared/src/filePreview.ts
[panel]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/files/FilePreviewPanel.tsx
[table]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/files/LargeTextViewer.tsx
[binary]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/files/BinaryViewer.tsx
[source]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/components/files/ReadOnlySourcePreview.tsx
[syntax]: https://github.com/pingdotgg/t3code/blob/322f6544dfad0a3c8a0c8cbecf2c7f7874b14268/apps/web/src/lib/syntaxHighlighting.ts
[piano]: https://github.com/tikoci/lsp-routeros-ts/blob/1d0999f69e4f062c8a6cc08f9977f2ae84bc87c1/test-data/complex/piano.rsc
[lsp]: https://github.com/tikoci/lsp-routeros-ts/blob/1d0999f69e4f062c8a6cc08f9977f2ae84bc87c1/README.md
