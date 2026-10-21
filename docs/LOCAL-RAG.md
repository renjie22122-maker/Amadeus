# Local retrieval

[English](LOCAL-RAG.md) | [简体中文](LOCAL-RAG.zh-CN.md)

## Setup

The optional Python sidecar adds E5 small/base/large (384/768/1024 dimensions), BGE cross-encoder reranking, FAISS, embedded Qdrant and LightRAG. Built-in SQLite FTS and hybrid retrieval remain available. Milvus requires a separately deployed server.

Online: run Setup-Local-RAG.cmd then Start-Local-RAG.cmd. Offline Windows x64/Python 3.11:

```powershell
./Setup-Local-RAG.ps1 -Python C:/Path/python.exe -OfflineBundle D:/Path/Amadeus-offline
# NVIDIA GPU variant:
./Setup-Local-RAG.ps1 -Python C:/Path/python.exe -OfflineBundle D:/Path/Amadeus-offline -Gpu
```

The bundle needs wheelhouse, constraints.txt and both model folders under models. GPU also needs wheelhouse-gpu and constraints-gpu.txt. Do not copy virtual environments. Installation targets .data/retrieval-python, not system Python. Startup uses UTF-8 and does not modify execution policy.

Configure local connections in Settings after saving other edits. Select absolute model folders, model identity, extraction connection and scope. Restart the sidecar after changing configuration. Normal application startup starts a configured sidecar; ordinary first startup does not force these large dependencies.

## Privacy and retrieval

Embedding and reranking run locally. LightRAG uses local JSON, NetworkX and NanoVectorDB storage; entity extraction/consolidation sends selected text to the configured generation API. Authorize the intended scope separately. It does not generate a final answer on behalf of the main model.

Long embedding inputs use overlapping windows and normalized mean pooling with query/passage prefixes. This avoids prefix-only truncation but is not a native long-context encoder. Changing dimensions requires new indexes.

Cross-encoder reranking runs after fusion on up to 60 candidates. Its score is not a calibrated probability; evaluate thresholds on representative bilingual queries.

FAISS supports flat/HNSW/IVF-flat/IVF-PQ. Small training sets fall back to flat (2496/9984 rows for IVF/PQ respectively; PQ requires compatible dimensions). Native execution runs in a bounded child process; crashes/timeouts return explicitly labeled exact fallback. Successful native indexes are cached locally by vector-content hash; up to four generations are retained. Embedded Qdrant uses exact search, not server HNSW.

Adapters send scoped vector snapshots per query (80 MiB float32 payload / 128 MiB request / 200,000 vectors maximum), not million-vector streaming ingestion. External old collections require retention management. Milvus client installation does not install its server.

LightRAG uses durable batch IDs; unknown submissions are not blindly replayed. Citations must match current authorized chunk IDs and text, even if older graph data remains locally. Retrieval is not verification.

inspect_retrieval_status reports scoped totals, vector coverage/dimensions and diagnostic states; index suggestions do not authorize switching or rebuilding. investigate_knowledge performs bounded multi-query investigation.

## Local validation, 2026-10-11

CUDA on RTX 4090, E5-large 1024-dimensional embedding and Chinese-query/English-document reranking passed real calls. The supplied FAISS 1.15.1 Windows wheel crashed; Windows setup now pins tested 1.12.0. HNSW passed, and IVF-flat/IVF-PQ trained and queried 10,000 synthetic 64-dimensional vectors successfully. See the delivery report for graph ingestion and remaining service tests.

LightRAG synthetic ingestion and retrieval also passed: 3 entities, 2 relations and 1 source chunk; Qdrant embedded search passed. This is an integration smoke test, not a retrieval-quality benchmark.

## Managed installation

