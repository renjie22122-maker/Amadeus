# Rich conversation content

[English](CHAT-FORMATTING.md) | [简体中文](CHAT-FORMATTING.zh-CN.md) · [Documentation](README.md)

The renderer supports standard Markdown headings, lists, task lists, tables, links, images, syntax-highlighted fenced code and KaTeX math. Code blocks have copy and collapse controls. Large formulas scroll horizontally.

## Bold text and literal syntax

Complete bold spans next to Chinese punctuation have a compatibility pass when ordinary Markdown leaves the stars visible. Code blocks, inline code, explicitly escaped stars and unfinished streaming spans are preserved. This is intentionally conservative: it does not attempt to repair every malformed Markdown document or rewrite stored messages.

## Attributed quotations

Use an explicit, general-purpose speaker label:

```markdown
> [speaker: Reviewer]
> The evidence supports this conclusion.

> [speaker: Author]
> I will update the implementation.
```

The UI shows a name and a deterministic color. Chinese `[角色: 名字]` is also accepted. This works for interviews, discussions, reviews, fiction and other attributed quotations. Ordinary blockquotes stay ordinary; no speaker is inferred. Colors use a six-color palette and can repeat, so names remain the primary identity.

## Math and interactive examples

Use `$x^2$` / `$$...$$` or LaTeX `\( ... \)` / `\[ ... \]` delimiters. KaTeX is not a complete TeX document compiler.

A fenced `html` or `html-preview` block displays its interactive preview by default. Switch between Preview and Code in the same-sized panel; code scrolls internally. Switching preserves the iframe state; Reset reloads it. Choose compact, standard or tall height, or resize vertically. A fenced `mermaid` block renders local relationship, flow, sequence, state and entity diagrams with the same preview/code switch. Mermaid uses strict mode and an inert SVG image; parse errors leave the source accessible.

The iframe has an opaque origin, scripts only (no same-origin, top-navigation, popup or form sandbox privileges), and a CSP restricting resource loads and connections. It cannot access the parent application's DOM/storage. This is a browser preview boundary, not an OS sandbox: it does not guarantee resource limits or prevent every possible navigation. Do not use it as a general execution environment for hostile programs. Remote dependencies, arbitrary Python execution, package installation and full development-server projects are not supported. Raw HTML in ordinary Markdown remains escaped/ignored.

## Media and dictation

Generated image, video and audio outputs stay anchored to the first media-task event. Subsequent updates replace that card in place rather than moving it to a later turn. Existing generated-media cards provide players, downloads and collapse controls. Recognized local conversation media links with audio/video extensions can also embed a player; arbitrary remote links are not automatically converted into players.

The microphone icon is next to **Send**. Configure a transcription connection in Settings first. Recording requires browser microphone permission and a supported browser on localhost or HTTPS. Stop recording, then choose Upload & transcribe. The result enters an editable draft; it is not sent as a chat message automatically. This is dictation, not real-time voice conversation.

## Validation

See [verification](VERIFICATION.md) for the current regression baseline. A real headless Edge fixture verified default previews, state-preserving switches, same-sized scrolling code, two Mermaid diagrams and mobile width. TypeScript and the production build passed. No paid media service was called.

## Interactive results

HTML components in completed assistant messages can submit a result through the optional bridge:

```js
window.amadeus?.submitResult({
  title: 'Scenario comparison',
  data: { option: 'A', total: 42 },
});
// Alternatively: { title: 'Feedback', text: 'Your result' }
```

Each submission creates a separate record. Users can edit a record, select several records, and append the current or selected results to the existing chat draft. Only pressing the normal Send button delivers them to the model. This supports repeated simulations, games, forms and calculators; it is not specific to dice. Existing components must call the bridge to report results.

The toolbar follows the selected interface language and provides Preview/Code tabs, height selection, copy and reset. Switching views or language preserves component state.

The host checks the sending iframe, opaque origin, instance token and payload shape. Records are untrusted component-reported data, not verified evidence or permission grants. Titles allow 100 characters and result text 16,000; each mounted component retains at most 20 records and visibly rejects overflow. Remove a record before submitting more. Batch draft insertion may require splitting large selections.

Pending records are local UI state, not durable storage: reset, reload or unmount can discard them. Results already added to a draft follow ordinary draft behavior; sent messages follow ordinary conversation persistence. Client-side buttons cannot guarantee durable once-only rolls or tamper-proof outcomes. Components cannot automatically send messages, call tools or access host storage. No new dependency or launcher change is required; existing startup scripts rebuild changed frontend sources.

## Preview sizing

HTML and SVG previews default to Fit content. Height follows content changes, image loads and available width without resetting component state; source view remains scrollable. Fit window, Compact, Standard and Tall remain available. Long content is capped at 2400px with an explicit hint so an untrusted component cannot expand the chat indefinitely. Viewport-relative layouts or internally scrolling widgets may still scroll.

Size messages are accepted only from the current sandbox iframe with the current token; the preview retains its opaque origin and restrictive CSP. A size message cannot submit a result or access host tools.

## Declarative charts and comparison cards

A fenced chart block contains JSON, not executable JavaScript. Preview is the default; use Code to inspect/copy the source and the existing height selector to fit content or the window. The renderer follows the application theme and keeps wide tables horizontally scrollable.

