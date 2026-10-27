import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { reorganizeMemories } from '../server/services/memory-reorganization.js';
import type { Conversation, Memory, Profile } from '../shared/types.js';
const profile = { id: 'test', model: 'test', baseUrl: 'https://model.example' } as Profile;
const reply = (items: any[]) => ({
  message: { role: 'assistant' as const, content: JSON.stringify({ items }) },
  usage: { input: 1, output: 1, cached: 0, measured: true },
});
async function fixture() {
  const store = new Store(
    join(await mkdtemp(join(tmpdir(), 'memory-reorganization-')), 'db.sqlite'),
  );
  const c = { id: 'chat', projectId: null, remoteChatOnly: true } as Conversation;
  store.put('conversation', c);
  const source = store.event(c.id, null, 'chat.memory-source', {
    senderId: 'B',
    text: 'I have a PS3 controller.',
  });
  store.event(c.id, null, 'chat.memory-source', { senderId: 'A', text: 'That colour is ugly.' });
  const life = new MemoryLifecycle(store);
  const add = (id: string, patch: Partial<Memory> = {}) =>
    life.create({
      id,
      scope: 'chat:chat',
      content: 'A owns a PS3 controller',
      source: `chat:chat#event:${source.id}`,
      sourceConversationId: c.id,
      sourceEventId: source.id,
      active: true,
      automatic: true,
      kind: 'fact',
      chatSubject: 'participant',
      expiresAt: null,
      revision: 1,
      createdAt: Date.now(),
      ...patch,
    });
  const run = (complete: any, authorized = () => true) =>
    reorganizeMemories(
      store,
      c,
      profile,
      { complete },
      new AbortController().signal,
      authorized,
      () => false,
      life,
    );
  const evidence = [{ eventId: source.id, quote: 'I have a PS3 controller.' }];
  return { store, c, source, life, add, run, evidence };
}
test('old active memory is corrected using speaker context, preserves history and is not reviewed twice', async () => {
  const f = await fixture();
  try {
    f.add('old');
    let calls = 0;
    const provider = async (req: any) => {
      calls++;
      const x = JSON.parse(req.messages[1].content).items[0];
      assert.equal(x.context[0].sender, 'B');
      assert.equal(x.context[1].sender, 'A');
      return reply([
        {
          id: 'old',
          action: 'revise',
          reason: 'wrong speaker',
          content: 'B owns a PS3 controller.',
          evidence: f.evidence,
        },
      ]);
    };
    await f.run(provider);
    await f.run(provider);
    assert.equal(calls, 1);
    assert.equal(f.store.get<Memory>('memory', 'old').content, 'B owns a PS3 controller.');
    assert.equal(f.store.get<Memory>('memory', 'old').sourceEventId, f.source.id);
    assert.ok(
      f.store
        .list<any>('memory-history')
        .some(
          (h) =>
            h.before?.content === 'A owns a PS3 controller' &&
            h.after.content === 'B owns a PS3 controller.',
        ),
    );
  } finally {
    f.store.close();
  }
});
test('history-only and uncertain records are held without deletion or reactivation', async () => {
  const f = await fixture();
  try {
    f.add('history');
    f.add('uncertain');
    await f.run(async () =>
      reply(
        ['history', 'uncertain'].map((id) => ({
          id,
          action: id,
          reason: 'not reusable or uncertain',
          evidence: f.evidence,
        })),
      ),
    );
    for (const id of ['history', 'uncertain']) {
      assert.equal(f.store.get<Memory>('memory', id).active, false);
      assert.ok(
        f.store
          .list<any>('memory-history')
          .some((h) => h.memoryId === id && h.before?.active === true),
      );
    }
    assert.equal(
      await f.run(async () => {
        throw Error('must not run');
      }),
      false,
    );
  } finally {
    f.store.close();
  }
});
test('merge retains donor and all source references; no merge across audience boundaries', async () => {
  const f = await fixture();
  try {
    f.add('one');
    f.add('two');
    await f.run(async () =>
      reply([
        { id: 'one', action: 'keep', reason: 'useful', evidence: [] },
        { id: 'two', action: 'merge', targetId: 'one', reason: 'same fact', evidence: f.evidence },
      ]),
    );
    assert.equal(f.store.get<Memory>('memory', 'two').duplicateOf, 'one');
    assert.equal(f.store.get<Memory>('memory', 'two').active, false);
    assert.ok(f.store.get<Memory>('memory', 'one').sourceRefs?.length);
  } finally {
    f.store.close();
  }
});
test('manual, other chat, excluded and expired records never enter model input', async () => {
  const f = await fixture();
  try {
    f.add('ok');
    f.add('manual', { automatic: false });
    f.add('inactive', { active: false });
    f.add('expired', { expiresAt: 1 });
    f.add('other', { sourceConversationId: 'elsewhere' });
    await f.run(async (req: any) => {
      assert.deepEqual(
        JSON.parse(req.messages[1].content).items.map((x: any) => x.memory.id),
        ['ok'],
      );
      return reply([{ id: 'ok', action: 'keep', reason: 'good', evidence: [] }]);
    });
  } finally {
    f.store.close();
  }
});
test('source mutation, revoked authorization, invented quotes and duplicate decisions cannot apply', async () => {
  for (const mode of ['mutation', 'authorization', 'quote', 'duplicate']) {
    const f = await fixture();
    try {
      f.add('old');
      let authorized = true;
      await f.run(
        async () => {
          if (mode === 'mutation')
            f.life.update('old', { content: 'manual replacement', automatic: false }, 1);
          if (mode === 'authorization') authorized = false;
          const d = {
            id: 'old',
            action: 'revise',
            reason: 'correction',
            content: 'bad replacement',
            evidence: mode === 'quote' ? [{ eventId: f.source.id, quote: 'invented' }] : f.evidence,
          };
          return reply(mode === 'duplicate' ? [d, d] : [d]);
        },
        () => authorized,
      );
      assert.notEqual(f.store.get<Memory>('memory', 'old').content, 'bad replacement');
      assert.equal(f.store.get<any>('memory-reorganization', 'old').status, 'retry_wait');
    } finally {
      f.store.close();
    }
  }
});
test('network failures use backoff and stop after five attempts', async () => {
  const f = await fixture();
  try {
    f.add('old');
    let calls = 0;
    const provider = async () => {
      calls++;
      throw Error('network');
    };
    for (let i = 0; i < 5; i++) {
      f.store.remove('memory-reorganization-sweep', f.c.id);
      await f.run(provider);
      const r = f.store.get<any>('memory-reorganization', 'old');
      assert.equal(r.attempts, i + 1);
      f.store.put('memory-reorganization', { ...r, nextAttemptAt: 0 });
    }
    await f.run(provider);
    assert.equal(calls, 5);
    assert.equal(f.store.get<Memory>('memory', 'old').revision, 1);
  } finally {
    f.store.close();
  }
});

test('different member entities cannot merge, and ordinary project boundaries remain intact', async () => {
  const f = await fixture();
  try {
    const a = f.life.saveEntity('chat:chat', 'member A', []),
      b = f.life.saveEntity('chat:chat', 'member B', []);
    f.add('one', { entityId: a.id });
    f.add('two', { entityId: b.id });
    await f.run(async () =>
      reply([
        { id: 'one', action: 'keep', reason: 'useful', evidence: [] },
        {
          id: 'two',
          action: 'merge',
          targetId: 'one',
          reason: 'incorrect merge',
          evidence: f.evidence,
        },
      ]),
    );
    assert.equal(f.store.get<Memory>('memory', 'two').active, true);
    assert.equal(f.store.get<any>('memory-reorganization', 'two').status, 'retry_wait');
    assert.equal(f.store.get<Memory>('memory', 'one').revision, 1);
  } finally {
    f.store.close();
  }
});