Offline bundles are optional. Setup installs Python packages into the application data directory and prepares models under retrieval-service/models. With no local source, models download from Hugging Face; rerunning setup reuses completed downloads. Local sources are copied and SHA-256 checked before configuration changes, so subsequent startup does not depend on the bundle. Keep the source until setup succeeds. GPU online setup accepts -Gpu and an optional -TorchIndexUrl matching your driver; CPU remains the default. Model download failures preserve existing data.

## Damaged vector tolerance

Knowledge retrieval validates persisted vectors row by row (JSON/object shape, finite numeric values, nonzero finite norm, model and query dimension). Invalid or incompatible rows cannot poison healthy semantic candidates; their text remains available to lexical retrieval. Query embedding failure falls back to lexical retrieval with an explicit degraded reason. Cancellation and database failures still propagate.

Each hybrid result and its retrieval trace carry request-local retrievalDiagnostics, including scanned/usable/invalid/incompatible vector counts; concurrent searches do not share these trace diagnostics. Normal document indexing no longer trusts a matching model name alone: malformed vectors are regenerated and are excluded from reuse. Index status exposes invalid counts. Memory vector caches use the same value validator and tolerate RECORD_CORRUPT for this derived record kind only; ordinary storage failures are not converted into missing data. Incompatible dimensions are skipped at query time; this does not silently migrate models or rebuild an entire corpus. External ANN, reranker or LightRAG service failures are not universally hidden by this policy.

### Query channels and per-passage provenance

`retrievalDiagnostics` reports query-level embedding model/dimension, semantic status, candidate counts and returned-channel counts. `retrievalChannels` and `ranking.embeddingModel` on a passage describe only that passage: a lexical-only hit does not imply vectors were disabled for the query. Semantic states distinguish requested/policy disablement, missing configuration, embedding/backend failure, incompatible candidates, index changes and completed search. Returned counts overlap for hybrid hits. Streaming and small-scope fusion use the same one-based RRF formula, 1/(60+rank). Vector participation and reranker scores are not proof of relevance; ambiguous terms can still produce unrelated candidates. No launcher/dependency changes are required; restart the application to load this update.

The large-scope result adapter now preserves the stored scope before the final authorization filter. Previously semantic candidates could be computed successfully but discarded for missing scope; the authorization filter remains enforced.

### Text encoding and repair of older imports

Text extraction strictly decodes UTF-8 (including BOM), UTF-16 LE/BE with BOM, and BOM-less UTF-16 when alternating NUL bytes provide strong evidence. Invalid UTF-8 may fall back to strict GB18030 (including GBK-compatible Chinese files). Excessive replacement/control characters are rejected instead of silently indexed. This is conservative detection, not universal encoding identification: ambiguous legacy encodings and UTF-32 should be converted to UTF-8. Original files are never rewritten.

On the next enabled folder-maintenance scan after application restart, older text sources receive a one-time stored-text quality audit. Suspicious sources are reparsed even when their file hash is unchanged, versioned, and indexed through the existing authorized pipeline; healthy documents and vectors are reused. A failed repair retires the corrupt current version and records a per-file issue, rather than continuing to retrieve it. Historical versions remain. This migration applies to registered folder sources; manual uploads require reimporting the original file. Already-authorized graph extraction may run again on repaired document text. No new dependency, setup script or vector model is required.

### PDF, Office and OCR content quality

All document extractors now validate the resulting body, not just parser exit success. Empty PDF page labels, OCR headers without recognized content, formatting-only spreadsheets and excessive replacement/control characters do not count as successful imports. PDF pages with broken text mapping are eligible for OCR when enabled; unrecovered corrupt text produces a page-specific error. Knowledge uploads request OCR, like folder imports. Blank pages may coexist with readable pages. This detects structural failures, not OCR semantic correctness: plausible but misrecognized words, layout/table order and missing image text on otherwise text-rich pages still require evidence checks. Existing PDF/Office imports are not automatically reprocessed by the text-encoding migration.

## Long-range reading and bounded hypothesis comparison

