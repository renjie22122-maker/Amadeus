import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { FileScope } from '../server/services/paths.js';
import { Isolations } from '../server/services/isolation.js';
import { AnnIndex } from '../server/services/ann.js';
import { cosine } from '../server/services/embedding.js';
import { execute } from '../server/services/process.js';
import { Configuration } from '../server/services/settings.js';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-migration-')),
    root = join(dir, 'project');
  await mkdir(root);
  const store = new Store(join(dir, 'state.sqlite'));
  return {
    dir,
    root,
    store,
    service: new Isolations(store, join(dir, 'private')),
    config: new Configuration(join(dir, 'settings.json')),
  };
}
test('isolated edits leave parent intact; versioned merge, deletion and duplicate refusal', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'before');
    await writeFile(join(f.root, '.env'), 'secret');
    await writeFile(join(f.root, 'b.txt'), 'remove');
    const child = await f.service.create('parent', new FileScope([f.root]));
    assert.equal(await readFile(join(child.roots[0], 'a.txt'), 'utf8'), 'before');
    await assert.rejects(readFile(join(child.roots[0], '.env')));
    await new FileScope(child.roots).write('a.txt', 'after');
    const { unlink } = await import('node:fs/promises');
    await unlink(join(child.roots[0], 'b.txt'));
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'before');
    const review = await f.service.inspect(child.id);
    assert.equal(review.changes.length, 2);
    assert.equal(review.changes[0].conflict, false);
    await assert.rejects(f.service.merge(child.id, 'wrong'), /Review again/);
    await f.service.merge(child.id, review.version);
    assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'after');
    await assert.rejects(readFile(join(f.root, 'b.txt')));
    await assert.rejects(f.service.merge(child.id, review.version), /Already merged/);
  } finally {
    f.store.close();
  }
});
test('concurrent parent changes reject the entire merge before writing', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a'), 'original');
    const child = await f.service.create('p', new FileScope([f.root]));
    await writeFile(join(child.roots[0], 'a'), 'child');
    await writeFile(join(f.root, 'a'), 'parent');
    const review = await f.service.inspect(child.id);
    assert.equal(review.changes[0].conflict, true);
    await assert.rejects(f.service.merge(child.id, review.version), /Parent files changed/);
    assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'parent');
  } finally {
    f.store.close();
  }
});
test('nested copies merge only into their immediate parent', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a'), 'root');
    const c = await f.service.create('p', new FileScope([f.root]));
    const g = await f.service.create('child', new FileScope(c.roots));
    await writeFile(join(g.roots[0], 'a'), 'grandchild');
    await f.service.merge(g.id, (await f.service.inspect(g.id)).version);
    assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'root');
    assert.equal(await readFile(join(c.roots[0], 'a'), 'utf8'), 'grandchild');
  } finally {
    f.store.close();
  }
});
test('native backend never falls back when interpreter is missing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      execute('echo unsafe > marker', f.root, new AbortController().signal, 1000, {
        ...f.config.get(),
        commandBackend: 'native-windows',
        nativePython: '',
      }),
      /requires an absolute/,
    );
    await assert.rejects(readFile(join(f.root, 'marker')));
  } finally {
    f.store.close();
  }
});
test('HNSW 15k vectors: held-out recall and generation replacement', async () => {
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const rows = Array.from({ length: 15000 }, (_, i) => ({
    id: String(i),
    values: Array.from({ length: 32 }, random),
  }));
  const ann = new AnnIndex();
  let found = 0,
    total = 0;
  try {
    for (let n = 0; n < 12; n++) {
      const q = Array.from({ length: 32 }, random);
      const exact = rows
        .map((r) => ({ id: r.id, score: cosine(q, r.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => r.id);
      const result = await ann.search('large', rows, q, 10);
      found += result.result.filter((r: any) => exact.includes(r.id)).length;
      total += 10;
    }
    assert.ok(found / total >= 0.95, 'Recall@10 ' + found / total);
    console.log('ANN held-out recall@10', found / total, 'vectors', rows.length);
    const other = await ann.search(
      'new-scope',
      [{ id: 'private-other', values: rows[0].values }],
      rows[0].values,
      10,
    );
    assert.deepEqual(
      other.result.map((r: any) => r.id),
      ['private-other'],
    );
    const cached = await ann.search(
      'new-scope',
      [{ id: 'private-other', values: rows[0].values }],
      rows[0].values,
      1,
    );
    const emptied = await ann.search('new-scope', [], rows[0].values, 1);
    assert.deepEqual(emptied.result, []);
    assert.equal(cached.result[0].id, 'private-other');
  } finally {
    ann.close();
  }
});

test('streamed knowledge retrieval preserves scope, deletion and embedding model compatibility', async () => {
  const { Knowledge } = await import('../server/services/knowledge.js');
  const f = await fixture();
  let model = 'model-a';
  const embedding = {
    enabled: () => true,
    fingerprint: () => model,
    encode: async () => [[1, 0, 0, 0]],
  };
  const kb = new Knowledge(f.store, embedding as any);
  try {
    f.store.put('document', { id: 'doc-a', scope: 'project:a', createdAt: 1 });
    f.store.put('document', { id: 'doc-b', scope: 'project:b', createdAt: 1 });
    const stmt = f.store.db.prepare(
      'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,source_hash,vector) VALUES(?,?,?,?,?,?,?,?)',
    );
    f.store.transaction(() => {
      for (let n = 0; n < 2200; n++)
        stmt.run(
          'a' + n,
          'project:a',
          'doc-a',
          'A',
          n,
          'body',
          'hash',
          JSON.stringify({ model, values: [1, n / 2200, 0, 0] }),
        );
      stmt.run(
        'secret',
        'project:b',
        'doc-b',
        'SECRET',
        0,
        'other',
        'hash',
        JSON.stringify({ model, values: [1, 0, 0, 0] }),
      );
    });
    let result = await kb.hybrid(['project:a'], 'unmatchedquery', 6);
    assert.equal(kb.lastRetrieval.backend, 'streamed-exact');
    assert.equal(kb.lastRetrieval.semanticStatus, 'searched');
    assert.ok(result.length);
    assert.ok(result.every((r) => r.scope === 'project:a'));
    const removed = result[0].id;
    f.store.db.prepare('DELETE FROM chunks WHERE id=?').run(removed);
    result = await kb.hybrid(['project:a'], 'unmatchedquery', 6);
    assert.ok(!result.some((r) => r.id === removed));
    result = await kb.hybrid(['project:b'], 'unmatchedquery', 6);
    assert.deepEqual(
      result.map((r) => r.id),
      ['secret'],
    );
    model = 'model-b';
    assert.equal((await kb.hybrid(['project:a'], 'unmatchedquery', 6)).length, 0);
  } finally {
    kb.close();
    f.store.close();
  }
});
test('linked entries refuse copying and binary changes refuse merging before writes', async () => {
  const { link } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a'), 'original');
    await link(join(f.root, 'a'), join(f.root, 'hard'));
    await assert.rejects(f.service.create('p', new FileScope([f.root])), /Linked/);
    const { unlink } = await import('node:fs/promises');
    await unlink(join(f.root, 'hard'));
    const child = await f.service.create('p', new FileScope([f.root]));
    await writeFile(join(child.roots[0], 'a'), Buffer.from([0, 1, 2]));
    const review = await f.service.inspect(child.id);
    await assert.rejects(f.service.merge(child.id, review.version), /Binary/);
    assert.equal(f.service.get(child.id).state, 'ready');
    assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'original');
  } finally {
    f.store.close();
  }
});

test('partial merge records progress and resumes only remaining approved writes', async (t) => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.txt'), 'old-a');
    await writeFile(join(f.root, 'b.txt'), 'old-b');
    const child = await f.service.create('parent', new FileScope([f.root]));
    const files = new FileScope(child.roots);
    await files.write('a.txt', 'new-a');
    await files.write('b.txt', 'new-b');
    const version = (await f.service.inspect(child.id)).version,
      original = FileScope.prototype.write;
    let n = 0;
    t.mock.method(
      FileScope.prototype,
      'write',
      async function (this: FileScope, ...args: Parameters<typeof original>) {
        if (++n === 2) throw Error('injected write failure');
        return original.apply(this, args);
      },
    );
    await assert.rejects(f.service.merge(child.id, version), /injected/);
    t.mock.restoreAll();
    assert.equal(f.service.get(child.id).state, 'uncertain');
    const review = await f.service.inspect(child.id);
    assert.equal(review.changes.filter((c) => c.alreadyApplied).length, 1);
    assert.ok(review.changes.every((c) => !c.conflict));
    await f.service.merge(child.id, review.version);
    assert.equal(await readFile(join(f.root, 'b.txt'), 'utf8'), 'new-b');
    assert.equal(f.service.get(child.id).state, 'merged');
  } finally {
    f.store.close();
  }
});

