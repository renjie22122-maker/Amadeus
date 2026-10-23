import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoReview } from '../server/services/auto-review.js';
import { Inputs } from '../server/services/approvals.js';
import { Configuration } from '../server/services/settings.js';
import { Store } from '../server/storage/store.js';
import type { Run } from '../shared/types.js';
function approved() {
  return JSON.stringify({
    risk: 'low',
    authorization: 'explicit',
    evidence: [0],
    bounded: true,
    effectsKnown: true,
    sensitiveData: false,
    securityChange: false,
    reason: 'Explicit bounded read',
  });
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-review-'));
  const store = new Store(join(dir, 'db.sqlite')),
    config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...{ ...config.get(), commandBackend: 'approval-host' as const },
    profiles: [
      {
        id: 'test',
        name: 'Test',
        transport: 'openai-chat',
        baseUrl: 'https://review.example',
        model: 'test',
      },
    ],
    defaultProfileId: 'test',
  });
  store.put('conversation', { id: 'chat', permission: 'auto' });
  const run = {
    id: 'run',
    conversationId: 'chat',
    profileId: 'test',
    status: 'running',
    checkpoints: [],
  } as unknown as Run;
  store.put('run', run);
  store.event('chat', 'run', 'user.message', { content: 'Read the requested file.' });
  return { store, config, run };
}
test('automatic approval is a separate tool-free request and records its rationale and usage', async () => {
  const f = await setup();
  let count = 0;
  const review = new AutoReview(f.store, f.config, () => ({
    complete: async (req) => {
      count++;
      assert.equal(req.tools.length, 0);
      const env = JSON.parse(req.messages[1].content);
      assert.equal(env.network, 'host');
      assert.equal(env.cwdIsSecurityBoundary, false);
      return {
        message: {
          role: 'assistant',
          content: approved(),
        },
        usage: { input: 20, output: 10, cached: 0, measured: true },
      };
    },
  }));
  const inputs = new Inputs(f.store, (...args) => review.review(...args));
  const answer = await inputs.request(
    f.run,
    'approval',
    { command: 'echo hello' },
    new AbortController().signal,
  );
  assert.match(answer, /Approved by automatic/);
  assert.equal(count, 1);
  assert.equal(f.store.list<any>('approval-review')[0].usage.input, 20);
  assert.equal(f.store.list<any>('input')[0].status, 'answered');
  f.store.close();
});
test('review failure, malformed output and explicit human gates all require a person', async () => {
  const f = await setup();
  for (const content of ['not JSON', '{"decision":"allow"}']) {
    const review = new AutoReview(f.store, f.config, () => ({
      complete: async () => ({
        message: { role: 'assistant', content },
        usage: { input: 1, output: 1, cached: 0, measured: true },
      }),
    }));
    assert.equal((await review.review(f.run, {}, new AbortController().signal)).decision, 'ask');
  }
  let called = false;
  const review = new AutoReview(f.store, f.config, () => ({
    complete: async () => {
      called = true;
      throw Error();
    },
  }));
  assert.equal(
    (await review.review(f.run, { forceHuman: true }, new AbortController().signal)).decision,
    'ask',
  );
  assert.equal(called, false);
  assert.equal((await review.review(f.run, {}, new AbortController().signal)).decision, 'ask');
  f.store.close();
});
test('ask mode bypasses reviewer and mode changes invalidate automatic permission', async () => {
  const f = await setup();
  let count = 0;
  const review = new AutoReview(f.store, f.config, () => ({
    complete: async () => {
      count++;
      f.store.put('conversation', { id: 'chat', permission: 'ask' });
      return {
        message: { role: 'assistant', content: approved() },
        usage: { input: 1, output: 1, cached: 0, measured: true },
      };
    },
  }));
  assert.equal((await review.review(f.run, {}, new AbortController().signal)).decision, 'ask');
  assert.equal(await review.review(f.run, {}, new AbortController().signal), null);
  assert.equal(count, 1);
  f.store.close();
});

test('only exact built-in queries shortcut review; composed commands and high risk do not', async () => {
  const f = await setup();
  let calls = 0;
  const reviewer = new AutoReview(f.store, f.config, () => ({
    complete: async () => {
      calls++;
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            ...JSON.parse(approved()),
            risk: 'unknown',
            authorization: 'unknown',
          }),
        },
        usage: { input: 1, output: 1, cached: 0, measured: true },
      };
    },
  }));
  try {
    const signal = new AbortController().signal;
    assert.equal(
      (await reviewer.review(f.run, { command: 'cd', cwd: '.', backend: 'approval-host' }, signal))
        .decision,
      'allow',
    );
    assert.equal(calls, 0);
    for (const command of ['cd & echo other', 'cd > changed.txt', 'pwd', 'ver', 'python test.py'])
      assert.equal(
        (await reviewer.review(f.run, { command, cwd: '.', backend: 'approval-host' }, signal))
          .decision,
        'ask',
      );
    assert.equal(calls, 5);
    assert.equal(
      (
        await reviewer.review(
          f.run,
          { command: 'git push', cwd: '.', backend: 'approval-host' },
          signal,
        )
      ).decision,
      'ask',
    );
    assert.equal(calls, 6);
    assert.equal(
      (await reviewer.review(f.run, { command: 'git push', forceHuman: true }, signal)).decision,
      'ask',
    );
    assert.equal(calls, 6);
  } finally {
    f.store.close();
  }
});

