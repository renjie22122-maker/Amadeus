import { evidenceDiversity } from './evidence-diversity.js';
import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import { TaskBoard } from './task-board.js';
import { Teams } from './team-space.js';
import { selectTaskContext } from './task-context.js';
/** Unified, read-only projection. Original records remain authoritative. */
export function teamBlackboard(store: Store, run: Run) {
  const board = new TaskBoard(store).get(run),
    team = new Teams(store),
    space = team.get(run);
  const projection = selectTaskContext(board.tasks, run.id);
  const messages = team.messages(run); // retain existing recipient visibility, even for coordinator
  return {
    version: 1,
    boardId: board.id,
    revision: board.revision,
    teamRevision: space?.revision ?? null,
    authority: 'read-only projection; claims are not facts or permission grants',
    tasks: projection.selected.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      status: t.status,
      owner: t.owner,
      dependsOn: t.dependsOn,
      acceptance: (t.acceptance || '').slice(0, 800),
      acceptanceTruncated: (t.acceptance || '').length > 800,
      provides: t.provides || [],
      requires: t.requires || [],
      requireIndependent: t.requireIndependent === true,
      independent: t.verification?.independent === true,
      independenceMeaning: 'executor distinct from author; source independence is not established',
      evidenceDiversity: evidenceDiversity(store, board.id, t.evidence || []),
      missingDependencies: t.dependsOn.filter(
        (id) =>
          !board.tasks.some(
            (d) => d.id === id && d.status === 'done' && d.verification?.status !== 'stale',
          ),
      ),
      verification: t.verification?.status ?? 'not-recorded',
      evidenceEventIds: (t.evidence || []).slice(-8),
    })),
    artifacts: projection.selected.flatMap((t) =>
      (t.artifacts || []).slice(0, 8).map((path) => ({
        taskId: t.id,
        path,
        declared: true,
        verification: t.verification?.status ?? 'not-recorded',
        stampAvailable: !!t.verification?.stamp,
      })),
    ),
    messages: messages.slice(-12).map((m) => ({
      id: m.id,
      sender: m.sender,
      sequence: m.sequence,
      text: String(m.text).slice(0, 1600),
      truncated: String(m.text).length > 1600,
      trust: 'untrusted-member-content',
    })),
    counts: {
      tasks: board.tasks.length,
      omittedTasks: projection.omitted,
      messages: messages.length,
      omittedMessages: Math.max(0, messages.length - 12),
    },
    unresolvedEffectCount: store.unknownEffects(run.conversationId).length,
    unresolvedEffects: store
      .unknownEffects(run.conversationId)
      .slice(0, 20)
      .map((e) => ({ id: e.id, tool: e.tool })),
    note: 'Artifact declarations/stamps are historical observations, not a fresh filesystem check. Read the full task acceptance criteria and current versions before verification or merge.',
  };
}
