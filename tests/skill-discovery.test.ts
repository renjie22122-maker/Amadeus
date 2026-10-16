import { BackgroundCommands } from '../server/services/background-commands.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { rankSkills, taskSkills } from '../server/services/skill-discovery.js';
import { installSkills } from '../server/tools/skill-tools.js';

test('task discovery finds beyond first twenty across languages without loading bodies or forcing a match', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-routing-')),
    store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 30; i++)
    store.put('skill', {
      id: String(i),
      name: 'fixture-' + i,
      description: 'unrelated accounting',
      content: 'DO NOT AUTO LOAD',
      enabled: true,
    });
  store.put('skill', {
    id: 'image',
    name: 'image-edit',
    description: 'reference image editing',
    content: 'PRIVATE BODY',
    enabled: true,
  });
  store.put('skill', {
    id: 'off',
    name: 'image',
    description: 'image',
    content: 'DISABLED',
    enabled: false,
  });
  const found = taskSkills(store, 'r', 'c', [], '使用参考图编辑图片')!;
  assert.equal(found.recommended[0].id, 'image');
  assert.equal(found.loaded.length, 0);
  assert(!JSON.stringify(found).includes('PRIVATE BODY'));
  assert(!found.recommended.some((x) => x.id === 'off'));
  assert.equal(taskSkills(store, 'r', 'c', [], '使用参考图编辑图片'), undefined);
  assert.equal(rankSkills(store.list<any>('skill'), [], '你好').length, 0);
  assert.equal(
    taskSkills(store, 'r', 'c', [], 'accounting')!.recommended[0].name.startsWith('fixture'),
    true,
  );
});

test('skill readiness distinguishes unread, read and changed resources without granting authority', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-readiness-')),
    store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('skill', {
    id: 's',
    name: 'test',
    description: 'test',
    content: 'Read mode.md',
    source: join(dir, 'SKILL.md'),
    enabled: true,
  });
  writeFileSync(join(dir, 'mode.md'), 'current schema');
  const defs = new Map<string, any>();
  installSkills({ add: (d: any) => defs.set(d.name, d) } as any);
  const c: any = { store, run: { id: 'r' } };
  const check = async () =>
    JSON.parse(
      (await defs.get('inspect_skill_readiness').run({ id: 's', references: ['mode.md'] }, c))
        .content,
    );
  assert.equal((await check()).readingComplete, false);
  await defs.get('read_skill').run({ id: 's' }, c);
  await defs.get('read_skill_file').run({ id: 's', path: 'mode.md' }, c);
  assert.equal((await check()).readingComplete, true);
  assert.equal((await check()).permissionsGranted, false);
  writeFileSync(join(dir, 'mode.md'), 'new schema');
  assert.equal((await check()).resources[1].state, 'changed_since_read');
  c.run.id = 'another-run';
  assert.equal((await check()).readingComplete, false);
});

test('pending steering releases a wait even when its wake event preceded subscription', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'steering-race-')),
    store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const jobs = new BackgroundCommands(store);
  store.put('command-job', {
    id: 'j',
    conversationId: 'c',
    runId: 'r',
    status: 'running',
    stdout: '',
    stderr: '',
  });
  store.put('user-inbox', { id: 'msg', conversationId: 'c', state: 'pending' });
  jobs.wake('c');
  const result = await jobs.wait('c', 'j', new AbortController().signal, 1);
  assert('waitReason' in result);
  assert.equal(result.waitReason, 'user-input');
  assert.equal(result.status, 'running');
  assert.equal(store.get<any>('command-job', 'j').status, 'running');
});
