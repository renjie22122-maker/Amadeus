# Paired context and control probes

[English](README.md) | [简体中文](README.zh-CN.md) · [Documentation](../../docs/README.md)

Run from the repository root:
node --import tsx evals/context-control/run.ts --live --runs=3

Uses the configured provider and incurs API charges. Inputs are synthetic; project
files, private conversations and credentials are not included. Six cases cover
bilingual constraints, revised requirements, repetition, event waits, productive
work and verification. Retention cases use the same twice-summarized history for
both variants; enabled adds original source records. Control cases share the same
facts; enabled adds the policy's advice. Variant ordering alternates by round.

The versioned report includes configuration, samples, correctness, usage, price-based
cost and latency, with shared summarization costs reported separately. It is an
ablation smoke test, not an end-to-end coding benchmark. A tie is evidence of no
observed benefit on these cases, not justification to claim improvement. Cache
warmth, small sample size and fixed task templates limit comparisons.

## Recorded run (2026-10-03)

deepseek-flash, six cases x three repetitions x two variants, plus twelve shared
summary calls. Semantic scoring: off 13/18, on 16/18. Source-ledger cases were
6/6 in both variants; advisory cases were also 6/6 in both. The remaining
identical-prompt cases scored 1/6 versus 4/6, so the aggregate difference cannot
be attributed to the implementation. Input totals for graded requests were 2,958
versus 3,798 tokens, average latency 1,607 versus 1,635 ms. Configured prices were
incomplete; USD totals remain unknown.

The original strict string grader mislabeled JSON-encoded correct actions. Grader
v2 separates formatting from semantic action, rejects conflicting choices, and
regrades the preserved responses without new API calls. Remaining failures are
retained. This run does not establish a success-rate improvement.

## Context preparation regression checks

Detailed team procedures now load when team tools are discovered, a team is active,
or host/creative mode is explicitly selected. The initial prompt keeps a short
capability entry and the existing permission rules. This replaces 4,458 characters
with 501 before activation (3,957 fewer characters, not a measured token saving).
Disabled memory omits its management instructions. Existing `context.cache_observed`
events report request component sizes; `context.guidance_loaded` records procedure
activation without copying prompt contents into the event.

Compaction retains one latest runtime snapshot, task snapshot and workflow procedure
after retained history. Superseded projections are excluded from summarization;
original user requirements, tool groups and trust/source ledgers remain protected.
Before compaction, normal steps remain append-only to preserve reusable prefixes.

`tests/context-guidance.test.ts`, context reuse tests and runtime tests exercise
discovery, permissions, snapshot ordering and retained evidence without live models.
These checks establish payload reduction and state consistency, not improved intent
understanding. Evaluate that separately with repeated, matched-model engineering
tasks, including vague goals, evidence that changes the diagnosis, and unavailable
target services. Compare actual request settings, tool outcomes and first divergent
decisions; do not attribute a same-model difference to an unmeasured mechanism.

The runtime also supplies a timestamped initial clock observation and the read-only
`read_clock` tool. It returns UTC, an explicit IANA timezone (or labelled host
timezone), time since this run was created, and time in its latest recorded status.
Elapsed time includes waits and downtime; it is not productive or CPU time. Missing
timestamps or backwards clock movement yield unknown durations, not invented values.
Use the tool at decision checkpoints, and existing scheduling tools for wake-ups.
`tests/runtime-clock.test.ts` covers conversion, scope, permissions and clock anomalies.
