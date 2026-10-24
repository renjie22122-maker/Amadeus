import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { runtimeClock } from '../server/services/runtime-clock.js';
import { tools } from '../server/tools/registry.js';
import { Configuration } from '../server/services/settings.js';
import { restrictedChat } from '../server/services/chat-access.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-clock-'));
  const store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.parse('2026-10-25T00:00:00Z');
  const run: any = {
    id: 'r',
    conversationId: 'c',
    status: 'running',
    createdAt: now - 120000,
    depth: 0,
  };
  return { dir, store, run, now };
}

test('clock converts the same instant, labels host timezone and includes waiting in wall time', (t) => {
  const { store, run, now } = fixture(t);
  store.event('c', 'r', 'run.status', { status: 'waiting_approval' });
  store.db.prepare("UPDATE events SET created_at=? WHERE run_id='r'").run(now - 30000);
  store.event('other', 'other', 'run.status', { status: 'completed' });
  const clock = runtimeClock(store, run, 'Asia/Shanghai', now);
  assert.equal(clock.observedAtUtc, '2026-10-25T00:00:00.000Z');
  assert.equal(clock.localDateTime, '2026-10-25 08:00:00');
  assert.equal(clock.timeZoneSource, 'requested');
  assert.equal(clock.elapsedSinceRunCreatedMs, 120000);
  assert.equal(clock.currentStatus, 'waiting_approval');
  assert.equal(clock.elapsedInRecordedStatusMs, 30000);
  assert.equal(runtimeClock(store, run, undefined, now).timeZoneSource, 'execution-host');
  assert.equal(runtimeClock(store, run, 'UTC', now).unixMilliseconds, clock.unixMilliseconds);
});

test('invalid zones fail explicitly, absent timestamps and reversed clock never invent durations', (t) => {
  const { store, run, now } = fixture(t);
  assert.throws(() => runtimeClock(store, run, 'Invalid/Zone', now), /IANA/);
  const absent = runtimeClock(store, { ...run, createdAt: undefined }, 'UTC', now);
  assert.equal(absent.elapsedSinceRunCreatedMs, null);
  assert.equal(absent.elapsedInRecordedStatusMs, null);
  const reversed = runtimeClock(store, { ...run, createdAt: now + 1 }, 'UTC', now);
  assert.equal(reversed.clockMovedBackwards, true);
  assert.equal(reversed.elapsedSinceRunCreatedMs, null);
});

test('clock is available without project or write permissions and respects explicit tool restrictions', async (t) => {
  const { store, run, dir } = fixture(t);
  const conversation: any = { id: 'c', permission: 'read-only', teamStrategy: 'off' };
  store.put('run', run);
  store.put('conversation', conversation);
  const ctx: any = {
    store,
    run,
    conversation,
    config: new Configuration(join(dir, 'settings')),
    signal: new AbortController().signal,
  };
  const registry = tools();
  assert.ok(registry.modelSpecs(ctx).some((s) => s.name === 'read_clock'));
  const value = JSON.parse((await registry.invoke('read_clock', { timeZone: 'UTC' }, ctx)).content);
  assert.equal(value.runId, 'r');
  assert.equal(value.timeZone, 'UTC');
  assert.ok(
    registry
      .modelSpecs({
        ...ctx,
        conversation: restrictedChat({ ...conversation, remoteChatOnly: true }),
      })
      .some((s) => s.name === 'read_clock'),
  );
  assert.ok(
    !registry
      .specs({ ...ctx, conversation: { ...conversation, allowedTools: [] } })
      .some((s) => s.name === 'read_clock'),
  );
});
