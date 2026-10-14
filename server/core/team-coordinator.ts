import type { Conversation, Run } from '../../shared/types.js';
import type { EventEmitter } from 'node:events';
import type { FileScope } from '../services/paths.js';
import { Store } from '../storage/store.js';
import { Teams } from '../services/team-space.js';
import { rootRun, TaskBoard } from '../services/task-board.js';
import { TeamScheduler } from '../services/team-scheduler.js';
import { Verification } from '../services/verification.js';
import { assert, abortError } from './errors.js';
export interface TeamCoordinatorPort {
  events: Pick<EventEmitter, 'on' | 'off'>;
  filesForConversation(c: Conversation): Promise<FileScope>;
  steer(conversationId: string, text: string): unknown;
  pump(): void;
}
/** Coordinates team work through explicit capabilities; never receives the Runtime object. */
export class TeamCoordinator {
  constructor(
    private store: Store,
    private port: TeamCoordinatorPort,
  ) {}
  async dispatch(run: Run) {
    const root = rootRun(this.store, run);
    const policy = this.store.maybe<{ enabled: boolean }>('team-scheduling', root);
    if (!policy?.enabled) return;
    const lead = this.store.get<Run>('run', root);
    await new Verification(this.store).refresh(
      lead,
      await this.port.filesForConversation(
        this.store.get<Conversation>('conversation', lead.conversationId),
      ),
    );

    for (const assignment of new TeamScheduler(this.store).dispatch(run)) {
      const target = this.store.get<Run>('run', assignment.runId);
      this.port.steer(
        target.conversationId,
        '[Automatic team assignment] Task ' +
          assignment.taskId +
          ': ' +
          assignment.title +
          '. Acceptance: ' +
          assignment.acceptance +
          '. Inspect the latest plan, complete only this assigned task, cite actual evidence, and update its status before finishing. Existing permissions are unchanged.',
      );
      this.store.event(run.conversationId, run.id, 'team.assigned', assignment);
    }
  }
  async awaitDiscussion(run: Run, signal: AbortSignal, afterId?: string, seconds = 60) {
    signal.throwIfAborted();
    this.store.transition(run.id, 'waiting_children');
    this.port.pump();
    try {
      return await new Promise((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          this.port.events.off('event', check);
          signal.removeEventListener('abort', abort);
        };
        const check = () => {
          if (
            this.store
              .list<any>('user-inbox')
              .some((x) => x.runId === run.id && x.state === 'pending')
          ) {
            clean();
            resolve({ status: 'input_pending', messages: [] });
            return;
          }
          const teams = new Teams(this.store),
            team = teams.get(run);
          if (!team || !team.members.includes(run.id)) return;
          const rows = teams.messages(run);
          const index = afterId ? rows.findIndex((m) => m.id === afterId) : -1;
          if (afterId && index < 0) {
            clean();
            reject(new Error('Unknown discussion cursor.'));
            return;
          }
          const messages = rows.slice(index + 1).filter((m) => m.sender !== run.id);
          if (messages.length) {
            clean();
            resolve({ status: 'messages', messages });
          }
        };
        const abort = () => {
          clean();
          reject(abortError());
        };
        const timer = setTimeout(
          () => {
            clean();
            resolve({ status: 'no_messages', messages: [] });
          },
          Math.min(60, Math.max(1, seconds)) * 1000,
        );
        this.port.events.on('event', check);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      });
    } finally {
      if (!signal.aborted && this.store.get<Run>('run', run.id).status === 'waiting_children')
        this.store.transition(run.id, 'running');
    }
  }
  async awaitAssignment(run: Run, signal: AbortSignal) {
    assert(run.parentRunId, 'TEAM_WORKER', 'Only a worker waits for team assignments.');
    signal.throwIfAborted();
    this.store.put('team-worker-ready', { id: run.id });
    if (!this.store.maybe('team-worker-idle', run.id))
      this.store.put('team-worker-idle', { id: run.id, since: Date.now() });
    this.store.transition(run.id, 'waiting_children');
    this.port.pump();
    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.port.events.off('event', check);
          signal.removeEventListener('abort', abort);
        };
        const check = () => {
          if (
            this.store
              .list<any>('user-inbox')
              .some((x) => x.runId === run.id && x.state === 'pending')
          ) {
            cleanup();
            resolve({ status: 'input_pending', tasks: [] });
            return;
          }
          const board = new TaskBoard(this.store).get(run);
          const assigned = board.tasks.filter((t) => t.owner === run.id && t.status === 'running');
          if (
            assigned.length ||
            (board.tasks.length > 0 && board.tasks.every((t) => t.status === 'done'))
          ) {
            if (assigned.length) this.store.remove('team-worker-idle', run.id);
            cleanup();
            resolve({
              status: assigned.length ? 'assigned' : 'no_remaining_tasks',
              tasks: assigned,
            });
          }
        };
        const abort = () => {
          cleanup();
          reject(abortError());
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve({ status: 'no_assignment', tasks: [] });
        }, 60000);
        this.port.events.on('event', check);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else {
          check();
          void this.dispatch(run).catch((error) => {
            cleanup();
            reject(error);
          });
        }
      });
    } finally {
      this.store.remove('team-worker-ready', run.id);
      if (!signal.aborted && this.store.get<Run>('run', run.id).status === 'waiting_children')
        this.store.transition(run.id, 'running');
    }
  }
}
