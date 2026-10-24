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

## Underspecified task investigation

The runtime now offers optional `update_problem_frame` / `inspect_problem_frame` tools before planning. They retain the objective, explicit requirements, assumptions, unknowns, falsifiable hypotheses, scoped tool-result references and acceptance criteria in the current run. The cognitive snapshot restores the frame after context compaction. Revisions are audited and cannot reset the initial investigation allowance. That allowance is a tool-call reassessment point, not a hard stop or a semantic progress score. Records do not carry into a new run automatically; follow-ups must reconcile current user intent with prior context.

The host validates evidence provenance and revision consistency, not the truth of a diagnosis. Failed commands may be useful diagnostic evidence. Simple tasks do not need a frame, and the tools do not change permissions, require user approval, or certify task completion. The existing document research cases remain the workflow for knowledge-library evidence.

`tests/problem-framing.test.ts` covers these runtime contracts without a model connection. It does **not** demonstrate better autonomous engineering. To evaluate that claim, compare frozen versions with identical models and budgets across explicit repairs, clear goals with unknown solutions, and broad improvement requests. Use isolated repositories with hidden defects and distractors, including no-change cases, unavailable target services, misleading passing checks, and mid-task evidence that refutes the initial hypothesis. Repeat runs and separately score diagnosis, requirement coverage, unnecessary changes, regressions, verification gaps, interventions and cost. Keep held-out criteria out of the model input and report unavailable environment checks as unverified. This planning-only runner does not execute that benchmark.