test('new instructions, configuration or changed action invalidate approval', async () => {
  for (const change of ['message', 'execution', 'action']) {
    const f = await setup(),
      payload = { command: 'echo hello' };
    const reviewer = new AutoReview(f.store, f.config, () => ({
      complete: async () => {
        if (change === 'message') f.store.event('chat', 'run', 'user.message', { content: 'Stop' });
        if (change === 'execution')
          f.store.put('conversation', {
            id: 'chat',
            permission: 'auto',
            execution: { backend: 'approval-host', network: 'host' },
          });
        if (change === 'action') payload.command = 'different action';
        return {
          message: { role: 'assistant', content: approved() },
          usage: { input: 1, output: 1, cached: 0, measured: true },
        };
      },
    }));
    try {
      const result = await reviewer.review(f.run, payload, new AbortController().signal);
      assert.equal(result.decision, 'ask');
      assert.match(result.reason, /changed/);
      assert.equal(result.policyVersion, '2026-10-23.3');
    } finally {
      f.store.close();
    }
  }
});

test('reviewer sees same-session manual decisions only, never automatic grants as human authority', async () => {
  const f = await setup();
  for (const [id, chat, auto] of [
    ['human', 'chat', false],
    ['other', 'other', false],
    ['machine', 'chat', true],
  ] as const) {
    f.store.put('input', {
      id,
      conversationId: chat,
      kind: 'approval',
      status: 'answered',
      answer: 'Approved once',
      payload: { command: 'echo hello', ...(auto ? { autoReview: { decision: 'allow' } } : {}) },
    });
  }
  const reviewer = new AutoReview(f.store, f.config, () => ({
    complete: async (req) => {
      const evidence = JSON.parse(req.messages[1].content);
      assert.deepEqual(
        evidence.humanDecisions.map((d: any) => d.id),
        ['human'],
      );
      assert.match(evidence.humanDecisions[0].scope, /one-time/);
      return {
        message: { role: 'assistant', content: approved() },
        usage: { input: 1, output: 1, cached: 0, measured: true },
      };
    },
  }));
  try {
    await reviewer.review(f.run, { command: 'echo hello' }, new AbortController().signal);
  } finally {
    f.store.close();
  }
});

test('review clarification pauses exact action; alternative returns denial without executing', async () => {
  const f = await setup();
  const inputs = new Inputs(f.store, async () => ({
    decision: 'ask',
    reason: 'Need target confirmation',
    assessment: { clarification: 'May I write only the specified report?' },
  }));
  try {
    const waiting = inputs.request(
      f.run,
      'approval',
      { command: 'example' },
      new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 0));
    const item = f.store.list<any>('input')[0];
    assert.equal(item.payload.clarification, 'May I write only the specified report?');
    assert.equal(f.store.get<any>('run', 'run').status, 'waiting_approval');
    const rejected = assert.rejects(waiting, (error: any) => error.code === 'APPROVAL_DENIED');
    inputs.answer(item.id, 'Use a read-only alternative instead', false);
    await rejected;
    assert.equal(f.store.get<any>('run', 'run').status, 'running');
    assert.equal(f.store.get<any>('input', item.id).status, 'denied');
  } finally {
    f.store.close();
  }
});

test('review source reuse is bounded and never forwarded to a separate profile', async () => {
  const { reviewEvidence } = await import('../server/services/review-evidence.js');
  const run: any = {
    checkpoints: Array.from({ length: 5 }, (_, i) => [
      {
        role: 'assistant',
        calls: [{ id: String(i), name: 'read_file', arguments: { path: 'source' + i } }],
      },
      { role: 'tool', callId: String(i), content: 'x'.repeat(9000) },
    ]).flat(),
  };
  const included: any = reviewEvidence(run, true);
  assert.equal(included.reads.length, 3);
  assert.equal(included.reads[0].content.length, 8000);
  assert.equal(included.reads[0].truncated, true);
  assert.equal((reviewEvidence(run, false) as any).reads, undefined);
});

