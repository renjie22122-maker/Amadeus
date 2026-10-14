import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../server/storage/store.js';
import { Teams } from '../server/services/team-space.js';
import { TeamAutomation, automationInput } from '../server/services/team-automation.js';
import { DelegationManager } from '../server/core/delegation-manager.js';
import { TeamCoordinator } from '../server/core/team-coordinator.js';
function fixture() {
  const store = new Store(':memory:');
  const bus = new EventEmitter();
  store.onEvent = (e) => bus.emit('event', e);
  const lead: any = {
    id: 'lead',
    conversationId: 'lead',
    parentRunId: null,
    status: 'running',
    depth: 0,
    createdAt: 1,
  };
  store.put('run', lead);
  store.put('conversation', { id: 'lead', teamMode: 'creative', teamStrategy: 'auto' });
  const child = (id: string, parent = 'lead') => {
    const r = { ...lead, id, conversationId: id, parentRunId: parent, depth: 1 };
    store.put('run', r);
    store.put('conversation', { id, teamMode: 'creative', teamStrategy: 'auto' });
    return r;
  };
  return { store, bus, lead, child, teams: new Teams(store) };
}
test('explicit pre-created team enrolls peers; ordinary and fixed-roster children are unchanged', () => {
  const f = fixture();
  try {
    const a = f.child('a');
    f.teams.enrollSpawn(f.lead, a);
    assert.equal(f.teams.get(a), undefined);
    f.teams.configure(f.lead, 'creative', ['lead', 'a'], 8);
    const b = f.child('b');
    f.teams.enrollSpawn(f.lead, b);
    assert(!f.teams.get(f.lead)!.members.includes('b'));
    f.store.remove('team-space', 'lead');
    f.store.put('run', { ...a, status: 'completed' });
    f.store.put('run', { ...b, status: 'completed' });
    f.teams.configure(f.lead, 'creative', ['lead'], 8, true);
    const c = f.child('c');
    f.teams.enrollSpawn(f.lead, c);
    const d = f.child('d');
    f.teams.enrollSpawn(f.lead, d);
    f.teams.post(c, 'Evidence question', ['d']);
    assert.equal(f.teams.messages(d)[0].text, 'Evidence question');
    assert.throws(() => f.teams.updateLimits(c, 20), /coordinator/);
    f.teams.updateLimits(f.lead, 20);
    assert.equal(f.teams.project(c)!.discussionBudget.remaining, 19);
    assert.throws(() => f.teams.post(c, 'private', ['unrelated']), /Recipients/);
  } finally {
    f.store.close();
  }
});
test('automation policy can be saved before team creation and emits refresh event', () => {
  const f = fixture();
  try {
    const service = new TeamAutomation(f.store, {} as any);
    const saved = service.configure(
      f.lead,
      automationInput.parse({ enabled: true, autoRecover: true }),
    );
    assert.equal(saved.enabled, true);
    assert.equal(f.teams.get(f.lead), undefined);
    assert(f.store.events('lead').some((e) => e.type === 'team.control'));
  } finally {
    f.store.close();
  }
});
test('new steering wakes child wait, leaves child running, and releases listeners', async () => {
  const f = fixture();
  const a = f.child('a');
  try {
    const manager = new DelegationManager(f.store, {} as any, '', f.bus, { pump: () => {} } as any);
    const pending = manager.wait(f.lead, [a.id], new AbortController().signal);
    assert.equal(f.store.get<any>('run', 'lead').status, 'waiting_children');
    f.store.put('user-inbox', { id: 'x', runId: 'lead', state: 'pending' });
    f.bus.emit('event', {});
    const result = await pending;
    assert.equal(result[0].waitReason, 'input_pending');
    assert.equal(f.store.get<any>('run', 'a').status, 'running');
    assert.equal(f.store.get<any>('run', 'lead').status, 'running');
    assert.equal(f.bus.listenerCount('event'), 0);
    assert.equal(f.bus.listenerCount('finished'), 0);
  } finally {
    f.store.close();
  }
});
test('discussion and assignment waits accept new input without requiring a team message', async () => {
  const f = fixture();
  try {
    const service = new TeamCoordinator(f.store, { events: f.bus, pump: () => {} } as any);
    const pending = service.awaitDiscussion(f.lead, new AbortController().signal);
    f.store.put('user-inbox', { id: 'x', runId: 'lead', state: 'pending' });
    f.bus.emit('event', {});
    assert.equal(((await pending) as any).status, 'input_pending');
    assert.equal(f.bus.listenerCount('event'), 0);
    const a = f.child('a');
    const next = service.awaitAssignment(a, new AbortController().signal);
    f.store.put('user-inbox', { id: 'y', runId: 'a', state: 'pending' });
    f.bus.emit('event', {});
    assert.equal(((await next) as any).status, 'input_pending');
    assert.equal(f.bus.listenerCount('event'), 0);
  } finally {
    f.store.close();
  }
});