For ambiguous multi-source questions, the agent can discover `create_research_case`, `read_knowledge_context`, `inspect_research_case`, `update_research_case` and `investigate_research_gap`. Ordinary lookup needs none of this machinery: `search_knowledge` no longer expands a query merely because it contains “infer” or “compare”. Explicit research search broadens candidate selection for the supplied query; it does not invent three additional queries.

A research case preserves alternatives, supporting/counter passages, missing observations and discriminating predictions. Reading notes can describe timelines, relationships, recurring patterns, constraints or summaries; they cite original chunk IDs and distinguish observation, reported claim and inference. Source openings provide paginated navigation, and ordinal windows restore adjacent context without embedding calls. These are not automatically inferred chapter boundaries or generated full-book summaries. Pass a case ID to context/ordinary document reads to register returned evidence. Truncated context passages are labeled and not registered as fully read; use the document reader for the complete passage.

Cases are shared only within the originating conversation/task tree and compatible knowledge scopes. Document versions, content hashes and an as-of time bind evidence; changed/deleted sources are flagged. Explicitly remove stale citations from the comparison before reading replacement evidence. Repeated passage hashes are deduplicated, but distinct hashes do not prove independent authorship. Notes remain model assessments and never become confirmed long-term memory automatically.

### Stop conditions

These are host defaults, not user configuration chores or proof of optimal retrieval:

| Bound                     | Research-case behavior                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Retrieval count           | At most 6 attempts, shared by members                                                                                                   |
| Single-query deadline     | 180 seconds; the attempt after a timeout can use up to 300 seconds                                                                      |
| Cumulative retrieval time | 12 minutes; the next deadline cannot exceed the remaining allowance                                                                     |
| No additional evidence    | Stop after two successful attempts add no new passage hashes                                                                            |
| Service failure           | Separate from evidence no-gain; two consecutive failures stop with a service diagnosis                                                  |
| Reading                   | At most 16 registered windows/pages and 160,000 returned characters, shared by members                                                  |
| Duplication               | Reject repeated successful queries and unchanged windows for the same member; the same question in a task tree reuses its existing case |

Timeouts rely on the retrieval backend honoring cancellation; synchronous local work is not forcibly terminated by a JavaScript timer. Failed attempts consume count/time budget but do not prove missing evidence. A failed query may be explicitly retried within the same budgets; there is no automatic loop. Stopped-owner attempts are reconciled without replay, with conservative estimated elapsed time labeled as estimated. Reading and lookup outside this workflow remain available for other tasks; these limits are not a global ban on all retrieval. The agent must not bypass them by renaming the same investigation.

Stop early when the needed distinctions are supported, or when available evidence cannot distinguish alternatives. Budget exhaustion requires reporting coverage gaps, not choosing a winner. New passages alone do not establish improved reasoning. Open/inconclusive research produces a nonblocking delivery warning, so the runtime does not force more searching merely to clear a gate. Exhaustive reading requires separately planned coverage; this workflow never claims that a large corpus was read in full.

To request focused peer scrutiny, link `researchCaseId` in `submit_team_proposal`. Reviewers identify an alternative, a discriminating observation and its effect on the conclusion. Changes to the linked comparison/source invalidate its accepted state. Existing proposal response/revision/recheck rules apply; no extra team or messages are required for simple work. This is currently grounded in indexed knowledge passages, not an automatic universal verifier for web pages or experiments.

No new model, package, reindexing or launcher change is needed. The running service loads the update only after a later restart. These regression-tested mechanisms do not establish an improvement in literary interpretation or general reasoning scores.

CLI extraction selection is provider-neutral: explicit `--profile` wins (unknown IDs or incompatible transports fail), otherwise retain existing extraction settings; for a new configuration use the compatible default profile or sole OpenAI Chat connection. Ambiguous choices leave extraction unconfigured with a message, while embedding/reranking remain usable. No corpus is sent during configuration. An explicit profile replaces the old extraction connection. Switching embedding models no longer carries over the old offline directory unless explicitly specified again.

