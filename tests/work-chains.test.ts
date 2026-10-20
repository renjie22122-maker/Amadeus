import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../server/tools/registry.js';
import { installWorkChains, pythonCommand, pythonSource } from '../server/tools/work-chains.js';
import { checkResponse } from '../server/core/response-contract.js';
import { installMedia } from '../server/tools/media.js';
import { installDocumentTools } from '../server/tools/document-tools.js';
import { approvalSnapshot } from '../server/tools/approval-snapshot.js';
import { FileScope } from '../server/services/paths.js';
import { extractIsolated } from '../server/services/document-parser.js';
const definitions = () => {
  const defs = new Map<string, any>();
  const registry = { add: (d: any) => defs.set(d.name, d) } as any;
  installWorkChains(registry);
  installMedia(registry);
  installDocumentTools(registry);
  return defs;
};
function ctx(backend = 'docker'): any {
  return {
    config: {
      get: () => ({
        commandBackend: backend,
        web: { enabled: true },
        media: { transcriptionId: 'stt', autoApproveMaxUsd: 1 },
      }),
    },
    conversation: { id: 'chat', permission: 'ask', projectId: 'project' },
    run: { id: 'run', depth: 0 },
    signal: new AbortController().signal,
    store: { maybe: () => undefined },
    callId: 'call',
  };
}
test('Python source cannot break out of shell quoting, including unicode and shell substitutions', () => {
  const code = 'print("你好 $() ` & \\\" ")\n# next';
  const cmd = pythonCommand(code);
  assert(!cmd.includes('你好'));
  assert(!cmd.includes('$('));
  const encoded = cmd.match(/b64decode\('([^']+)'\)/)![1];
  assert.equal(Buffer.from(encoded, 'base64').toString(), code);
  assert.throws(() => pythonCommand('中'.repeat(5000)), /12 KB/);
});
test('isolated analysis fails closed on host; Docker delegates once with required backend', async () => {
  const d = definitions().get('run_python');
  let calls = 0;
  const c = ctx('approval-host');
  c.invokeTool = async () => {
    calls++;
  };
  await assert.rejects(() => d.run({ code: 'print(1)' }, c), /Docker/);
  assert.equal(calls, 0);
  const docker = ctx();
  docker.invokeTool = async (name: string, args: any) => {
    calls++;
    assert.equal(name, 'run_command');
    assert.equal(args.requiredBackend, 'docker');
    return { content: 'job', outcome: { status: 'succeeded', code: 'COMMAND_SCHEDULED' } };
  };
  assert.equal(
    (await d.run({ code: 'print(1)', folder: 0, reason: 'calculate', timeoutSeconds: 600 }, docker))
      .outcome.code,
    'COMMAND_SCHEDULED',
  );
  assert.equal(calls, 1);
});
test('tool plan validates all calls, current scope and dependency indexes without executing', () => {
  const registry = new ToolRegistry();
  let executed = 0;
  registry.add({
    name: 'read_x',
    effect: 'read',
    description: 'read',
    schema: z.object({ path: z.string() }),
    run: () => {
      executed++;
      return { content: '' };
    },
  });
  const c = ctx();
  assert.equal(registry.checkCall('read_x', { path: 'a' }, c).valid, true);
  assert.equal(registry.checkCall('read_x', { path: 42 }, c).valid, false);
  assert.equal(registry.checkCall('read_x', { path: 'a', invented: true }, c).valid, false);
  c.conversation.allowedTools = [];
  assert.equal(registry.checkCall('read_x', { path: 'a' }, c).valid, false);
  assert.equal(executed, 0);
  const defs = new Map<string, any>();
  installWorkChains({
    add: (d: any) => defs.set(d.name, d),
    checkCall: (...args: any[]) => (registry.checkCall as any)(...args),
  } as any);
  c.conversation.allowedTools = undefined;
  const result = JSON.parse(
    defs.get('inspect_tool_plan').run(
      {
        calls: [
          { name: 'read_x', arguments: { path: 'a' }, dependsOn: [] },
          { name: 'missing', arguments: {}, dependsOn: [2] },
        ],
      },
      c,
    ).content,
  );
  assert.equal(result.valid, false);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[1].invalidDependencies, [2]);
  assert.equal(executed, 0);
});
test('format checks preserve ordinary prose; strict formats reject wrappers without rewriting', () => {
  const c = { prefix: '', userRequirement: 'requested', format: 'text' } as const;
  assert.deepEqual(checkResponse('<answer>42</answer>', c), []);
  for (const text of ['<answer>42</answer>', '**42**', '42 kg', '42\nextra'])
    assert(checkResponse(text, { ...c, format: 'number' }).length);
  assert.deepEqual(
    checkResponse('FINAL ANSWER: 42', { ...c, format: 'number', prefix: 'FINAL ANSWER: ' }),
    [],
  );
  assert(checkResponse('```json\n{}\n```', { ...c, format: 'json' }).length);
  assert.deepEqual(checkResponse('{"value":42}', { ...c, format: 'json' }), []);
  assert(checkResponse('<answer>cat</answer>', { ...c, format: 'single-line' }).length);
});
test('approval detects changed project, permissions or execution backend', () => {
  const c = ctx();
  let current = { ...c.conversation };
  c.store.maybe = () => current;
  const validate = approvalSnapshot(c);
  validate();
  current.permission = 'read-only';
  assert.throws(validate, /changed/);
});
test('transcription binds a durable job after upload approval and never uploads on denial', async () => {
  const d = definitions().get('transcribe_media');
  const c = ctx();
  // This isolated tool fixture has no chat transport tables.
  c.store.db = { prepare: () => ({ get: () => undefined }) };
  let submitted = 0,
    approved = false,
    bound = false;
  const service = {
    id: 'stt',
    kind: 'transcription',
    baseUrl: 'https://example.com',
    name: 'STT',
    model: 'model',
    estimatedUsd: 0.1,
  };
  c.media = {
    connection: () => service,
    streamOutput: () => ({
      metadata: { mime: 'audio/wav', name: 'a.wav', sha256: 'abc' },
      chunks: (async function* () {
        yield Buffer.from('audio');
      })(),
    }),
    submit: async (a: any) => {
      assert(approved);
      assert.equal(a.operationKey, 'run:call');
      assert.equal(a.audio.bytes.toString(), 'audio');
      a.prepared('job');
      submitted++;
      return { id: 'job' };
    },
  };
  c.bindEffect = (protocol: string, id: string) => {
    assert.equal(protocol, 'media-job');
    assert.equal(id, 'job');
    bound = true;
  };
  c.inputs = {
    request: async () => {
      approved = true;
    },
  };
  await d.run({ reference: 'attachment:a', reason: 'transcribe' }, c);
  assert.equal(submitted, 1);
  assert(bound);
  c.inputs.request = async () => {
    throw Error('denied');
  };
  await assert.rejects(() => d.run({ reference: 'attachment:a' }, c), /denied/);
  assert.equal(submitted, 1);
  c.inputs.request = async () => {
    c.store.maybe = () => ({ ...c.conversation, permission: 'read-only' });
  };
  await assert.rejects(() => d.run({ reference: 'attachment:a' }, c), /changed/);
  assert.equal(submitted, 1);
});
test('frame sampling enforces mounted folder and returns image-read guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chain-frame-'));
  try {
    await writeFile(join(root, 'clip.mp4'), 'fixture');
    const c = ctx();
    c.files = new FileScope([root]);
    let called = false;
    c.invokeTool = async (name: string, args: any) => {
      called = true;
      assert.equal(name, 'run_python');
      assert(args.code.includes('requestedSeconds'));
      assert(args.code.includes('read_image'));
      return { content: 'queued' };
    };
    await definitions()
      .get('extract_media_frames')
      .run({ path: 'clip.mp4', folder: 0, seconds: [0, 2], reason: 'inspect' }, c);
    assert(called);
    assert.throws(() =>
      definitions()
        .get('extract_media_frames')
        .schema.parse({ path: 'x', seconds: [-1], reason: 'x' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('document reader stages scoped bytes, returns pagination, rejects outside paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chain-document-'));
  try {
    await writeFile(join(root, 'notes.txt'), 'abcdef');
    const c = ctx();
    c.files = new FileScope([root]);
    c.inputs = { request: async () => {} };
    const d = definitions().get('read_document');
    const result = JSON.parse((await d.run({ path: 'notes.txt', offset: 1, limit: 3 }, c)).content);
    assert.equal(result.text, 'bcd');
    assert.equal(result.nextOffset, 4);
    assert.equal(result.totalCharacters, 6);
    await writeFile(join(root, 'notes.txt'), 'changed');
    await assert.rejects(
      () => d.run({ path: 'notes.txt', offset: 4, limit: 3, expectedSha256: result.sha256 }, c),
      /changed between pages/,
    );
    await assert.rejects(() => d.run({ path: '../outside.txt', offset: 0, limit: 3 }, c));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('document parsing respects an already cancelled request without launching work', async () => {
  await assert.rejects(async () => extractIsolated('missing', 1000, AbortSignal.abort()), /abort/i);
});

test('approval sees exactly the encoded Python, never a fabricated source hint', () => {
  const code = 'print("hello")';
  const command = pythonCommand(code);
  assert.equal(pythonSource(command)?.code, code);
  assert.equal(pythonSource(command + ' && dangerous'), undefined);
  assert.equal(pythonSource('echo benign'), undefined);
});
