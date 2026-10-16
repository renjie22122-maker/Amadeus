import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextBudget,
  sampleContext,
  splitSummaryText,
  textUnits,
} from '../server/core/context-budget.js';
import type { Profile, ModelMessage } from '../shared/types.js';
const p = {
  transport: 'openai-chat',
  baseUrl: 'https://example.com',
  model: 'test',
  contextWindow: 1048576,
  maxOutputTokens: 8192,
} as Profile;
test('measured context stays at 10 percent rather than character-based premature compaction', () => {
  const m: ModelMessage[] = [{ role: 'user', content: 'abcdef '.repeat(60000) }];
  const s = sampleContext(m, [], p, 108646),
    b = contextBudget(m, [], p, 0.75, s);
  assert.equal(b.tokens, 108646);
  assert.equal(b.method, 'measured');
  assert.equal(b.threshold, 786432);
  assert.ok(b.tokens < b.threshold);
});
test('new content and tool schemas count; measurement is invalidated on model change', () => {
  const m: ModelMessage[] = [{ role: 'user', content: 'hello '.repeat(100) }],
    s = sampleContext(m, [], p, 150);
  const appended = contextBudget(
    [...m, { role: 'tool', content: '中文'.repeat(500) }],
    [],
    p,
    0.75,
    s,
  );
  assert.ok(appended.tokens > 1000);
  assert.equal(appended.method, 'calibrated');
  const changed = contextBudget(
    m,
    [{ name: 'x', description: 'schema '.repeat(100), parameters: {}, effect: 'read' }],
    p,
    0.75,
    s,
  );
  assert.ok(changed.tokens > 150);
  assert.equal(contextBudget(m, [], { ...p, model: 'other' }, 0.75, s).method, 'estimated');
});
test('output reservation and safety margin bound trigger; multilingual summary chunks fit', () => {
  const b = contextBudget([], [], { ...p, contextWindow: 8192, maxOutputTokens: 4096 }, 0.75);
  assert.equal(b.threshold, 3840);
  const original = 'English 中文 😀 '.repeat(1000),
    chunks = splitSummaryText(original, 500);
  assert.equal(chunks.join(''), original);
  assert.ok(chunks.every((c) => textUnits(c) <= 500));
  assert.ok(chunks.length > 2);
});

test('compaction event history survives reopening storage and remains conversation scoped', async () => {
  const { Store } = await import('../server/storage/store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'compaction-history-'));
  let store = new Store(join(dir, 'db'));
  try {
    store.event('chat', 'old-run', 'context.compacted', { beforeTokens: 900, afterTokens: 100 });
    store.event('other-chat', 'other-run', 'context.compacted', {});
    store.close();
    store = new Store(join(dir, 'db'));
    const history = store.events('chat', 0, 'context.compacted');
    assert.equal(history.length, 1);
    assert.equal(history.filter((e) => e.runId === 'new-run').length, 0);
    assert.equal(history[0].data.afterTokens, 100);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