### Query latency and cache behavior

Retrieval traces record executed stages in `diagnostics.timingsMs`: lexical search, query embedding, streamed vectors, document graph, LightRAG and reranking. Total latency alone does not identify corpus size as the bottleneck. On a manifest cache hit, `vectorHealth.scanned` is build-time coverage, not a fresh full scan.

Query embeddings and reranking of identical input use process-local caches (64 entries, 120 seconds), including concurrent request coalescing with independent caller cancellation. Cancelling all subscribers aborts the shared request. Keys include connection/model/credential configuration and exact input. No full retrieval results or disk query cache are stored; scope/version checks remain in place. Candidate counts and reranking quality settings are unchanged.

Compatible services support `/vectors/search-batch` for up to 64 cached shards. FAISS retains native process isolation while starting Python once per batch; older adapters use the per-shard protocol. FAISS disk indexes have a 512 MiB eviction budget instead of a four-file limit; memory retains at most two indexes. Qdrant reuses content-addressed collections only after successful population and count verification; partial writes, deletion and count changes trigger repair. This write optimization is not yet applied to Milvus.

An isolated synthetic four-shard HNSW microtest (64 vectors per shard, 16 dimensions) measured 1.294 s serial versus 0.307 s batched with identical scores/ranks. This is not a production end-to-end guarantee. Cold model loading and long-passage reranking can still dominate. Existing local RAG processes require an idle restart to load the updated Python implementation; launcher change detection remains in effect.

### Request deadlines and document-graph latency

The local sidecar verifies prefixed, re-tokenized embedding windows against the loaded model's finite input limit before inference. Tokenizing a full source for windowing is not the same as feeding it to the model. No source file is shortened or removed. Reranking validates the loaded model's token limit too.

Content-free diagnostics are stored in `.data/retrieval-service/requests.jsonl` (1 MiB rotation, one previous file). They contain request IDs, stage durations, model input counts/limits, and outcomes; never prompts, token IDs, credentials, URLs or vectors. Local client requests share an ID and deadline with the sidecar. Client logs distinguish caller cancellation, deadline expiry and transport failure. Queue wait, model load, tokenization and inference are measured separately. A disconnected client receives no second error response. Expired requests stop before the next model batch; an already executing native model batch cannot be forcibly cancelled safely. The model lock still bounds concurrent inference; HTTP concurrency does not imply parallel GPU kernels.

Document chunks now have a `(document_id, ordinal)` index, which also speeds neighbor reads. Graph search checks each distinct source quotation once per invocation and reuses that invocation's visible edges; later queries revalidate source changes and permissions. Event evidence uses an exact event lookup instead of loading a conversation's history. These changes retain scope, time and source checks; no documents or indexes are discarded. Startup adds the SQLite index automatically; no re-embedding is required. The local RAG launcher checks both service and helper module versions.

Validation on an isolated snapshot of 90,108 chunks and 379 graph edges: the same query took 31.870 s without the document index/reuse versus 0.014 s after, with identical complete graph results (that query had zero matching paths). This is a graph-stage measurement, not an end-to-end guarantee. A separate offline CPU inference test used 3,732 multilingual source tokens in nine windows; actual tensor input length was at most 485 against a 512-token limit. Cold model load was 8.282 s and subsequent inference 0.312 s. Controlled queue expiry returned 504 without entering inference; controlled client cancellation recorded `client_disconnected` without a repeated traceback. Historical disconnects without request IDs cannot be retroactively classified.

A synchronous graph full scan can also delay context-panel HTTP requests on the same Node process. The index addresses the observed bottleneck; a loading panel alone is not proof of a frontend fault. Watcher `processing` can mean scan/hash validation, not import: use the phase and imported/reused counts. Cached vector coverage counters are not per-query scan counts. Duplicate PDF/DOCX files remain available; matching passages do not establish independent corroboration, and a failed retrieval does not prove corpus absence.