test('isolated copies retain ordinary hidden configuration but exclude secrets and report omissions', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, '.editorconfig'), 'root = true');
    await writeFile(join(f.root, '.gitignore'), 'build/');
    await writeFile(join(f.root, '.env'), 'secret');
    await writeFile(join(f.root, 'private.key'), 'secret');
    await mkdir(join(f.root, '.git'));
    const child = await f.service.create('parent', new FileScope([f.root]));
    assert.equal(await readFile(join(child.roots[0], '.editorconfig'), 'utf8'), 'root = true');
    await assert.rejects(readFile(join(child.roots[0], 'private.key')));
    assert.equal(child.copyReport?.files, 2);
    assert.equal(child.copyReport?.excludedEntries, 3);
    await writeFile(join(child.roots[0], '.editorconfig'), 'root = false');
    const review = await f.service.inspect(child.id);
    assert.equal(review.changes[0].path, '@0/.editorconfig');
    await f.service.merge(child.id, review.version);
    assert.equal(await readFile(join(f.root, '.editorconfig'), 'utf8'), 'root = false');
    assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'secret');
  } finally {
    f.store.close();
  }
});

test('oversized copies fail explicitly without a usable partial isolation', async () => {
  const f = await fixture();
  try {
    const handle = await (await import('node:fs/promises')).open(join(f.root, 'large.bin'), 'w');
    await handle.truncate(65 * 1024 * 1024);
    await handle.close();
    await assert.rejects(
      f.service.create('parent', new FileScope([f.root])),
      /large.bin.*No usable copy/,
    );
    assert.equal(f.store.list('isolation').length, 0);
  } finally {
    f.store.close();
  }
});
