# Architecture

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-12.

## Module boundaries

- `shared/`: domain and wire types; `server/storage/`: SQLite records, ordered events, effects and usage.
- `server/core/`: model loop, pump, lifecycle, context, delegation, team coordination and deterministic cognitive policy.
- `server/providers/`: protocol serialization, streaming, model discovery and measured usage.
- `server/tools/`: schemas, discovery, availability, permissions and audited invocation.
- `server/services/`: execution, approvals, files, knowledge, memory, media, MCP and background work.
- `server/http/`: authenticated loopback API/SSE; `src/`: React interface.

RunEnvironment builds scoped model facts through explicit dependencies without scheduling work. RunPump controls admission and draining; finalization and team coordination use separate modules. Runtime remains the composition root and model-loop coordinator: decomposition reduces coupling but does not eliminate it.

## Lifecycle and durable effects

Runs use queued, running, waiting_user, waiting_approval, waiting_children, completed, failed and interrupted states. Terminal runs are not resurrected; continuation creates a new run. Structured termination reasons distinguish recoverable limits/protocol interruption from failures.

Tool intent and results are journaled. Pre-start failures are not_started; ambiguous external effects remain unknown. Startup reconciliation atomically interrupts old runs and cancels orphaned inputs. Opt-in team recovery can start an inspected new turn; arbitrary commands are never replayed merely because the service restarted. See [recovery](INTERACTION.md).

SSE carries persisted event IDs with up to 1,000 replayed events; larger gaps request an authoritative snapshot. Token deltas are ephemeral, finalized content durable. Provider streams have request and byte-idle deadlines. The model loop retries transient failed or partial responses up to five times before any tool execution, with cancellable backoff. Completed tool results remain in checkpoints; no tool is replayed. Invalid arguments, duplicate call IDs and empty deliveries share at most two repair requests per successful model step. Empty deliveries retain measured usage and cannot complete a run. Length truncation has a separate two-repair allowance: request a smaller complete action, with a minimal-step instruction on the final repair. Limits and reasoning settings are unchanged; all requests still count toward the model-step budget. Exhaustion produces a recoverable interruption. The attached tool schemas are authoritative; discovery guidance is conditional on the discovery tool being present.

## Context and control

Measured main-request tokens calibrate local estimates; tool schemas and images contribute to capacity. Compaction preserves latest requests, complete recent tool pairs and an ordered verbatim request-source ledger. A summarizer failure may externalize older history to scoped spill storage. Protected requirements that still cannot fit produce an explicit error.

Repeated reads execute again before eligible reference/delta substitution. Source hashes, retained bases and model/tool configuration prevent stale reuse. No cached model answer or old test success substitutes for execution. See [prefix caching](DEEPSEEK-CACHE.md).

The cognitive controller derives repetition, progress and verification signals from observations, excludes event-driven waits, and emits bounded advice/recovery proposals. It is a deterministic policy, not another LLM agent. Follow-up assessments show observed change, not causal improvement.

## Teams

Plan compilation validates contracts and dependency graphs before scheduling. A read-only blackboard projects tasks, recipient-visible messages, artifacts, evidence and unknown effects; bounded selective context marks omitted entries. Source records stay authoritative.

Persistent members can continue through new runs while preserving conversation history. Isolation, ancestry, depth, permissions, current role revisions and unresolved effects still gate continuation. Writable child copies require versioned review/merge. Roles grant coordination authority, not permissions.

Model concurrency defaults to 3 per conversation; cumulative child executions default to 8 per tree. Explicit 0 disables that count limit, including continued members. Depth, budgets, provider quotas and team automation limits remain separate. See [routing](PLANNING-AND-ROUTING.md).

## Limits

This is a single-host runtime, not distributed consensus or exactly-once external execution. Provenance is not semantic correctness; filesystem observations are not adversarial locks. Broad held-out performance and security claims require independent evaluation.

Memory, policy and graph routes now live in server/http/memory.ts with explicit Store, Configuration and MemoryIndex dependencies. The HTTP composition root retains shared authentication and lifecycle hooks; this does not finish decomposing App.tsx or the tool registry.

## Evidence-driven reflection

Task snapshots include a bounded deterministic critique: declared goal completion, source-valid tool evidence, recorded checks, independent checks, stale checks, blockers and unknown effects. Evidence must belong to the same task tree; scheduled commands do not count as passing evidence. Suggested next checks target acceptance counterexamples. No correctness probability is fabricated, and missing undeclared requirements remain unknown. This extends the advisory controller; it does not add an autonomous critic model, force an adversarial team for every task, or establish learned optimal routing. Existing full/reference/delta context reuse remains unchanged.

