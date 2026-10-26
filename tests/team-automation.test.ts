import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import { Teams } from '../server/services/team-space.js';
import { TaskBoard } from '../server/services/task-board.js';
import { TeamScheduler } from '../server/services/team-scheduler.js';
import { TeamAutomation, automationInput } from '../server/services/team-automation.js';
function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'team-controls-')), 'db.sqlite'));
  let clock = 100000,
    created = 0;
  const lead = {
    id: 'root',
    conversationId: 'root',
    parentRunId: null,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    depth: 0,
    modelCalls: 0,
    estimatedUsd: null,
  } as any;
  const peer = { ...lead, id: 'peer', conversationId: 'peer', parentRunId: 'root', depth: 1 };
  for (const r of [lead, peer]) {
    store.put('run', r);
    store.put('conversation', {
      id: r.conversationId,
      permission: 'read-only',
      teamMode: 'host',
      teamStrategy: 'auto',
    });
  }
  const teams = new Teams(store);
  teams.configure(lead, 'host', ['root', 'peer'], 12);
  const board = new TaskBoard(store);
  board.create(
    lead,
    [
      { id: 'a', title: 'read', dependsOn: [], acceptance: 'result' },
      { id: 'b', title: 'read', dependsOn: [], acceptance: 'result' },
    ],
    0,
  );
  const scheduler = new TeamScheduler(store);
  scheduler.configure(lead, ['peer'], 1, true);
  const service = new TeamAutomation(
    store,
    {
      resume: (old, next) =>
        store.put('run', {
          ...old,
          id: next,
          recoveredFrom: old.id,
          status: 'queued',
          parentRunId: old.parentRunId || old.id,
        }),
      spawn: async (source) => {
        const next = {
          ...peer,
          id: 'scale-' + ++created,
          conversationId: 'scale-' + created,
          createdAt: clock,
          parentRunId: source.id,
        };
        store.put('conversation', {
          id: next.conversationId,
          permission: 'read-only',
          teamMode: 'host',
          teamStrategy: 'auto',
        });
        store.put('run', next);
        return next.id;
      },
      stop: (key) => {
        store.put('run', { ...store.get<any>('run', key), status: 'interrupted' });
      },
    },
    () => clock,
  );
  return {
    store,
    lead,
    peer,
    teams,
    board,
    scheduler,
    service,
    setTime: (n: number) => (clock = n),
  };
}
const policy = (input: any) => automationInput.parse({ enabled: true, ...input });
test('recovery maps unfinished ownership once; unknown side effects and unsettled coordination block it', () => {
  const f = setup();
  try {
    f.scheduler.dispatch(f.lead);
    f.store.put('run', { ...f.peer, status: 'interrupted' });
    const effect = f.store.beginEffect('peer', 'run_command', { command: 'write' });
    assert.equal(f.service.plan(f.peer).eligible, false);
    assert.throws(() => f.service.recover(f.peer), /Unknown/);
    f.store.endEffect(effect, 'done');
    f.store.event('peer', 'peer', 'tool.started', { callId: 'spawn', name: 'spawn_agent' });
    assert.equal(f.service.plan(f.peer).eligible, false);
    f.store.event('peer', 'peer', 'tool.completed', {
      callId: 'spawn',
      name: 'spawn_agent',
      output: 'known',
    });
    const next = f.service.recover(f.store.get<any>('run', 'peer'));
    assert.equal(f.service.recover(f.peer).id, next.id);
    assert.equal(f.board.get(f.lead).tasks[0].owner, next.id);
    assert.ok(f.teams.get(f.lead)!.members.includes(next.id));
    assert.ok(!f.teams.get(f.lead)!.members.includes('peer'));
  } finally {
    f.store.close();
  }
});
test('automatic recovery honors readonly, attempt limit and manual hold', async () => {
  const f = setup();
  try {
    f.service.configure(f.lead, policy({ autoRecover: true, maxRecoveries: 1 }));
    f.store.put('run', { ...f.peer, status: 'interrupted' });
    f.store.put('team-member-held', { id: 'peer' });
    await f.service.tick();
    assert.equal(f.store.list('team-superseded').length, 0);
    f.store.remove('team-member-held', 'peer');
    f.store.put('conversation', { id: 'peer', permission: 'ask' });
    await f.service.tick();
    assert.equal(f.store.list('team-superseded').length, 0);
    f.store.put('conversation', { id: 'peer', permission: 'read-only' });
    await f.service.tick();
    assert.equal(f.store.list('team-superseded').length, 1);
    const next = f.store.get<any>('team-superseded', 'peer').next;
    f.store.put('run', { ...f.store.get<any>('run', next), status: 'interrupted' });
    await f.service.tick();
    assert.equal(f.store.list('team-superseded').length, 1);
  } finally {
    f.store.close();
  }
});
test('autoscale obeys active, lifetime and cost limits; only idle managed workers retire', async () => {
  const f = setup();
  try {
    f.scheduler.dispatch(f.lead); // peer occupied, second task ready
    f.service.configure(
      f.lead,
      policy({ autoScale: true, maxWorkers: 2, maxNewWorkers: 1, idleSeconds: 10 }),
    );
    await f.service.tick();
    assert.ok(f.store.maybe('team-auto-worker', 'scale-1'));
    await f.service.tick();
    assert.equal(f.store.list('team-auto-worker').length, 1);
    f.scheduler.dispatch(f.lead);
    const evidence = f.store.event('scale-1', 'scale-1', 'tool.completed', {
      name: 'read_file',
      output: 'done',
    });
    f.board.update(
      f.store.get<any>('run', 'scale-1'),
      'b',
      f.board.get(f.lead).revision,
      'done',
      [evidence.id],
      'read',
    );
    f.store.put('run', {
      ...f.store.get<any>('run', 'scale-1'),
      status: 'waiting_children',
      updatedAt: 1,
    });
    f.store.put('team-worker-ready', { id: 'scale-1' });
    f.setTime(200000);
    await f.service.tick();
    assert.ok(f.store.maybe('team-retired', 'scale-1'));
    assert.equal(f.store.get<any>('run', 'peer').status, 'running');
    await f.service.tick();
    assert.equal(f.store.list('team-auto-worker').length, 1);
  } finally {
    f.store.close();
  }
});
test('unknown billing blocks costly starts, election uses current revision and never changes permissions', async () => {
  const f = setup();
  try {
    f.scheduler.dispatch(f.lead);
    f.service.configure(f.lead, policy({ autoScale: true, costLimitUsd: 1, autoElect: true }));
    f.store.put('run', { ...f.lead, status: 'failed', modelCalls: 1, estimatedUsd: null });
    await f.service.tick();
    const t = f.teams.get(f.peer)!;
    assert.equal(t.roles.coordinator, 'peer');
    assert.equal(t.term, 1);
    assert.equal(f.store.list('team-auto-worker').length, 0);
    assert.equal(f.store.get<any>('conversation', 'peer').permission, 'read-only');
    f.service.elect(f.lead);
    assert.equal(f.teams.get(f.peer)!.term, 1);
    assert.throws(
      () => f.teams.handoff(f.lead, 'coordinator', 'peer', t.revision, 'stale authority'),
      /role/,
    );
  } finally {
    f.store.close();
  }
});
test('crash after recording a replacement reconciles without another model start', () => {
  const f = setup();
  try {
    f.store.put('run', { ...f.peer, status: 'interrupted' });
    f.store.put('run', { ...f.peer, id: 'replacement', status: 'interrupted' });
    f.store.put('team-control-operation', {
      id: 'reservation',
      root: 'root',
      kind: 'recovery',
      previous: 'peer',
      next: 'replacement',
      state: 'reserved',
    });
    f.service.reconcile();
    f.service.reconcile();
    assert.equal(f.store.get<any>('team-superseded', 'peer').next, 'replacement');
    assert.equal(f.store.get<any>('team-control-operation', 'reservation').state, 'completed');
    assert.equal(f.store.runs().length, 3);
  } finally {
    f.store.close();
  }
});

