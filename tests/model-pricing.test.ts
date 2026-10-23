import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPricing, scheduledRate } from '../shared/model-pricing.js';
import type { Profile } from '../shared/types.js';
const p = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  prices: { input: null, output: null, cached: null },
} as Profile;
test('official catalog is origin/model/date scoped, manual rates always win', () => {
  const at = Date.parse('2026-10-23T02:00:00Z');
  assert.equal(modelPricing(p, at).prices.input, 0.3);
  assert.equal(modelPricing(p, Date.parse('2026-10-23T12:00:00Z')).prices.input, 0.15);
  assert.equal(modelPricing(p, Date.parse('2026-10-24T02:00:00Z')).prices.input, 0.15);
  for (const override of [{ baseUrl: 'https://api.deepseek.com.evil.test' }, { model: 'other' }])
    assert.equal(modelPricing({ ...p, ...override }, at).prices.input, null);
  assert.equal(modelPricing(p, Date.parse('2026-11-24')).prices.input, null);
  assert.equal(
    modelPricing({ ...p, prices: { input: 0, output: 0, cached: 0 } }, at).prices.input,
    0,
  );
  assert.equal(
    modelPricing({ ...p, prices: { input: 2, output: null, cached: null } }, at).prices.output,
    null,
  );
});

test('generic schedules handle boundaries, holidays and overnight windows', () => {
  const rule = {
    weekdays: [1, 2, 3, 4, 5],
    utcWindows: [[60, 240]] as [number, number][],
    offPeakMultiplier: 0.5,
    holidayTimeZone: 'Asia/Shanghai',
    holidays: [['2026-10-01', '2026-10-07']] as [string, string][],
  };
  assert.equal(scheduledRate(rule, Date.parse('2026-10-23T00:59Z')).band, 'off-peak');
  assert.equal(scheduledRate(rule, Date.parse('2026-10-23T01:00Z')).band, 'peak');
  assert.equal(scheduledRate(rule, Date.parse('2026-10-23T04:00Z')).band, 'off-peak');
  assert.equal(scheduledRate(rule, Date.parse('2026-10-01T02:00Z')).holiday, true);
  assert.equal(
    scheduledRate({ ...rule, utcWindows: [[1380, 60]] }, Date.parse('2026-10-23T00:30Z')).band,
    'peak',
  );
});

test('run accounting snapshots each request band and never backfills unknown usage', async () => {
  const { Store } = await import('../server/storage/store.js');
  const { accountModelUsage } = await import('../server/core/model-session.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pricing-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const run = {
    id: 'r',
    conversationId: 'c',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    modelCalls: 0,
    estimatedUsd: 0,
  } as import('../shared/types.js').Run;
  try {
    const usage = { input: 1000000, output: 100000, cached: 500000, measured: true };
    accountModelUsage(store, run, usage, p, 'one', Date.parse('2026-10-23T02:00Z'));
    assert.ok(Math.abs(run.estimatedUsd! - 0.273) < 1e-9);
    accountModelUsage(store, run, usage, p, 'two', Date.parse('2026-10-23T12:00Z'));
    assert.ok(Math.abs(run.estimatedUsd! - 0.4095) < 1e-9);
    assert.deepEqual(run.priceBands, ['peak', 'off-peak']);
    assert.equal(run.cachedTokens / run.inputTokens, 0.5);
    const ledger = store.db.prepare('SELECT data FROM ledger WHERE request_id=?').get('one') as {
      data: string;
    };
    assert.equal(JSON.parse(ledger.data).pricing.basis, 'peak');
    accountModelUsage(store, run, { ...usage, measured: false }, p, 'three');
    assert.equal(run.estimatedUsd, null);
    accountModelUsage(store, run, usage, p, 'four');
    assert.equal(run.estimatedUsd, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