test('waiting for approval has no expiry and consumes no execution deadline', async () => {
  const f = await setup();
  const inputs = new Inputs(f.store);
  try {
    const waiting = inputs.request(
      f.run,
      'approval',
      { command: 'echo pending' },
      new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 60));
    const input = f.store.list<any>('input')[0];
    assert.equal(input.status, 'pending');
    assert.equal(f.store.get<any>('run', 'run').status, 'waiting_approval');
    inputs.answer(input.id, 'Approved', true);
    assert.equal(await waiting, 'Approved');
  } finally {
    f.store.close();
  }
});

test('reviewer reads literal scoped scripts, excludes escapes and notices changed bytes', async () => {
  const { inspectReviewSources } = await import('../server/services/review-evidence.js');
  const { FileScope } = await import('../server/services/paths.js');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'review-source-'));
  const work = join(root, 'work');
  await mkdir(work);
  await writeFile(join(root, 'outside.py'), 'secret');
  await writeFile(join(work, 'check.py'), 'print(1)');
  const files = new FileScope([work]);
  const payload = { cwd: work, command: 'python check.py && python ../outside.py' };
  const first = await inspectReviewSources(files, payload);
  assert.equal(first[0].content, 'print(1)');
  assert.equal(first[1].status, 'unavailable');
  assert.equal(JSON.stringify(first).includes('secret'), false);
  await writeFile(join(work, 'check.py'), 'print(2)');
  assert.notEqual((await inspectReviewSources(files, payload))[0].sha256, first[0].sha256);
  assert.deepEqual(await inspectReviewSources(files, { ...payload, cwd: root }), []);
});

test('review failure identifies invalid response versus provider error without leaking body', async () => {
  const f = await setup();
  try {
    const invalid = new AutoReview(f.store, f.config, () => ({
      complete: async () => ({
        message: { role: 'assistant', content: 'not JSON' },
        usage: { input: 100, output: 3, cached: 0, measured: true },
      }),
    }));
    const result = await invalid.review(f.run, {}, new AbortController().signal);
    assert.equal(result.failureCode, 'REVIEW_INVALID_RESPONSE');
    assert.equal(result.usage.input, 200);
    const failed = new AutoReview(f.store, f.config, () => ({
      complete: async () => {
        throw Error('secret-key-do-not-log');
      },
    }));
    const failure = await failed.review(f.run, {}, new AbortController().signal);
    assert.equal(failure.failureCode, 'REVIEW_PROVIDER_FAILED');
    assert.ok(!JSON.stringify(failure).includes('secret-key'));
  } finally {
    f.store.close();
  }
});
test('global test-runner termination requires human scope review without spending reviewer tokens', async () => {
  const f = await setup();
  let calls = 0;
  try {
    const reviewer = new AutoReview(f.store, f.config, () => ({
      complete: async () => {
        calls++;
        throw Error('unreachable');
      },
    }));
    const result = await reviewer.review(
      f.run,
      {
        command:
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--test' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      },
      new AbortController().signal,
    );
    assert.equal(result.decision, 'ask');
    assert.equal(result.failureCode, 'UNSCOPED_PROCESS_TERMINATION');
    assert.equal(calls, 0);
  } finally {
    f.store.close();
  }
});
test('package review follows concrete lifecycle scripts without executing them', async () => {
  const { inspectReviewSources } = await import('../server/services/review-evidence.js');
  const { FileScope } = await import('../server/services/paths.js');
  const { writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'package-review-'));
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { pretest: 'node before.js', test: 'node check.js', posttest: 'node after.js' },
      }),
    );
    for (const file of ['before.js', 'check.js', 'after.js'])
      await writeFile(join(dir, file), 'console.log("synthetic test")');
    const sources = await inspectReviewSources(new FileScope([dir]), {
      cwd: dir,
      command: 'npm test',
    });
    for (const file of ['package.json', 'before.js', 'check.js', 'after.js'])
      assert.ok(sources.some((s) => s.path.endsWith(file) && s.status === 'read'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('identical in-flight reviews share inference but never cache completed permissions', async () => {
  const f = await setup();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const review = new AutoReview(f.store, f.config, () => ({
    complete: async () => {
      calls++;
      await gate;
      return {
        message: { role: 'assistant', content: approved() },
        usage: { input: 100, output: 10, cached: 80, measured: true },
      };
    },
  }));
  const signal = new AbortController().signal;
  const first = review.review(f.run, { command: 'echo hello' }, signal);
  const second = review.review(f.run, { command: 'echo hello' }, signal);
  await new Promise((r) => setTimeout(r, 30));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.usage).length, 1);
  assert.equal(results[1].sharedReviewId, results[0].id);
  assert.equal(results[0].cache.hitRate, 0.8);
  await review.review(f.run, { command: 'echo hello' }, signal);
  assert.equal(calls, 2);
  f.store.close();
});

