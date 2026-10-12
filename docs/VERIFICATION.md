# Testing and evidence

[English](VERIFICATION.md) | [简体中文](VERIFICATION.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-12.

## Current verification baseline

On 2026-10-05, the Amadeus rename at d663030 passed 333 tests, with 2 explicitly skipped environment-dependent tests, plus TypeScript and production build. This documentation update does not constitute new paid-model or OS-isolation testing. The build still reports large chunks.

Run from repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Use pnpm 11.19.0 and Node.js 24+. CI runs the checks on Ubuntu and Windows. A local pass is not a claim that a later remote CI job passed.

Optional host tests:

```powershell
$env:AGENTDEMO_BROWSER_TEST = '1'
node --import tsx --test tests/browser-tabs.test.ts
$env:AGENTDEMO_DESKTOP_TEST = '1'
node --import tsx --test tests/window-capture.test.ts
```

The desktop fixture creates its own windows and tests covered-window capture/minimized rejection; it is not a broad application benchmark. A skip is not a pass.

## What evidence means

A tool receipt proves that an observation occurred against recorded artifacts, not semantic correctness. File coverage comes from actual matching reads; command exit zero does not check every declared file. Verification tasks require a passed observation before done; owner self-check and another-run check are distinct. A different run alone does not ensure independent reasoning.

Snapshots include declared artifacts/read paths, package/config manifests and recognizable relative JS/TS imports. Bounds: 512 entries, 4 MB/file, 16 MB total. Incomplete inputs reject binding. Dynamic imports, external resolution and undeclared dependencies are not fully covered. Before/after hashes detect many stale cases, not adversarial TOCTOU.

Tests include negative controls, crash windows, unknown effects, startup state combinations, permissions, source scopes and replay prevention. They do not exhaust every runtime sequence or certify isolation.

## Benchmarks

- [Coding pilot](../evals/coding/README.md): production runtime on small synthetic tasks; both arms 10/10, with no reuse/compaction exercised.
- [Planning](../evals/planning/README.md): proposal protocol and graph checks, not delivered code or worker throughput.
- [Context/control](../evals/context-control/README.md): paired synthetic probes; no demonstrated implementation benefit.
- [Approval history](APPROVAL-EVALUATION.md): 0 percentage-point incremental reduction on its small balanced sample.

API usage omissions and unconfigured prices remain unknown. Cached tokens are a subset of input, not extra tokens. Historical reports are dated and kept in [history](history/README.md); no numeric capability rating is inferred.

CI also checks current bilingual guide pairs and local link targets, builds backend assets and smoke-tests compiled HTTP/isolated parsing, image codec and ONNX module loading. These checks do not prove document semantic freshness, clean-machine embedding inference or sandbox correctness.

## Explicit acceptance layers

Task done records execution completion with attached observations. record_verification binds a successful check to current inputs. record_task_acceptance separately records an authorized reviewer's accepted/rejected/uncertain judgment, rationale, attempted counterexample and evidence IDs. Its kind explicitly remains reviewer-judgment-not-proof.

Set requireSemantic on substantive implementation/delivery contracts to require accepted semantic assessment before delivery. Rejected assessments block delivery even on optional contracts. Changed criteria or stale artifact stamps invalidate the assessment. requireIndependent additionally rejects the author as semantic reviewer and author-only evidence. Permission approvals do not populate human acceptance; that field remains not-recorded. The blackboard and delivery projection expose these layers separately. This is evidence-bound review, not automatic proof of software correctness.

Validation on 2026-10-12 for the boundary/receipt/decomposition update: 425 tests, 423 passed, 2 environment-dependent skips; TypeScript, production build and compiled HTTP/document/image/ONNX smoke checks passed. No paid model requests were used. Large frontend bundle warnings remain. The live strict-native refusal and unavailable Docker checks are recorded in the security guide and are not successful sandbox-containment tests.

## Slow-refresh UI regression

After building, run node scripts/check-chat-ui.mjs (install a Playwright browser first, or set BROWSER_CHANNEL=msedge for an installed Edge). It uses a temporary database and fake provider, blocks refresh GETs after submitting, verifies the send spinner ends at acknowledgement, checks the next draft remains editable, then releases refresh and checks timeline convergence. No live user conversation or paid provider is used.

Chat-performance regressions also check metadata-only active lookups with intentionally corrupt historical checkpoints, scoped records, incremental events, and SSE gap repair. These are behavioral checks, not production latency benchmarks.

Validation for this update: 428 tests, 426 passed, 2 skipped; TypeScript, production build, compiled-service smoke and the isolated Edge slow-refresh regression passed. Skipped native desktop tests are not containment evidence.

Vector/chart update validation: 434 tests, 432 passed, 2 skipped. Added malformed-vector, repair, cancellation, database-error, scope and concurrent-trace cases. scripts/check-chart-ui.mjs uses a temporary fake-provider service to exercise all four charts, code switching, mobile width and restored-chat bootstrap; scripts/check-chat-ui.mjs still checks slow-refresh send acknowledgement. Both passed with installed Edge (BROWSER_CHANNEL=msedge). These checks do not certify all renderer formats or OS isolation.
