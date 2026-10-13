import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareExecutionLayout } from '../server/services/execution-layout.js';
import { FileScope, validateRoots } from '../server/services/paths.js';
test('embedded workspace exposes task data but not private runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'layout-test-'));
  try {
    const l = await prepareExecutionLayout(root);
    await writeFile(join(l.workspace, 'task.csv'), 'value\n17');
    await writeFile(join(l.state, 'settings.json'), 'secret');
    assert.equal(await l.files.resolve('task.csv'), join(l.workspace, 'task.csv'));
    await assert.rejects(() => l.files.resolve('../runtime-state/settings.json'));
    await assert.rejects(
      () => validateRoots([l.workspace], root),
      (e: any) => e.code === 'PRIVATE_STORAGE',
    );
    await assert.rejects(
      () => new FileScope([l.workspace], root).resolve('task.csv'),
      (e: any) => e.code === 'PRIVATE_STORAGE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
