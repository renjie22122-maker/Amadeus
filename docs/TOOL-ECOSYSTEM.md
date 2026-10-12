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

File selection and drag-and-drop also accept supported media. Images render inline; audio and video have native controls, seeking and a download link. Playback is not muted by default and never autoplays. Supported container detection includes PNG/JPEG/GIF/WebP, MP3/WAV/FLAC/Ogg, MP4/M4A and WebM. Browser codec support varies; failed previews keep the download link. Upload/import remains limited to 25 MB per file. An invalid file does not discard other successfully uploaded files.

Both paths return/use `attachment:<id>`: `inspect_media` checks metadata, `read_image({mediaRef})` supplies actual image pixels to a vision-capable model, `export_media` saves bytes without overwriting workspace files, and `generate_media.references` can reuse the attachment subject to the configured provider and normal approval. References are conversation-scoped and new attachments are hash-checked. Audio/video playback does not mean the model has heard or seen its contents: transcription and frame extraction are separate, authorized processing steps. Audio/video are not imported into the knowledge base as pretend text transcripts.
