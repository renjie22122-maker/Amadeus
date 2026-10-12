import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import { FileScope } from '../server/services/paths.js';
import { inspectEffects } from '../server/services/recovery.js';
import { nativeReceipt } from '../server/services/native-receipt.js';
import { execute } from '../server/services/process.js';
import { TaskAcceptance, acceptanceStatus } from '../server/services/task-acceptance.js';
import { stamp } from '../server/services/verification.js';
import { prepareResume } from '../server/core/resume-preparation.js';

test('maybe distinguishes absence, corrupt records and a closed database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-audit-')),
    store = new Store(join(dir, 's.sqlite'));
  assert.equal(store.maybe('fixture', 'missing'), undefined);
  store.db.prepare('INSERT INTO records VALUES(?,?,?)').run('fixture', 'bad', '{');
  assert.throws(
    () => store.maybe('fixture', 'bad'),
    (e: any) => e.code === 'RECORD_CORRUPT',
  );
  store.close();
  assert.throws(() => store.maybe('fixture', 'missing'));
});

test('concurrent no-clobber exports publish exactly once and clean their temporary entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publish-audit-')),
    files = new FileScope([dir]);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => files.writeBytes('out', Buffer.from('value-' + i))),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(await files.read('out'), /^value-\d+$/);
  assert.deepEqual(await readdir(dir), ['out']);
  await assert.rejects(files.read('out', 2), /bytes/);
});

test('ancestor junction swap at the validation boundary rejects publication without overwriting outside files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'path-race-'));
  const root = join(dir, 'root'),
    outside = join(dir, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'child'));
  await writeFile(join(outside, 'target'), 'outside-sentinel');
  const files = new FileScope([root]),
    original = files.resolve.bind(files);
  let switched = false,
    targetChecks = 0;
  files.resolve = async (name, write) => {
    if (name === 'child/target' && write) targetChecks++;
    if (!switched && name === 'child/target' && targetChecks === 3) {
      // An independent filesystem actor can replace an ancestor between awaited checks.
      await rename(join(root, 'child'), join(root, 'old-child'));
      await symlink(
        outside,
        join(root, 'child'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      switched = true;
    }
    return original(name, write);
  };
  await assert.rejects(files.write('child/target', 'secret'));
  assert.equal(switched, true);
  assert.equal(await readFile(join(outside, 'target'), 'utf8'), 'outside-sentinel');
  if (process.platform === 'win32') await rmdir(join(root, 'child'));
  else await unlink(join(root, 'child'));
});

test('recovery uses bound same-conversation receipts; unknown non-idempotent effects never replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-audit-')),
    store = new Store(join(dir, 's.sqlite'));
  try {
    store.put('run', { id: 'r', conversationId: 'c', status: 'interrupted' });
    const valid = store.beginEffect('r', 'generate_media', {});
    const unknown = store.beginEffect('r', 'remote_charge', {});
    const foreign = store.beginEffect('r', 'generate_media', {});
    store.put('media-job', {
      id: 'job',
      runId: 'r',
      conversationId: 'c',
      status: 'queued',
      remoteId: 'provider-receipt',
    });
    store.put('media-job', {
      id: 'foreign',
      runId: 'r',
      conversationId: 'other',
      status: 'completed',
    });
    for (const [id, jobId] of [
      [valid, 'job'],
      [foreign, 'foreign'],
    ])
      store.put('effect-reference', { id, runId: 'r', protocol: 'media-job', jobId });
    const result = await inspectEffects(store, new FileScope([dir]), 'c');
    assert.deepEqual(result.resolved, [valid]);
    assert.deepEqual(new Set(result.unresolved.map((e) => e.id)), new Set([unknown, foreign]));
    assert.ok(result.unresolved.every((e) => e.replayAllowed === false));
    assert.equal(store.events('c').filter((e) => e.type === 'effect.reconciled').length, 1);
  } finally {
    store.close();
  }
});

