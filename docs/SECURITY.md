# Security model

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-12.

## Local service and data

Amadeus is a single-user loopback service, not a multi-user deployment. Host/origin validation, HttpOnly SameSite cookies and CSRF checks protect its control API. Windows settings use current-user DPAPI; other platforms use restricted local files. Same-user malware or administrators can still access data. Keep .data and .diagnostics out of Git.

FileScope checks authorized roots, traversal, symlinks/junctions, hard links, metadata and private storage. Case-normalized checks matter, but application path validation is not OS command isolation or an adversarial filesystem lock. Skills, retrieved documents, memories, screenshots and tool output are untrusted context.

## Approval versus isolation

Read-only denies commands and writes; general chats have no project command capability. Ask requires concrete command approval. Scoped file writes are allowed by default; enable Approve file writes to approve mutations outside Trusted mode. Trusted is explicitly selected, and isolated children of Trusted parents start in Ask.

Fresh configurations choose AppContainer on Windows and Docker elsewhere. Existing configurations retain their backend. Missing prerequisites fail closed, without host fallback. Host commands run with host-account rights; cwd does not contain their effects.

Docker uses a non-root UID:GID (default 1000:1000), no network, dropped capabilities, resource limits, a read-only container root and a selected project mount. Metadata directories are masked; unsafe linked/metadata-pointer entries are rejected. Docker requires an installed image and running daemon; this workstation's Docker isolation has not been integration-certified.

AppContainer requires an absolute Python path. File-isolation mode permits host network; strict offline additionally requires successful network-denial preflight. This workstation previously failed that preflight. Native execution refuses directories containing .git/.agentdemo: selective metadata-denial ACL testing failed, so it is not advertised as solved. Use a clean isolated copy. See [backends](MIGRATION.md).

## Other execution channels

MCP executables, browser adapters and Computer Use run with their separately configured host authority. Enabling them is not protected by the command sandbox. Public fetch_url validates/pins public DNS addresses and redirects; browser host rules are separate and are not DNS-pinned SSRF isolation. Configured model/embedding endpoints may intentionally be local.

Action restrictions can deny or require human review; they cannot grant wider authority. Source-injection warnings are heuristic, not complete taint analysis. Package signatures authenticate a supplied publisher key, not code safety.

## Effects and approval evidence

Approval waits have no expiry. Effects begin only when an approved mutation is about to execute. Proven pre-start failures record not_started; timeouts may remain unknown. Exact file postimages can resolve automatically; arbitrary command outcomes require evidence and, where unresolved, user confirmation/retry authorization. No blind replay.

Automatic review may inspect bounded source evidence only under its authorized same-profile path; separate reviewers do not automatically receive it. Failure means human review, never allow. See [automatic approval](AUTO-REVIEW.md).

Regression tests establish exercised contracts, not a security certification or correctness proof.

## 2026-10-12 boundary audit

- Scoped file reads use a checked file handle and bounded allocation. Publication uses an exclusive temporary handle, flushes content, rechecks parent/file identity and cleans only the matching temporary entry. Concurrent no-clobber publication and an injected junction-swap boundary have regression coverage.
- **Residual P0:** portable Node path-based publication and cleanup are not handle-relative filesystem confinement. A hostile process able to rename ancestors can still race the final operation. These tests do not establish bypass-proof protection; use OS isolation and do not run hostile workspace mutators concurrently with host file tools.
- Unknown backend values, root Docker users and ambiguous Docker mount paths are rejected before launch. Strict native receipts require network-preflight confirmation. A process error after the spawn event is an unknown outcome, never a proven pre-start failure.
- Live check on this workstation: Docker was unavailable; strict AppContainer returned SANDBOX_PREFLIGHT_FAILED (network denial not confirmed) before the requested echo command. No host fallback occurred. Docker containment and successful native isolation were **not** integration-certified.
- Recovery references bind an effect to its original run, conversation and durable command/media job. A media receipt can establish submission, not successful generation or acceptance. Unknown external non-idempotent tools without a protocol still require inspection; no generic retry is safe.
- User effect resolution is an audited attestation, not a host-verified success. Reconciliation cannot overwrite an already settled effect.
