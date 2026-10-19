# Amadeus benchmark plan

[English](BENCHMARKS.md) | [简体中文](BENCHMARKS.zh-CN.md)

## Purpose and implementation status

Evaluate **model × runtime × task × environment**, not feature counts or subjective architecture scores. The [requested article](https://blog.csdn.net/u013010473/article/details/157695931) is a useful multidimensional overview; use official implementations for current versions and grading.

Adapters cover eleven BFCL Python/live single-turn categories, LongMemEval S/oracle full-context QA, and GAIA validation. Environment readiness, attempted counts and grades are separate milestones.

## Tracks

| Priority   | Frozen benchmark                                       | Measures                                             | Grading and prerequisites                                     |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| P0         | SWE-bench Verified, pinned dataset revision/test split | Real repository issue repair                         | Official patch grading; distinguish sample from full results  |
| P0         | Terminal-Bench 2.0 through Harbor                      | Multi-step terminal work and artifacts               | Official verifier; 2.0 is a reproduction baseline, not latest |
| P1         | BFCL V4                                                | Tool selection, arguments and multi-turn calls       | Official AST/execution checks, not end-to-end security        |
| P1         | τ²-bench pinned release                                | Dialogue, tool use, business constraints             | Official state grading; include simulator costs               |
| P1         | WebArena via BrowserGym/AgentLab                       | Browser workflows and website state                  | Resettable self-hosted websites, not demo servers             |
| P1         | LongMemEval original snapshot; V2 separate             | Cross-session updates, time and abstention           | Actual Memory ingestion pipeline, official scoring            |
| P1         | Internal bilingual RAG holdout                         | Retrieval, cross-document reasoning, abstention      | Independent relevance labels; not a public leaderboard        |
| P2         | Original OSWorld pinned snapshot                       | Cross-application desktop tasks                      | Disposable VM and reset; never user's desktop                 |
| Continuous | Internal reliability/security suite                    | Crashes, approval, scope, injection, unknown effects | Assert observed side effects; separate from capability scores |

Official sources: [SWE-bench](https://www.swebench.com/SWE-bench/guides/evaluation/), [Terminal-Bench 2.0](https://www.tbench.ai/news/announcement-2-0), [current Terminal-Bench run guide](https://www.tbench.ai/run), [BFCL](https://gorilla.cs.berkeley.edu/leaderboard), [τ²-bench](https://github.com/sierra-research/tau2-bench), [WebArena](https://github.com/web-arena-x/webarena), [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [OSWorld](https://os-world.github.io/).

The current Terminal-Bench run page uses 4.0 and GPU-capable environments. Keep that distinct from the chosen 2.0 local reproduction. Datasets, models and dependencies retain their own licenses.

## Stages and comparisons

0. No-model-cost container/grader checks: correct, broken, empty, timed-out and tampering controls, mounts and reset.
1. Ten SWE tasks, repository-stratified with a fixed seed and frozen IDs before generation. Verify gold and empty-patch controls. Record exclusions before seeing agent outcomes.
2. 100 paired tasks × 3 repetitions × 2 configurations = **600 attempts**. Stratify by repository and available difficulty; alternate AB/BA, reset each attempt. Never label a subset as the full Verified score.
3. Full official suite and additional tracks. Start terminal/browser adapters at 10 tasks, memory at 20, then expand. Publish separate track scores, not one superiority score.

A: production single agent. B: read-result-reuse disabled only, as implemented in the current coding pilot; **not all context optimizations off**. C: Team after adapter implementation, under the same total time/token/cost budget including all children and reviewers. D: full context ablation only after each intervention is implemented and observed; otherwise unavailable.

Start concurrency 1, then 2. Initial planning allowance: 2 CPUs/4 GiB/20 minutes per task; validate against official task needs first, separately bound grading, classify inadequate resources as infrastructure errors. These are evaluation settings, not product-wide limits. Before paid batches require model, price source and per-attempt/batch budget. Unknown prices cannot enforce a claimed hard dollar budget. No 600-attempt batch has run in this change.

## Adapter and isolation contract

prepare → reset → solve → collect artifact/patch → stop agent → grade → archive → cleanup.

Each attempt has its own store, container, files, session and retrieval/memory cache. Give the solver only the issue, base code and permitted resources. Keep gold, hidden tests and graders inaccessible. Audit upstream images before solver use: some evaluation images may already contain grading material.

Keep model credentials in the trusted host broker, never in candidate-code containers. Only the trusted harness controls Docker; do not expose its socket to submissions. Amadeus's per-command Docker backend is not automatically a persistent benchmark environment; all attempt file/command operations must target the same environment.

Limit capabilities, processes, CPU, memory, time and output. Prepare dependencies before solving; default to no network. Browser tasks need an internal test-site network; internet tasks form a separate allowlisted group. Never fall back to host execution.

Unknown interrupted effects are retained and never silently replayed; new attempts get new identities. Regrading immutable artifacts is separate from rerunning the agent and records a new grader/version identity.

## Manifest, metrics and analysis

Record run/attempt/task IDs; code commit and dirty-diff hash; dataset revision and exact IDs/input hashes; grader commit; image digests; model/endpoint without secrets, parameters, tools/permissions, budgets, seeds, resources, timestamps and artifact hashes. Preserve official raw reports.

Measure pass@1; complete/partial/timeout/infrastructure/not-started counts; keep all scheduled tasks in the denominator and separately show gradable tasks. Report all-three-success consistency separately from best-of-k/pass@k.

Aggregate input, cached-input subset and output across the whole task tree, reviewers, rerankers, simulators and judges. Never add cached tokens twice. Separate billed and estimated costs; unknown is null. Cost per solved task includes failed attempts; zero successes makes it undefined. Unobserved provider retries are null.

Report end-to-end and execution p50/p95 latency, tool calls, retries, compactions, stagnation, recoveries, human interventions, queue wait, false completion, scope leaks, unauthorized effects, orphan processes and peak resources. Use task-clustered paired bootstrap 95% intervals for differences; repetitions are not independent tasks. Wilson intervals may accompany single-arm proportions. Report counts as well as percentages.

Cold/warm provider cache experiments require separate design; alternating run order alone does not prove cold cache. RAG: Recall@10, nDCG@10, supported citations, false answers on unanswerable questions, bilingual strata, index coverage and latency. Tune thresholds only on development data. Memory ingestion must not see future test questions; test updates, expiration, project separation and conflicts. Multiple agents citing one source are not independent evidence.

## Local validation and commands

2026-10-12: Docker Engine 29.8.2, Linux, 32 CPUs, about 31.2 GiB memory. A real Alpine container passed non-root, read-only root/bind mount, writable tmpfs, zero capabilities, no-new-privileges and loopback-only network checks. This is a smoke test, not an adversarial isolation audit. No reboot needed for current Docker availability.

```powershell
node evals/benchmark/preflight.mjs
node evals/benchmark/preflight.mjs --container
node --import tsx evals/coding/run.ts --preflight
```

Engine-only by default; --container requires locally installed alpine:3.22 or --image= with an Alpine-compatible image. Never implicitly downloads or calls a model. Reports stay under ignored .diagnostics/benchmark. Existing synthetic grader preflight passed 10 tasks/21 controls; this is not public coding benchmark performance.

Normal and first-start launchers deliberately do not install huge benchmark dependencies or run evaluations. See [download and transfer instructions](BENCHMARK-DOWNLOADS.md). Implemented adapters and reporting scripts do not imply completed results; use actual attempt receipts.

## Dimension coverage audit

The article groups metrics into outcomes, process quality, efficiency/cost, and safety/reliability. Our implementation plan operationalizes them independently:

- Outcomes: official success plus separately reported partial goal coverage and artifact quality.
- Process: observed action/state validity, invalid arguments, unproductive repeats and recovery; never require private chain-of-thought or score self-praise.
- Efficiency: steps, latency, tokens, cost and resource use across all agents/reviewers/simulators.
- Safety/reliability: scoped synthetic canaries and fault injection, unauthorized effects, false completion, repeated consistency and perturbation robustness.
- Methodology: pinned environments, contamination controls, held-out evaluation and uncertainty intervals.

The seven primary tracks do not directly cover databases, graphs, game planning or open research. Add **AgentBench v0.2** DB/KG/card/puzzle/ALFWorld environments ([official repository](https://github.com/THUDM/AgentBench)); do not mix them with current FC results. Add **GAIA** research/file/calculation tasks ([official dataset](https://huggingface.co/datasets/gaia-benchmark/GAIA)); dataset access conditions may require the downloader's consent. Use scoreable validation; unavailable test answers cannot produce invented local scores. The download catalog includes both supplements.

This is one suite: seven core tracks, two coverage supplements and internal diagnostics, not an unweighted average. Keep planned/environment_ready/adapter_ready/executed distinct.

Internal diagnostics also cover same-budget single/Team coordination, conflicting and duplicate-source evidence; Memory formation/retrieval/update/decay and bilingual no-answer RAG; image/audio/video import-generation-reference-export integrity and audio tracks; background waiting, user steering, delayed approval, offline/restart/unknown-effects; injection from untrusted documents/web/tool results. Test safety false accepts and false rejects together. Media aesthetic quality requires separate blind review; it is not a correctness assertion.

## Native versus controlled evaluation

GAIA primary protocol `native-evidence-v1` reports three separate arms: Amadeus production tools, smolagents 1.26.0 ToolCallingAgent, and CodeAgent. smolagents retains native search, page conversion and Python execution, with configured Python file/image tools. Its solver runs inside offline Docker; host transport gates external reads and model calls. These are configured integrations, not identical tool implementations or unrestricted default products.

Auxiliary `shared-evidence-v2` gives Amadeus and ToolCallingAgent seven common tools plus bounded output-format repair. Report it separately. BFCL remains first-decision tool calling; LongMemEval S/oracle remains supplied-history QA, not persistent Memory/RAG. CodeAgent is only added to GAIA.

Keep model, inputs, budgets and source restrictions comparable. Withhold generated search synthesis/snippets; reject known answer repositories and traces before access, at every redirect, and through recognizable content markers. Unknown mirrors and training contamination remain possible. Older runs containing answer traces are contaminated diagnostics, not clean comparative scores; preserve receipts.

New-protocol GAIA grades the raw final answer without stripping labels. Product format contracts ask the model to fix shape, precision and ordering; they never substitute references. Native baselines retain their own output behavior. Record infrastructure failures and incomplete work explicitly.

Run `Setup-Evaluation.cmd` to prepare optional Python/FFmpeg/smolagents dependencies; normal and first-start launchers do not download evaluation images or start paid tests. Freeze image SHA256, package versions, dataset hashes and adapter commit. The runner fails before paid GAIA calls when environment preflight fails. Credentials and answer references stay outside solver containers.

General tools now preserve XLSX coordinates, stored styles, formulas and merges, support original-pixel image crops, and flag repeated web observations. Stored styles do not render conditional formatting. Browser interaction and transcription require separate configuration; this profile does not claim those capabilities.

### Failure diagnosis (2026-10-18)

Development changes do not modify the running frozen evaluation. Model-step exhaustion, task deadline, and provider generation failure remain separate failures; none is automatically graded as success. Runtime gives an advisory in the last three configured model calls, without increasing limits or bypassing delivery checks. Empty retrievals and HTTP failures do not count as new evidence; identical page bodies on different URLs are not independent corroboration.

The native baseline line broker serializes complete request/reply exchanges across tool threads to avoid crossed responses. This transport fix applies to both baseline modes; it does not substitute Amadeus tools. Wrapper exception types are retained separately from provider diagnostics. A future comparison needs a new frozen run for all arms; current results are preserved.

Read-only snapshot: BFCL 6,980 result files had no execution error; LongMemEval-S had two ECONNRESET failures (one per arm, same case, connect/stream phases); Oracle had no execution error in 1,000 results. Missing completion receipts are not presumed failed answers or replayed. GAIA generation wrappers included output truncation, request timeout and empty response; not all deadline failures have a proven single cause. Production already has bounded network recovery; these text QA evaluations use a direct provider path and do not measure that Runtime recovery.

Amadeus BFCL snapshot: 784 rejected calls/answers included 244 relevance decisions without a detailed checker code, 157 string-value errors and 138 multiple-function count errors. These are checker categories, not verified root causes. LongMemEval rejected-answer samples include omitted items, event deduplication, time-window interpretation and disputed category boundaries. Guidance now emphasizes faithful arguments and evidence aggregation; execution rejects unknown top-level arguments consistently with preflight, while declared map fields remain supported. This cannot determine arbitrary semantic correctness or guarantee a higher score. Never inject reference answers, silently rewrite outputs or loosen grading.

## 2026-10-19 failure-feedback update

The frozen b77928f evaluation is unchanged. Its 56 Amadeus GAIA step-limit traces each reached 16 model requests; final tool calls were dominated by web fetch/search. Transport exceptions previously bypassed persisted research progress. The runtime now records unsuccessful acquisitions (without swallowing the original error), and includes attempts/unusable/novel-response counters in the final quarter of a bounded model-call budget (at least three calls). Novel response content is not verified relevance or independent evidence. This is advisory, not an increased budget or automatic acceptance.

Future runner receipts record worker/runner PIDs and process exit before result decoding. Missing/invalid receipts remain unresolved, are never silently replayed, and produce `finished_with_unresolved`. Four old started-only receipts had no result or exit receipt; they cannot establish whether the model was wrong or why execution stopped. Existing result files and frozen runners were not rewritten. No score improvement is claimed from these code changes.
