import { selectDelegationModel } from '../services/delegation-models.js';
import { Teams } from '../services/team-space.js';
import { configuredLimit } from './limits.js';
import { Isolations } from '../services/isolation.js';
import type { Run, Conversation } from '../../shared/types.js';
import type { ToolContext } from '../tools/registry.js';
import type { Configuration } from '../services/settings.js';
import { Store, id } from '../storage/store.js';
import type { EventEmitter } from 'node:events';
import { assert, abortError } from './errors.js';
import { terminal } from './lifecycle.js';
interface DelegationHost {
  context(run: Run): Promise<ToolContext>;
  start(
    conversationId: string,
    message: string,
    maxSteps: number,
    options: { parentRunId: string; depth: number; fresh: boolean; controlTicket?: string },
  ): Run;
  signal(runId: string): AbortSignal | undefined;
  pump(): void;
  steer(conversationId: string, message: string): void;
}
export class DelegationManager {
  private pendingSpawns = new Map<string, number>();
  private waitingOn = new Map<string, string[]>();
  constructor(
    private store: Store,
    private config: Configuration,
    private directory: string,
    private bus: EventEmitter,
    private host: DelegationHost,
  ) {}
  async spawn(
    parent: Run,
    task: string,
    deliverable: string,
    mode: 'read-only' | 'isolated' = 'read-only',
    controlTicket?: string,
    specialistId?: string,
    profileId?: string,
  ) {
    const settings = this.config.get();
    const specialist = specialistId
      ? settings.specialists?.find((s) => s.id === specialistId)
      : undefined;
    assert(!specialistId || specialist, 'SPECIALIST_UNKNOWN', 'Unknown specialist definition.');
    assert(
      parent.depth < settings.maxAgentDepth,
      'DEPTH_LIMIT',
      'Configured delegation depth reached.',
    );
    const root = this.root(parent);
    assert(
      this.store.runMetadata().filter((r) => r.parentRunId && this.root(r) === root).length +
        (this.pendingSpawns.get(root) || 0) <
        configuredLimit(settings.maxChildren),
      'CHILD_LIMIT',
      'Configured total child limit reached for this run tree.',
    );
    this.pendingSpawns.set(root, (this.pendingSpawns.get(root) || 0) + 1);
    try {
      const c = this.store.get<Conversation>('conversation', parent.conversationId),
        now = Date.now();
      assert(c.teamStrategy !== 'off', 'DELEGATION_DISABLED', 'User disabled delegation.');
      assert(
        mode !== 'isolated' || (c.permission !== 'read-only' && !!c.projectId),
        'DELEGATION_PERMISSION',
        'Writable delegation requires a writable project task.',
      );
      const modelSelection = selectDelegationModel(c, settings.profiles, profileId);
      const source = (await this.host.context(parent)).files;
      const isolation =
        mode === 'isolated'
          ? await new Isolations(this.store, this.directory).create(parent.id, source)
          : null;
      const child = {
        ...c,
        ...modelSelection,
        isolationId: isolation?.id || c.isolationId,
        id: id(),
        title: task.slice(0, 65),
        specialistId: specialist?.id || c.specialistId,
        allowedTools: specialist
          ? specialist.allowedTools.filter((t) => !c.allowedTools || c.allowedTools.includes(t))
          : c.allowedTools,
        skillIds: specialist
          ? specialist.skillIds.filter((key) => this.store.maybe<any>('skill', key)?.enabled)
          : c.skillIds,
        permission:
          mode === 'isolated'
            ? c.permission === 'trusted'
              ? ('ask' as const)
              : c.permission
            : ('read-only' as const),
        parentId: c.id,
        forkEvent: null,
        createdAt: now,
        updatedAt: now,
      };
      assert(
        !this.host.signal(parent.id)?.aborted,
        'CANCELLED',
        'Parent was cancelled during copy preparation.',
      );
      this.store.put('conversation', child);
      this.store.put('agent-binding', { id: child.id, owner: c.id, roots: source.roots, mode });

      new Teams(this.store).checkEnrollment(parent, child.id);
      const run = this.host.start(
        child.id,
        (mode === 'isolated'
          ? 'Independent isolated task. Write only to this copy; the parent must review and merge changes. Copy coverage: ' +
            JSON.stringify(isolation?.copyReport) +
            '. Excluded entries are unavailable; do not assume this is a complete project clone.\n'
          : 'Independent read-only task:\n') +
          (specialist
            ? 'Specialist guidance (does not grant permissions): ' + specialist.instructions + '\n'
            : '') +
          task +
          '\nRequired deliverable:\n' +
          deliverable,
        0,
        { parentRunId: parent.id, depth: parent.depth + 1, fresh: true, controlTicket },
      );
      new Teams(this.store).enrollSpawn(parent, run);
      this.store.event(c.id, parent.id, 'child.started', {
        runId: run.id,
        conversationId: child.id,
        profileId: child.profileId,
        task,
        deliverable,
      });
      return run.id;
    } finally {
      this.pendingSpawns.set(root, Math.max(0, (this.pendingSpawns.get(root) || 1) - 1));
    }
  }
  private member(parent: Run, key: string) {
    const targetRun = this.store.maybe<Run>('run', key);
    const child = this.store.get<Conversation>('conversation', targetRun?.conversationId || key);
    // parentId alone also describes user-created forks; require delegation provenance.
    const runs = this.store.runMetadata(child.id);
    assert(
      child.parentId === parent.conversationId &&
        runs.some(
          (r) =>
            r.parentRunId &&
            this.store.maybe<Run>('run', r.parentRunId)?.conversationId === parent.conversationId,
        ),
      'AGENT_SCOPE',
      'Only direct delegated members owned by this conversation can be continued.',
    );
    return { child, runs };
  }
  members(parent: Run) {
    return this.store
      .list<Conversation>('conversation')
      .filter((c) => c.parentId === parent.conversationId)
      .flatMap((c) => {
        try {
          const { runs } = this.member(parent, c.id),
            latest = runs.at(-1);
          return [
            {
              agentId: c.id,
              name: c.title,
              runId: latest?.id,
              status: c.archived
                ? 'closed'
                : latest && !terminal(latest.status)
                  ? latest.status
                  : 'idle',
              lastOutcome: latest?.status,
              permission: c.permission,
              profileId: c.profileId,
            },
          ];
        } catch {
          return [];
        }
      });
  }
  private assertIdle(runs: Run[]) {
    assert(
      runs.every((r) => terminal(r.status)),
      'AGENT_BUSY',
      'Member is active. Send a message to its current run or wait.',
    );
    const owned = new Set(runs.map((r) => r.id)),
      all = this.store.runMetadata();
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of all)
        if (r.parentRunId && owned.has(r.parentRunId) && !owned.has(r.id)) {
          owned.add(r.id);
          changed = true;
        }
    }
    assert(
      !all.some((r) => owned.has(r.id) && !terminal(r.status)),
      'AGENT_BUSY',
      'Member has active descendants.',
    );
    assert(
      !this.store
        .list<any>('command-job')
        .some(
          (j) =>
            owned.has(j.runId) && ['running', 'waiting_approval', 'unknown'].includes(j.status),
        ),
      'AGENT_RECOVERY',
      'Member background operations must finish or be reconciled first.',
    );
    assert(
      !all.some((r) => owned.has(r.id) && this.store.unknownEffects(r.conversationId).length),
      'AGENT_RECOVERY',
      'Inspect unresolved member operations before continuing; nothing was replayed.',
    );
  }
  closeMember(parent: Run, key: string) {
    const { child, runs } = this.member(parent, key);
    this.assertIdle(runs);
    this.store.put('conversation', { ...child, archived: true });
    this.store.event(parent.conversationId, parent.id, 'agent.closed', { agentId: child.id });
    return { agentId: child.id, status: 'closed', historyRetained: true };
  }
  async continueMember(
    parent: Run,
    key: string,
    message: string,
    controlTicket?: string,
    profileId?: string,
  ) {
    const { child, runs } = this.member(parent, key);
    const c = this.store.get<Conversation>('conversation', parent.conversationId),
      settings = this.config.get();
    assert(
      !c.archived && !child.archived,
      'AGENT_CLOSED',
      'Member or owning conversation is closed.',
    );
    assert(
      !parent.recoveryOnly && c.teamStrategy !== 'off',
      'DELEGATION_DISABLED',
      'Delegation is disabled or parent requires recovery.',
    );
    assert(
      parent.depth < settings.maxAgentDepth,
      'DEPTH_LIMIT',
      'Configured delegation depth reached.',
    );
    this.assertIdle(runs);
    const modelSelection = selectDelegationModel(c, settings.profiles, profileId);
    assert(
      child.projectId === c.projectId,
      'AGENT_SCOPE_CHANGED',
      'Project changed; create a new member for the new scope.',
    );
    assert(
      !this.store.unknownEffects(child.id).length,
      'AGENT_RECOVERY',
      'Inspect unresolved member operations before continuing; nothing was replayed.',
    );
    const root = this.root(parent);
    assert(
      this.store.runMetadata().filter((r) => r.parentRunId && this.root(r) === root).length +
        (this.pendingSpawns.get(root) || 0) <
        configuredLimit(settings.maxChildren),
      'CHILD_LIMIT',
      'Configured child execution limit reached.',
    );
    this.pendingSpawns.set(root, (this.pendingSpawns.get(root) || 0) + 1);
    try {
      const source = (await this.host.context(parent)).files;
      const binding = this.store.maybe<any>('agent-binding', child.id);
      assert(
        !binding || JSON.stringify(binding.roots) === JSON.stringify(source.roots),
        'AGENT_SCOPE_CHANGED',
        'Workspace roots changed; create a new member for the new scope.',
      );
      const mode = binding?.mode || (child.permission === 'read-only' ? 'read-only' : 'isolated');
      let isolationId = c.isolationId;
      let isolation: any;
      if (mode === 'isolated') {
        assert(
          c.permission !== 'read-only' && c.projectId,
          'DELEGATION_PERMISSION',
          'Writable continuation requires a writable project.',
        );
        assert(child.isolationId, 'AGENT_ISOLATION', 'Writable member has no isolated copy.');
        const service = new Isolations(this.store, this.directory),
          old = service.get(child.isolationId);
        assert(
          JSON.stringify(old.originals) === JSON.stringify(source.roots),
          'AGENT_SCOPE_CHANGED',
          'Isolated copy belongs to a different workspace.',
        );
        assert(
          old.state === 'ready' || old.state === 'merged',
          'AGENT_RECOVERY',
          'Reconcile the isolated merge before continuing.',
        );
        isolation = old.state === 'merged' ? await service.create(parent.id, source) : old;
        isolationId = isolation.id;
      }
      assert(
        !this.host.signal(parent.id)?.aborted,
        'CANCELLED',
        'Parent was cancelled before continuation.',
      );
      // No await between the final liveness check and registration.
      this.assertIdle(this.store.runMetadata(child.id));
      const run = this.store.transaction(() => {
        if (isolation) this.store.put('isolation', { ...isolation, parentRunId: parent.id });
        this.store.put('conversation', {
          ...child,
          isolationId,
          permission:
            mode === 'read-only'
              ? 'read-only'
              : c.permission === 'trusted' && child.permission === 'trusted'
                ? 'trusted'
                : c.permission === 'read-only'
                  ? 'read-only'
                  : 'ask',
          ...modelSelection,
          subagentModels: c.subagentModels,
          execution: c.execution,
          knowledge: c.knowledge,
          memory: c.memory,
          remoteMemoryOnly: c.remoteMemoryOnly || c.remoteChatOnly,
          includeUserMemory: c.includeUserMemory,
          skillIds: child.skillIds.filter((id) => c.skillIds.includes(id)),
          teamStrategy: c.teamStrategy,
          teamMode: c.teamMode,
        });
        this.store.put('agent-binding', { id: child.id, owner: c.id, roots: source.roots, mode });
        new Teams(this.store).checkEnrollment(parent, child.id);
        const next = this.host.start(
          child.id,
          'Continue your existing role/task with retained history. This is a new instruction, not authorization to replay interrupted operations. Recheck current workspace facts.\n' +
            message,
          0,
          { parentRunId: parent.id, depth: parent.depth + 1, fresh: false, controlTicket },
        );
        new Teams(this.store).enrollSpawn(parent, next);
        this.store.event(c.id, parent.id, 'child.started', {
          runId: next.id,
          conversationId: child.id,
          agentId: child.id,
          continuedFrom: runs.at(-1)?.id,
          task: message,
          deliverable: 'Follow-up using retained member history',
        });
        return next;
      });
      return { agentId: child.id, runId: run.id, status: run.status, profileId: run.profileId };
    } finally {
      this.pendingSpawns.set(root, Math.max(0, (this.pendingSpawns.get(root) || 1) - 1));
    }
  }
  private integrationCopy(parent: Run, key: string) {
    const child = this.store.get<Run>('run', key);
    assert(
      child.parentRunId === parent.id && child.status === 'completed',
      'MERGE_SCOPE',
      'Only a completed direct child can be integrated.',
    );
    assert(
      !this.store.runMetadata().some((r) => r.parentRunId === child.id && !terminal(r.status)),
      'CHILD_ACTIVE',
      'Child has active descendants.',
    );
    const conversation = this.store.get<Conversation>('conversation', child.conversationId);
    assert(conversation.isolationId, 'NOT_ISOLATED', 'Child has no isolated copy.');
    const service = new Isolations(this.store, this.directory);
    assert(
      service.get(conversation.isolationId).parentRunId === parent.id,
      'MERGE_SCOPE',
      'Not owned by this parent.',
    );
    return { service, id: conversation.isolationId };
  }
  async inspectChanges(parent: Run, key: string) {
    const copy = this.integrationCopy(parent, key);
    return copy.service.inspect(copy.id);
  }
  async mergeChanges(parent: Run, key: string, version: string) {
    const copy = this.integrationCopy(parent, key);
    return copy.service.merge(copy.id, version);
  }
  private root(run: Run): string {
    let r = run;
    while (r.parentRunId) r = this.store.runHeader(r.parentRunId);
    return r.id;
  }
  async wait(parent: Run, keys: string[], signal: AbortSignal) {
    for (const key of keys)
      assert(
        this.root(this.store.get<Run>('run', key)) === this.root(parent) && key !== parent.id,
        'TEAM_SCOPE',
        'Cannot wait on an unrelated task.',
      );
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (this.waitingOn.get(from) || []).some((k) => reaches(k, target, seen));
    };
    for (const key of keys) {
      let ancestor = parent.parentRunId;
      while (ancestor) {
        assert(ancestor !== key, 'WAIT_CYCLE', 'A child cannot wait on its ancestor.');
        ancestor = this.store.runHeader(ancestor).parentRunId;
      }
      assert(!reaches(key, parent.id), 'WAIT_CYCLE', 'Delegation wait would create a cycle.');
    }
    this.waitingOn.set(parent.id, keys);
    this.store.transition(parent.id, 'waiting_children');
    this.host.pump();
    let waitReason = 'completed';
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.bus.off('finished', check);
          this.bus.off('event', check);
          signal.removeEventListener('abort', abort);
        };
        const check = () => {
          const pending = this.store
            .list<any>('user-inbox')
            .some((x) => x.runId === parent.id && x.state === 'pending');
          if (pending || keys.every((key) => terminal(this.store.runHeader(key).status))) {
            waitReason = pending ? 'input_pending' : 'completed';
            cleanup();
            resolve();
          }
        };
        const abort = () => {
          cleanup();
          reject(abortError());
        };
        const timer = setTimeout(() => {
          waitReason = 'timeout';
          cleanup();
          resolve();
        }, 60000);
        this.bus.on('finished', check);
        this.bus.on('event', check);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      });
    } finally {
      this.waitingOn.delete(parent.id);
      if (!signal.aborted && this.store.get<Run>('run', parent.id).status === 'waiting_children')
        this.store.transition(parent.id, 'running');
    }
    return keys.map((key) => {
      const r = this.store.get<Run>('run', key);
      return {
        runId: key,
        waitReason,
        status: r.status,
        error: r.error,
        answer:
          this.store.selectedEvents(r.conversationId, ['assistant.message'], 1).at(-1)?.data.text ||
          '',
        usage: { input: r.inputTokens, output: r.outputTokens, cost: r.estimatedUsd },
      };
    });
  }
  message(parent: Run, key: string, message: string) {
    const target = this.store.get<Run>('run', key);
    assert(this.root(target) === this.root(parent), 'TEAM_SCOPE', 'Cannot message unrelated tasks');
    assert(!terminal(target.status), 'TASK_FINISHED', 'Task already finished');
    this.host.steer(target.conversationId, '[Team message from ' + parent.id + '] ' + message);
    this.store.event(parent.conversationId, parent.id, 'agent.message.submitted', {
      sender: parent.id,
      recipient: target.id,
    });
  }
}
