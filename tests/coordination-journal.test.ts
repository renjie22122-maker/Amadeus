import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/storage/store.js';
import { TeamAutomation } from '../server/services/team-automation.js';
import { reconcileCoordination } from '../server/services/coordination-journal.js';
import { TaskBoard } from '../server/services/task-board.js';
for (const phase of ['before', 'inside', 'after', 'legacy'])
  test('process crash coordination reconciliation: ' + phase, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'coord-crash-')), 'state.sqlite');
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('tests/fixtures/coord-crash.ts'), file, phase],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(child.status, 23, child.stderr);
    const store = new Store(file);
    try {
      store.recover();
      reconcileCoordination(store);
      reconcileCoordination(store);
      const peer = store.get<any>('run', 'peer');
      const service = new TeamAutomation(store, {
        resume: (old, next) =>
          store.put('run', { ...old, id: next, status: 'queued', createdAt: 2 }),
        spawn: async () => {
          throw Error('No spawning expected');
        },
        stop: () => {},
      });
      assert.equal(service.plan(peer).eligible, true);
      const task = new TaskBoard(store).get(peer).tasks[0];
      assert.equal(task.status, ['after', 'legacy'].includes(phase) ? 'running' : 'pending');
      assert.equal(store.events('peer').filter((e) => e.type === 'tool.completed').length, 1);
      const next = service.recover(peer);
      if (task.owner) assert.equal(new TaskBoard(store).get(peer).tasks[0].owner, next.id);
    } finally {
      store.close();
    }
  });
test('missing evidence for legacy coordination remains blocked', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'coord-negative-')), 'state.sqlite');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('tests/fixtures/coord-crash.ts'), file, 'legacy'],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(child.status, 23);
  const store = new Store(file);
  try {
    const board = store.get<any>('task-board', 'root');
    board.revision++;
    store.put('task-board', board);
    store.recover();
    reconcileCoordination(store);
    assert.equal(store.events('peer').filter((e) => e.type === 'tool.completed').length, 0);
  } finally {
    store.close();
  }
});
test('rolled back nested transaction publishes no events', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'coord-tx-')), 'state.sqlite'));
  const events: any[] = [];
  store.onEvent = (e) => events.push(e);
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.transaction(() => store.event('c', 'r', 'test', {}));
        throw Error('rollback');
      }),
    );
    assert.equal(events.length, 0);
    assert.equal(store.events('c').length, 0);
    store.transaction(() => store.transaction(() => store.event('c', 'r', 'test', {})));
    assert.equal(events.length, 1);
  } finally {
    store.close();
  }
});

test('background reconciliation only decodes outstanding tool starts', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'coord-index-')), 'state.sqlite'));
  try {
    store.put('run', { id: 'r', conversationId: 'c', status: 'interrupted', createdAt: 1 } as any);
    store.event('c', 'r', 'tool.started', { callId: 'done', name: 'read_file' });
    store.event('c', 'r', 'tool.completed', { callId: 'done', output: 'x'.repeat(1000000) });
    store.event('c', 'r', 'tool.started', { callId: 'unknown', name: 'run_command' });
    store.eventsForRun = () => {
      throw Error('Must not load completed outputs');
    };
    reconcileCoordination(store);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM events WHERE type='tool.completed'").get()!.n,
      1,
    );
    const plan = store.db
      .prepare("EXPLAIN QUERY PLAN SELECT run_id FROM events WHERE type='tool.started'")
      .all();
    assert.match(JSON.stringify(plan), /events_tool_started/);
  } finally {
    store.close();
  }
});
