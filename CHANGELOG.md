# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md) · [Documentation](docs/README.md)

Entries below describe repository changes, not a semantic-version release series. Historical test counts belong to their recorded runs.

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
