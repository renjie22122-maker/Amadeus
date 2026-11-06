# Office files and structured analysis

[English](OFFICE.md) | [简体中文](OFFICE.zh-CN.md)

Office tools are shared by local conversations, projects, and connected chats. Ordinary chats can process only sent attachments belonging to that conversation. They do not gain host filesystem or shell access. Local paths must remain in the current authorized file scope. Export/edit/create respect artifact creation permissions.

## Workflow

1. `office_open` snapshots and hashes the source, inspects workbook headers/merged ranges or document parts, and reuses the parsed snapshot for repeated queries.
2. `office_query` filters all XLSX/CSV rows locally. AND/OR predicates, literal text matching, typed numeric comparisons, sorting, grouped counts and aggregates are supported. Only the result page enters model context. Pagination never restricts the rows scanned. Group summaries explicitly flag truncation after 200 groups.
3. For semantic ranking, inspect real headers and eligibility notes, filter mandatory requirements, then evaluate all remaining candidates. Keyword hits are not semantic relevance scores; missing conditions are not evidence of eligibility. Do not ask the user to prefilter just because the extracted text exceeds context.
4. `office_export` returns every matching row as an XLSX attachment with original sheet/row, source hash and query audit. Original files remain unchanged. Exported formula-looking strings remain literal; cached formula results are not recalculated.
5. `office_read` searches and pages DOCX/PPTX text objects by stable part/block IDs. DOCX table paragraphs and presentation-order slide parts are identified. PDF/text use extracted text (PDF may use OCR), not verified page coordinates.
6. `office_edit` creates a new XLSX/DOCX/PPTX copy using exact expected old values, rejects stale or duplicate targets, and reopens the result to verify edits. Full paragraph replacement uses first-run styling. Excel library round-trips may alter unsupported features.
7. `office_create` produces basic DOCX/PPTX/XLSX/PDF attachments from structured blocks, slides or literal cells. Reopen outputs to verify content. Connected chat uses the existing file-delivery pipeline; creating an attachment does not prove platform delivery succeeded.

## Execution and limits

A shared cancellable FIFO queue runs one fixed Office subprocess at a time, avoiding unbounded parallel parsing and main-thread blocking. The process has a 768 MiB V8 heap budget and 120-second execution deadline. Inputs are limited to 128 MiB, OOXML expanded packages to 512 MiB/50,000 entries. Limits fail explicitly, never claim a partial scan is complete. Result pages are bounded independently of full-table evaluation. Parsing cache is conversation-local and content-addressed. No macros, user programs or formula execution are provided.

This is structured file processing, not native Office automation. Visual fidelity, chart rendering, recalculation, tracked-change editing, legacy binary .doc/.xls/.ppt, Outlook mail/calendar, Access and OneNote are not implemented by these tools. Use an appropriately authorized native integration when those capabilities are required; do not claim they were verified.

## Regression evidence

`tests/office.test.ts` covers full-sheet filtering/export beyond the visible page, columns absent from the first row, source-row provenance, cached imports, missing filter values, stale edits, literal formula-like text, DOCX/PPTX reopen verification, cross-conversation/host-path denial, revoked scopes and cancellation. Fixtures are isolated and do not touch knowledge indexes or live chats.
