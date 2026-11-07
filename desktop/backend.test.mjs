import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBackend } from './backend.mjs';

test('concurrent starts share one child, stop drains it, and restart uses a new child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-desktop-'));
  mkdirSync(join(root, 'build/server'), { recursive: true });
  writeFileSync(
    join(root, 'build/server/main.js'),
    `
    process.send({ type: 'amadeus:ready', url: 'http://127.0.0.1:12345' });
    process.on('message', m => { if (m.type === 'amadeus:shutdown') setTimeout(() => process.exit(0), 40); });
    process.on('disconnect', () => process.exit(0));
  `,
  );
  const backend = new DesktopBackend({
    node: process.execPath,
    root,
    directory: join(root, 'data'),
  });
  try {
    const first = backend.start();
    assert.equal(backend.start(), first);
    assert.equal(await first, 'http://127.0.0.1:12345');
    const pid = backend.child.pid;
    assert.equal(await backend.start(), backend.url);
    assert.equal(backend.child.pid, pid);
    const stop = backend.stop();
    assert.equal(backend.stop(), stop);
    await assert.rejects(backend.start(), /stopping/);
    await stop;
    assert.equal(backend.child, undefined);
    await backend.start();
    assert.notEqual(backend.child.pid, pid);
  } finally {
    await backend.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup failure rejects and does not silently relaunch a failed service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-desktop-'));
  const backend = new DesktopBackend({
    node: process.execPath,
    root,
    directory: join(root, 'data'),
  });
  try {
    await assert.rejects(backend.start(), /exited/);
    assert.equal(backend.child, undefined);
  } finally {
    await backend.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