### Security review and evidence-bound challenges

For software with trust boundaries, the assistant can discover `prepare_security_review`.
It produces **untested** counterexample designs for identity, authorization, untrusted
input, shared-state transitions, external events, secrets, and file/network access.
The assistant selects applicable surfaces and adds verification tasks to its plan.
Negative tests should have positive controls and inspect durable state. Execution
approval is permission to run a check, not a security review of the delivered application.

Concrete concerns can be persisted with `record_task_challenge`. Open challenges
block finalization of affected tasks. `resolve_task_challenge` requires the current
task verification event, generated after the challenge, with a successful receipt and
matching artifact stamps. Earlier green tests cannot close a new concern. Changed
contracts or stale artifact verification reopen resolved concerns. Author checks remain
distinguished from independent checks. Review-design and challenge tools cannot count
as completion evidence. The delivery loop allows two corrective attempts; it does not
retry uncertain effects or create an unlimited review loop.

These controls prove recorded check provenance, not that a test logically refutes a
concern. Selecting all relevant surfaces and discovering vulnerabilities still depend
on the model and available evidence. Static inspection may be recorded as such; it
must not be presented as an executed exploit test. There is no calibrated security
score, mandatory reviewer on every chat, or claim of vulnerability-free output.
Reflection exposes separate fact/plan/tool/evidence/memory/answer uncertainty states,
not fabricated probabilities. No new dependency or launcher change is required.

The host also injects review designs into task snapshots when declared task text matches risk surfaces or declared artifacts are source files. This heuristic does not require a user review request or a tool invocation. It does not cover absent plans, undeclared changes or every risk; checklist execution remains model-driven, while recorded open challenges are host-gated.

### Unified delivery evidence and convergence signals

The host projects task status, open challenges, applicable memory checks and unknown
effects into one read-only delivery report. It reuses the existing authorities rather
than maintaining a second mutable obligation ledger. `inspect_delivery_evidence`
refreshes artifact verification before returning the report; finalization refreshes
and uses the same blocker lists, recording a `delivery.assessed` event.

Red means an existing required gate is unresolved. Yellow means no such blocker but
recorded coverage gaps remain. Green only means the recorded required gates are
satisfied, never that the application is correct or secure. Empty evidence is
unassessed. A blocked task is not a pass. Reports link declared artifacts and acceptance
criteria to direct dependent verification tasks; all such checks must be recorded
before reporting successor coverage. Artifact inspection remains distinct from this
declared check relationship. Undeclared dependencies and logical test adequacy remain
unknown. Detailed reports are bounded to 100 entries and 50 impact rows with omitted
counts; blocker evaluation is not truncated. This is a tool/context report, not a new
UI traffic-light indicator or automatic risk classifier.

The deterministic controller separately tracks exact repeated trajectories and
repeated operation targets whose output varies. Eight repeated targets without
recorded task/check progress may trigger advisory plan review, at most once per
12 batches. This signal never independently stops a run: changing timestamps can
hide polling, but legitimate observation can also vary. Distinct request targets and
event-driven waits are not treated as this loop. Task/check progress resets the
window. Target novelty is a distinct-request ratio, not semantic novelty or a
calibrated confidence estimate. Existing unchanged-cycle limits remain enforced.

No new dependency, database migration or first-start change is needed. Restart the
service to load backend changes; starting a second launcher does not reload an
already-running service.

### Closing the progress feedback loop

After a tool batch settles, existing recorded checks are refreshed against current
declared artifact/dependency stamps before cognitive observation. This reuses the
verification service and does not execute tests. Modified artifacts can therefore
produce coverage-regression feedback before final delivery.

Progress records both gains and losses: reopened/removed completed tasks and lost
recorded checks take priority over simultaneous new completions. Such a transition
requests verification, not automatic replay. Scope revision may explain the change;
the signal is not itself proof of a software defect. A replacement current check
does not count as loss. Existing final gates still determine completion.

