import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { ConversationTitles, shortTitle } from '../server/services/conversation-titles.js';

function fixture(t: any, reply: (req: any) => Promise<any>) {
  const dir = mkdtempSync(join(tmpdir(), 'titles-'));
  const store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('conversation', {
    id: 'c',
    title: 'temporary',
    parentId: null,
    titleGeneration: { runId: 'r', state: 'pending' },
  });
  store.put('run', {
    id: 'r',
    conversationId: 'c',
    profileId: 'p',
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    modelCalls: 0,
    estimatedUsd: null,
  });
  store.event('c', 'r', 'user.message', { text: 'Help me plan a coherent film adaptation.' });
  store.event('c', 'r', 'assistant.message', { text: 'We planned scenes and reference assets.' });
  const titles = new ConversationTitles(
    store,
    () => ({ efforts: ['none'], prices: { input: null, output: null, cached: null } }) as any,
    () => ({ complete: reply }),
  );
  return { store, titles };
}
const result = {
  message: { role: 'assistant', content: 'Film adaptation planning' },
  usage: { input: 20, output: 4, cached: 0, measured: true },
};
test('summarizes once without tools and accounts usage', async (t) => {
  let calls = 0;
  const { store, titles } = fixture(t, async (req) => {
    calls++;
    assert.deepEqual(req.tools, []);
    assert.match(req.messages[1].content, /reference assets/);
    return result;
  });
  await titles.generate('r');
  await titles.generate('r');
  assert.equal(calls, 1);
  assert.equal(store.get<any>('conversation', 'c').title, 'Film adaptation planning');
  assert.equal(store.get<any>('run', 'r').modelCalls, 1);
});
test('manual rename during pending generation wins even with same title', async (t) => {
  const { store, titles } = fixture(t, async () => {
    const c = store.get<any>('conversation', 'c');
    store.put('conversation', { ...c, titleGeneration: { runId: 'r', state: 'manual' } });
    return result;
  });
  await titles.generate('r');
  assert.equal(store.get<any>('conversation', 'c').title, 'temporary');
});
test('failure preserves title and does not retry or alter task status', async (t) => {
  let calls = 0;
  const { store, titles } = fixture(t, async () => {
    calls++;
    throw new Error('offline');
  });
  await assert.rejects(titles.generate('r'));
  await titles.generate('r');
  assert.equal(calls, 1);
  assert.equal(store.get<any>('conversation', 'c').title, 'temporary');
  assert.equal(store.get<any>('run', 'r').status, 'completed');
});
test('child and unsuccessful runs are not renamed', async (t) => {
  const { store, titles } = fixture(t, async () => {
    throw new Error('must not call');
  });
  const run = store.get<any>('run', 'r');
  store.put('run', { ...run, parentRunId: 'parent' });
  await titles.generate('r');
  store.put('run', { ...run, status: 'failed' });
  await titles.generate('r');
  assert.equal(store.get<any>('conversation', 'c').titleGeneration.state, 'pending');
});
test('temporary title bounds Unicode and removes formatting', () => {
  assert.equal(shortTitle('## Hello **world**'), 'Hello world');
  assert.equal(Array.from(shortTitle('😀'.repeat(80))).length, 32);
});