test('unknown backend and Docker root/mount ambiguity refuse execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backend-audit-'));
  for (const config of [
    { commandBackend: 'typo' },
    { commandBackend: 'docker', dockerUser: '0:0' },
  ])
    await assert.rejects(
      execute('echo should-not-run', dir, new AbortController().signal, 1000, config as any),
      (e: any) => ['UNKNOWN_BACKEND', 'DOCKER_POLICY'].includes(e.code),
    );
  await assert.rejects(
    execute('echo no', dir + ',extra', new AbortController().signal, 1000, {
      commandBackend: 'docker',
    } as any),
    (e: any) => e.code === 'DOCKER_POLICY',
  );
});
test('native strict-offline receipt is mandatory and cannot silently imply host fallback', () => {
  const base = { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  assert.throws(
    () => nativeReceipt(base, 'deny'),
    (e: any) => e.code === 'NATIVE_OUTCOME_UNKNOWN',
  );
  assert.throws(
    () => nativeReceipt({ ...base, commandStarted: false, preflight: { allowed: false } }, 'deny'),
    (e: any) => e.code === 'SANDBOX_PREFLIGHT_FAILED',
  );
  assert.equal(
    nativeReceipt({ ...base, commandStarted: true, preflight: { allowed: true } }, 'deny').code,
    0,
  );
  assert.throws(() => nativeReceipt({ ...base, code: '0' }, 'host'));
});

test('semantic acceptance is separate, evidence-bound, independent and invalidated by changed artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-audit-')),
    store = new Store(join(dir, 's.sqlite'));
  try {
    const author = {
      id: 'author',
      parentRunId: 'reviewer',
      conversationId: 'c',
      status: 'running',
      checkpoints: [],
    } as any;
    const reviewer = { ...author, id: 'reviewer', parentRunId: null };
    store.put('run', author);
    store.put('run', reviewer);
    const files = new FileScope([dir]);
    await files.write('code.txt', 'checked');
    const snapshot = await stamp(files, ['code.txt']);
    const event = store.event('c', 'reviewer', 'tool.completed', {
      verification: {
        passed: true,
        before: snapshot,
        after: snapshot,
        checkedPaths: ['code.txt'],
      },
    });
    const task: any = {
      id: 't',
      title: 't',
      status: 'done',
      owner: 'author',
      acceptance: 'a criterion',
      requireIndependent: true,
      requireSemantic: true,
      artifacts: ['code.txt'],
      dependsOn: [],
      evidence: [event.id],
      verification: { status: 'checked', independent: true, stamp: snapshot },
    };
    store.put('task-board', { id: 'reviewer', revision: 1, tasks: [task] });
    assert.equal(acceptanceStatus(store, 'reviewer', task).semanticAssessment, 'not-recorded');
    const args = {
      taskId: 't',
      revision: 1,
      verdict: 'accepted' as const,
      rationale: 'Observed criterion coverage',
      counterexample: 'Checked rejected input preserves state',
      eventIds: [event.id],
    };
    await assert.rejects(new TaskAcceptance(store).record(author, files, args), /distinct/);
    await new TaskAcceptance(store).record(reviewer, files, args);
    assert.equal(acceptanceStatus(store, 'reviewer', task).semanticAssessment, 'accepted');
    assert.equal(acceptanceStatus(store, 'reviewer', task).humanAcceptance, 'not-recorded');
    await files.write('code.txt', 'changed');
    await assert.rejects(new TaskAcceptance(store).record(reviewer, files, args), /changed/);
    task.verification.status = 'stale';
    assert.equal(acceptanceStatus(store, 'reviewer', task).semanticAssessment, 'stale');
  } finally {
    store.close();
  }
});

test('resume closes unmatched calls once without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-audit-')),
    store = new Store(join(dir, 's.sqlite'));
  try {
    const run: any = {
      id: 'r',
      conversationId: 'c',
      checkpoints: [
        { role: 'assistant', calls: [{ id: 'call', name: 'run_command', arguments: {} }] },
      ],
    };
    await prepareResume(store, run, new FileScope([dir]));
    await prepareResume(store, run, new FileScope([dir]));
    assert.equal(run.checkpoints.filter((m: any) => m.role === 'tool').length, 1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM effects').get()?.n, 0);
  } finally {
    store.close();
  }
});
