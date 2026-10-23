import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractIsolated } from '../server/services/document-parser.js';

test('parser drains its result after worker exit when the parent event loop was busy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parser-exit-race-'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const path = join(dir, 'readable.txt');
    await writeFile(path, 'Readable source evidence.');
    const result = extractIsolated(path, 15000);
    timer = setTimeout(() => {
      // Reproduce IPC/exit queue ordering in this isolated test process only.
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        /* deliberate parent congestion */
      }
    }, 50);
    assert.equal(await result, 'Readable source evidence.');
    clearTimeout(timer);
    await writeFile(path, '');
    await assert.rejects(extractIsolated(path, 15000), /DOCUMENT_EMPTY/);
  } finally {
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  }
});
