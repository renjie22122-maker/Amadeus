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
