import { randomUUID } from 'node:crypto';
const executionEpoch = randomUUID();
import type { Run, ToolResult } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { terminal } from '../core/lifecycle.js';
import { TaskBoard } from './task-board.js';
export interface CoordinationReceipt {
  id: string;
  runId: string;
  callId: string;
  tool: string;
  args: Record<string, any>;
  state: 'prepared' | 'completed' | 'not_started';
  atomic: boolean;
  epoch?: string;
  result?: string;
}
export const receiptId = (runId: string, callId: string) => runId + ':' + callId;
export function prepareCoordination(
  store: Store,
  run: Run,
  callId: string,
  tool: string,
  args: Record<string, any>,
  atomic: boolean,
) {
  const id = receiptId(run.id, callId),
    previous = store.maybe<CoordinationReceipt>('coordination-receipt', id);
  if (previous) {
    if (previous.tool !== tool || JSON.stringify(previous.args) !== JSON.stringify(args))
      throw new Error('Coordination call identity was reused with different arguments.');
    return previous;
  }
  return store.put<CoordinationReceipt>('coordination-receipt', {
    id,
    runId: run.id,
    callId,
    tool,
    args,
    state: 'prepared',
    atomic,
    epoch: executionEpoch,
  });
}
export function commitCoordination(
  store: Store,
  receipt: CoordinationReceipt,
  fn: () => ToolResult,
): ToolResult {
  return store.transaction(() => {
    const result = fn();
    if (result && typeof (result as any).then === 'function')
      throw new Error('Atomic coordination cannot await.');
    store.put('coordination-receipt', { ...receipt, state: 'completed', result: result.content });
    return result;
  });
}
export function reconcileCoordination(store: Store, onlyRun?: Run) {
  const candidates = onlyRun
    ? [onlyRun]
    : (
        store.db
          .prepare(
            `SELECT DISTINCT s.run_id FROM events s WHERE s.type='tool.started' AND NOT EXISTS(SELECT 1 FROM events c WHERE c.run_id=s.run_id AND c.type='tool.completed' AND json_extract(c.data,'$.callId')=json_extract(s.data,'$.callId'))`,
          )
          .all() as { run_id: string }[]
      ).map((r) => store.runHeader(r.run_id));
  for (const run of candidates.filter((r) => terminal(r.status))) {
    // Resolve outstanding calls directly. Completed outputs can be very large and
    // must not be decoded on every background tick.
    const pending = store.db
      .prepare(
        `SELECT s.data FROM events s WHERE s.run_id=? AND s.type='tool.started'
       AND NOT EXISTS(SELECT 1 FROM events c WHERE c.run_id=s.run_id
         AND c.type='tool.completed' AND json_extract(c.data,'$.callId')=json_extract(s.data,'$.callId'))
       ORDER BY s.id`,
      )
      .all(run.id) as { data: string }[];
    for (const row of pending) {
      const event = { data: JSON.parse(row.data) };
      const callId = event.data.callId,
        tool = event.data.name,
        args = event.data.arguments || {};
      let receipt = store.maybe<CoordinationReceipt>(
        'coordination-receipt',
        receiptId(run.id, callId),
      );
      if (receipt?.state === 'prepared' && receipt.atomic && receipt.epoch !== executionEpoch)
        receipt = store.put<CoordinationReceipt>('coordination-receipt', {
          ...receipt,
          state: 'not_started',
          result:
            'Interrupted before atomic coordination committed. No changes from this call were committed.',
        });
      if (
        receipt?.state === 'prepared' &&
        ['spawn_agent', 'continue_agent'].includes(tool) &&
        receipt.epoch !== executionEpoch
      ) {
        const children = store
          .runMetadata()
          .filter((r) => r.parentRunId === run.id && r.controlTicket === receipt!.id);
        if (children.length === 1)
          receipt = store.put<CoordinationReceipt>('coordination-receipt', {
            ...receipt,
            state: 'completed',
            result: JSON.stringify({ runId: children[0].id, agentId: children[0].conversationId }),
          });
        if (!children.length)
          receipt = store.put<CoordinationReceipt>('coordination-receipt', {
            ...receipt,
            state: 'not_started',
            result:
              'No child run was created for this call before the service restarted. Any prepared isolated copy is retained for inspection; no child execution was replayed.',
          });
      }
      // Conservative migration for old revision-checked updates: verify the exact current result.
      if (!receipt && tool === 'update_task' && Number.isInteger(args.revision)) {
        const board = new TaskBoard(store).get(run),
          task = board.tasks.find((t) => t.id === args.id);
        if (
          task &&
          board.revision === args.revision + 1 &&
          task.status === args.status &&
          task.owner === (args.status === 'pending' ? null : run.id) &&
          task.note === (args.note || '') &&
          JSON.stringify(task.evidence) === JSON.stringify(args.evidence || [])
        ) {
          receipt = store.put<CoordinationReceipt>('coordination-receipt', {
            id: receiptId(run.id, callId),
            runId: run.id,
            callId,
            tool,
            args,
            atomic: false,
            state: 'completed',
            result:
              'Legacy reconciliation: current task revision and complete requested state match; no operation replayed. ' +
              JSON.stringify(task),
          });
        }
      }
      if (!receipt || receipt.state === 'prepared') continue;
      if (receipt.tool !== tool || JSON.stringify(receipt.args) !== JSON.stringify(args)) continue;
      store.transaction(() => {
        store.event(run.conversationId, run.id, 'tool.completed', {
          callId,
          name: tool,
          output: receipt!.result || '',
          reconciled: true,
          state: receipt!.state,
        });
        store.event(run.conversationId, run.id, 'coordination.reconciled', {
          callId,
          tool,
          state: receipt!.state,
        });
      });
    }
  }
}
