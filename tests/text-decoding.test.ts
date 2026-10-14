import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocumentText, suspiciousText } from '../server/services/text-decoding.js';
import { extract } from '../server/services/documents.js';
import { KnowledgeMaintenance } from '../server/services/knowledge-maintenance.js';
import { Knowledge } from '../server/services/knowledge.js';
import { Store } from '../server/storage/store.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('strict Unicode, GB18030 and GBK text decoding without silent replacement', () => {
  const text = '中文 English';
  assert.equal(decodeDocumentText(Buffer.from(text)).text, text);
  assert.equal(decodeDocumentText(Buffer.from('\ufeff' + text)).text, text);
  assert.equal(
    decodeDocumentText(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')])).text,
    text,
  );
  const be = Buffer.from('\ufeff' + text, 'utf16le');
  be.swap16();
  assert.equal(decodeDocumentText(be).text, text);
  assert.equal(
    decodeDocumentText(Buffer.from('English text 中文', 'utf16le')).text,
    'English text 中文',
  );
  assert.equal(decodeDocumentText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 32, 65])).text, '中文 A');
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from([0xef, 0xbb, 0xbf, 0xff]),
    Buffer.from('\ufffd'.repeat(20)),
    Buffer.alloc(20),
    Buffer.from([255, 254, 0, 0, 65, 0, 0, 0]),
  ])
    assert.throws(() => decodeDocumentText(bytes));
  assert(suspiciousText('\ufffd'.repeat(20)));
  assert(!suspiciousText(text));
});

test('maintenance repairs unchanged corrupt text once and reuses healthy documents and vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'encoding-migration-'));
  const root = join(dir, 'docs');
  await mkdir(root);
  const store = new Store(join(dir, 'data', 'db.sqlite'));
  let encodes = 0,
    parses = 0,
    oldParser = true;
  const embeddings: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => {
      encodes += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
  const kb = new Knowledge(store, embeddings);
  const manager = new KnowledgeMaintenance(
    store,
    kb,
    embeddings,
    join(dir, 'data'),
    undefined,
    async (path) => {
      parses++;
      return oldParser && path.endsWith('legacy.txt') ? '\ufffd'.repeat(60) : extract(path);
    },
  );
  try {
    await writeFile(join(root, 'legacy.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 32, 65]));
    await writeFile(join(root, 'healthy.md'), 'healthy evidence');
    store.put('project', { id: 'p', folders: [root] });
    store.put('knowledge-watch', {
      id: 'project:p',
      paths: [root],
      enabled: true,
      target: 'fixture',
      revision: 1,
    });
    await manager.tick();
    assert.equal(parses, 2);
    const sources = store.list<any>('knowledge-source');
    for (const source of sources)
      store.put('knowledge-source', { ...source, parserRevision: undefined });
    const healthy = sources.find((s) => s.path.endsWith('healthy.md'));
    oldParser = false;
    const before = encodes;
    await manager.tick();
    assert.equal(parses, 3);
    assert.equal(encodes, before + 1);
    const current = store.list<any>('document').filter((d) => d.validUntil == null);
    assert.equal(current.length, 2);
    assert(current.some((d) => d.id === healthy.documentId));
    assert(kb.search(['project:p'], '中文').some((h) => h.text.includes('中文')));
    assert.equal(store.list<any>('document').length, 3);
    await manager.tick();
    assert.equal(parses, 3);
    assert.equal(encodes, before + 1);
  } finally {
    await manager.close();
    kb.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