Run-local context now includes the latest intervention assessment and any pending
bounded recovery proposal, including when no task board exists. Resolved or older
than four batches recovery proposals are omitted. Reset and separate runs do not
inherit the feedback. Changing a trajectory remains distinct from verification;
coverage regression is recorded separately in learning outcome summaries. No
confidence boost, automatic experience activation, new critic model or permission
grant results from these observations. Existing evidence-backed experience formation
and next-task memory checks remain the learning boundary. No new dependencies or
startup changes; backend restart is required to load this revision.

### Guarded recovery inspections

A recovery proposal has a unique ID. The agent can discover `inspect_recovery_step`
and select a current step through the normal tool registry and permission checks.
The dispatcher accepts only three diagnostic kinds: inspect recorded effects,
refresh declared artifact verification, or inspect the delivery report. It does not
run commands, arbitrary paths, installations, rollback, tests or permission changes.
Other proposal kinds stay with normal guarded tools or a user scope decision.

Each run/proposal/step is claimed once and has an audit receipt. Duplicate calls
return that receipt, including an unfinished or failed inspection; they do not
re-execute it. New execution requires a current pending proposal no more than four
batches old. Reset removes the proposal, and a superseded or foreign ID is rejected.
A crash during inspection can leave an inspecting receipt; it is diagnostic state,
not an effect-resolution claim or a new completion blocker.

Receipts return to run-local cognitive context. Inspection is not recovery success,
does not resolve unknown effects, and cannot satisfy task completion evidence.
The existing outcome assessment still distinguishes verified progress from a changed
strategy. This is bounded diagnostic dispatch, not autonomous arbitrary recovery or
a learned policy optimizer. No dependencies, migrations or launcher changes.

### World-changing recovery contracts

`prepare_recovery_action` captures a reason, expected result, declared existing paths,
artifact/dependency stamps, workspace identity, plan revision, one action and one
check. `execute_recovery_action` dispatches the action and check through the normal
audited tool executor, preserving per-tool permissions, approval, sandbox, hooks and
effect records. Actions support write/edit/command; checks support read with an explicit
expected substring or a command (optionally an expected output substring).
A zero command exit is an observed check result, not semantic proof.

Contracts expire after ten minutes; each run can prepare at most three. Commands use the ordinary 1–1800 second execution timeout (default 120 seconds)
and default 10-second yielding; the same process continues in the background. Scope/plan/path changes and unresolved
effects reject execution. A contract is claimed once before dispatch: duplicates
return its receipt, including executing/unknown receipts after interruption. There is
no automatic retry or rollback. New actions cannot run concurrently with another
recovery in the same run. Existing approval may wait independently of command time.

Results distinguish productive (declared predicate observed), ineffective, regressed
(previously checked tasks became stale), and unknown. Child event IDs bind action and
check observations; receipts return to cognitive context. Neither the wrapper nor
preparation counts as completion evidence, and no result resolves unknown effects or
activates memory. Final verification/challenge/memory gates remain authoritative.
The current policy does not autonomously optimize strategies or automatically run a
new proposal after failure; the model selects subsequent guarded work.

Declared paths must already exist. These snapshots are pre-dispatch checks, not an
OS lock: external writes during approval/execution and undeclared dependencies remain
limitations. Command-only checks must be designed to test the stated expectation;
the host does not infer test adequacy. No new dependency or launcher change is needed.

Background recovery persists waiting-action / waiting-check and original job IDs.
Use event-driven wait_background_command, then execute_recovery_action with the same
contract ID: only the unstarted dependent check may launch, never the action again.
Check commands can yield too. Receipt reuse while waiting is nonblocking. Execution
timeouts and approvals retain ordinary semantics; initial contract expiry does not
cancel a started job. Unknown jobs stop the chain and block delivery, as do pending
recovery phases. The model resumes from background completion notifications; this is
not an independent scheduler that runs verification while the model is offline.
No startup script changes: existing source fingerprint rebuilding applies.

### Outcome-informed recovery selection

Recovery results now produce run-local policy feedback, grounded in matching executed
tool events or terminal background results. Denials, missing receipts and unknown
outcomes do not become learned failure evidence. Productive observations remain
options, never permission grants or calibrated success predictions.

Preparing an identical action under the same declared artifact/scope preconditions
after a grounded ineffective/regressed outcome is rejected and audited. Argument
object ordering and command explanation wording do not create a new strategy;
weakening the verification predicate does not bypass this restriction. Changed
operations or declared preconditions can be considered within the existing attempt
budget. These restrictions apply to the recovery-contract path, not all ordinary
tools. Feedback is injected into current-run context and does not cross conversations
or projects, activate memory, or automatically select an alternative command.

