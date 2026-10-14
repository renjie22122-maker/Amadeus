# Conversations, progress and recovery

[English](INTERACTION.md) | [简体中文](INTERACTION.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-05; code baseline: `d663030`.

## Navigation

Newly opened conversations start near the latest content. Steps can expand/collapse, with a compact live preview when folded. Round navigation locates user turns. The context/workspace strip opens detail panels; context pages and knowledge-maintenance progress load independently of slower statistics.

Thinking, collaboration and access controls sit near the composer. Display scaling offers Auto and 25/50/75/100/115/125/150%. Ordinary chats show chat files; project chats show registered roots. Custom names are preserved through the Amadeus rename.

## Live updates

Elapsed wall time includes model, tools and approval waits; terminal runs stop the timer. Durable follow-ups display pending until the next safe consumption point, not immediate model receipt. Background jobs permit independent work; a foreground command can still occupy the run.

The client reconnects up to five times with 1/2/4/8/16-second backoff; a healthy heartbeat resets the streak. Reconnection reauthenticates and restores durable state without resending operations. Event IDs suppress duplicates; large gaps refresh snapshots. Manual reconnect remains available. A mutation timeout is not evidence that it failed.

Questions and approvals appear at their chronological event positions. A global attention menu jumps to the relevant chat/card. Desktop notifications need browser permission and an open page; this is not a persistent Windows notification service. Generic notification text avoids exposing task content.

## Review and recovery

Run changes are grouped and collapsed, with red/green text differences, line counts and unified/before-after views. Snapshots exclude hidden/generated/linked/binary/oversized files and are bounded (400 entries, 2 MB, eight levels). They can observe user edits too; they are not undo or transaction isolation. Old events cannot recover absent before-images.

Unknown effects allow a read-only inspection continuation, not blind write/command replay. Exact full-content writes and recorded edit postimages can be reconciled automatically. resolve_effect may then ask for confirmation. “Allow another attempt” records explicit retry authorization while retaining the unknown prior outcome; it does not itself execute a command. Subsequent work retains normal approvals.

Approval waits have no expiry and do not consume command execution time. Stop/restart cancels waiters and exposes recovery; it never silently approves. Known pre-start errors are distinguished from unknown execution.

## Content and workspace preview

Markdown supports tables, math, code, attributed quotations and embedded media. HTML and Mermaid default to preview with a same-sized scrollable code view. See [formatting](CHAT-FORMATTING.md).

Workspace HTML preview can inline up to 40 scoped local resources, with a browser sandbox/CSP and no host-page access. It is not arbitrary Python execution, a dependency installer or a full development server. See [tool boundaries](TOOL-ECOSYSTEM.md).

## Collaboration in each round

Each round retains its own expandable collaboration panel when a new turn starts. Expand it to view member hierarchy, declared task dependencies and recorded communication arrows; select a node to inspect the corresponding work. Historical details load on demand. New member approval or question waits open the panel for attention.

Creation relationships are distinct from task dependencies. Communication counts represent submitted messages, not read receipts; older messages without structured records are not inferred. Graphs show up to 60 nodes, with all members available in the accompanying list.

## Model request recovery

Malformed tool arguments allow up to two correction requests per model step. Temporary connection failures or interrupted streams reconnect up to five times with 2/4/8/16/30-second delays; progress is visible and Stop cancels the wait. Successful responses reset these allowances. Only the failed model response is requested again: partial tool calls never execute and completed tool operations remain in context. Partial text is marked incomplete. Retries can incur additional provider charges; unavailable usage is not treated as measured zero. Credential/configuration errors are not retried automatically. After exhaustion, the run stops with a recoverable reason; an explicit model-step limit still applies.

## Long commands and timeout tests

A single ordinary command now waits up to 10 seconds, then returns the ID of the same still-running background process. Its execution timeout is unchanged; approval wait is excluded. The UI records the handoff and background progress. New messages wake background waits. The agent may do independent work, but must not change files, outputs or environments being used by that job. When no independent work remains, it waits for an event rather than polling the model.

Short commands return their original exit code/output. A scheduled job is not passing test evidence. Set yieldAfterSeconds=0 for strict synchronous completion, or background=true for immediate scheduling. Implicit multi-call batches, sequential workflows and hooks retain synchronous defaults to preserve dependencies. This does not create a filesystem lock or guarantee that the model always chooses useful parallel work. Already-running foreground commands on an older service are not retroactively detached.

## Pasted text and draft preview

Pasting at least 8,000 characters or 100 lines creates a Markdown text attachment using the existing upload path. It stays in the draft until sent, can be removed like other attachments, and does not become knowledge or memory automatically. Sending is disabled during that upload. Upload errors retain the source for retry or restoration to the draft.

Short Markdown/formula pastes open Preview; Edit returns to the unchanged source. Tables, fenced code and KaTeX math are supported. This is a source/preview editor, not a rich-text WYSIWYG editor. Draft previews do not execute HTML or fetch remote images. Existing attachment limits still apply.

### Updates and argument repair

Quick Start checks source fingerprints and rebuilds when the service is stopped. An already running service is only reopened; rebuilding files does not reload its in-memory code. Finish tasks and stop the service before running Start-Amadeus.cmd again. First-Start-Amadeus.cmd prepares locked dependencies and builds; it refuses to replace dependencies underneath a running service.

Malformed tool arguments get at most two consecutive repair attempts, reset after each successful model response. Exhaustion is a recoverable interruption; incomplete calls are never executed. Network reconnection is separate. Historical failures do not describe the currently installed implementation. Security review designs are untested suggestions, not evidence of vulnerability discovery or remediation.

## Live task progress

The composer shows reported-done, working, pending and blocked counts. SSE updates and reconnect refresh the board. Queued messages are not yet plan changes; after delivery the model can extend_plan with new requirements while retaining existing status and evidence. Reported done is not independent acceptance.

### Collaboration evidence

Team blackboard distinguishes unique evidence events, repeated observations, executors and grouped retrieval passages. Multiple agents quoting identical retrieved text do not establish independent sources. Repeating a test is replication; different outputs require inspection, not an automatic contradiction verdict. Existing task challenges still require newer current-artifact evidence and cannot be resolved by vote. Source independence remains explicitly unestablished where lineage is unknown.

## Sidebar navigation

Projects and ordinary conversations share one scroll area, with initial visible counts adapted to the sidebar height (up to five per list) and See more / See less controls. Project chats also expand progressively. Pinned conversations remain first and visible; other chats use most recent activity. Projects use the later of creation and active conversation activity. The selected conversation and its project remain available when lists collapse. Search includes project names and all matching conversations regardless of collapsed counts. Projects start collapsed except the current project and search matches. No settings or startup changes are required.

### Team setup, waiting and discussion budgets

Creative teams can be created before delegation with `configure_team(autoEnroll=true, members=[currentRunId])`. New child invocations and continued direct collaborators are then enrolled synchronously; ordinary delegation and fixed rosters are unchanged. Existing permission, depth, resource and 32-member roster limits remain. Completed members are continued with `continue_agent`; they are not automatically awakened or counted as active. Coordinator-only limit changes preserve history. The per-member budget counts messages, not debate rounds or independent evidence; no-new-evidence synthesis remains a model decision, not a proven convergence detector.

`wait_agents` yields on new pending input or after 60 seconds without stopping children. Team message/task waits also yield to pending input. The model receives steering on the next loop boundary; this is not an immediate second model call alongside an active call. Automation policies save before team setup, emit refresh events, and are inherited by future teams in the same conversation; they do not create teams or authorize writes. UI labels identify named role holders and shared responsibilities, show discussion allowance and allow updating it. Errors remain visible and successful saves acknowledge the returned policy. No new setup dependencies; restart the application to activate.

### Automatic organization

The default organization mode is now `auto` for new conversations and conversations without an explicit mode. The model can choose ordinary subagents, a creative discussion team, or a host-scheduled team without asking the user to select infrastructure. Explicit hierarchy/host/creative choices and delegation-off remain binding. Auto mode does not force team creation, change permissions, waive approvals or remove concurrency/cost limits. The selected team mode and reason are recorded and displayed. Before a team exists, configuration and direct-message tools are discoverable in the model's working tool list; after creation, relevant team messaging/scheduling tools are included. This enables task-based model decisions, not a calibrated automatic planner or guaranteed optimal assignment. No launcher changes or dependency installs are needed.

### Responsive history and team visibility

Chat opens the latest 500 events and loads earlier pages on request; this is a page size, not a retention limit. Live updates use event cursors. Team member feeds also refresh incrementally, with earlier records available in execution details. Each round shows delegation versus team mode, member completion/running/attention counts and task completion separately; completion is not acceptance. The relation view exposes members, dependencies and recorded communication. Background recovery reads only the relevant run/tool events and uses metadata for roster scans, avoiding historical checkpoint deserialization. Existing launchers rebuild changed sources; no new dependency or setup step is required.

### Topic teams and recoverable enrollment

![Team organization and evidence review](images/team-research-flow.svg)

`configure_team` defaults to open enrollment: configure the lead first, then spawn or continue peers. An explicitly fixed roster still blocks those calls. The coordinator can inspect the revision and call `update_team_roster` to open enrollment or add active same-tree peers without deleting messages, roles or tasks. Closed participation, permissions and resource limits still apply.

`configure_team_group` organizes parallel topics inside one team. `team_discuss(groupId)` routes to that group's members; a nonmember cannot post to it, except the coordinator. Groups can overlap and share the team's message allowance, permissions and coordinator: they are not isolated nested teams. The round panel shows group purposes and members. Continuation/recovery updates membership while old message recipients remain historical facts.

Research assessments can record claim-level source nature, conclusion type, edition context and limitations. Testimony/commentary cannot be labeled direct observation in this record. These are agent assessments, not truth certification. A primary document can contain secondary commentary; absent search results cannot prove a statement never appears. Separate self-review from actual independent contributors, and repeated citations from independent sources.

Management responsibilities are grouped by their current owner. The lead appears as “Lead agent”, not the full conversation prompt. Transfers are under an optional disclosure and only list other active members. These controls neither create professional roles nor spawn agents; actual contributors and assigned work remain in the round’s collaboration view.

## Concrete peer collaboration

Independent subtasks may return directly to the lead. A team is useful only when members need to reconcile constraints, competing proposals or conflicting evidence. The model chooses this based on the current task; a past role arrangement is not a mandatory template.

For such work, `configure_team(reviewRequired=true)` declares a peer-review obligation. Submit a concrete version with `submit_team_proposal`, assigning only affected reviewers. Each reviewer reads it with `inspect_team_proposal`, then records acceptance or a specific requested change with `review_team_proposal`. The author either answers using `respond_team_review` or revises the proposal. An answer awaits reassessment; a revision invalidates old acceptance. No minimum message count, fixed professional roles, all-to-all discussion or majority vote is required.

The team panel shows proposal version, author, reviewers and whether review, response or reassessment is pending. The lead cannot close declared review work without a proposal or with open reviews. Members may finish their own turn; the lead can continue the same member for follow-up. Notifications identify pending delivery and do not claim that recipients read them.

Structured contributions share the existing member discussion budget; each proposal allows at most six versions. The coordinator can explicitly retain an unresolved disagreement or withdraw a proposal with its impact recorded. Both remain delivery warnings, never successful review. Reading receipts prove access to a version, not comprehension; peer acceptance is not factual truth, independent evidence or artifact verification. File changes still require the existing verification path.

No dependency or launcher change is required. Existing teams default to no declared review requirement. Restart the service when ready to load this update; an already-running service is not upgraded automatically.

Research proposals may link a scoped research case: reviewers compare a specific alternative and discriminating observation, with its decision impact. The linked research revision must remain current. See [long-range reading and research budgets](LOCAL-RAG.md#long-range-reading-and-bounded-hypothesis-comparison).