test('reserved scaling is reconciled by unique ticket rather than spawning again', () => {
  const f = setup();
  try {
    f.store.put('run', {
      ...f.peer,
      id: 'already-spawned',
      conversationId: 'spawned',
      controlTicket: 'ticket-123',
    });
    f.store.put('conversation', {
      id: 'spawned',
      title: 'ticket-123: Host-managed worker',
      permission: 'read-only',
    });
    f.store.put('team-control-operation', {
      id: 'ticket-123',
      root: 'root',
      kind: 'scale',
      state: 'reserved',
    });
    f.service.reconcileScaling();
    f.service.reconcileScaling();
    assert.equal(f.store.get<any>('team-control-operation', 'ticket-123').next, 'already-spawned');
    assert.equal(f.teams.get(f.lead)!.members.filter((k) => k === 'already-spawned').length, 1);
    assert.equal(f.store.runs().length, 3);
  } finally {
    f.store.close();
  }
});
test('a later conversation run blocks revival of an obsolete task', () => {
  const f = setup();
  try {
    f.store.put('run', { ...f.peer, status: 'interrupted' });
    f.store.put('run', { ...f.peer, id: 'new-question', status: 'completed', createdAt: 2000 });
    const p = f.service.plan(f.store.get<any>('run', 'peer'));
    assert.equal(p.eligible, false);
    assert.match(p.blockers.join(' '), /advanced/);
  } finally {
    f.store.close();
  }
});

