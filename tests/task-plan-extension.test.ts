import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { TaskBoard } from '../server/services/task-board.js';
test('new requirements extend a revisioned plan without resetting completed work', () => {
  const store = new Store(':memory:');
  const run: any = {
    id: 'lead',
    conversationId: 'chat',
    parentRunId: null,
    status: 'running',
    depth: 0,
  };
  store.put('run', run);
  store.put('conversation', { id: 'chat', permission: 'ask' });
  const board = new TaskBoard(store);
  const initial = board.create(
    run,
    [{ id: 'a', title: 'Inspect', acceptance: 'Read source', dependsOn: [] }],
    0,
  );
  const ev = store.event('chat', 'lead', 'tool.completed', { name: 'read_file', output: 'source' });
  const done = board.update(run, 'a', initial.revision, 'done', [ev.id], 'read');
  const next = board.extend(
    run,
    [{ id: 'b', title: 'New requirement', acceptance: 'Check new behavior', dependsOn: ['a'] }],
    done.revision,
  );
  assert.deepEqual(next.tasks[0], JSON.parse(JSON.stringify(done.tasks[0])));
  assert.equal(next.tasks[1].status, 'pending');
  assert.equal(next.revision, done.revision + 1);
  assert.throws(() =>
    board.extend(run, [{ id: 'c', title: 'c', acceptance: 'c', dependsOn: [] }], done.revision),
  );
  assert.throws(() =>
    board.extend(
      run,
      [{ id: 'a', title: 'replace', acceptance: 'x', dependsOn: [] }],
      next.revision,
    ),
  );
  assert.throws(() =>
    board.extend(
      run,
      [{ id: 'c', title: 'c', acceptance: 'c', dependsOn: ['missing'] }],
      next.revision,
    ),
  );
  assert.equal(board.get(run).tasks.length, 2);
  store.close();
});