This is outcome-informed anti-repetition, not causal/counterfactual inference.
Counterfactuals are explicitly unobserved. Environment changes outside declared
preconditions, check inadequacy and confounders remain limitations; there is no
estimated uplift, automatic rollback or global learned policy. No new dependencies
or startup changes; restart is required to load the backend revision.

## Capability admission and independent delivery contracts

Registered tools share one capability admission function for discovery and invocation. After policy, hooks and approvals, invocation rechecks persisted permissions, workspace/isolation identity, execution settings and deny rules before entering the tool. Adapter-level approval, isolation and effect handling remain mandatory; provider HTTP calls are not routed through this tool kernel. This is not an OS isolation replacement or an atomic filesystem lock.

An implementation task can declare `requireIndependent: true`. Delivery and team closure require current checked evidence marked independent by the existing verifier, rather than the author's self-check alone. The requirement participates in contract revisions. Counterexample challenges remain separate and must be resolved with current evidence. Independence describes recorded authorship, not guaranteed semantic correctness, different-model consensus or an automatic reviewer launch.

The bounded team blackboard now includes acceptance text (800 characters with truncation notice), provided/required interfaces, missing task dependencies and independence status. Original contracts remain authoritative; this projection avoids requiring the lead to read every member's full plan. Interface declarations are not an automatic compatibility proof. No dependency, migration or launcher change is needed.

Declared artifact tasks require a current checked verification before delivery even outside teams. Tasks without declared artifacts may still report unverified coverage as yellow; this is not a passing semantic claim.

## Recovery and storage boundaries (2026-10-12)

resume-preparation owns interrupted checkpoint repair without replay; recovery-tools and the HTTP effects module own their respective entry points. Effect recovery protocols inspect host-bound durable receipts, separately from exact file postimage checks. Media intent/reference is persisted transactionally before provider submission; background terminal state and effect settlement commit together. Runtime remains a composition/model-loop coordinator; the larger decomposition is incremental, not complete.

Store.maybe returns undefined only for NOT_FOUND. Corrupt record JSON raises RECORD_CORRUPT without including record content; database faults propagate rather than becoming missing data. A storage failure during reconciliation is not silently treated as an unknown file.

Service composition now lives in core/runtime-services and http/maintenance-services; MCP discovery/browser/desktop registration lives in tools/mcp-tools, with file transfers using FileScope handles. Built-in tools remain host-registered; agents discover enabled MCP services, while skills and generated scripts do not automatically become trusted tools with higher privileges.

## Conversation read path and responsive submission

Conversation HTTP projection lives in server/http/conversation-view.ts. Conversation-scoped records are filtered in SQLite before JSON decoding. Activity checks read run metadata; starting another turn hydrates only the latest checkpoint, rather than every historical run. The projection computes task members/board once per request.

The UI releases submission state after the message acknowledgement, independently of subsequent refresh. Cached conversations fetch events after the last HTTP snapshot cursor (never the latest SSE event, which may have gaps). Delivery state is refreshed even for older messages. Concurrent global refreshes share a request. Chat/settings/background shell refreshes omit the memory/document catalog; library pages request the full state. Background polling waits for completion before scheduling another poll; model discovery requests are cancelled when leaving their connection.

Limits: an uncached conversation still transfers its complete event history; the five-entry cache is not durable history pagination. Large single turns and synchronous background database work can still affect responsiveness. This change does not close malicious ancestor replacement races or certify unavailable Docker/strict AppContainer backends.

Message submission returns run metadata without model checkpoints.

## Model session and knowledge tool modules

core/model-session.ts owns provider completion observation, context/prefix accounting and usage ledger updates. Runtime delegates to it while retaining model-loop and lifecycle coordination. tools/knowledge-tools.ts installs knowledge search, bounded investigation, trace inspection and evidence assessment; ToolRegistry still owns invocation policy, approvals, effects and schema enforcement. This is incremental decomposition, not a claim that the composition roots are fully decomposed. Persisted vector validation lives in services/vector-record.ts and is reused by knowledge and memory caches.

### Provider transport diagnostics and embedded workspaces

Provider connection and body-stream failures carry typed `MODEL_NETWORK` / `MODEL_TLS` errors. Reconnect events retain the phase and an allowlisted transport code, never raw error messages, request URLs or credentials. Runtime keeps its bounded model-only reconnect policy; TLS/authentication/configuration errors, caller cancellation and ordinary programming errors are not classified as transient network failures. A received response is not silently replayed by the transport layer; incomplete tool calls never execute.

