import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../server/storage/store.js';
const { activity } = createRequire(import.meta.url)('../server/services/token-activity-worker.cjs');
test('activity counts ledger calls once across parent/child, handles timezone, missing usage and historical price', () => {
  const store = new Store(':memory:');
  try {
    const at = Date.UTC(2025, 11, 31, 17);
    const insert = store.db.prepare('INSERT INTO ledger VALUES(?,?,?)');
    const entry = {
      at,
      model: 'test',
      usage: { input: 100, output: 20, cached: 40, measured: true },
      pricing: { prices: { input: 2, cached: 1, output: 4 } },
    };
    insert.run('one', 'parent', JSON.stringify(entry));
    insert.run('two', 'child', JSON.stringify(entry));
    insert.run(
      'three',
      'parent',
      JSON.stringify({ ...entry, usage: { input: 500, output: 0, cached: 0, measured: false } }),
    );
    insert.run('four', 'parent', JSON.stringify({ ...entry, pricing: undefined }));
    store.db
      .prepare('INSERT INTO run_metadata VALUES(?,?,?,?)')
      .run('parent', 'chat', at, JSON.stringify({ inputTokens: 100000, reasoning: 'high' }));
    store.db
      .prepare('INSERT INTO run_metadata VALUES(?,?,?,?)')
      .run('child', 'chat', at, JSON.stringify({ reasoning: 'low' }));
    store.put('skill-read', { id: 'one', runId: 'parent', skillId: 'skill', resource: 'SKILL.md' });
    const result = activity(store.db, 2026, 'Asia/Shanghai');
    assert.equal(result.days[0].date, '2026-01-01');
    assert.equal(result.total.input, 300);
    assert.equal(result.total.output, 60);
    assert.equal(result.total.cached, 120);
    assert.equal(result.total.calls, 4);
    assert.equal(result.total.unreported, 1);
    assert.equal(result.total.unpriced, 1);
    assert.ok(Math.abs(result.total.estimatedUsd - 0.00048) < 1e-10);
    assert.equal(result.runs, 2);
    assert.equal(result.skillsExplored, 1);
    assert.equal(activity(store.db, 2026, 'UTC').total.calls, 0);
    assert.equal(activity(store.db, 2025, 'UTC').total.calls, 4);
  } finally {
    store.close();
  }
});
test('activity empty years and leap dates remain valid without invented insights', () => {
  const store = new Store(':memory:');
  try {
    const r = activity(store.db, 2024, 'UTC');
    assert.deepEqual(r.days, []);
    assert.equal(r.total.calls, 0);
    assert.deepEqual(r.plugins, []);
  } finally {
    store.close();
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { tokenActivityRoutes } from '../server/http/token-activity.js';
test('statistics worker reads file database and coalesces simultaneous requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-')),
    store = new Store(join(dir, 'db.sqlite')),
    app = Fastify();
  tokenActivityRoutes(app, store.path);
  try {
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject('/api/token-activity?year=2026&timeZone=Asia%2FShanghai'),
      ),
    );
    for (const reply of replies) {
      assert.equal(reply.statusCode, 200);
      assert.equal(reply.json().total.calls, 0);
    }
    assert.equal(replies[0].body, replies[1].body);
    const years = await Promise.all(
      [2024, 2025, 2027].map((year) => app.inject('/api/token-activity?year=' + year)),
    );
    assert.deepEqual(
      years.map((r) => r.json().year),
      [2024, 2025, 2027],
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
