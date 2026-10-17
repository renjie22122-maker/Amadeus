# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) · [Documentation](docs/README.md)

Entries below describe repository changes, not a semantic-version release series. Historical test counts belong to their recorded runs.

## 2026-10-17 — Composer model and delegated model controls

The model chip now opens searchable main-chat and subagent connection settings. Users can keep inheritance, choose a child default, or authorize additional per-task model choices. Spawn and continuation enforce that list, retain normal permissions and report the selected profile; active runs cannot be reconfigured. Save feedback, API-settings navigation and narrow-screen layout are included. No dependency or launcher changes; restart required to load the update.

## 2026-10-17 — Resumable PDF OCR and scoped source discovery

Large pages use bounded overlapping OCR tiles without whole-page downscaling. Folder imports persist checksummed page/tile checkpoints bound to source bytes, resume interrupted attempts, and remove checkpoints after successful import. Page/tile progress renews inactivity timeouts within a fixed attempt budget; incomplete documents never enter retrieval. Source discovery adds bounded authorized title metadata to model context, with guidance to distinguish current rules, historical examples and uncertain OCR. No new dependencies or launcher changes; restart to load the code. Windows OCR was tested with a synthetic wide scanned page and interrupted-tile recovery; this is not a claim that all user PDFs now parse successfully.

## 2026-10-15 — Bounded source-grounded research

Added ordered source navigation, version-bound reading notes and alternative explanations with targeted peer scrutiny. Research shares retrieval/read budgets, distinguishes slow-service failures from no new evidence, exposes stopping reasons and reconciles interrupted attempts without replay. Removed keyword-triggered automatic query multiplication. Open research is a delivery limitation, not a reason to keep searching. No new dependencies, reindexing or launcher changes; no service restart performed.

## 2026-10-15 — Versioned peer collaboration

Optional concrete proposal review links objections, author responses, revisions and reassessment. Pending declared review blocks lead completion with bounded repair; unresolved/withdrawn outcomes remain warnings. Independent work needs no team or discussion quota. Adds team-panel status and continuation-safe reviewer identity. No new dependencies or launcher changes.

## Evidence and native evaluation

Preserve spreadsheet styles and image detail; add explicit format contracts and repeat-observation hints. Separate three native GAIA arms from controlled shared-tool experiments, apply source exclusions and preserve raw grading. Optional Setup-Evaluation prepares dependencies without starting paid runs.

## 2026-10-13 — Audited computation, media understanding and output contracts

Added Docker-only Python analysis, timestamped frame/audio extraction, scoped paginated document/OCR reading, approved durable audio transcription, capability diagnostics and non-executing tool-plan validation. Final response contracts validate shape with two bounded repairs; raw answers remain recorded. Thin/error web pages expose browser handoff guidance without authority escalation. Optional Setup-Analysis builds Python + FFmpeg; First Start only describes it. Existing frozen evaluations are not modified; no benchmark improvement is claimed.

## 2026-10-13 — General model-delivery recovery

Tool guidance now treats the attached schemas as authoritative and only recommends discovery when its tool is present. Empty deliveries are rejected before completion, retain measured usage and share the bounded protocol-repair allowance. Output truncation permits two smaller-step repairs, with a minimal-action instruction on the last attempt. Output/reasoning settings, permissions and previously executed operations remain unchanged; partial tool calls never execute. Persistent failures remain interrupted and recoverable. No new dependencies or launcher changes; restart the service to load the code. Benchmark samples are diagnostics, not evidence of a general score improvement.

## 2026-10-12 — Benchmark preparation and MIT license

Added a bilingual multi-track evaluation design, full source/data download inventory with hash verification, and a no-model-cost Docker preflight. Public benchmark adapters and live scores are not yet implemented. Existing synthetic grading controls and container smoke passed. Adopted MIT; normal launchers do not install benchmark environments.

## 2026-10-12 — Execution boundaries, recovery receipts and acceptance layers

Checked file handles and concurrent publication regressions; fail-closed backend/receipt validation; command/media recovery references; separate semantic acceptance records; missing/corrupt/database errors distinguished. Extracted resume preparation, recovery tools and HTTP effects. Hostile ancestor races remain a limitation; local Docker unavailable and strict native network preflight failed, not isolation-certified. No new startup dependencies.

## 2026-10-07 — Artifact delivery gates and copy coverage

Unverified declared artifacts now block single-agent delivery too. Isolated copies preserve allowlisted hidden configurations, exclude key/certificate files and report copy coverage and actionable limit errors. Resource limits remain bounded.

## 2026-10-07 — Capability admission and independent review contracts

