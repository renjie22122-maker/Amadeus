import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { KnowledgeMaintenance } from '../server/services/knowledge-maintenance.js';
import { extractIsolated } from '../server/services/document-parser.js';

test('one corrupt source does not block siblings; failures are bounded and explicitly retryable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-resilient-'));
  const root = join(dir, 'sources');
  await mkdir(root);
  await mkdir(join(dir, 'private'));
  const store = new Store(join(dir, 'db.sqlite'));
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'test',
    encode: async (t: string[]) => t.map(() => [1, 0]),
  };
  const knowledge = new Knowledge(store, embedding);
  let attempts = 0,
    good = 0;
  const manager = new KnowledgeMaintenance(
    store,
    knowledge,
    embedding,
    join(dir, 'private'),
    undefined,
    async (path) => {
      if (basename(path) === 'bad.pdf') {
        attempts++;
        throw Error('Corrupt PDF');
      }
      good++;
      return readFile(path, 'utf8');
    },
  );
  store.put('knowledge-watch', {
    id: 'general',
    enabled: true,
    paths: [root],
    target: 'test',
    revision: 1,
  });
  try {
    await writeFile(join(root, 'bad.pdf'), 'bad');
    await writeFile(join(root, 'good.md'), 'Verified sibling knowledge.');
    for (let i = 0; i < 5; i++) await manager.tick();
    assert.equal(attempts, 3);
    assert.equal(good, 1);
    assert.equal(store.get<any>('knowledge-watch', 'general').status, 'partial');
    assert.equal(store.list('document').length, 1);
    manager.recheck('general');
    await manager.tick();
    assert.equal(attempts, 4);
    assert.equal(good, 1);
    assert.equal(knowledge.diagnostics([]).status, 'disabled');
    assert.equal(knowledge.diagnostics(['project:other']).status, 'not_imported');
    assert.equal(knowledge.diagnostics(['general']).documents, 1);
    await rm(join(root, 'bad.pdf'));
    await manager.tick();
    assert.equal(store.get<any>('knowledge-watch', 'general').status, 'synced');
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanner accepts over 1000 supported files without truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-many-'));
  const root = join(dir, 'sources');
  await mkdir(root);
  await mkdir(join(dir, 'private'));
  const store = new Store(join(dir, 'db.sqlite'));
  const embedding: any = { enabled: () => true, fingerprint: () => 'test' };
  // Empty text is an explicit per-file failure, keeping this enumeration test independent of indexing.
  const knowledge = new Knowledge(store, embedding);
  let parsed = 0;
  const manager = new KnowledgeMaintenance(
    store,
    knowledge,
    embedding,
    join(dir, 'private'),
    undefined,
    async () => {
      parsed++;
      throw Error('fixture parse failure');
    },
  );
  store.put('knowledge-watch', {
    id: 'general',
    enabled: true,
    paths: [root],
    target: 'test',
    revision: 1,
  });
  try {
    for (let i = 0; i < 1002; i++) await writeFile(join(root, i + '.md'), 'source');
    await manager.tick();
    assert.equal(parsed, 1002);
    assert.equal(store.get<any>('knowledge-watch', 'general').scan.files, 1002);
    assert.equal(knowledge.diagnostics(['general']).status, 'import_failed');
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF over 25 MB and 500 pages includes the final page; parser timeout returns bounded failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-pdf-'));
  const path = join(dir, 'large.pdf');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (let i = 1; i <= 501; i++) {
    const page = objects.length + 1,
      content = page + 1;
    kids.push(page + ' 0 R');
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
        content +
        ' 0 R >>',
    );
    const text = 'BT /F1 12 Tf 30 200 Td (Verified page ' + i + ' sentinel) Tj ET';
    objects.push('<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream');
  }
  objects[1] = '<< /Type /Pages /Count 501 /Kids [' + kids.join(' ') + '] >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += i + 1 + ' 0 obj\n' + o + '\nendobj\n';
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    'xref\n0 ' +
    (objects.length + 1) +
    '\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, '0') + ' 00000 n \n')
      .join('');
  pdf +=
    'trailer\n<< /Size ' +
    (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF\n';
  try {
    await writeFile(path, Buffer.concat([Buffer.from(pdf), Buffer.alloc(26 * 1024 * 1024, 32)]));
    const result = await extractIsolated(path);
    assert.match(result, /Verified page 501 sentinel/);
    await assert.rejects(extractIsolated(path, 1), /timed out/);
    const controller = new AbortController();
    const parsing = extractIsolated(path, 120000, controller.signal);
    controller.abort();
    await assert.rejects(parsing, /cancelled/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