test('malformed assessment gets one format repair without weakening gates', async () => {
  const f = await setup();
  let calls = 0;
  const review = new AutoReview(f.store, f.config, () => ({
    complete: async () => ({
      message: { role: 'assistant', content: ++calls === 1 ? 'bad json' : approved() },
      usage: { input: 2, output: 3, cached: 0, measured: true },
    }),
  }));
  try {
    const result = await review.review(f.run, { command: 'inspect' }, new AbortController().signal);
    assert.equal(result.decision, 'allow');
    assert.equal(calls, 2);
    assert.equal(result.formatRepairAttempts, 1);
    assert.equal(result.usage.input, 4);
  } finally {
    f.store.close();
  }
});

test('concurrent malformed reviews share one bounded repair and count usage once', async () => {
  const f = await setup();
  let calls = 0;
  try {
    const reviewer = new AutoReview(f.store, f.config, () => ({
      complete: async () => {
        const count = ++calls;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          message: { role: 'assistant', content: count === 1 ? 'invalid' : approved() },
          usage: { input: 100, output: 3, cached: 0, measured: true },
        };
      },
    }));
    const signal = new AbortController().signal;
    const results = await Promise.all([
      reviewer.review(f.run, {}, signal),
      reviewer.review(f.run, {}, signal),
    ]);
    assert.equal(calls, 2);
    assert.ok(results.every((r) => r.decision === 'allow'));
    assert.equal(
      results.reduce((n, r) => n + (r.usage?.input || 0), 0),
      200,
    );
  } finally {
    f.store.close();
  }
});

test('evidence repairs return to the agent without approval or side effects and stop at three', async () => {
  const f = await setup();
  let count = 0;
  try {
    const inputs = new Inputs(f.store, async () => ({
      id: 'r' + count,
      decision: 'ask',
      cache: { requestHash: 'evidence' + count++ },
      replan: {
        kind: 'inspect',
        instruction: 'Read the target process ownership and active task status.',
      },
    }));
    for (let n = 0; n < 3; n++) {
      await assert.rejects(
        inputs.request(
          f.run,
          'approval',
          { command: 'scoped-operation' },
          new AbortController().signal,
        ),
        /REVIEW_NEEDS_EVIDENCE|NOT started/,
      );
      assert.equal(f.store.list<any>('input').length, 0);
      assert.equal(f.store.get<any>('run', f.run.id).status, 'running');
    }
    assert.equal(f.store.list<any>('review-replan').length, 3);
    const pending = inputs.request(
      f.run,
      'approval',
      { command: 'scoped-operation' },
      new AbortController().signal,
    );
    const rejected = assert.rejects(pending, /User denied/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const item = f.store.list<any>('input')[0];
    assert.equal(item.status, 'pending');
    inputs.answer(item.id, 'No', false);
    await rejected;
  } finally {
    f.store.close();
  }
});
test('unchanged evidence cannot repeatedly defer a human decision', async () => {
  const f = await setup();
  try {
    const inputs = new Inputs(f.store, async () => ({
      decision: 'ask',
      cache: { requestHash: 'same' },
      replan: { kind: 'revise', instruction: 'Use a narrower target.' },
    }));
    await assert.rejects(
      inputs.request(f.run, 'approval', {}, new AbortController().signal),
      /NOT started/,
    );
    const pending = inputs.request(f.run, 'approval', {}, new AbortController().signal);
    const rejected = assert.rejects(pending, /User denied/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inputs.answer(f.store.list<any>('input')[0].id, 'No', false);
    await rejected;
    assert.equal(f.store.list<any>('review-replan').length, 1);
  } finally {
    f.store.close();
  }
});
test('remediation is never an authorization and allows high-risk inspection but excludes critical risk and missing consent', async () => {
  const { decideAssessment } = await import('../server/services/review-policy.js');
  const base = {
    ...JSON.parse(approved()),
    risk: 'unknown',
    effectsKnown: false,
    remediation: { kind: 'inspect', instruction: 'Inspect scoped source.' },
  };
  const fixable = decideAssessment(base, [0]);
  assert.equal(fixable.decision, 'ask');
  assert.equal(fixable.replan?.kind, 'inspect');
  const high = decideAssessment({ ...base, risk: 'high' }, [0]);
  assert.equal(high.decision, 'ask');
  assert.equal(high.replan?.kind, 'inspect');
  for (const change of [
    { risk: 'critical' },
    { authorization: 'none' },
    { authorization: 'unknown' },
    { securityChange: true },
    { sensitiveData: true },
    { evidence: [99] },
  ]) {
    const review = decideAssessment({ ...base, ...change }, [0]);
    assert.equal(review.decision, 'ask');
    assert.equal(review.replan, undefined);
  }
});