Supported schemas (all allow title and caption):

- Bar: {"type":"bar","title":"Latency","unit":" ms","data":[{"label":"Before","value":120},{"label":"After","value":75}]}. Optional max sets a scale at least as large as the data; zero and negative values are supported.
- Line: {"type":"line","data":[{"label":"First","value":3},{"label":"Second","value":7}]}. Points are equally spaced categories; hover for values or expand Data for every label/value.
- Flow cards: {"type":"flow","steps":[{"title":"Observe","detail":"Collect evidence"},{"title":"Verify"}]}.
- Table: {"type":"table","columns":["Variant","Result"],"rows":[["A","Passed"],["B","Pending"]]}.

Use Mermaid for actual relationship edges, sequence/state/entity diagrams; standard Markdown tables and sandboxed HTML/SVG remain supported. Chart JSON is validated and labels are escaped. Limits: 100 data points/table rows, 20 columns, 50 flow steps, 100,000 source characters; invalid or unfinished input shows an explanation with source access. This is a presentation format, not measured evidence: models must not fabricate scores or probabilities to fill a chart.

## Local media in conversations (2026-10-12)

Ask the Agent to show an existing image, video or audio file from an authorized project folder. The new `import_media({path})` tool reads through FileScope, saves a copy and embeds it at the current point in conversation history; it does not put it into the user's unsent draft. Repeated imports of the same bytes/name in the same run reuse the reference. No provider call is made by importing.

File selection and drag-and-drop also accept supported media. Images render inline; audio and video have native controls, seeking and a download link. Playback is not muted by default and never autoplays. Supported container detection includes PNG/JPEG/GIF/WebP, MP3/WAV/FLAC/Ogg, MP4/M4A and WebM. Browser codec support varies; failed previews keep the download link. Local media upload/import, playback, inspection and export have no fixed application file-size cap; streams keep memory bounded. Disk space and filesystem/browser limits still apply. Full-buffer image decoding and provider reference submission retain their separate 25 MB processing budget; oversized media stays stored and can be exported for resizing, splitting or transcoding. Large-container inspection may report unknown audio tracks rather than guessing. An invalid file does not discard other successfully uploaded files.

Both paths return/use `attachment:<id>`: `inspect_media` checks metadata, `read_image({mediaRef})` supplies actual image pixels to a vision-capable model, `export_media` saves bytes without overwriting workspace files, and `generate_media.references` can reuse the attachment subject to the configured provider and normal approval. References are conversation-scoped and new attachments are hash-checked. Audio/video playback does not mean the model has heard or seen its contents: transcription and frame extraction are separate, authorized processing steps. Audio/video are not imported into the knowledge base as pretend text transcripts.

Fit-content iframe previews reserve scrollbar space, coalesce height reports over 100 ms, and ignore changes of at most 2 CSS pixels to reduce layout feedback jitter. Genuine larger growth/shrink still applies. Browser regressions cover long bilingual tables at multiple widths and zoom levels; this is not proof against every user-authored responsive layout.

## Downloadable documents and files

`register_artifact(path)` now attaches an immutable file snapshot to the current conversation by default and returns its authenticated `downloadUrl`. The file card shows its name, type, byte size, download action and SHA-256. Any scoped regular file is supported, including PDF, DOCX, PPTX, XLSX, Markdown, CSV, JSON, HTML, LaTeX source and ZIP. No external upload or command/network permission is needed just to deliver an existing authorized file. `attach=false` keeps registration internal. Workspace changes do not change an already delivered copy; registration of a new version creates a new download. Attachment storage is removed through conversation deletion, subject to retained fork references.

`create_document` saves a new workspace file and attaches it automatically:

| Format | Structured input                                                  | Renderer                                                   |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| DOCX   | title and paragraph/heading/bullet/code/page-break blocks         | docx                                                       |
| PDF    | the same blocks, A4 layout                                        | installed Edge on Windows or Playwright Chromium elsewhere |
| PPTX   | slides with title, body and optional speaker notes                | PptxGenJS, widescreen                                      |
| XLSX   | named sheets with literal text, numbers, booleans and empty cells | ExcelJS                                                    |

These are basic document renderers, not full Microsoft Office automation or arbitrary format conversion. XLSX strings are not interpreted as formulas. Complex styling, formulas, charts, images and specialized formats can be produced with separately authorized tools, then delivered using `register_artifact`. For LaTeX, create and deliver `.tex` sources; compiled PDF additionally requires an available approved TeX toolchain. Never rename extensions to pretend conversion succeeded. Generation does not certify content correctness or visually verified layout.

PDF rendering uses escaped structured content in a fresh headless browser with scripts and resource requests disabled. It does not use the user's browser profile. Outside trusted mode this fixed process needs approval; no fallback disables browser sandboxing. Missing browser installations report an actionable error. The tool input budget is one million characters, with bounded slides, blocks and sheet cells; this is separate from downloads, which stream without a fixed single-file size cap. Failed snapshots are removed, but available disk space still matters.

The standard launchers install locked dependencies when needed. No Microsoft Office installation is required for DOCX/PPTX/XLSX. Existing running services must be restarted after tasks finish to load updated tools and UI.