Embedded runners use `prepareExecutionLayout` to create sibling `runtime-state` and `workspace` directories and validate the same FileScope boundary used by production tools. A workspace nested inside private storage is a configuration error, not a reason to disable private-storage protection. Attachment preflight resolves copied files before paid model requests.

Folder maintenance separates saving sources, incremental synchronization, and retrying failed items. Adding a folder preserves unchanged document parsing, completed embedding jobs and failed-item history; unchanged saves are idempotent. Only explicit retry resets failed jobs. Source changes invalidate active scans by revision. Enabled sources are picked up on the maintenance interval. LightRAG continues submitting only unsynchronized chunks; this change does not claim full graph deletion reconciliation.

External vector retrieval partitions eligible rows into at most 16 MiB float32 shards and merges their top candidates. The per-request resource guard remains; 80 MiB is no longer a whole-corpus limit. The updated local sidecar caches validated snapshots (512 MiB LRU disk budget), allowing subsequent queries to omit vector payloads; cache misses re-upload bounded shards. ANN remains approximate and small IVF shards may fall back to exact search. Host-side eligible vector materialization still exists: this is not a streaming/memory-mapped database replacement. Vector service errors return explicitly degraded lexical results; cancellation still propagates. `search_knowledge(mode="lexical")` bypasses model/graph/reranking services. `list_knowledge_documents` lists scoped current titles and IDs with pagination. `search_capabilities.semantic` now also controls knowledge retrieval. Restart the application and local retrieval sidecar to enable both halves of the cache protocol; older sidecars still accept bounded full shard requests.

Large-corpus retrieval now uses keyset-paged vector reads (up to 4096 rows and 16 MiB numeric payload per page), scope/document/time filtering before ranking, and a bounded top-60 candidate buffer. Persistent sidecar manifests allow unchanged queries to send query vectors without reloading all source vectors; generation or document changes invalidate manifests, and cache eviction rebuilds bounded shards. Without an external backend, this path is exact streaming search, not ANN: memory is bounded but scan latency still grows with corpus size. Research-mode routing is a deterministic Chinese/English intent heuristic, overridable by lookup/research, not a learned planner. It uses bounded query facets, normalized-passage deduplication, chapter diversity, recorded coverage and stop reasons; observations are not semantic proof. Indexed-document reading supports paginated contextual inspection without source files. Fully calibrated automatic ANN algorithm selection and generated hierarchical chapter summaries remain future work; no quality improvement is claimed without evaluation.

## Startup and UI performance (2026-10-15)

Restart recovery reads run metadata, updates lifecycle status transactionally and leaves checkpoint payloads untouched. Completed historical model contexts are not decoded just to find unfinished work. Pending approvals are cancelled in the same transaction; unknown effects are not replayed. Memory eligibility scans and global running-task checks also use metadata.

The settings, library and background pages load their JavaScript on demand. Concurrent bootstrap requests share one in-flight request (not a stale cache). Hidden knowledge panels pause periodic progress/statistics requests and refresh on visibility restoration. Existing conversation pagination, incremental event loading and streaming remain in place.

The launcher respects the configured data directory for logs, checks supervisor exit, and allows a bounded 90-second readiness window. Local RAG is still a separate service; its already-running notice is not evidence that Amadeus is ready.

A local recovery check on 1,378 runs / 3.07 GB of checkpoint text took approximately 120 ms with a 24 MiB JavaScript heap after recovery. This is a single recovery-stage measurement, not a full-app latency benchmark or memory bound.

Finalization and error cleanup also use run metadata when checking descendants, including plain conversations with no children. Delegation inventory, handoff eligibility and learning outcome summaries must not hydrate every historical checkpoint. Regression tests forbid bulk run loading during both a plain final answer and provider failure.

Additional bounded reads: typed event queries filter in SQLite, child reports fetch only the latest assistant event, and recovery skips event reads when there are no unknown effects. Scheduled run polling reads headers; attachment metadata excludes text/path before JSON decoding, and media lists query their conversation only. Embedding and LightRAG synchronization keep an ID inventory but load text/vector payloads only for the current batch (16 chunks). Document graph evidence checks use a database existence query. ID inventories and genuinely requested full conversation history are still proportional to history size; this is not a constant-memory guarantee.
