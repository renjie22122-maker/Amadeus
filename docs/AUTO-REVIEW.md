# Automatic approval

[English](AUTO-REVIEW.md) | [简体中文](AUTO-REVIEW.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-23.

Policy version in code: `2026-10-23.2`. This is Amadeus's implementation, not a claim to reproduce private Codex internals.

## Decision path

Tool guards first determine whether approval is required. Auto mode invokes a separate tool-free reviewer. Exact argument-free cd with execution metadata has a narrow shortcut. Deterministic dangerous matches, explicit ask rules and forceHuman still require a person.

The host accepts only validated bounded low-risk actions with explicit/implicit authorization, or medium-risk actions with explicit/ordinary task-implied authorization, known effects, valid user-message references and no sensitive-data/security-change flags. High, critical and unknown risks go to the user. A changed operation, settings or authorization context invalidates the assessment.

## Evidence and privacy

The same conversation profile may receive prior file observations and up to six scoped literal/package/test candidates: reads are bounded to 128,000 bytes per file and transmitted excerpts to 12,000 characters. Hashes and truncation flags accompany sources; npm pre/main/post scripts and recent same-run command observations may contribute. Imports and test discovery are not exhaustive.

A separately selected reviewer does not automatically receive code or command logs. Source text is untrusted data, never an instruction. File hashes are checked again after review; this is not a filesystem lock. Host execution is described with host network/file authority, not the native backend's restrictions.

## Failure and user decisions

Preparation, provider, invalid response, deadline and cancellation failures remain distinct. No failure authorizes an operation; raw provider error bodies are not exposed. Cards distinguish missing authorization, process ownership and incomplete evidence from reviewer unavailability. Broad process-name cleanup needs human scope review: cwd is not a process boundary.

The user can allow once, deny or request an alternative with constraints. An alternative denies the original operation and returns feedback for replanning; it cannot rewrite and silently execute a different command. Approval waiting does not consume execution timeout.

## Cache and audit

Stable policy/environment fields precede changing evidence/actions. Identical in-flight reviews can share computation only under the same run/configuration/evidence/cancellation context. Completed results are evicted; each caller rechecks sources. This is not a reusable permission grant.

Audit cards expose policy, rationale, duration, input/cached/output tokens and estimated cost separately from chat. Cache hits come from measured usage. Models can misclassify; zero test false approvals is not a safety proof. See [historical evaluation](APPROVAL-EVALUATION.md) and [security](SECURITY.md).

## General evidence and accounting (2026-10-23)

Automatic review selects recent and task-relevant human authorization, preserving message IDs; it does not treat scheduled prompts or tool text as human approval. Bounded low/medium actions may use explicit or ordinary task-implied authorization when material effects are established. High-risk, unknown effects, sensitive transfers and persistent security changes still need human review. A malformed reviewer JSON response receives one format-only retry within the original timeout; both calls count toward usage. A valid negative decision is not retried for a different verdict.

Native write_file/edit_file/apply_patch mutations in auto mode now provide scoped before/after excerpts, hashes and truncation markers before writing. Bytes are rechecked immediately before execution; changes invalidate review. This is an application tool gate, not an OS filesystem sandbox or an atomic lock against unrelated external writers. Host commands remain subject to their own review. Review considers actual destination, data categories, process ownership, active-work impact and reversibility across action types, not application/vendor allowlists. Unknown state must be established, not invented by the reviewer.

Known zero-cost media no longer require a monetary ceiling solely because the ceiling is unset. Unknown cost remains unknown. This changes only the cost gate: action intent, reference uploads and other permissions still apply. Local endpoints are not proof that a service makes no upstream requests.

Media connections optionally declare USD response amount paths or billable-unit paths and USD/unit. Each job snapshots its mapping; results are marked provider-reported versus usage-calculated, separate from the preflight configured estimate. Fields are not guessed from arbitrary `cost` keys, and no account billing endpoint is contacted automatically. Binary-only responses and providers whose charges arrive via separate billing endpoints remain unknown unless supported by a future billing adapter. This is not yet automatic price synchronization or final invoice reconciliation. Never infer frames from seconds without the documented rate and model parameters.

Language-model streaming already requests terminal usage and distinguishes input/cache/output pricing per million tokens. Explicit provider cache misses are now retained too. Pricing is configured; measured token usage does not imply a measured monetary charge. DeepSeek [usage schema](https://api-docs.deepseek.com/api/create-chat-completion/), fal [pricing API](https://fal.ai/docs/platform-apis/v1/models/pricing), and MiniMax [video task creation](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) illustrate different contracts. No prices are hard-coded here.

Validation: synthetic billing/usage fixtures, budget boundaries, file preview/staleness and reviewer repair tests. This does not establish a live-provider approval false-positive rate or validate every vendor's billing account API.

## Bounded evidence repair before human escalation

A valid independent assessment can request inspect/revise/wait for an already authorized task whose material effects remain unresolved. The original operation is not started or approved. The host returns a not-started tool result to the executing agent, which may collect evidence or propose a smaller operation using existing permissions. Every resubmission is reviewed independently. There is no automatic shell execution, permission grant or background sleep created by this mechanism.

At most three repair notices per run are persisted. Identical unchanged review evidence goes straight to the existing human path; counters survive restart. Missing consent, high/critical risk, sensitive transfers, security changes, forced human rules, recovery uncertainty, failed reviewer calls and changed authorization are excluded. This lowers unnecessary interruptions without claiming that every task can finish without a person. Model compliance and the available inspection tools still determine whether the agent resolves the missing facts.

Public design references: [OpenAI Auto-review research](https://alignment.openai.com/auto-review/) separates execution from authorization, supplies rejection rationale and limits repeated denials; [Claude Code modes](https://code.claude.com/docs/en/permission-modes) distinguish classifier review from bypass and retain escalation thresholds; [ChatGPT Agent safety](https://help.openai.com/en/articles/11752874-chatgpt-agent) documents consequential-action confirmation. These are design references, not shared implementation or promised approval rates. Amadeus still has more conservative deterministic high-risk gates and has not replicated their OS sandbox or production evaluations.
