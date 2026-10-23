# Memory, knowledge and retrieval

[English](MEMORY.md) | [简体中文](MEMORY.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-06.

## Managing recall scope

Storage scope (general conversations or one project) is separate from recall scope (original conversation only or shared in that storage scope). Search by conversation title, filter by original chat and recall scope, or jump to the current conversation. Manual creation is optional and preselects the current eligible original chat; worker chats and other projects are excluded.

Select any number of matching entries and apply **original chats only**, **share within scope**, or **restore automatic scope** in sequential batches. Each local entry keeps its own source chat; changing reach never rewrites provenance or activates a candidate/disabled memory. Stale revisions and conflicting active facts fail individually. Entries without a recorded original chat cannot be explicitly restricted to one.

Automatic scope follows kind: episodes and general-chat decisions remain local; preferences, experiences and project decisions are shared in their storage scope. Explicit overrides remain until reset. The effective scope is shown during creation. A local manual entry requires a same-scope original conversation. Existing records are not mass-migrated or automatically broadened by this UI change.

## Scopes and opt-in

Ordinary conversations share user memory; each project has its own memory. Automatic management keeps project/general scopes separate; deliberate user-memory mixing is a separate choice. Scope defaults apply to new conversations, with per-chat overrides. Existing chats are not silently opted in. Changing the extraction destination requires renewed authorization.

Automatic management enables extraction and recall. Extraction uses up to 30 recent human messages (4,000 characters each) and 80 same-scope entries after two idle minutes; it excludes assistant/tool text and attachments. Disabling discards in-flight results. Clear sourced preferences, decisions and episodes can activate; ambiguous conflicts/manual records are not blindly overwritten. Experiences need applicability and same-scope successful host evidence.

## History and graphs

Entries carry effective time, source, revision and optional entity/attribute/value. Exact duplicates consolidate; explicit newer same-attribute automatic facts may supersede older automatic records. New evidence can reconsider disputes. Similarity alone cannot resolve identity or truth.

Confirmed aliases and source-backed directed relations support bounded temporal graph search (up to three hops/40 paths). Source quotation matching proves provenance, not entailment or causal truth. Expired/deleted/retired support is excluded. Forgetting removes application entries, vectors and revision snapshots and blocks regeneration from that source; it is not forensic erasure of backups or SQLite free pages.

Optional document graph extraction uses the selected model destination, up to eight chunks/14,000 characters per document. Labels/relations must appear in quotes; exact same-scope entities can be reused, ambiguous aliases rejected. This is bounded extraction, not unrestricted ontology learning.

## Knowledge and versions

General chats can use a shared library plus their private session documents. Projects never automatically include the general library. Delegated work inherits authorized parent scopes; child chats are not ordinary scope-picker entries.

Import uploads or register folder sources. Automatic maintenance creates content versions, preserves citations, retires missing/invalid old sources and reuses unchanged documents. Private session uploads are not automatically shared. Same filenames at unrelated paths do not imply a revision. See [folder import](knowledge-import-resilience.md).

## Embeddings and ANN

Choose local multilingual-e5-small ONNX q8 (384 dimensions) or a compatible embedding API. Local model weights download initially, then use a verified disk cache. E5 uses distinct query/passage prefixes. Local extraction/embedding/retrieval does not make answering local: retrieved excerpts may reach the conversation LLM. Remote indexing sends authorized chunks/queries to its selected endpoint.

FTS and vector candidates combine with reciprocal-rank fusion and heading reranking. Under 2,000 vectors, similarity is exact; larger eligible sets use HNSW. SQLite is authoritative. Up to four derived ANN generations persist with content/scope/model keys and verified hashes. A small exact-neighbor calibration can raise ef from 256 to 512/1024 or fall back to exact. This measures approximation fidelity, not semantic quality.

Automatic local memory indexing and authorized document maintenance do not require clicking each document. Batch indexing repairs current-scope gaps. Destination changes require renewed scope selection. Remote memory indexing retains explicit control.

## Recovery and quality

Transient failures back off; configuration failures pause after three attempts. Same-destination credential changes or Recheck after repair can retry safely. Failed installs receive diagnosis through normal approval, not automatic replay.

User-labelled retrieval examples can compare lexical/hybrid strategies; selection requires at least 15 cases, five held-out cases and 0.1 MRR gain. Agent labels are excluded. This does not automatically search new models, rerankers or chunk sizes. A historical four-query E5 smoke test ranked 3/4 first and exposed a cross-language error; it is not a large-corpus quality claim.

## Managing a growing memory list

The library defaults to current entries and separates active, candidate and explicitly deactivated, disputed and historical/expired states. Search content, topic or source; pages contain 25 records. Select a page or individual records, then confirm, deactivate or forget any number of explicitly selected entries (sent sequentially in requests of 100). Forgetting asks for confirmation and uses existing source-exclusion semantics. Every item checks scope and revision independently; a failed item does not undo successful items. Conflicting, expired or superseded records cannot be bulk-approved.

Ambiguous conflicts have a visible count and direct review filter, with competing content and sources. They remain outside recall until resolved. No automatic interruption or automatic choice of winner is introduced.

Opted-in background learning now processes new user messages after the last successful extraction, in batches of up to 30, instead of repeatedly extracting the same recent history. Existing same-scope structured attribute/value matches are reused. Exact duplicate candidates can be consolidated without activating them; source/revision history remains. Old candidates can be reviewed against sources when their original conversation is opted in, never blanket-approved. Use the existing scope default to enable automatic management for new/inheriting chats; chat-level overrides and project/general isolation remain. No new external destination is authorized by these changes.

## Recall reach and decay

Storage scope, recall reach and decay are independent. Episodes and general-chat decisions default to their original conversation; preferences and project decisions default to their existing user/project scope. New suggestions record the source conversation. Structured legacy references provide a fallback. Unknown-source local entries are not recalled. Sharing a local record requires a user edit and never crosses projects. Starting a new conversation excludes another conversation's local episodes; switching tasks within the same conversation does not automatically infer scenario boundaries.

Automatic decay keeps preferences, project decisions and verified experiences stable. Episodes/general-chat decisions use weight = 0.5^(ageDays/30 + laterUserTurns/100), floored at 0.05. Users may override stable, time-only, turns-only or combined policies and half-lives. Tools, token volume and memory reads neither count as turns nor refresh age. Missing activity evidence contributes no turn penalty. This affects ranking, not truth or deletion; explicit expiry still excludes records.

Classification uses the extractor's generic memory kind, not topic keywords. Misclassified legacy entries may need correction. Deployment does not trigger paid historical reclassification or destructive cleanup.

## Readable graph management

System memory:<id> nodes represent provenance, not people or concepts. The UI hides them by default and displays memory summaries when shown. Advanced creation controls are collapsed; relations support search and pagination. Revisions update system-owned source quotations, deactivation retires those links, retrieval checks expiry, and forgetting removes unreferenced internal nodes. Unrelated domain edges are never rewritten automatically. Missing/invalid evidence is visibly marked and excluded from current traversal. Source links do not imply semantic entity resolution or factual inference.

The memory list shows source conversation titles where available, dates, reach and decay rules. Raw IDs/revisions remain under technical details. Scope search without a conversation context excludes local records; these remain visible in management and recallable in their original conversation.

Enabled means eligible for retrieval, not included in every prompt or verified as true. Scope, relevance, expiry and decay determine actual recall. Manual confirmation enables a candidate; reactivation enables an explicitly deactivated memory. Legacy inactive candidates without clear lifecycle metadata remain candidates rather than guessing their intent.

## Automatic review of existing candidates

The original conversation must be unarchived, idle and opted into automatic memory using its authorized model connection. Old candidates can then be reviewed, up to 8 per request with corresponding original human messages of up to 12,000 characters each. Attachments and tool output are excluded. Review uses model quota. Unchanged versions/source/model/active-set fingerprints are not repeatedly reviewed; failed or interrupted calls are not blindly replayed.

The host checks exact source quotes, revisions, permission, expiry, conflict and experience evidence before activation. Disabled, disputed, historical, expired and forgotten entries are not revived. Untraceable sources remain manual. Changes to source/model/active memories can trigger reconsideration. Activation permits relevant recall, not proof of truth. Enabling another conversation does not approve every project candidate. No extra dependency or first-start change is needed.

## Applicability and scoped exceptions

Recall includes applicability conditions, matching signals and explicit same-key conflicts. Relevance is not a calibrated truth probability. For an exact structured entity/attribute/condition match, conversation-local or project-specific records can shadow a broader preference in the returned context without deleting or modifying it. Different conditions remain separate and must be checked against the current request. Same-priority conflicting values remain visible rather than silently choosing one. Scope authorization, source checks and expiry run before this selection; user preferences are not automatically enabled for projects.

### Experience checks

Recalled, active experiences produce run-local pending verification items. Historical
evidence does not prove the current implementation. The model adds applicable checks
to its plan and uses resolve_memory_check to cite a current completed verify task
with version-bound evidence, or records a reason for non-applicability. Outcomes are
audited, not used to inflate confidence or automatically activate/share memories.
Memory disablement, revision changes and scope changes remove old items from context.
Candidates remain hypotheses and are not silently promoted. Planning/check selection
and non-applicability remain model judgments; this is not a measured reduction in bugs.
Prior contracts and regression tests should be preserved; removed scope is not a fix.

Pending recalled-experience checks block final completion until checked or explicitly assessed as not applicable. The runtime allows bounded corrective steps; historical evidence is never replayed.

### Installing this update

No new dependency, model download or database migration is required. Existing launcher source fingerprints include this backend change. Stop the running service after tasks finish and run Start-Amadeus.cmd; new installations continue to use First-Start-Amadeus.cmd. Opening an existing process does not activate updated backend code. Existing memory records are retained; verification items are created only when eligible experiences are recalled.

Experience dispositions now record a fingerprint of the declared task contract (acceptance, dependencies, artifacts and input/output declarations). Adding/removing/changing that contract reopens old applicability/check decisions; progress-only status changes do not. Legacy decisions without a fingerprint also require reassessment. This detects structural changes within a run, not semantic weakening or cross-session contract loss. Outcome events retain the memory revision and contract fingerprint for audit; they do not establish causal improvement.

### Evidence-backed learning review

- `propose_verified_experience` requires an executed typed failure and a later successful, current version-bound verify task from the same run. It records expected/observed behavior and a cause hypothesis alongside artifact and event references. It creates an inactive conversation-local candidate, never a proven causal law or automatic shared memory. Reported behavior and causality still require review.
- `compare_acceptance_contracts` compares an earlier root run in the same conversation with the current plan. Added, removed and changed contracts are explicit. Stable task IDs are required for matching; renames appear removed/added. It is structural comparison, not semantic weakening detection or permission to remove requirements.
- `inspect_learning_outcomes` reports current eligible experience dispositions and existing intervention assessments for up to the latest 100 runs in this conversation. Changed trajectory, cleared errors and recorded progress remain distinct. Disabled memory returns no metrics. The report does not calculate defect prevention, calibrated confidence or causal improvement, nor automatically change routing or permissions.
  Automatic tool choice remains model-driven. No new dependency or launcher change is needed; restart the stopped service to load the compiled backend. Retrospective reports do not execute tests or replay operations.

### Retrieval diagnostics and graph automation (2026-10-11)

Knowledge retrieval uses SQLite lexical retrieval plus optional local/API vectors, exact search below 2,000 eligible vectors and HNSW above that boundary. The default is a custom chunk pipeline; optional LightRAG is now available through the local sidecar. Local multilingual-e5-small is 384-dimensional with query/passage prefixes. Optional cross-encoder reranking and windowed embeddings are documented in [Local retrieval](LOCAL-RAG.md); the built-in small encoder still has a fixed tokenizer budget.

Hybrid results retain channel ranks/raw scores and RRF contributions instead of overwriting fusion scores with ranks. Heading boost is separate; scores are not calibrated probabilities and may rank unrelated candidates. Alternative sources require whitespace-normalized identical chunk text among retrieved candidates, not arbitrary documents or exhaustive duplicate discovery. Empty queries return no candidates.

Authorized folder graph extraction already activates source-backed unambiguous relations automatically (bounded to the first 8 chunks/14,000 characters). Ambiguous entity relations are recorded as deferred while valid relations continue. Unique confirmed same-scope entity names with already-confirmed aliases are reused by proposal tools. New aliases and ambiguous matches still require review; quoted co-occurrence is not semantic truth. No additional remote calls or expanded consent scopes are introduced.

Remaining evaluation includes controlled reindexing, bilingual held-out retrieval and threshold calibration. Index/database replacement and 1024 dimensions alone do not establish improved relevance.

### Retrieval inventory for agents

The core read-only tool `inspect_retrieval_status` reports only the current conversation's authorized knowledge scopes and accessible memories. It includes current/retained documents, chunks, UTF-8 chunk payload bytes, vector coverage and dimensions, missing/stale/invalid vectors, import health, and memory state versus recall eligibility. It does not expose source text, credentials, other conversations' private memories or global database totals. Serialized vector bytes and estimated float32 payload size are not physical disk/RAM usage; shared database and remote collection sizes remain unknown rather than guessed.

Empty knowledge searches include inventory diagnostics that distinguish disabled scope, no import, import failure, awaiting import, no searchable chunks, lexical-only mode, incomplete indexing, mixed dimensions and a fully indexed search with no match. These states do not certify relevance or truth.

Index recommendations are advisory. The built-in route remains exact below 2,000 eligible vectors and HNSW otherwise. A supplied `memoryBudgetMiB` only informs the recommendation; it changes no settings. IVF needs representative training and tuning; PQ is lossy compression and must pass recall evaluation. Count alone never triggers a backend switch, download, network health check or rebuild. Configured external backends are reported separately from verified service health.

### Graph discovery and provenance

Graph tools distinguish semantic entities from memory-source nodes. Legacy memory:ID records get readable source previews without renaming or inventing aliases. Discovery matches labels, bilingual lexical terms and currently permitted evidence; list_memory_entities returns pagination and current scope counts. Invalid, superseded and conversation-inaccessible memory sources are excluded at read time; retained history is not current truth. Empty search diagnostics distinguish no visible graph, no matching nodes and nodes without usable edges. Source links remain provenance, never inferred semantic facts. Existing authorized document extraction and optional LightRAG are separate from this memory graph.

Automatic management now backfills up to four active source-backed memories per idle cycle through the already authorized conversation model. Names, relations and quotes must be present in both memory and original human text. Ambiguous entities are deferred; interrupted calls are not replayed. Automatically derived entities disappear from current results when their evidence becomes invalid. A shared topic no longer implies contradiction: exclusive attributes compare entity, applicability and value; multi-valued records may coexist. Old automatic disputes join source review, requiring explicit coexistence decisions; user-disabled items stay disabled. This is source-checked model extraction, not proof of semantic truth.

### Retrieval quality and investigation

Search defaults to all authorized documents; optional documentIds narrows only a particular follow-up before lexical and vector selection. Lexical/vector candidate pools are up to 60 each. New imports use 600-character passages with overlap for long lines (a character bound, not a tokenizer guarantee). Existing large chunks remain intact: reranking selects up to three query-local 600-character windows and returns exact offsets plus original citations. Relevant tail text can therefore be scored without a destructive reimport.

Automatic relative-gap cutoff conservatively retains at least two passages, leaves short/flat or non-sigmoid score lists unchanged, and exposes deferred IDs/scores. It is a heuristic, not calibrated relevance: unrelated high scores can survive. No universal threshold proves answerability. Results remain unassessed until the agent records assess_retrieval with evidence and missing aspects; this assessment is not a verification verdict. Up to four unique investigation queries, a 60-second budget and two consecutive no-new-evidence rounds bound a call; these limits do not cap an entire conversation. Retrieval traces keep candidate hashes, configuration identity and ranks locally (latest 500). Raw query text is not exposed by the agent trace tool. Historical traces aid audit, not bitwise model reproducibility or proof a corpus is complete.

## Conflict-record consistency repair

Creation and editing persist detected conflict IDs. Self references, other scopes/conversation partitions, unavailable or expired targets are excluded. Valid explicit links between mutually disputed entries remain visible even though neither is recalled.

At service startup, a local audit repairs current disputed records. Recoverable references are retained; records without current counterparts become candidates requiring human review. Repairs never activate recall, call a model, change source text or delete history. Revision history retains before/after states, and repeated startup is idempotent. Historical and expired entries are not revived.

Human-review holds exclude repaired records from automatic candidate review and automatic conflict resolution. Explicit human confirmation or adjudication is required. The UI explains missing counterparts rather than presenting an empty list as proof of a contradiction.

New automatic extraction and candidate review classify applicability separately from memory kind. Uncertain applicability stays in the original conversation; a preference label alone does not establish sharing. Legacy records without independent applicability assessment retain type-based defaults. Explicit reach overrides take precedence. Existing records retain their legacy reach and are labeled as not separately reviewed; no bulk activation or migration occurs.

### Multidimensional automatic memory (2026-10-23)

Memories include preferences, reported facts/background, ongoing goals, decisions, episodes and evidence-backed experience. Extraction and candidate review share a contract assessing kind, cross-chat applicability, stability and conditions independently. Users need not say "remember" or "all future chats". Useful direct reports can be shared under existing access rules even when they change over time. Do not infer a user profile from temporary commands, fiction or third-party reports. Secrets remain excluded; explicitly supplied personal context for personalization is minimized, never used to infer sensitive traits or widen audiences.

- Stable content does not decay by default; evolving content decays by source time; temporary content decays by time and later turns. Unassessed legacy records preserve prior defaults.
- Preserve exact quotes, events, source time, units and conditions. Source time is not an inferred measurement date; explicitly reported historical dates stay in the content.
- Shared means eligible for relevant retrieval, not always injected. Recalled evolving facts/goals include a dated-report freshness marker; the model should check currency when material.
- Different stability, conditions or observation times are not merged merely because text matches. Automatically local facts can shadow broad facts for a query without overwriting them.
- No bulk legacy rewrite, widened group/project/personal access, or activation of conflict holds. No database migration, new models or startup command changes.

Design references: [ChatGPT/Codex memories](https://learn.chatgpt.com/docs/customization/memories), [Claude memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory). These inform provenance, cross-session retrieval and namespace boundaries; this is not a reproduction of undisclosed algorithms.

Regression coverage checks extraction persistence, cross-chat facts/goals, source age and decay, conditions, project isolation, local specificity and conflict holds. Semantic classification still depends on the model; local tests are not a measured live-model extraction accuracy evaluation.

## External chat memory isolation

External private chats and groups automatically use a separate `chat:<conversationId>` memory domain. This applies to every supported transport and both chat/work bindings. Local general/project memories are never recalled there, and external memories never enter local or other external chats. Changing applicability or recall reach cannot widen this boundary. Knowledge-library access remains a separate existing permission.

Automatic learning runs during idle maintenance through the conversation's configured model, under the existing bounded extraction/review process. It reads persisted original inbound messages with trusted platform sender metadata, not injected group-history wrappers. Group memories retain their reporting sender and separate subject entities; statements about others must not be promoted to verified personal facts. Learning is asynchronous, not a promise that every message becomes memory immediately. Older messages without trustworthy sender/source records are not automatically backfilled.

The Memory page lists each external conversation separately, with review, editing, forgetting and an automatic-management toggle. Local memory defaults do not overwrite these settings. Initial migration enables isolated learning for existing bindings without changing connection enabled state or reviving stale authorization. Legacy source-linked memories stored in a broader domain are retained but disabled, with revision history; they are not copied or automatically reactivated. Removing an external binding does not remove its isolation marker.

### Subjects inside one external chat

Memory subject is independent of kind (fact, preference, goal, decision, episode) and lifetime: `participant` retains a person's self-report, `conversation` describes shared context/agreements, and `assistant` describes interaction preferences or role framing in that chat. No preset personality or cross-chat profile is created. Attribution and applicability remain visible. Intent is assessed from original context, without keyword, member-count or platform-role adoption rules. A single clear request can establish an interaction preference; repetition alone does not establish agreement. Direct reports, requests, agreements, observations and proposals retain their assessed basis. Proposals remain provisional, and later evidence is reassessed automatically without reviving disabled or forgotten entries. Both local and external memory use revision intent: clear sourced updates can replace older automatic facts, while a newer timestamp alone cannot authorize replacement. Ambiguous contradictions remain isolated for review; ordinary learning and clear updates need no manual confirmation. Fictional roles are not real identity, capability or permission.

A bounded selection of active assistant interaction preferences can accompany even a short greeting, only in the originating chat. They remain conditional memory context, subordinate to current requests and system/tool rules. Personal preferences are not automatically applied to everyone. The memory list labels member context, shared chat context and bot interaction settings separately.