test('recovery rebinds descendants and copy ownership while preserving the team root', () => {
  const f = setup();
  try {
    f.store.put('run', { ...f.peer, id: 'grandchild', parentRunId: 'peer' });
    f.store.put('isolation', { id: 'copy', parentRunId: 'peer', state: 'ready' });
    const next = { ...f.peer, id: 'replacement' };
    f.store.put('run', next);
    f.service.bind(f.peer, next);
    assert.equal(f.store.get<any>('run', 'grandchild').parentRunId, 'replacement');
    assert.equal(f.store.get<any>('isolation', 'copy').parentRunId, 'replacement');
    assert.equal(f.teams.get(next)!.id, 'root');
  } finally {
    f.store.close();
  }
});
test('idle retirement uses cumulative idle time across wait cycles', async () => {
  const f = setup();
  try {
    f.store.put('task-board', { id: 'root', revision: 1, tasks: [] });
    f.store.put('run', { ...f.peer, status: 'waiting_children', updatedAt: 99000 });
    f.store.put('team-auto-worker', { id: 'peer' });
    f.store.put('team-worker-ready', { id: 'peer' });
    f.store.put('team-worker-idle', { id: 'peer', since: 1 });
    f.service.configure(f.lead, policy({ idleSeconds: 90, autoScale: true }));
    await f.service.tick();
    assert.equal(f.store.get<any>('run', 'peer').status, 'interrupted');
  } finally {
    f.store.close();
  }
});

// Historical checkpoint corruption must not block status-only maintenance.
test('maintenance skips checkpoint payloads and recovery planning for completed members', async () => {
  const { store, lead, peer, service } = setup();
  try {
    for (const run of [lead, peer]) store.put('run', { ...run, status: 'completed' });
    service.configure(
      lead,
      automationInput.parse({ enabled: true, autoRecover: true, autoElect: true }),
    );
    store.db.prepare("UPDATE run_checkpoints SET data='invalid payload'").run();
    service.plan = () => {
      throw Error('Completed runs must not be recovery-planned');
    };
    await service.tick();
  } finally {
    store.close();
  }
});
