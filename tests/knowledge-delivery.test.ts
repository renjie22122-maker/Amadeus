import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/storage/store.js';
import { deliverKnowledge } from '../server/services/knowledge-delivery.js';

test('knowledge delivery verifies registered originals, isolates scopes and preserves explicit reuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-delivery-'));
  const store = new Store(join(dir, 'test.db'));
  try {
    const bytes = Buffer.from('verified original bytes');
    const path = join(dir, 'original.pdf');
    await writeFile(path, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const doc = {
      id: 'doc',
      scope: 'general',
      name: 'original.pdf',
      hash: 'text-hash',
      createdAt: 1,
      validFrom: 1,
      validUntil: null,
    };
    store.put('document', doc);
    store.put('knowledge-source', {
      id: 'source',
      scope: 'general',
      documentId: 'doc',
      path,
      hash,
      removed: false,
    });
    const c: any = {
      store,
      scopes: ['general'],
      conversation: { id: 'chat' },
      run: { id: 'run' },
      signal: new AbortController().signal,
    };
    const sent = await deliverKnowledge(c, 'doc', 'original');
    const a = store.get<any>('attachment', sent.delivery.id);
    assert.deepEqual(await readFile(a.path), bytes);
    assert.equal(a.conversationId, 'chat');
    assert.equal((await deliverKnowledge(c, 'doc', 'original')).delivery.id, a.id);
    await assert.rejects(
      deliverKnowledge({ ...c, scopes: ['other'] }, 'doc', 'original'),
      /outside/,
    );
    await writeFile(path, 'changed source');
    await assert.rejects(deliverKnowledge(c, 'doc', 'original'), /differs/);
    assert.equal(store.attachmentMetadata('chat').length, 1);
    await writeFile(path, bytes);
    store.put('document', {
      ...doc,
      id: 'reused',
      scope: 'project',
      reusedFrom: { documentId: 'doc', scope: 'general', hash: doc.hash },
    });
    const reused = await deliverKnowledge(
      { ...c, scopes: ['project'], run: { id: 'run-project' } },
      'reused',
      'original',
    );
    assert.deepEqual(await readFile(store.get<any>('attachment', reused.delivery.id).path), bytes);
    store.put('document', { ...doc, id: 'spoof', source: path });
    await assert.rejects(deliverKnowledge(c, 'spoof', 'original'), /No verified original/);
    store.put('document', { ...doc, validUntil: 2 });
    await assert.rejects(deliverKnowledge(c, 'doc', 'original'), /outside/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('uploaded originals and labeled text exports require no arbitrary file paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-upload-delivery-'));
  const store = new Store(join(dir, 'test.db'));
  try {
    const path = join(dir, 'file.txt');
    await writeFile(path, 'original');
    const hash = createHash('sha256').update('original').digest('hex');
    store.put('document', {
      id: 'd',
      scope: 'general',
      name: 'file.txt',
      createdAt: 1,
      hash: 'text',
    });
    store.put('knowledge-original', { id: 'd', scope: 'general', path, hash });
    const c: any = {
      store,
      scopes: ['general'],
      conversation: { id: 'chat' },
      run: { id: 'run' },
      signal: new AbortController().signal,
    };
    assert.equal((await deliverKnowledge(c, 'd', 'original')).format, 'original');
    store.db
      .prepare(
        'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,source_hash) VALUES(?,?,?,?,?,?,?)',
      )
      .run('ch', 'general', 'd', 'file.txt', 0, 'indexed text', 'text');
    const exported = await deliverKnowledge(c, 'd', 'extracted-text');
    assert.match(exported.delivery.name, /\.extracted\.txt$/);
    assert.match(
      await readFile(store.get<any>('attachment', exported.delivery.id).path, 'utf8'),
      /not the original file/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
