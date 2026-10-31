# Feature guide

[English](FEATURES.md) | [简体中文](FEATURES.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-05; code baseline: `d663030`.

## Conversations and projects

General conversations use private chat-file storage, not a project command workspace. Projects support up to 12 non-overlapping folders. Add/remove folders through project management. Removing a project archives access, not disk files; permanent chat deletion requires confirmation and does not delete project files. Conversation forks share project files; isolated worker copies are different.

The UI supports English/Chinese, a custom assistant name, automatic text sizing and 25–150% presets. Copy conversations/code, rate replies, navigate rounds and inspect context, usage, workspace and changes. Steps and resolved interactions can collapse. Plans appear when a task board exists. See [interaction](INTERACTION.md) and [formatting](CHAT-FORMATTING.md).

## Models and tools

Connections cover OpenAI-compatible Chat Completions, Responses, Anthropic and Gemini adapters. Discovery uses returned metadata; unsupported or absent fields remain configurable, not proven capabilities. Reasoning choices depend on each configured model. Images enter capable models through attachments or read_image; a capability declaration alone is not a live test.

Skills load progressively and can be batch-selected, filtered by source/category and optionally classified using a disclosed model destination. Imports do not grant tools, credentials or dependencies. Guarded preparation and local versioned packages complement discovery. See [tools](TOOL-ECOSYSTEM.md).

## Teams and waiting

Choose single-agent, automatic delegation or preferred collaboration; team topology additionally offers lead/workers, host-scheduled peers and creative peers. Host scheduling checks dependencies, resources, permissions, isolation and capacity before feedback-informed ranking.

Persistent members use continuation instead of requiring a new identity every turn. Optional recovery, bounded expansion/retirement and role takeover remain single-host policies. Creative messages are claims or fiction, not verification.

Background commands and deferred approvals let the model perform independent work while a job waits; dependent work must await its result. Ordinary foreground tool calls may still block that run. Other conversations have separate admission limits. No extra waiting agent is required.

## Knowledge and memory

Ordinary-chat shared memory/library, project scope and private conversation documents stay distinct. Authorized folder maintenance handles incremental parsing, versions, OCR, vectors and failures. Local multilingual E5 and remote embedding are supported; ANN is a local search index, not a language model. See [memory](MEMORY.md).

## Media

Separate providers cover image, video, music, speech, transcription and 3D protocols. Configure actual model IDs, options and credentials; protocol support is not universal live validation. Prices are estimates, not invoices.

Generated outputs have same-conversation handles. list_media finds old jobs; inspect_media checks bytes; read_image views images; export_media copies exact bytes to an authorized new project path. Image/audio/video handles may feed later generation where the provider supports the field/format. 3D files can be exported but are not generic generation references. Dictation inserts editable text rather than sending it. See [media tools](TOOL-ECOSYSTEM.md).

## Automation boundaries

Memory defaults, document maintenance, schedules and team recovery are opt-in and scope-bound. Schedules require the service to run. Scope expansion, new external destinations, credentials and uncertain destructive outcomes remain user-controlled. Automatic approval does not bypass isolation. See [security](SECURITY.md).

## Scheduled task cards

Open **Background work → Scheduled tasks** to create or edit a named task, select its source conversation, first local execution time, fixed repeat interval (minutes/hours/24-hour days/7-day weeks), optional command-completion trigger, and notification policy. Tasks appear as cards with pause/enable, duplicate, remove, and linked run history. Running tasks cannot be edited; pausing prevents future dispatch but lets the current run finish. A failed/interrupted run must be inspected; duplicating creates a new explicit task rather than replaying that run.

Choose **Continue in this chat** or **New chat for each run**. New chats inherit the source project/model/permissions/settings, not its message history; write self-contained instructions. Archived sources, removed projects, changed model destinations and unresolved effects block dispatch. A persisted run/destination pair prevents duplicate dispatch after restart. Missed intervals coalesce into one run and retain the original interval alignment. Intervals are elapsed time, not daylight-saving-aware calendar rules.

Notifications are durable **in-app** records, with a toast while the UI is open. Choose all outcomes, changes/completion/errors, failures only, or silent history. `report_scheduled_result` lets the executing scheduled run report unchanged/update/complete. Meaningful-only notifications suppress a successful unchanged report; complete stops future repeats after successful execution. These are model reports, not independently proven change detection. Missing reports and failures remain visible. Read/unread is retained; history links to the actual execution conversation.

The service/computer must remain running. There is no cloud wake-up or OS push notification. Scheduled model work consumes provider quota and uses normal approvals. Existing schedules are compatible; no new dependency, download, or first-start option is required. Rebuild/restart the server and refresh the UI to enable this update; do not interrupt active work without approval.

### Reuse existing knowledge in a project

In Knowledge, select a project scope and expand **Reuse documents from another library**. Choose the source library, search, select current documents and add them. This explicitly copies selected version snapshots and compatible valid vectors locally; it does not parse files, request embeddings, grant filesystem access, or broaden the project retrieval scope. No other source documents or memories are included. Repeated selection of the same version is idempotent. Missing, invalid or incompatible vectors remain pending for normal index completion. Provenance is visible on each document card. Source changes and deletion do not alter a project snapshot; remove the project copy independently or explicitly add a newer version. Vector storage is copied, not a shared mutable index. LightRAG graphs are not copied or implicitly authorized by this action.

