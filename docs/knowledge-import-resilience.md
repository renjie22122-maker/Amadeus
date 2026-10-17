# Folder import and automatic maintenance

[English](knowledge-import-resilience.md) | [简体中文](knowledge-import-resilience.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-17.

## Configure

Choose All general chats / shared library, a project, or a private conversation scope. Shared general folders do not grant chat command access; projects never implicitly read the general library. Project folder sources must belong to registered project roots. Private conversation scope supports imported documents, not arbitrary host folder scans.

Register up to 12 source paths, choose embedding, optionally authorize graph extraction, then enable/save maintenance. The 30-second worker handles subsequent changes. Local E5 keeps embeddings local; remote embedding and graph extraction disclose their separate destinations. Adding folders does not reparse unchanged successful documents; hashes are checked, same-model vectors reused. Moved files or changed scope have new identities.

## Parsing and limits

There is no fixed supported-file count, visited-entry count, single-source byte size or PDF-page ceiling. Hidden/build/dependency entries, links and unsupported formats remain skipped and counted.

Supported documents include text, Markdown, CSV, JSON, DOCX, XLSX and text PDFs. Images/scanned pages use local Windows OCR with installed language packs. PDFs extract page by page, including beyond page 500, preserving page labels.

Parsing is sequential per changed source in a separate process. A completed page or OCR tile renews the 120-second inactivity deadline; a PDF attempt still has a 30-minute total budget, a 768 MB V8 heap and a 5-million-character extracted-text limit. Native allocations and source-image decoding are not bounded by the V8 heap limit. Excessive extraction fails visibly rather than silently truncating.

Large PDF pages use sequential overlapping tiles at the normal 1.5 render scale, at most 2500 × 2500 pixels per canvas. They are no longer shrunk to fit one canvas. Pathological page geometry requiring more than 256 tiles fails explicitly. This preserves the usual render resolution, not necessarily every pixel of a high-DPI scan. OCR may still misread tiny text or tables; overlapping boundaries may repeat text and regional reading order is not a reconstruction of table cells. Empty OCR results cannot turn maps into textual knowledge.

Folder maintenance saves completed pages and OCR tiles atomically under its private `pdf-checkpoints/<scope-and-source-key>` directory. Fingerprints include source bytes, OCR mode and parser format version; checksums reject damaged records. A retry resumes validated records, including after process restart; changed bytes never reuse old pages. Incomplete documents are not published. Successful imports remove their checkpoint folder; abandoned fragments older than seven days expire when that source is retried. Local checkpoint text stays on disk and follows the application's data-directory access protections. The existing three-attempt/manual-retry policy remains; resumability is not unlimited automatic retries. Shutdown cancels the current isolated parser. Chat document reading has tiled OCR but does not persist checkpoints by default. Attachment upload limits are independent.

## Source discovery and evidence use

The model context includes a count of currently accessible documents and at most six title matches for the current request. This is metadata-only discovery, with no embedding or external model request. Scope and version filters apply before selection. No title match is not proof of absent content, and matches are not proof the documents were read. For relevant local materials the assistant is instructed to retrieve evidence; greetings and unrelated tasks do not require a search. Current authoritative rules, historical examples and practice material must remain distinct. OCR tables with lost layout or questionable numbers require verification; numerical plans need consistent totals. These instructions guide source selection, not a guarantee that every model answer is verified.

## Failures and versions

Each file fails independently. Unchanged failed bytes get at most three parse attempts; changed bytes or explicit Retry failed items resets them; saving paths alone does not reset failures. Transient indexing/network failures use backoff; configuration errors pause and can resume after matching repairs. A failed changed source retires the stale indexed version. Incomplete scans never retire unseen files.

Progress reports stage/file/elapsed/counts. Scan/evaluation can be indeterminate; each stage has its own denominator, not a promised ETA. The panel and progress load separately from vector statistics; edited drafts are retained.

Automatic maintenance indexes imported documents. Batch fill indexes is a one-shot repair for current-scope versions, reuses completed vectors and refuses a changed destination. It does not implicitly enable watching or graph extraction.

Empty searches distinguish no matches, disabled scope, no documents and import failure. Chat history itself is not a knowledge document. See [memory and retrieval](MEMORY.md).
