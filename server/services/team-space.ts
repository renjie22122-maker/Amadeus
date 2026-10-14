import type { Conversation, Run } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { terminal } from '../core/lifecycle.js';
import { rootRun, TaskBoard } from './task-board.js';
export interface TeamSpace {
  id: string;
  mode: 'host' | 'creative';
  revision: number;
  term?: number;
  members: string[];
  roles: Record<'coordinator' | 'planner' | 'reviewer' | 'summarizer', string>;
  closed: Record<string, string>;
  maxMessages: number;
  autoEnroll?: boolean;
  selection?: { by: 'agent' | 'user'; reason: string };
}
export class Teams {
  constructor(private store: Store) {}
  get(run: Run) {
    return this.store.maybe<TeamSpace>('team-space', rootRun(this.store, run));
  }
  authority(run: Run, role: keyof TeamSpace['roles'] = 'coordinator') {
    const team = this.get(run);
    return team ? team.roles[role] === run.id : run.id === rootRun(this.store, run);
  }
  configure(
    run: Run,
    mode: TeamSpace['mode'],
    members: string[],
    maxMessages: number,
    autoEnroll = false,
    reason = '',
  ) {
    assert(this.authority(run), 'TEAM_ROLE', 'Only current coordinator configures the team.');
    const root = rootRun(this.store, run),
      origin = this.store.get<Run>('run', root);
    const c = this.store.get<Conversation>('conversation', origin.conversationId);
    assert(
      c.teamStrategy !== 'off' && ((c.teamMode || 'auto') === 'auto' || c.teamMode === mode),
      'TEAM_MODE',
      'Select this team mode in conversation controls first.',
    );
    assert(
      !this.get(run),
      'TEAM_EXISTS',
      'Team already exists; use role handoff rather than resetting state.',
    );
    assert(
      members.length >= (autoEnroll ? 1 : 2) &&
        members.length <= 32 &&
        new Set(members).size === members.length &&
        members.includes(run.id),
      'TEAM_MEMBERS',
      'Choose 2-32 distinct current run IDs, including coordinator ' +
        run.id +
        '. Names and stable agent IDs are not run IDs; use continue_agent for idle members first.',
    );
    for (const key of members) {
      const r = this.store.get<Run>('run', key);
      assert(
        rootRun(this.store, r) === root && !terminal(r.status) && !r.recoveryOnly,
        'TEAM_SCOPE',
        'Enroll active members in this task tree. For completed direct members call continue_agent with their stable agentId, then enroll the returned runId; or configure an autoEnroll team before spawning.',
      );
    }
    assert(
      Number.isInteger(maxMessages) && maxMessages >= 1 && maxMessages <= 1000,
      'TEAM_LIMIT',
      'Set 1–1000 discussion messages per member.',
    );
    assert(
      this.store
        .runs()
        .filter((r) => rootRun(this.store, r) === root && !terminal(r.status))
        .every((r) => members.includes(r.id)),
      'TEAM_ROSTER',
      'Enroll all active members before fixing the team roster.',
    );
    const team: TeamSpace = {
      id: root,
      mode,
      revision: 1,
      members,
      roles: { coordinator: run.id, planner: run.id, reviewer: run.id, summarizer: run.id },
      closed: {},
      maxMessages,
      autoEnroll,
      selection: {
        by: (c.teamMode || 'auto') === 'auto' ? 'agent' : 'user',
        reason: reason.trim() || 'Selected for the current task',
      },
    };
    this.store.put('team-space', team);
    const defaults = this.store.maybe<any>('team-automation-default', origin.conversationId);
    if (defaults && !this.store.maybe('team-automation', root))
      this.store.put('team-automation', { ...defaults, id: root });
    this.audit(run, 'created', { mode, members, maxMessages, selection: team.selection });
    return team;
  }
  checkEnrollment(parent: Run, conversationId: string) {
    const t = this.get(parent);
    if (!t?.autoEnroll || !t.members.includes(parent.id) || t.closed[parent.id]) return;
    const retained = t.members.filter((key) => {
      const old = this.store.get<Run>('run', key);
      return old.conversationId !== conversationId || !terminal(old.status);
    });
    assert(
      retained.length < 32,
      'TEAM_MEMBERS',
      'Team roster is full (32); use independent delegation or a separate team task.',
    );
  }
  enrollSpawn(parent: Run, child: Run) {
    const t = this.get(parent);
    if (!t?.autoEnroll || !t.members.includes(parent.id) || t.closed[parent.id]) return;
    assert(
      rootRun(this.store, child) === t.id,
      'TEAM_SCOPE',
      'New member must belong to the same task tree.',
    );
    // Retire an older completed invocation of this stable member without erasing its transcript.
    t.members = t.members.filter((key) => {
      const old = this.store.get<Run>('run', key);
      if (old.conversationId === child.conversationId && terminal(old.status)) {
        for (const role of Object.keys(t.roles) as (keyof TeamSpace['roles'])[])
          if (t.roles[role] === key) t.roles[role] = child.id;
        return false;
      }
      return true;
    });
    if (!t.members.includes(child.id)) t.members.push(child.id);
    t.revision++;
    this.store.put('team-space', t);
    this.audit(parent, 'member-enrolled', { runId: child.id });
  }
  updateLimits(run: Run, maxMessages: number) {
    const t = this.get(run);
    assert(
      t && this.authority(run),
      'TEAM_ROLE',
      'Only the coordinator can change discussion limits.',
    );
    assert(
      Number.isInteger(maxMessages) && maxMessages >= 1 && maxMessages <= 1000,
      'TEAM_LIMIT',
      'Set 1–1000 messages per member.',
    );
    t.maxMessages = maxMessages;
    t.revision++;
    this.store.put('team-space', t);
    this.audit(run, 'discussion-limit-updated', { maxMessages });
    return this.project(run);
  }
  handoff(
    run: Run,
    role: keyof TeamSpace['roles'],
    target: string,
    revision: number,
    reason: string,
  ) {
    return this.store.transaction(() => {
      const t = this.get(run);
      assert(t && t.revision === revision, 'TEAM_CHANGED', 'Read current team revision.');
      assert(
        t.roles[role] === run.id || t.roles.coordinator === run.id,
        'TEAM_ROLE',
        'Only role holder or coordinator may hand off.',
      );
      const r = this.store.get<Run>('run', target);
      assert(
        t.members.includes(target) && !terminal(r.status) && !r.recoveryOnly && !t.closed[target],
        'TEAM_MEMBER',
        'Target must be an active participating member.',
      );
      const previous = t.roles[role];
      t.roles[role] = target;
      t.revision++;
      this.store.put('team-space', t);
      this.audit(run, 'role-handoff', { role, previous, target, reason });
      return t;
    });
  }
  post(run: Run, text: string, to: string[]) {
    return this.store.transaction(() => {
      const t = this.get(run);
      assert(
        t?.mode === 'creative' && t.members.includes(run.id) && !t.closed[run.id],
        'TEAM_DISCUSSION',
        'Join an open creative team before posting.',
      );
      const messages = this.messages(run);
      assert(
        messages.filter((m) => m.sender === run.id).length < t.maxMessages,
        'DISCUSSION_LIMIT',
        'Configured per-member discussion limit reached; summarize or end participation.',
      );
      const recipients = to.length ? [...new Set(to)] : t.members.filter((k) => k !== run.id);
      assert(
        recipients.every((k) => t.members.includes(k) && k !== run.id),
        'TEAM_SCOPE',
        'Recipients must be other team members.',
      );
      const sequence =
        this.store.list<any>('team-discussion').filter((m) => m.teamId === t.id).length + 1;
      const row = {
        id: id(),
        sequence,
        teamId: t.id,
        sender: run.id,
        recipients,
        text,
        at: Date.now(),
      };
      this.store.put('team-discussion', row);
      this.audit(run, 'discussion', { messageId: row.id });
      return row;
    });
  }
  messages(run: Run) {
    const t = this.get(run);
    return t
      ? this.store
          .list<any>('team-discussion')
          .filter(
            (m) => m.teamId === t.id && (m.sender === run.id || m.recipients.includes(run.id)),
          )
          .sort((a, b) => a.sequence - b.sequence)
      : [];
  }
  close(run: Run, summary: string) {
    const t = this.get(run);
    assert(t && t.members.includes(run.id), 'TEAM_MEMBER', 'Not an enrolled member.');
    assert(
      !this.store.unknownEffects(run.conversationId).length,
      'OUTCOME_UNKNOWN',
      'Resolve uncertain operations before ending participation.',
    );
    assert(
      !new TaskBoard(this.store)
        .get(run)
        .tasks.some(
          (x) =>
            x.owner === run.id &&
            (x.status !== 'done' ||
              (x.requireIndependent &&
                (x.verification?.status !== 'checked' || x.verification.independent !== true)) ||
              x.verification?.status === 'stale' ||
              (x.artifacts?.length && x.verification?.status !== 'checked')),
        ),
      'TASK_INCOMPLETE',
      'Finish owned tasks or explicitly hand them off.',
    );
    t.closed[run.id] = summary;
    t.revision++;
    this.store.put('team-space', t);
    this.audit(run, 'participation-ended', { summary });
    return this.project(run);
  }
  project(run: Run) {
    const t = this.get(run);
    if (!t) return null;
    const tasks = new TaskBoard(this.store).get(run).tasks;
    const members = t.members.map((k) => this.store.runHeader(k));
    const blockers: string[] = [];
    for (const r of members) {
      if (this.store.unknownEffects(r.conversationId).length)
        blockers.push('Uncertain operation: ' + r.id);
      const c = this.store.get<Conversation>('conversation', r.conversationId);
      if (c.isolationId && this.store.maybe<any>('isolation', c.isolationId)?.state !== 'merged')
        blockers.push('Isolated changes require integration: ' + r.id);
    }
    for (const task of tasks)
      if (
        task.status !== 'done' ||
        (task.requireIndependent &&
          (task.verification?.status !== 'checked' || task.verification.independent !== true)) ||
        task.verification?.status === 'stale' ||
        (task.artifacts?.length && task.verification?.status !== 'checked')
      )
        blockers.push('Unfinished or unverified task: ' + task.id);
    if (t.mode === 'host' && !tasks.length) blockers.push('No declared tasks');
    const allEnded = members.every((r) => terminal(r.status));
    const unclosed = members.filter(
      (r) =>
        terminal(r.status) && r.status !== 'completed' && !this.store.maybe('team-retired', r.id),
    );
    for (const r of unclosed) blockers.push('Member interrupted or failed: ' + r.id);
    const status = allEnded ? (blockers.length ? 'blocked' : 'completed') : 'active';
    return {
      ...t,
      status,
      blockers,
      messages: this.messages(run),
      discussionBudget: {
        unit: 'messages_per_member',
        limit: t.maxMessages,
        used: this.messages(run).filter((m) => m.sender === run.id).length,
        remaining: Math.max(
          0,
          t.maxMessages - this.messages(run).filter((m) => m.sender === run.id).length,
        ),
        notice:
          'Message allowance is not evidence quality or consensus. Summarize when no new evidence remains; request coordinator adjustment if necessary.',
      },
      basis:
        t.mode === 'creative'
          ? 'Participation ended; not factual consensus or correctness verification.'
          : 'Task evidence and integration state; not a proof of semantic correctness.',
    };
  }
  private audit(run: Run, action: string, data: unknown) {
    this.store.event(run.conversationId, run.id, 'team.lifecycle', {
      teamId: rootRun(this.store, run),
      action,
      data,
    });
  }
}