Unified registered-tool admission with post-wait checks; optional independent-evidence delivery requirements; bounded team interface and acceptance projections. Provider transport enforcement remains separate.

## 2026-10-07 — Outcome-informed recovery selection

Grounded run-local results guide strategy choice; repeated ineffective operations under unchanged declared preconditions are rejected. No causal claims or automatic permission changes.

## 2026-10-07 — Background recovery continuation

Recovery action and verification commands reuse normal yielding and 1–1800 second timeouts. Durable job IDs permit once-only continuation; pending/unknown recovery blocks delivery.

## 2026-10-07 — Guarded recovery actions and postcondition checks

Bounded once-only action/check contracts reuse tool approval and effect journaling; no automatic replay or correctness claim.

## 2026-10-07 — Guarded recovery inspections

Unique proposal IDs, bounded diagnostic selection, once-only receipts and run-local feedback through existing tools. No command replay, permission expansion or diagnostic-as-verification claims.

## 2026-10-07 — Progress feedback integration

Refresh recorded checks after tool batches; surface coverage regression before delivery; return bounded run-local intervention feedback to context without granting replay or promoting memories.

## 2026-10-07 — Unified delivery assessment and bounded convergence advice

One projection for existing task, challenge, memory and effect obligations; declared impact-to-check mapping; varying-output polling advice without an automatic stop. Existing safety gates stay enforced. No new dependency or launcher change.

## 2026-10-07 — Learning review and contract comparison

Evidence-backed inactive experience candidates, same-conversation contract comparison, bounded outcome reporting and acceptance-bound applicability invalidation. No claim of calibrated learning or causal improvement.

## 2026-10-07 — Experience-to-verification workflow

Recalled active experiences create run-local verification items. Completion requires current version-bound checks or an explicit non-applicability reason. Disabled, changed or out-of-scope memories are excluded; outcomes do not automatically promote confidence or sharing. Generic review guidance adds unknown-value rejection, operation-key/content conflicts and multi-page coverage. Cross-version contract comparison and measured defect-rate improvements remain future work.

## 2026-10-07 — Draft previews and evidence-driven context

Long pasted text becomes an attachment; safe Markdown/math draft preview. Task reflection exposes evidence gaps without fabricated confidence. Structured memory exceptions preserve broader preferences and report conflicts.

Generic security review is triggered from declared tasks; unresolved challenges block delivery and old evidence cannot close new concerns. Check provenance does not establish semantic correctness. No new dependencies.

## 2026-10-06 — Engineering checks and preview sizing

Compiled backend with runtime assets, memory-domain routes, Unicode regression, package metadata without a license grant, bilingual link checks and compiled smoke tests. Preview adds content/window fitting and SVG support.

## 2026-10-06 — Memory scope controls

Separate storage and recall scopes; original-chat filtering, current-chat shortcut, searchable manual creation and bulk scope overrides/reset with revision and conflict checks.

## 2026-10-06 — Memory candidate review

Unlimited memory selection with sequential batches, separate candidate/deactivated states, and source-backed automatic review of existing opted-in candidates.

## 2026-10-05 — Memory management

Memory management: scoped bulk actions, readable source/status filters, incremental extraction, local episodes, configurable type-based decay, and maintained provenance links.

## 2026-10-05 — Interactive component results

Generic multi-result bridge with editable records, batch draft insertion, source validation and localized compact preview controls. No automatic message sending; unsent records remain local UI state.

## 2026-10-05 — Documentation consolidation

- Paired current English/Chinese guides for setup, architecture, interaction, tools, approval, security, memory, retrieval, scheduling and evaluation.
- Removed conflicting obsolete limits and descriptions from current guides.
- Preserved all 21 pre-consolidation Markdown documents in the [history archive](docs/history/README.md), with fixed-revision links.
- Separated historical experiment summaries from current behavior. No new benchmark or capability gain is claimed by this documentation change.

## 2026-10-05 — Amadeus rename · d663030

- Renamed the GitHub project, interface defaults, notifications and documentation.
- Added First-Start-Amadeus / Start-Amadeus launchers, keeping old names compatible.
- Retained data paths, internal compatibility identifiers and custom assistant names.
- Validation: 333 passed, 2 environment-dependent skips; typecheck/build passed.

## 2026-10-05 — Interactive preview and startup · 9e8dc67

- Default HTML preview, persistent preview/code switching, internal source scrolling and adjustable panel height.
- Local Mermaid diagrams with strict SVG rendering.
- First Start protects live dependencies; Quick Start warns about outdated build inputs.

