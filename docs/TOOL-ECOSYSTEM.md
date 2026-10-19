# Tool ecosystem

[English](TOOL-ECOSYSTEM.md) | [简体中文](TOOL-ECOSYSTEM.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-05; code baseline: `d663030`.

## Discovery and composition

search_tools exposes matching schemas progressively, with English/Chinese lexical matching and optional local-only embedding fusion. Failed local embeddings fall back explicitly. search_capabilities combines scoped tool/skill/memory/knowledge discovery, not permission grants.

glob and literal UTF-8 grep keep FileScope and report exclusions/limits. read_json returns structured data; read_file adds human-readable line numbers. batch_read_tools accepts 20 parallel-safe reads with four workers. tool_workflow permits 12 steps, boolean conditions, prior-result references and loops of 20 items, at most 40 calls. Future/prototype references, recursive composition and arbitrary code evaluation are rejected. Each nested call keeps normal approval/audit; partial failure is not a transaction.

transform_data supports bounded count/projection/equality/unique/sum (1,000 items/1 MB). inspect_file_version and apply_patch support hash-pinned exact hunks for up to 20 existing files; partial write results remain visible. Git inspection uses the ordinary command backend, not privileged subprocesses. No automatic restore or authorship inference.

## Browser and desktop

Add a disabled adapter in Settings → Tool ecosystem, review its authority, then enable. Playwright uses installed Edge on Windows or prepared Chromium elsewhere. Browser profiles are conversation-scoped; optional saved cookies/local storage are not full saved tabs. Reset/deletion clears owned state.

Navigation, click, fill, keys, select, wait, scroll, screenshots and retained popup tabs are supported. browser_tabs/select_tab/close_tab use stable context-local IDs. Upload/download bridge is limited to 10 MiB and authorized paths; uploads need approval, downloads refuse overwrite and are not executed. Nonempty exact-host allowlists block redirects/WebSockets. Empty lists use approved host networking; this is not pinned-DNS SSRF isolation.

interaction_capabilities reports configuration without launching a process; enabled-unverified is not a successful probe. Windows Computer Use builds a local C# adapter with .NET Framework's compiler, without changing PowerShell policy. It enumerates windows/UI Automation controls and provides screenshot, mouse, typing, basic keys, scroll and drag. A mutex serializes input; selected windows must already be foreground. Lost focus stops input, not forced activation.

Without windowId, capture uses visible pixels; with it, PrintWindow attempts covered-window capture. Minimized/invalid/unsupported captures fail, with no automatic desktop fallback. A 20-second deadline and 16-million-pixel bound apply. GPU/protected content may still be black/stale; contentVerified is false. This is host desktop control, not automatically provisioned VM isolation or universal cross-application certification.

## Skills, packages and hooks

Skills load on demand and resources can be materialized. Dependencies can use approved project-local pip/npm preparation; npm lifecycle scripts are disabled. Readiness checks do not prove end-to-end skill behavior or acquire accounts.

Local package preview, hash-pinned install/update/rollback and disabling are supported; new revisions start disabled and source versions remain. agentdemo-signature.json is a compatibility filename. Ed25519 verifies the raw SHA-256 inventory digest with a user-trusted PEM key. Signatures do not certify safety. The source catalog is not a hosted marketplace, automatic remote downloader or OAuth lifecycle.

Hooks cover before/after Tool, Command, Compaction, TaskComplete and MemoryWrite. Deny-before and audit actions are supported; command hooks only apply at tool/command stages, retain normal permissions and stop recursive invocation (up to eight hook commands). Skills cannot activate hooks.

## Sources, artifacts and policy

research_sources collects up to six public URLs; crosscheck_sources checks quote spans, model-assigned stances, duplicate content and host counts. Provenance is not truth or publisher independence. Source-warning hashes survive bounded compaction; heuristic injection warnings are not full taint tracking.

Artifacts record path/hash/size/type/producer; inspection detects stale/missing bytes, retirement preserves files. All tools have audit/progress, commands also stream output. Progress is not invented percentage completion.

Action rules only deny or require human review; specialists restrict inherited skills/tools. Plan review binds human agreement to board hash/revision without granting tool rights. Model-capability inspection separates configuration from verified endpoint behavior.

## Generated media

list_media finds same-conversation historical/current jobs; media_status receipts provide media:jobId:outputId handles. inspect_media verifies metadata/integrity; read_image(mediaRef) sends normalized image pixels. export_media publishes exact bytes at an authorized new project path, refusing overwrite/protected paths. No manual reupload is required solely because bytes are in private media storage.

Image/audio/video handles can feed approved generation fields with a 25 MB inline reference limit; provider format support still applies. 3D exports are supported but not generic references. MP4 inspection reports readable audio-track presence, not audibility or browser codec compatibility. Other/legacy/unreadable outputs remain unknown. HTTP single byte ranges support seeking; UI does not mute by default. No transcoding, invented audio or paid generation occurs during export/inspection.

See [interactive formatting](CHAT-FORMATTING.md), [security](SECURITY.md) and [verification](VERIFICATION.md). Still open: robust transactional multi-file patches, Git ownership-aware restore, remote marketplace lifecycle, VM provisioning and broad desktop/application benchmarks.

## Public web and protocol configuration

web_search uses a separately configured DeepSeek Messages search channel, default https://api.deepseek.com/anthropic/v1. It requires structured search evidence rather than prose. The default deadline is 60 seconds with no automatic paid retry; auxiliary calls contribute run usage and consume model capacity. fetch_url reads public text/links without executing page JavaScript. Command networking still follows the selected backend.

Media adapters cover OpenAI-compatible, fal.ai, Replicate, Gemini, ElevenLabs, Deepgram, AssemblyAI, Meshy, Tripo and MiniMax protocols. MiniMax direct uses https://api.minimax.io; speech requires voice_setting.voice_id. Account access and options depend on the actual model, not the adapter list. Image tools accept PNG/JPEG/WebP/GIF by bytes, normalize to 640,000 pixels/1 MiB and use the first animated frame. SVG/PDF/video need conversion first. Media read/export has a separate 150 MB output boundary; this is not a provider generation-size limit.

Package signing inventories are path-sorted {path,bytes,sha256} entries with forward-slash paths, excluding hidden/build directories and the signature file. Ed25519 signs the raw 32-byte SHA-256 of the inventory JSON; signature is base64. Publisher keys require user trust, not self-assertion.

## Local media in conversations (2026-10-12)

Ask the Agent to show an existing image, video or audio file from an authorized project folder. The new `import_media({path})` tool reads through FileScope, saves a copy and embeds it at the current point in conversation history; it does not put it into the user's unsent draft. Repeated imports of the same bytes/name in the same run reuse the reference. No provider call is made by importing.

File selection and drag-and-drop also accept supported media. Images render inline; audio and video have native controls, seeking and a download link. Playback is not muted by default and never autoplays. Supported container detection includes PNG/JPEG/GIF/WebP, MP3/WAV/FLAC/Ogg, MP4/M4A and WebM. Browser codec support varies; failed previews keep the download link. Local media upload/import, playback, inspection and export have no fixed application file-size cap; streams keep memory bounded. Disk space and filesystem/browser limits still apply. Full-buffer image decoding and provider reference submission retain their separate 25 MB processing budget; oversized media stays stored and can be exported for resizing, splitting or transcoding. Large-container inspection may report unknown audio tracks rather than guessing. An invalid file does not discard other successfully uploaded files.

Both paths return/use `attachment:<id>`: `inspect_media` checks metadata, `read_image({mediaRef})` supplies actual image pixels to a vision-capable model, `export_media` saves bytes without overwriting workspace files, and `generate_media.references` can reuse the attachment subject to the configured provider and normal approval. References are conversation-scoped and new attachments are hash-checked. Audio/video playback does not mean the model has heard or seen its contents: transcription and frame extraction are separate, authorized processing steps. Audio/video are not imported into the knowledge base as pretend text transcripts.

## General work chains (2026-10-13)

`inspect_work_capabilities` lists currently admitted tools and distinguishes configured-but-unverified computation from missing or blocked capabilities. `inspect_tool_plan` checks each concrete tool name/schema and earlier dependency indexes without executing or granting approval. It reports duplicate calls; it cannot prove that a plan covers the user's goal. Tool selection guidance preserves distinct requested operations and avoids invented parameters.

`run_python` executes Python through the existing audited `run_command`, only with Docker selected. Source is transported as base64, the image must contain `python3`, and backend changes during approval fail closed. Docker keeps offline networking, a non-root user, resource limits and the selected workspace mount. Long jobs retain the same background job; wait before dependent work. This is not a persistent Python kernel. Standard-library CSV/JSON/ZIP/decimal/statistics work without extra Python packages; specialized libraries must be prepared in the image.

`extract_media_frames` samples up to eight requested timestamps with FFmpeg and returns scoped paths for `read_image`. `extract_media_audio` exports up to ten minutes per call as mono 16 kHz WAV, recording the actual duration and requested start. Export conversation media first; import the resulting audio before `transcribe_media`. Transcription uploads only after the existing media approval, rechecks configuration/authority, and binds a durable media-job recovery reference. The 25 MiB upload bound is explicit: split first rather than silently truncate. Provider results do not guarantee timestamps; segment start times must be retained by callers. Frame sampling is not whole-video QA.

`read_document` stages bytes through FileScope, runs the existing fixed parser with a 120-second no-page/tile-progress deadline (30-minute total PDF budget) / 768 MiB V8 heap, and returns text with offsets. PDF/images may use local Windows OCR; non-Windows OCR availability is not guaranteed. The parser runs locally, requires a project and execution permission, and is resource-limited, not an OS sandbox. Cancellation stops its worker; no document is uploaded. Pagination currently reparses the snapshot; it is not a persistent document-analysis session.

Thin/error HTTP pages return explicit browser handoff guidance. The agent discovers an enabled browser and applies normal MCP/network approvals; it never escalates silently or treats an HTTP error as proof that a browser will work.

`set_response_contract` records a user-requested text/single-line/number/JSON format and optional prefix for the current run. The runtime checks final shape and permits two corrective responses, preserving rejected outputs and never automatically stripping wrappers or replaying tools. Further failure is a recoverable protocol interruption. New delivered user input clears the contract. Ordinary chat remains unformatted unless requested. This checks representation, not answer truth, and depends on the model declaring the user's requirement; first-response benchmarks do not exercise this loop.

Optional setup: run `Setup-Analysis.cmd` with Docker running, then select Docker and `amadeus-analysis:local` in Settings. The image provides Python standard libraries and FFmpeg. Setup requires downloads, does not grant permissions, and is not part of normal First Start. No new Node dependency is required. The running frozen benchmark remains unchanged; new capability comparisons require a new recorded protocol.

Validation for this change: the full local suite passed 456 tests with three skips; focused follow-up tests also passed. Real offline/non-root Docker calculation and exact artifact publication passed using a cached Python image. That image lacks FFmpeg. Actual frame sampling and one-second audio extraction passed separately using the installed host FFmpeg on a synthetic clip, including missing-codec rejection; this does not certify FFmpeg in that Docker image. External transcription adapters use test fixtures, not a paid live provider request. Document pages expose SHA-256; pass it as expectedSha256 on later pages to reject source changes. Approval receives the Python source decoded from the exact command, never an unverified separate hint.

## Task-aware skills and responsive command waits

The runtime recommends up to 12 enabled skills from task-ranked metadata (including Chinese/English discovery hints), not just the first selected entries. Recommendations do not load bodies or execute skills. The model decides applicability and reads `read_skill`, then relevant supporting files. Unrelated tasks need no skill. Selected names are capped at 100 with an omitted count; `find_skills` remains paginated across the enabled catalog. New user steering refreshes recommendations. Matching is heuristic, not a calibrated semantic router.

`inspect_skill_readiness` checks current-run read receipts against the current skill body and up to 20 explicitly supplied references. It reports unread, changed, or unavailable resources. This checks only those references: it does not prove complete reference coverage, correct implementation, available dependencies, or permission. Before skill-assisted side effects, inspect actual workflow/API inputs and preserve user-approved assets; loading a guide is not verification.

Managed commands retain the same process and timeout when yielding. Even `yieldAfterSeconds=0` releases its wait for new user input. Pending inbox checks prevent lost wakeups. Batches defer unstarted calls after a yield or pending input; workflows stop at a running command, retaining receipts. Process steering, wait for the original job, then reconsider only unstarted work. No automatic replay or cancellation occurs. This does not preempt arbitrary blocking MCP calls or external jobs without a managed wait; hooks must finish before dependent effects proceed.

No new dependencies, configuration migration or launcher edits are required. Existing startup and first-start scripts rebuild changed sources; restart the service to activate this update.

Design references: [Codex progressive skill disclosure](https://learn.chatgpt.com/docs/build-skills), [Claude Code skills](https://code.claude.com/docs/en/skills). This is not complete compatibility with either product's invocation or permission fields.

Tool-definition serialization for OpenAI Chat and Responses uses stable tool-name and object-key ordering for every provider, including local compatible endpoints. Enum and tuple arrays retain their semantic order. Stable serialization does not assert provider cache support or guarantee a cache hit.
