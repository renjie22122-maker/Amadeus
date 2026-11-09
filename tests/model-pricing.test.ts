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
    assert.deepEqual(run.unreportedUsageReasons, { PROVIDER_OMITTED_USAGE: 1 });
    accountModelUsage(store, run, usage, p, 'four');
    assert.equal(run.estimatedUsd, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed requests retain safe usage reasons without inventing measured tokens', async () => {
  const { Store } = await import('../server/storage/store.js');
  const { completeModel } = await import('../server/core/model-session.js');
  const { AppError } = await import('../server/core/errors.js');
  const store = new Store(':memory:');
  const run = {
    id: 'failure',
    conversationId: 'c',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    modelCalls: 0,
    estimatedUsd: 0,
  } as import('../shared/types.js').Run;
  try {
    for (const [code, phase, expected] of [
      ['MODEL_HTTP_402', 'request', 'MODEL_HTTP_402'],
      ['MODEL_NETWORK', 'connect', 'CONNECTION_FAILED'],
      ['MODEL_TIMEOUT', 'stream', 'STREAM_INTERRUPTED'],
    ]) {
      const error = Object.assign(new AppError(code, 'private diagnostic'), { phase });
      await assert.rejects(
        completeModel(
          store,
          () => ({
            complete: async () => {
              throw error;
            },
          }),
          run,
          {
            profile: p,
            messages: [{ role: 'user', content: 'hello' }],
            tools: [],
            signal: new AbortController().signal,
            onText: () => {},
          },
        ),
      );
      assert.equal(run.unreportedUsageReasons?.[expected], 1);
    }
    assert.equal(run.usageComplete, false);
    assert.equal(run.estimatedUsd, null);
    const ledger = store.db.prepare('SELECT data FROM ledger').all() as { data: string }[];
    assert.equal(ledger.length, 3);
    for (const row of ledger) {
      assert.equal(JSON.parse(row.data).usage.measured, false);
      assert.equal(row.data.includes('private diagnostic'), false);
    }
  } finally {
    store.close();
  }
});
