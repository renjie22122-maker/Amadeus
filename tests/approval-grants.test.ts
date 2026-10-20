import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import { Inputs } from '../server/services/approvals.js';
import { ApprovalGrants } from '../server/services/approval-grants.js';
import { canRememberApproval } from '../shared/approval-grants.js';
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'approval-grants-')),
    store = new Store(join(dir, 'db.sqlite'));
  store.put('conversation', { id: 'chat', permission: 'ask', profileId: 'model', projectId: null });
  const run: any = {
    id: 'run',
    conversationId: 'chat',
    profileId: 'model',
    status: 'running',
    checkpoints: [],
  };
  store.put('run', run);
  const inputs = new Inputs(store);
  const payload = {
    command: 'Generate speech',
    backend: 'media-service',
    cwd: 'http://127.0.0.1:8812',
    forceHuman: true,
    estimatedUsd: 0,
    repeatable: { kind: 'media-generation', serviceId: 'voice', fingerprint: 'a'.repeat(64) },
    request: { model: 'tts', prompt: 'hello', options: { voice: 'one' }, referenceAttachments: {} },
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, run, inputs, payload };
}
async function allow(f: ReturnType<typeof setup>, payload: any = f.payload) {
  const pending = f.inputs.request(f.run, 'approval', payload, new AbortController().signal);
  const q = f.store.list<any>('input').find((x) => x.status === 'pending')!;
  f.inputs.answer(q.id, 'Allow and remember reviewed scope', true, true);
  await pending;
  return f.store.get<any>('input', q.id).payload.rememberedGrantId;
}
test('remembered service approval survives a new Inputs instance and permits voices, parameters and scoped references', async (t) => {
  const f = setup(t),
    grantId = await allow(f);
  const second = new Inputs(f.store);
  const reply = await second.request(
    f.run,
    'approval',
    {
      ...f.payload,
      request: {
        ...f.payload.request,
        prompt: 'new prose',
        options: { voice: 'two', speed: 1.1 },
        referenceAttachments: { image: ['attachment:owned'] },
      },
    },
    new AbortController().signal,
  );
  assert(reply.includes(grantId));
  assert.equal(second.grants.list('chat')[0].remaining, 99);
  second.grants.revoke(grantId);
  assert.equal(second.grants.consume('chat', f.payload), undefined);
});
test('grants never cross service, endpoint, configuration, conversation, price or authority boundaries', async (t) => {
  const f = setup(t);
  await allow(f);
  for (const p of [
    { ...f.payload, cwd: 'https://other.example' },
    { ...f.payload, repeatable: { ...f.payload.repeatable, serviceId: 'other' } },
    { ...f.payload, repeatable: { ...f.payload.repeatable, fingerprint: 'b'.repeat(64) } },
    { ...f.payload, estimatedUsd: 0.01 },
    { ...f.payload, forceManual: true },
    { ...f.payload, action: 'resolve-effect' },
  ])
    assert.equal(f.inputs.grants.consume('chat', p), undefined);
  f.store.put('conversation', { id: 'other', permission: 'ask' });
  assert.equal(f.inputs.grants.consume('other', f.payload), undefined);
  f.store.put('conversation', { id: 'chat', permission: 'read-only' });
  assert.equal(f.inputs.grants.consume('chat', f.payload), undefined);
});
test('exact operation approval preserves all execution parameters, expires and exhausts deterministically', async (t) => {
  const f = setup(t),
    p = {
      command: 'python report.py --source data.csv',
      backend: 'docker',
      cwd: '/workspace',
      request: { scriptHash: 'abc' },
      reason: 'report',
    };
  const id = await allow(f, p),
    grants = new ApprovalGrants(f.store);
  assert(grants.consume('chat', { ...p, reason: 'same operation' }));
  for (const changed of [
    { ...p, command: p.command + ' --delete' },
    { ...p, cwd: '/other' },
    { ...p, request: { scriptHash: 'changed' } },
  ])
    assert.equal(grants.consume('chat', changed), undefined);
  f.store.put('approval-grant', { ...f.store.get<any>('approval-grant', id), remaining: 1 });
  assert(grants.consume('chat', p));
  assert.equal(grants.consume('chat', p), undefined);
  f.store.put('approval-grant', {
    ...f.store.get<any>('approval-grant', id),
    remaining: 100,
    expiresAt: Date.now() - 1,
  });
  assert.equal(grants.consume('chat', p), undefined);
  assert.equal(canRememberApproval({ command: 'Discover extension by name' }), false);
});
test('remembering fails if permissions change during review; denial does not create grants', async (t) => {
  const f = setup(t),
    controller = new AbortController();
  const pending = f.inputs.request(f.run, 'approval', f.payload, controller.signal);
  const q = f.store.list<any>('input')[0];
  f.store.put('conversation', { id: 'chat', permission: 'read-only' });
  assert.throws(() => f.inputs.answer(q.id, 'remember', true, true), /authority changed/);
  assert.equal(f.inputs.grants.list('chat').length, 0);
  f.inputs.answer(q.id, 'Denied', false);
  await assert.rejects(pending, /denied/);
});
