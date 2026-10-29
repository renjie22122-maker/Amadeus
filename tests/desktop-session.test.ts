import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopSession, computerActionSchema } from '../server/services/desktop-session.js';
import { z } from 'zod';
test('desktop observations expire, isolate sessions and reject changed controls before clicking', async () => {
  let time = 0;
  const calls: any[] = [];
  let e = {
    runtimeId: [1, 2],
    name: 'Save',
    role: 'Button',
    x: 10,
    y: 20,
    width: 40,
    height: 20,
    enabled: true,
    password: false,
  };
  const native = async (a: any) => {
    calls.push(a);
    return a.action === 'inspect' ? { controls: [{ ...e }] } : { completed: true };
  };
  const run = createDesktopSession(native, () => time),
    other = createDesktopSession(native, () => time);
  const observation = await run({ action: 'inspect', windowId: '10' });
  const click = {
    action: 'click_element',
    windowId: '10',
    observationId: observation.observationId,
    elementIndex: 0,
  };
  await assert.rejects(other(click), /STALE/);
  await assert.rejects(run({ ...click, windowId: '11' }), /STALE/);
  e = { ...e, x: 11 };
  await assert.rejects(run(click), /STALE/);
  assert.equal(calls.filter((a) => a.action === 'click').length, 0);
  e = { ...e, x: 10 };
  await run(click);
  assert.deepEqual(calls.at(-1), { action: 'click', windowId: '10', button: 'left', x: 30, y: 30 });
  await assert.rejects(run(click), /STALE/);
  const next = await run({ action: 'inspect', windowId: '10' });
  time = 60_001;
  await assert.rejects(run({ ...click, observationId: next.observationId }), /STALE/);
});
test('desktop requires action arguments and accepts supported chords without shell syntax', async () => {
  const run = createDesktopSession(async () => ({}));
  for (const a of [
    { action: 'click', windowId: '1' },
    { action: 'type', windowId: '1' },
    { action: 'key', windowId: '1' },
    { action: 'activate' },
  ])
    await assert.rejects(run(a));
  for (const key of ['CTRL+L', 'CTRL+SHIFT+T', 'ALT+LEFT', 'F12', 'ENTER'])
    assert.equal(z.object(computerActionSchema).parse({ action: 'key', key }).key, key);
  for (const key of ['WIN+R', 'CTRL+foo', 'cmd /c', 'CTRL+'])
    assert.throws(() => z.object(computerActionSchema).parse({ action: 'key', key }));
});
test('desktop refuses protected elements and invalidates references after input', async () => {
  const run = createDesktopSession(async (a: any) =>
    a.action === 'inspect' ? { controls: [{ runtimeId: [1], enabled: true, password: true }] } : {},
  );
  const o = await run({ action: 'inspect', windowId: '1' });
  await assert.rejects(
    run({
      action: 'click_element',
      windowId: '1',
      observationId: o.observationId,
      elementIndex: 0,
    }),
    /protected/,
  );
  await run({ action: 'key', windowId: '1', key: 'TAB' });
  await assert.rejects(
    run({
      action: 'click_element',
      windowId: '1',
      observationId: o.observationId,
      elementIndex: 0,
    }),
    /STALE/,
  );
});
