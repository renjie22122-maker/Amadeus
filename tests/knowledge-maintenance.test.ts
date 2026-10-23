import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { KnowledgeMaintenance } from '../server/services/knowledge-maintenance.js';

test('automatic sources preserve versions, reuse vectors, isolate scopes and retire deleted files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-auto-'));
  const root = join(dir, 'docs'),
    data = join(dir, 'data');
  await mkdir(root);
  await mkdir(data);
  const store = new Store(join(data, 'db.sqlite'));
  let calls = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => {
      calls += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
  const knowledge = new Knowledge(store, embedding);
  const manager = new KnowledgeMaintenance(store, knowledge, embedding, data);
  store.put('project', { id: 'p', folders: [root] });
  store.put('knowledge-watch', {
    id: 'project:p',
    paths: [root],
    enabled: true,
    target: 'fixture',
    revision: 1,
  });
  await writeFile(join(root, 'guide.md'), '# Guide\nThe retention period is seven days.');
  await manager.tick();
  assert.equal(store.list<any>('document').length, 1);
  assert.equal(calls, 1);
  store.db.exec(
    'CREATE TEMP TABLE vector_writes(n INTEGER); INSERT INTO vector_writes VALUES(0); CREATE TEMP TRIGGER count_vector_writes AFTER UPDATE OF vector ON chunks BEGIN UPDATE vector_writes SET n=n+1; END;',
  );
  const originalIndex = knowledge.index.bind(knowledge);
  let indexCalls = 0;
  knowledge.index = async (...args) => {
    indexCalls++;
    return originalIndex(...args);
  };
  await manager.tick();
  assert.equal(calls, 1);
  assert.equal(indexCalls, 0);
  assert.equal(store.db.prepare('SELECT n FROM vector_writes').get()!.n, 0);
  await writeFile(join(root, 'guide.md'), '# Guide\nThe retention period is fourteen days.');
  await manager.tick();
  const docs = store.list<any>('document');
  assert.equal(docs.length, 2);
  assert.equal(docs.filter((d) => d.validUntil == null).length, 1);
  assert.equal(knowledge.search(['project:other'], 'retention').length, 0);
  assert.equal(knowledge.search(['project:p'], 'fourteen')[0].text.includes('fourteen'), true);
  await rm(join(root, 'guide.md'));
  await manager.tick();
  assert.equal(knowledge.search(['project:p'], 'retention').length, 0);
  assert.equal(store.get<any>('knowledge-watch', 'project:p').status, 'synced');
  await mkdir(join(root, 'nested'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'nested', 'readme.md'), 'Nested source material');
  await writeFile(join(root, 'node_modules', 'skip.md'), 'Excluded dependency');
  await writeFile(join(root, 'binary.exe'), 'unsupported');
  await manager.tick();
  assert.deepEqual(
    (({ completedAt, ...counts }) => counts)(store.get<any>('knowledge-watch', 'project:p').scan),
    {
      files: 1,
      updated: 1,
      unchanged: 0,
    },
  );
  assert.equal(knowledge.search(['project:p'], 'Nested')[0].text.includes('Nested'), true);
  await manager.tick();
  assert.deepEqual(
    (({ completedAt, ...counts }) => counts)(store.get<any>('knowledge-watch', 'project:p').scan),
    {
      files: 1,
      updated: 0,
      unchanged: 1,
    },
  );
  await manager.close();
  knowledge.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
});
test('destination changes and disabled scopes never embed; repeated failure stops after three tries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-auto-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let calls = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'local',
    encode: async () => {
      calls++;
      throw Error('invalid fixture vectors');
    },
  };
  const knowledge = new Knowledge(store, embedding);
  const manager = new KnowledgeMaintenance(store, knowledge, embedding, dir);
  store.put('conversation', { id: 's', projectId: null });
  knowledge.import('session:s', 'doc', 'some readable content');
  store.put('knowledge-watch', {
    id: 'session:s',
    paths: [],
    enabled: true,
    target: 'other',
    revision: 1,
  });
  await manager.tick();
  assert.equal(calls, 0);
  store.put('knowledge-watch', {
    id: 'session:s',
    paths: [],
    enabled: false,
    target: 'local',
    revision: 2,
  });
  await manager.tick();
  assert.equal(calls, 0);
  store.put('knowledge-watch', {
    id: 'session:s',
    paths: [],
    enabled: true,
    target: 'local',
    revision: 3,
  });
  for (let i = 0; i < 5; i++) await manager.tick();
  assert.equal(calls, 3);
  assert.equal(store.get<any>('knowledge-watch', 'session:s').status, 'partial');
  await manager.close();
  knowledge.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('explicit general folder sources import recursively without creating a project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'general-library-')),
    root = join(dir, 'sources'),
    data = join(dir, 'data');
  await mkdir(join(root, 'nested'), { recursive: true });
  await mkdir(data);
  const store = new Store(join(data, 'db.sqlite'));
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'local-test',
    encode: async (texts: string[]) => texts.map(() => [1, 0]),
  };
  const knowledge = new Knowledge(store, embedding),
    manager = new KnowledgeMaintenance(store, knowledge, embedding, data);
  try {
    await writeFile(join(root, 'nested', 'guide.md'), 'Shared library source');
    store.put('knowledge-watch', {
      id: 'general',
      paths: [root],
      enabled: true,
      target: 'local-test',
      revision: 1,
    });
    await manager.tick();
    assert.equal(store.get<any>('knowledge-watch', 'general').status, 'synced');
    assert.equal(knowledge.search(['general'], 'Shared').length, 1);
    assert.equal(knowledge.search(['project:p'], 'Shared').length, 0);
    assert.equal(store.list('project').length, 0);
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('adding a source reuses parsed documents and vectors without resetting failed jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-add-'));
  const first = join(dir, 'first'),
    second = join(dir, 'second'),
    data = join(dir, 'data');
  await Promise.all([first, second, data].map((p) => mkdir(p)));
  const store = new Store(join(data, 'db.sqlite'));
  let encoded = 0,
    parsed = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'test',
    encode: async (texts: string[]) => {
      encoded += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
  const knowledge = new Knowledge(store, embedding);
  const manager = new KnowledgeMaintenance(
    store,
    knowledge,
    embedding,
    data,
    undefined,
    async (path) => {
      parsed++;
      return (await import('node:fs/promises')).readFile(path, 'utf8');
    },
  );
  try {
    await writeFile(join(first, 'a.md'), 'First independent document about apples');
    await writeFile(join(second, 'b.md'), 'Second independent document about boats');
    const config = { id: 'general', enabled: true, paths: [first], target: 'test' };
    manager.saveSources(config);
    await manager.tick();
    assert.equal(parsed, 1);
    assert.equal(encoded, 1);
    const doc: any = store.list('document')[0];
    store.put('knowledge-index-job', {
      id: doc.id + '|failed-target',
      status: 'failed',
      attempts: 3,
    });
    const old: any = store.get('knowledge-watch', 'general');
    store.put('knowledge-watch', {
      ...old,
      issues: [
        {
          path: 'bad.pdf',
          stage: 'parse',
          hash: 'bad',
          attempts: 3,
          revision: old.revision,
          error: 'invalid',
        },
      ],
    });
    const saved: any = manager.saveSources({ ...config, paths: [first, second] });
    assert.equal(saved.issues[0].attempts, 3);
    assert.equal(saved.issues[0].revision, saved.revision);
    assert.equal(store.get<any>('knowledge-index-job', doc.id + '|failed-target').attempts, 3);
    assert.equal(
      manager.saveSources({ ...config, paths: [second, first] }).revision,
      saved.revision,
    );
    await manager.tick();
    assert.equal(parsed, 2);
    assert.equal(encoded, 2);
    assert.deepEqual(
      (({ completedAt, ...counts }) => counts)(store.get<any>('knowledge-watch', 'general').scan),
      {
        files: 2,
        updated: 1,
        unchanged: 1,
      },
    );
    manager.synchronize('general');
    await manager.tick();
    assert.equal(parsed, 2);
    assert.equal(encoded, 2);
    assert.equal(store.get<any>('knowledge-index-job', doc.id + '|failed-target').attempts, 3);
    manager.recheck('general');
    assert.equal(store.maybe('knowledge-index-job', doc.id + '|failed-target'), undefined);
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit backfill reports zero embedding calls and writes for complete current vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backfill-counts-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let calls = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => {
      calls += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
  const knowledge = new Knowledge(store, embedding);
  try {
    const doc: any = knowledge.import('general', 'test.txt', 'Some normal source text.');
    const first = await knowledge.index(doc.id);
    assert.equal(first.encoded, 1);
    store.db.exec(
      'CREATE TEMP TABLE writes(n INTEGER); INSERT INTO writes VALUES(0); CREATE TEMP TRIGGER track AFTER UPDATE OF vector ON chunks BEGIN UPDATE writes SET n=n+1; END;',
    );
    const second = await knowledge.index(doc.id);
    assert.equal(calls, 1);
    assert.equal(second.encoded, 0);
    assert.equal(second.filled, 0);
    assert.equal(second.skipped, second.chunks);
    assert.equal((store.db.prepare('SELECT n FROM writes').get() as any).n, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic scan respects configured interval while explicit synchronization bypasses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-interval-'));
  const root = join(dir, 'docs');
  const data = join(dir, 'data');
  await mkdir(data);
  await mkdir(root);
  const store = new Store(join(data, 'db.sqlite'));
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => texts.map(() => [1, 0]),
  };
  const knowledge = new Knowledge(store, embedding);
  let parsed = 0;
  const manager = new KnowledgeMaintenance(
    store,
    knowledge,
    embedding,
    data,
    undefined,
    async () => {
      parsed++;
      return 'Parsed fixture ' + parsed;
    },
  );
  try {
    manager.saveSources({
      id: 'general',
      enabled: true,
      paths: [root],
      target: 'fixture',
      scanIntervalSeconds: 3600,
    });
    await writeFile(join(root, 'one.txt'), 'one');
    await manager.tick(false);
    assert.equal(parsed, 1);
    await writeFile(join(root, 'two.txt'), 'two');
    await manager.tick(false);
    assert.equal(parsed, 1);
    manager.synchronize('general');
    await manager.tick(false);
    assert.equal(parsed, 2);
    const before = store.get<any>('knowledge-watch', 'general');
    manager.saveSources({
      id: 'general',
      enabled: true,
      paths: [root],
      target: 'fixture',
      scanIntervalSeconds: 7200,
    });
    const after = store.get<any>('knowledge-watch', 'general');
    assert.equal(after.scanIntervalSeconds, 7200);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.issues, before.issues);
    await writeFile(join(root, 'three.txt'), 'three');
    store.put('knowledge-watch', { ...after, status: 'processing' });
    await manager.tick(false);
    assert.equal(parsed, 3, 'interrupted scan resumes without waiting for its hourly interval');
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scan persists failures before the next file finishes, preserves successes on retry, and distinguishes import errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-live-errors-'));
  const root = join(dir, 'docs');
  const data = join(dir, 'data');
  await mkdir(root);
  await mkdir(data);
  const store = new Store(join(data, 'db.sqlite'));
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => texts.map(() => [1, 0]),
  };
  const knowledge = new Knowledge(store, embedding);
  let recovering = false;
  const parsed: string[] = [];
  const manager = new KnowledgeMaintenance(
    store,
    knowledge,
    embedding,
    data,
    undefined,
    async (path) => {
      parsed.push(path);
      if (path.endsWith('a.pdf') && !recovering) throw Error('Fixture parser failure');
      if (path.endsWith('b.pdf') && !recovering) {
        const live = store.get<any>('knowledge-watch', 'general');
        assert.equal(live.currentIssues.length, 1);
        assert.equal(live.issues[0].stage, 'parse');
        assert.equal(live.progress.failed, 1);
        assert.ok(live.issues[0].observedAt);
        assert.equal(live.scan.files, 99);
      }
      return 'Readable fixture text';
    },
  );
  try {
    for (const name of ['a.pdf', 'b.pdf']) await writeFile(join(root, name), name);
    store.put('knowledge-watch', {
      id: 'general',
      paths: [root],
      enabled: true,
      target: 'fixture',
      revision: 1,
      scan: { files: 99, updated: 0, unchanged: 99 },
    });
    await manager.tick();
    const first = store.get<any>('knowledge-watch', 'general');
    assert.equal(first.issues.length, 1);
    assert.equal(first.scan.files, 2);
    assert.ok(first.scan.completedAt);
    recovering = true;
    parsed.length = 0;
    await manager.tick();
    assert.deepEqual(parsed, [join(root, 'a.pdf')]);
    assert.equal(store.get<any>('knowledge-watch', 'general').issues.length, 0);
    await writeFile(join(root, 'c.pdf'), 'new');
    knowledge.import = () => {
      throw Error('Fixture database write failure');
    };
    await manager.tick();
    assert.equal(store.get<any>('knowledge-watch', 'general').issues[0].stage, 'import');
  } finally {
    await manager.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