## Earlier recorded changes

- f2e4863: media discovery across historical/current jobs and output types.
- 49a6a6a: scoped media references, inspection/export and browser popup continuity.
- 9552c9d: stable review prefixes, in-flight review deduplication and separate cache metrics.
- See [historical source documents](docs/history/README.md) for earlier implementation notes and dated experiments. Those documents may describe superseded behavior; use current guides for operation.

## 2026-10-11 — Local retrieval and evolving task plans

- Scoped retrieval inventory, bounded investigation, optional cross-encoder and LightRAG. Offline GPU setup supports E5-large 1024 dimensions; extraction uses an authorized connection.
- Isolated native FAISS workers with explicit exact fallback, embedded Qdrant and Milvus server adapter.
- Task status counts, SSE refresh and plan extensions retaining existing evidence.
- Updated launchers and bilingual guides; offline bundles and user data are excluded.

## 2026-10-11 — Memory graph discovery and conflict semantics

Readable legacy source nodes, paginated graph diagnostics, source-bound automatic relation backfill, invalid-source filtering, and source-reviewed coexistence of additive memories. Shared topics no longer imply conflicts; manual deactivation is preserved.

## 2026-10-12 — Retrieval investigations and evidence diversity

Document-scoped follow-up search, narrow passage reranking, automatic conservative cutoff, local retrieval audits and bounded investigation. Team evidence separates repeated sources from independent execution. No new dependency or data migration required; restart app and local RAG service to load changes.

## Conversation and panel responsiveness / 对话与面板响应

- Release send state on server acknowledgement; refresh independently. / 收到服务器确认即结束发送状态，独立刷新。
- Incremental cached conversation history, scoped SQL reads and latest-only checkpoint hydration. / 缓存历史增量读取、SQL 范围过滤、仅加载最近检查点。
- Lightweight shell state, coalesced refresh, non-overlapping background polling and cancelled stale model discovery. / 轻量页面状态、合并刷新、后台轮询不叠加、取消过时模型发现请求。
- Extract conversation-view routing; add a real-browser slow-refresh regression. Launchers need no new dependencies. / 拆出对话读取路由，增加真实浏览器慢刷新回归；启动项无需新依赖。
- Existing filesystem ancestor-race and unverified isolation-backend limitations remain explicit. / 保留文件父目录竞态及隔离后端未验证的限制说明。

## Retrieval resilience and general conversation charts / 检索容错与通用对话图表

- Validate vectors per row, repair malformed cache entries through normal indexing, expose scoped request-local degradation diagnostics. / 逐条校验向量、通过正常索引修复损坏缓存，暴露同范围请求级降级诊断。
- Extract model-session accounting and knowledge-tool registration from coordinators; preserve policy gates. / 拆分模型请求记账与知识工具注册，保留统一策略门控。
- Add declarative bar/line/flow/table previews with source switch, theme adaptation and bounded validated data; retain Mermaid and Markdown. / 新增条形、折线、流程卡片与表格预览，支持源码切换、主题适配与数据校验，保留 Mermaid 和 Markdown。
- Defer restored-conversation loading until local authentication bootstrap completes. / 恢复对话等待本地身份初始化完成，避免启动误报。

## 2026-10-12 — Local media / 本地媒体

- Added scoped `import_media` to embed workspace media in the current conversation; attachment handles support inspection, image reading, export and generation references.
- 本地音视频不再误走文档解析；补齐内嵌播放器、范围读取和批量上传失败隔离。

### Large local media / 大型本地媒体

- Removed the fixed local-media upload/import size cap; streaming import, playback ranges, integrity inspection and no-clobber export bound memory. Failed/cancelled transfers do not publish partial files.
- 保留独立的视觉解码、API参考输入限制；本地保存与播放不受该限制。

### Sidebar navigation / 侧栏列表

- Shared scrolling with progressive See more / See less for projects, ordinary conversations and project chats; recent activity ordering, pinned and selected retention, project-name search.
- 项目和普通对话共用滚动条，默认少量展示，展开不增加嵌套滚动区。

## 2026-10-16 — Skill discovery and responsive waits

Task-ranked skill metadata, on-demand bodies, current-reference read checks, and steering-aware command/batch/workflow waits without process replay. See TOOL-ECOSYSTEM for boundaries. No new dependencies or launcher migration.

## 2026-10-16 — CI fixture repair

Align the large-knowledge regression with the streamed retrieval path while preserving scope, deletion and model-compatibility checks. Exercise child-count limits against a real Store rather than an outdated mock. OS matrix jobs now finish independently (`fail-fast: false`).
