import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { FileScope } from '../server/services/paths.js';
import { installSkills, materializeSkill } from '../server/tools/skill-tools.js';
import { execute } from '../server/services/process.js';
import { Configuration } from '../server/services/settings.js';

test('skill resources copy exact bytes, preserve layout, execute and reject overwrites and escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-resources-'));
  const source = join(root, 'library'),
    work = join(root, 'work');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(work);
  const store = new Store(join(root, 'db.sqlite'));
  const files = new FileScope([work]);
  try {
    store.put('skill', {
      id: 's',
      name: 'fixture',
      description: 'file generation',
      content: 'Use scripts/build.cjs',
      source: join(source, 'SKILL.md'),
      enabled: true,
    });
    const bytes = Buffer.from([0, 255, 128, 1, 2]);
    await writeFile(join(source, 'asset.bin'), bytes);
    await writeFile(
      join(source, 'scripts/build.cjs'),
      "const fs=require('node:fs');const path=require('node:path');const b=fs.readFileSync(path.join(__dirname,'../asset.bin'));console.log(b.toString('hex'));",
    );
    await materializeSkill(store, files, 's', 'asset.bin', 'bundle/asset.bin');
    await materializeSkill(store, files, 's', 'scripts/build.cjs', 'bundle/scripts/build.cjs');
    assert.deepEqual(await readFile(join(work, 'bundle/asset.bin')), bytes);
    assert((await materializeSkill(store, files, 's', 'asset.bin', 'bundle/asset.bin')).reused);
    const result = await execute(
      '"' + process.execPath + '" bundle/scripts/build.cjs',
      work,
      new AbortController().signal,
      5000,
      { ...new Configuration(join(root, 'settings.json')).get(), commandBackend: 'approval-host' },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /00ff800102/);
    await writeFile(join(work, 'different'), 'keep me');
    await assert.rejects(
      materializeSkill(store, files, 's', 'asset.bin', 'different'),
      /Destination differs/,
    );
    assert.equal(await readFile(join(work, 'different'), 'utf8'), 'keep me');
    await assert.rejects(materializeSkill(store, files, 's', '../db.sqlite', 'bad'));
    await assert.rejects(materializeSkill(store, files, 's', 'asset.bin', '../outside'));
    store.put('skill', { ...store.get<any>('skill', 's'), enabled: false });
    await assert.rejects(materializeSkill(store, files, 's', 'asset.bin', 'disabled'), /disabled/);
  } finally {
    store.close();
  }
});

test('skill discovery is paginated, prioritizes selection and never exposes private source paths or disabled skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-discovery-'));
  const store = new Store(join(root, 'db.sqlite'));
  const defs = new Map<string, any>();
  installSkills({ add: (d: any) => defs.set(d.name, d) } as any);
  try {
    for (const id of ['a', 'b', 'off'])
      store.put('skill', {
        id,
        name: 'PDF ' + id,
        description: 'parse tables',
        content: 'instructions ' + id,
        source: 'private-secret-path',
        enabled: id !== 'off',
      });
    const ctx = {
      store,
      run: { id: 'r' },
      conversation: { skillIds: ['b'] },
      config: {
        get: () => ({ embedding: { backend: 'remote', baseUrl: '', model: '', apiKey: '' } }),
      },
      signal: new AbortController().signal,
    };
    const first = JSON.parse(
      (await defs.get('find_skills').run({ query: 'pdf', offset: 0, limit: 1 }, ctx)).content,
    );
    assert.equal(first.total, 2);
    assert.equal(first.skills[0].id, 'b');
    assert.equal(first.nextOffset, 1);
    assert(!JSON.stringify(first).includes('private-secret-path'));
    assert.equal((await defs.get('read_skill').run({ id: 'a' }, ctx)).content, 'instructions a');
    assert.throws(() => defs.get('read_skill').run({ id: 'off' }, ctx), /disabled/);
    assert.equal(defs.get('materialize_skill_file').effect, 'write');
  } finally {
    store.close();
  }
});
