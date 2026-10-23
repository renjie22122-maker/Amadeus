import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { FileScope } from '../server/services/paths.js';
import { inspectWrittenFiles, reviewEvidence } from '../server/services/review-evidence.js';
import type { Run } from '../shared/types.js';

test('only completed current-run writes provide hash evidence; later edits and outside roots do not match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-origin-'));
  const store = new Store(join(root, 'test.sqlite'));
  const files = new FileScope([root]);
  const run = { id: 'current' } as Run;
  const file = join(root, 'helper.txt');
  await writeFile(file, 'source-bytes-unique');
  try {
    const saved = store.beginEffect(run.id, 'write_file', {
      path: file,
      content: 'source-bytes-unique',
    });
    store.endEffect(saved, 'saved');
    const other = store.beginEffect('other', 'write_file', { path: 'private', content: 'secret' });
    store.endEffect(other, 'saved');
    store.beginEffect(run.id, 'write_file', { path: 'pending', content: 'pending' });
    let rows = await inspectWrittenFiles(store, run, files);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matchesRecordedWrite, true);
    assert(!JSON.stringify(rows).includes('source-bytes-unique'));
    await writeFile(file, 'user revision');
    rows = await inspectWrittenFiles(store, run, files);
    assert.equal(rows[0].matchesRecordedWrite, false);
    const escaped = store.beginEffect(run.id, 'write_file', {
      path: join(root, '..', 'outside'),
      content: 'data',
    });
    store.endEffect(escaped, 'saved');
    rows = await inspectWrittenFiles(store, run, files);
    assert.equal(rows[0].status, 'unavailable');
    assert.equal(rows[0].matchesRecordedWrite, false);
    assert(!JSON.stringify(rows).includes('secret'));
  } finally {
    store.close();
  }
});

test('directory observations retain truncation and are not shared with a different reviewer profile', () => {
  const run = {
    checkpoints: [
      { role: 'assistant', calls: [{ id: 'ls', name: 'list_files', arguments: { path: '@0/' } }] },
      { role: 'tool', callId: 'ls', content: 'x'.repeat(5000) },
    ],
  } as unknown as Run;
  const evidence = reviewEvidence(run, true);
  assert.equal(evidence.listings?.[0].truncated, true);
  assert.equal(evidence.listings?.[0].content.length, 4000);
  assert.equal(reviewEvidence(run, false).listings, undefined);
});
