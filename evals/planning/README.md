# Live planning comparison

[English](README.md) | [简体中文](README.zh-CN.md) · [Documentation](../../docs/README.md)

This is a real API **planning-only** comparison, not an end-to-end coding benchmark or a worker-throughput claim.
Fifteen authored tasks cover dependencies, independent branches, shared-file ordering and read-only scope. Five are development cases; ten are reserved for evaluation. The model sees task descriptions and IDs, not the expected edge set.

Run from the repository root with a configured connection:

```powershell
node --import tsx evals/planning/run.ts --runs=3 --parallel=2 --output=.diagnostics/planning-run
```

This makes paid requests (90 proposals plus at most one host-validation retry per contract sample). It never executes proposed tools. Use a new output directory; existing results are not overwritten. Settings and raw results stay private.

```powershell
node --import tsx evals/planning/run.ts --report-only --output=.diagnostics/planning-run
```

Report-only rebuilds aggregation from saved samples without API requests.

Both arms use the same profile, output schema and task input. Baseline uses minimal planning instructions; contract adds the production TASK_PLANNING policy and at most one repair from **generic host validation**, never the expected answer. Alternate arm ordering across repetitions. Identical declared dependencies and contract-derived dependencies are normalized.

The grader checks task identity, scope, cycles and transitive dependency reachability. Redundant edges that do not change ordering are accepted; missing dependencies and unnecessary ordering fail. It does not assess code quality, unstructured acceptance-text truth, filesystem outcomes, specialization quality or optimal worker selection. Tests include deliberately wrong plans. API failures count as failed samples; unavailable usage or prices remain unknown. Costs are configured-price estimates, not bills.

Do not tune the prompt against held-out failures and then call a rerun an untouched holdout. Freeze versions and add new cases before evaluating later changes. A ceiling result on these short synthetic prompts means a harder benchmark is needed, not that scheduling is solved.

## Optional problem framing

For complex investigations, `update_problem_frame` / `inspect_problem_frame` retain
run-local objectives, requirements, assumptions, unknowns and acceptance criteria.
Hypotheses are optional: feature planning can cite observed design context in
`decisionEvidence` without inventing a defect. `verificationGaps` records checks
unavailable in the target environment. Changed objectives or removed requirements
require `changeReason`; the audit retains the previous objective and removed items.
This is disclosure, not approval to reduce scope or a semantic coverage guarantee.

The host validates revisions and same-run tool-result references, not truth or file
freshness. Failed checks can be diagnostic evidence. The fixed investigation budget
is a reassessment point, never an execution limit; editing a frame cannot reset it.
Frames have a 16,000-character total limit and appear in the cognitive snapshot after
compaction. They are optional, do not block ordinary planning or delivery, and do not
automatically carry into a new run. Existing document research cases remain separate.

`tests/problem-framing.test.ts` checks these contracts, not model capability gains.
For a behavioral comparison, freeze versions and model settings, repeat clear-repair,
unknown-solution and broad-goal tasks with hidden acceptance checks and distractors,
and measure diagnosis, requirement coverage, unrelated changes, regressions,
verification gaps, interventions and cost. This planning-only runner does not execute
that end-to-end benchmark.