test('automatic organization accepts either team kind while explicit hierarchy and off remain binding', () => {
  for (const preference of [undefined, 'auto', 'hierarchy', 'host', 'creative']) {
    for (const mode of ['host', 'creative'] as const) {
      const f = fixture();
      try {
        f.store.put('conversation', { id: 'lead', teamMode: preference, teamStrategy: 'auto' });
        if (
          preference === 'hierarchy' ||
          (preference === 'host' && mode === 'creative') ||
          (preference === 'creative' && mode === 'host')
        ) {
          assert.throws(
            () =>
              f.teams.configure(f.lead, mode, ['lead'], 12, true, 'Task-specific evidence review'),
            /Select this team mode/,
          );
        } else {
          const t = f.teams.configure(
            f.lead,
            mode,
            ['lead'],
            12,
            true,
            'Task-specific evidence review',
          );
          assert.equal(t.selection?.reason, 'Task-specific evidence review');
          assert.equal(t.selection?.by, !preference || preference === 'auto' ? 'agent' : 'user');
        }
      } finally {
        f.store.close();
      }
    }
  }
  const f = fixture();
  try {
    f.store.put('conversation', { id: 'lead', teamMode: 'auto', teamStrategy: 'off' });
    assert.throws(
      () => f.teams.configure(f.lead, 'creative', ['lead'], 12, true),
      /Select this team mode/,
    );
  } finally {
    f.store.close();
  }
});

test('roster updates preserve discussion, require coordinator/current revision and reject foreign members', () => {
  const f = fixture();
  try {
    const a = f.child('a');
    f.teams.configure(f.lead, 'creative', ['lead', 'a'], 8);
    f.teams.post(a, 'Original evidence', ['lead']);
    assert.throws(() => f.teams.updateRoster(a, 1, true), /coordinator/);
    assert.throws(() => f.teams.updateRoster(f.lead, 99, true), /revision/);
    const t = f.teams.updateRoster(f.lead, 1, true);
    assert.equal(t!.messages[0].text, 'Original evidence');
    const b = f.child('b');
    f.teams.enrollSpawn(f.lead, b);
    assert(f.teams.get(f.lead)!.members.includes('b'));
    f.store.put('run', { ...b, id: 'foreign', parentRunId: null });
    assert.throws(() => f.teams.updateRoster(f.lead, 3, true, ['foreign']), /task tree/);
  } finally {
    f.store.close();
  }
});

test('topic groups route only to their members, retain global budgets and survive continuation', () => {
  const f = fixture();
  try {
    const a = f.child('a'),
      b = f.child('b'),
      c = f.child('c');
    f.teams.configure(f.lead, 'creative', ['lead', 'a', 'b', 'c'], 1, true);
    f.teams.configureGroup(f.lead, 1, {
      id: 'topic',
      title: 'Independent question',
      purpose: 'Test alternatives',
      members: ['a', 'b'],
    });
    const message = f.teams.post(a, 'Evidence for this topic', [], 'topic');
    assert.deepEqual(message.recipients, ['b']);
    assert.equal(f.teams.messages(c).length, 0);
    assert.equal(f.teams.messages(b).length, 1);
    assert.throws(() => f.teams.post(c, 'intrude', [], 'topic'), /group/);
    assert.throws(() => f.teams.post(a, 'over budget', [], 'topic'), /limit/);
    f.store.put('run', { ...b, status: 'completed' });
    const next = { ...b, id: 'b2' };
    f.store.put('run', next);
    f.teams.enrollSpawn(f.lead, next);
    assert.deepEqual(f.teams.get(f.lead)!.groups![0].members, ['a', 'b2']);
    assert.deepEqual(f.teams.messages(a)[0].recipients, ['b']);
  } finally {
    f.store.close();
  }
});
