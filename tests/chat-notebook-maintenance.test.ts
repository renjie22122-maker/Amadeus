import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Configuration } from '../server/services/settings.js';
import { ChatNotebookMaintenance } from '../server/services/chat-notebook-maintenance.js';
import { chatNotebook, notebookKey, updateNotebook } from '../server/services/chat-notebook.js';
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'notebook-worker-'));
  const store = new Store(join(dir, 'db'));
  const config = new Configuration(join(dir, 'config.json'));
  config.save({
    ...config.get(),
    profiles: [
      {
        id: 'test',
        name: 'test',
        transport: 'openai-chat',
        baseUrl: 'https://model.example',
        model: 'test',
      },
    ],
    defaultProfileId: 'test',
  });
  const c: any = {
    id: 'route',
    conversationId: 'chat',
    enabled: true,
    peerId: 'group',
    peerType: 'group',
    transport: 'onebot11',
    accountId: 'bot',
    revision: 1,
  };
  store.put('chat-connection', c);
  store.put('conversation', { id: 'chat', profileId: 'test', archived: false, projectId: null });
  const add = (text = 'Please keep replies concise.', route = c) =>
    store.event(route.conversationId, null, 'chat.memory-source', {
      connectionId: route.id,
      peerId: route.peerId,
      peerType: route.peerType,
      transport: route.transport,
      accountId: route.accountId,
      senderId: 'member',
      text,
    });
  const state = () => store.maybe<any>('chat-notebook-maintenance', notebookKey(c));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, config, c, add, state, now: Date.now() + 180000 };
}
const result = (a: any) => ({
  message: { role: 'assistant' as const, content: JSON.stringify(a) },
  usage: { input: 10, output: 10, cached: 0, measured: true },
});
const changed = (e: any) =>
  result({
    changed: true,
    style: 'Brief replies preferred by member.',
    diary: 'Member asked for concise replies.',
    reason: 'Explicit request',
    evidence: [{ eventId: e.id, quote: e.data.text }],
  });
test('incremental notebook revisions survive worker restart, no-change does not create revisions, scope is isolated', async (t) => {
  const f = fixture(t),
    e = f.add();
  f.add('Foreign secret', { ...f.c, id: 'other', peerId: 'other' });
  let calls = 0;
  const worker = () =>
    new ChatNotebookMaintenance(f.store, f.config, () => ({
      complete: async (req) => {
        calls++;
        assert.ok(!req.messages[1].content.includes('Foreign secret'));
        return calls === 1
          ? changed(e)
          : result({
              changed: false,
              style: '',
              diary: '',
              reason: 'Nothing useful',
              evidence: [],
            });
      },
    }));
  await worker().tick(f.now);
  assert.equal(chatNotebook(f.store, f.c).revision, 1);
  assert.equal(f.state().status, 'updated');
  await worker().tick(f.now + 100000);
  assert.equal(calls, 1);
  f.add('okay');
  await worker().tick(f.now + 200000);
  assert.equal(calls, 2);
  assert.equal(f.state().status, 'unchanged');
  assert.equal(chatNotebook(f.store, f.c).revision, 1);
  assert.equal(f.store.events('chat', 0, 'chat.notebook.updated').length, 1);
});
test('source changes, manual edits, opt-out and route changes discard stale model results', async (t) => {
  for (const action of ['manual', 'disable', 'route', 'source']) {
    const f = fixture(t),
      e = f.add();
    const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
      complete: async () => {
        if (action === 'manual' || action === 'disable')
          updateNotebook(
            f.store,
            f.c,
            {
              revision: 0,
              style: 'Human style',
              diary: '',
              reason: 'human',
              automatic: action === 'manual',
            },
            'human',
          );
        if (action === 'route') f.store.put('chat-connection', { ...f.c, peerId: 'other' });
        if (action === 'source') f.store.db.prepare('DELETE FROM events WHERE id=?').run(e.id);
        return changed(e);
      },
    }));
    await worker.tick(f.now);
    assert.equal(f.state().status, 'pending');
    assert.notEqual(chatNotebook(f.store, f.c).author, 'bot');
  }
});
test('failures back off and stop at five attempts without advancing the cursor', async (t) => {
  const f = fixture(t);
  f.add();
  let calls = 0;
  const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
    complete: async () => {
      calls++;
      throw Error('network');
    },
  }));
  let now = f.now;
  for (let i = 0; i < 5; i++) {
    await worker.tick(now);
    await worker.tick(now);
    now = f.state().nextAt + 1;
  }
  await worker.tick(now + 999999);
  assert.equal(calls, 5);
  assert.equal(f.state().status, 'needs_attention');
  assert.equal(f.state().cursor, undefined);
});
test('invalid evidence and tool calls never modify notebook', async (t) => {
  const f = fixture(t),
    e = f.add();
  const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
    complete: async () =>
      result({
        changed: true,
        style: 'invented',
        diary: '',
        reason: 'bad',
        evidence: [{ eventId: e.id, quote: 'not present' }],
      }),
  }));
  await worker.tick(f.now);
  assert.equal(chatNotebook(f.store, f.c).revision, 0);
  assert.equal(f.state().status, 'retrying');
});
test('new arrivals during extraction remain pending without invalidating current evidence', async (t) => {
  const f = fixture(t),
    e = f.add();
  let later: any;
  const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
    complete: async () => {
      later = f.add('Next request');
      return changed(e);
    },
  }));
  await worker.tick(f.now);
  assert.equal(f.state().cursor, e.id);
  assert.ok(later.id > f.state().cursor);
  assert.equal(chatNotebook(f.store, f.c).revision, 1);
});
test('long messages advance through chunks instead of marking truncated tails processed', async (t) => {
  const f = fixture(t),
    e = f.add('a'.repeat(9000));
  const seen: number[] = [];
  const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
    complete: async (req) => {
      seen.push(JSON.parse(req.messages[1].content).messages[0].text.length);
      return result({ changed: false, style: '', diary: '', reason: 'No update', evidence: [] });
    },
  }));
  await worker.tick(f.now);
  assert.equal(f.state().offset, 4000);
  await worker.tick(f.now + 100000);
  assert.equal(f.state().offset, 8000);
  await worker.tick(f.now + 200000);
  assert.equal(f.state().offset, 0);
  assert.equal(f.state().cursor, e.id);
  assert.deepEqual(seen, [4000, 4000, 1000]);
});
test('disabled and archived chats never invoke a model', async (t) => {
  const f = fixture(t);
  f.add();
  let calls = 0;
  const worker = new ChatNotebookMaintenance(f.store, f.config, () => ({
    complete: async () => {
      calls++;
      throw Error('unexpected');
    },
  }));
  updateNotebook(
    f.store,
    f.c,
    { revision: 0, style: '', diary: '', automatic: false, reason: 'off' },
    'human',
  );
  await worker.tick(f.now);
  updateNotebook(
    f.store,
    f.c,
    { revision: 1, style: '', diary: '', automatic: true, reason: 'on' },
    'human',
  );
  f.store.put('conversation', { id: 'chat', profileId: 'test', archived: true });
  await worker.tick(f.now);
  assert.equal(calls, 0);
});