Scan diagnostics separate the current cycle from the last completed scan. Processing alone does not mean new imports or vector writes. Compare counts only with matching scope, as-of time and observation timestamps. Unchanged files skip parsing; completed indexing jobs are not read or rewritten by maintenance. Cached HNSW shard coverage is not the number of vectors scored on each query.

Large-corpus statistics and index-status HTTP/tool requests yield every 64 rows so vector inspection does not monopolize the server event loop. This is cooperative scheduling, not faster inference. LightRAG is a separate opt-in channel; graph ingestion and API costs remain distinct from the built-in evidence graph.

Optional LightRAG query errors now preserve scoped base retrieval and report lightRagStatus=unavailable with elapsed time. This does not certify graph coverage; an enabled connection may still be building its graph.

Cold vector shard restoration selects a bounded page of eligible IDs through a partial covering index before loading vector payloads. This avoids sorting the corpus-sized vector JSON payload for every page, while preserving scope and temporal document filters.

LightRAG duplicate-content entries count as complete only when the referenced original is processed and its text matches after boundary-whitespace trimming (as stored by LightRAG). Unknown jobs may be reconciled against the original request digest and persisted document states; reconciliation does not resubmit extraction or repeat model calls. Missing, changed or unfinished evidence remains unknown.

Generated duplicate IDs are resolved through the exact submitted source path, then validated against the processed original content; filename-only matches never imply success.

### Shared tokenizer concurrency and inspected recovery

Embedding windowing, reranker length inspection, inference and LightRAG's tokenizer adapter share the same model lock. Each inference batch releases it; network extraction and the whole ingestion job are not locked. This prevents fast-tokenizer mutable truncation/padding state from being accessed concurrently. HTTP and extraction remain concurrent, without guaranteeing query priority.

An authenticated local `POST /lightrag/documents/resume` accepts `jobId`, the exact `original` submission and `confirmRetry: true` only after operator inspection. The original request digest must match. Recovery verifies unchanged persisted source/content, rejects unrelated unfinished documents and uses LightRAG's explicit one-attempt manual recovery protocol. It preserves completed records and existing extraction caches; it does not re-upload documents or silently retry unknown work. Failed documents may still require uncached extraction work. Another failure remains unknown for inspection. Keep this endpoint operator-driven, not part of periodic scanning.

The knowledge page separately displays LightRAG graph progress: confirmed source chunks / current eligible chunks. Counts advance per confirmed source chunk, independently of folder scans, vector indexing jobs and entity counts. UI requests read cached progress and schedule bounded background status checks without submitting graph work or scanning vectors. The last observation time is shown; unknown jobs require inspection, and connection failures preserve previous counts.

Graph progress now polls bounded batch status every two seconds without blocking UI requests. Each confirmed source chunk counts immediately, even when another chunk fails; completed counts are reconciled before the next batch. Extraction transport failures receive at most five retries (six attempts total, exponential backoff up to 16 seconds, 120 seconds per attempt, within the overall job deadline); authentication/schema errors do not. Local bounded diagnostics retain exception type, cause, HTTP code and duration, never prompts or credentials.

### Resume interrupted graph construction

The knowledge scope page offers **Resume graph building** when synchronization needs recovery or cannot refresh. It checks the authorized scope and original batch before asking the local service to resume incomplete content. Completed graph content is retained; an active batch is not submitted again. Background synchronization then continues subsequent batches. This does not clear the graph or reset source imports. If the original batch is missing or its sources changed, recovery stops for inspection rather than guessing or rebuilding everything.

Recovery note: a batch duplicate can point at a provisional ID that was itself deduplicated against an older graph document. Completion now resolves that missing ID through the content-hash lookup and verifies both processed primary status and exact stored text. Hash matches alone, active records and duplicate markers do not count as completed. This is a read-only reconciliation; it does not delete sources or repeat extraction. Job failures retain bounded traceback locations (not request bodies or credentials) to distinguish pipeline errors from query timing.
