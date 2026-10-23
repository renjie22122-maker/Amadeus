import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaConnection, MediaJob } from '../shared/media.js';
import {
  submitMedia,
  pollMedia,
  mediaHttp,
  extractMedia,
} from '../server/services/media-adapters.js';
import { MediaService, safeGlb } from '../server/services/media.js';
import { Configuration } from '../server/services/settings.js';
import { Store } from '../server/storage/store.js';
const connection = (
  protocol: MediaConnection['protocol'],
  kind: MediaConnection['kind'] = 'image',
): MediaConnection => ({
  id: 'service',
  name: 'fixture',
  protocol,
  kind,
  baseUrl: 'https://media.example/v1',
  apiKey: 'fixture-key',
  model: 'fixture/model',
  enabled: true,
  defaults: {},
  estimatedUsd: null,
});
const response = (data: any) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
test('media protocols send scoped auth and never retry submissions', async () => {
  for (const protocol of [
    'openai-image',
    'gemini-image',
    'gemini-music',
    'meshy',
    'tripo',
  ] as const) {
    let count = 0;
    let sent: any;
    const out = await submitMedia(
      connection(protocol),
      'hello',
      {},
      undefined,
      async (url, init) => {
        count++;
        sent = { url, body: JSON.parse(String(init.body)), headers: init.headers };
        return response(
          protocol === 'meshy'
            ? { result: 'task' }
            : protocol === 'tripo'
              ? { data: { task_id: 'task' } }
              : { data: [{ b64_json: 'AA==' }] },
        );
      },
    );
    assert.equal(count, 1);
    assert.ok(sent.url.startsWith('https://media.example/'));
    assert.ok(out.data);
  }
  let calls = 0;
  await assert.rejects(
    submitMedia(connection('openai-image'), 'x', {}, undefined, async () => {
      calls++;
      throw Error('connection dropped');
    }),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    mediaHttp(connection('openai-image'), 'https://foreign.example/result', {}, async () => {
      throw Error('must not fetch');
    }),
    { code: 'MEDIA_ORIGIN' },
  );
});
test('fal stores returned receipt URLs; completed requests download result without new POST', async () => {
  const c = connection('fal');
  let urls: string[] = [];
  const receipt = await submitMedia(c, 'draw', {}, undefined, async (_url, init) => {
    assert.equal(init.method, 'POST');
    return response({
      request_id: 'job',
      status_url: c.baseUrl + '/job/status',
      response_url: c.baseUrl + '/job/result',
      cancel_url: c.baseUrl + '/job/cancel',
    });
  });
  const out = await pollMedia(c, { ...receipt } as unknown as MediaJob, async (url, init) => {
    urls.push(url);
    assert.equal(init.method, 'GET');
    return response(
      url.endsWith('/status')
        ? { status: 'COMPLETED' }
        : { images: [{ url: 'https://assets.example/image.png' }] },
    );
  });
  assert.equal(out.state, 'done');
  assert.deepEqual(urls, [c.baseUrl + '/job/status', c.baseUrl + '/job/result']);
});
test('transcription uses actual audio bytes and correct provider-specific upload protocol', async () => {
  const audio = { bytes: Buffer.from('audio-fixture'), mime: 'audio/webm', name: 'recording.webm' };
  for (const protocol of ['openai-transcription', 'deepgram', 'assemblyai'] as const) {
    let calls = 0;
    const c = connection(protocol, 'transcription');
    await submitMedia(c, '', {}, audio, async (url, init) => {
      calls++;
      if (protocol === 'openai-transcription') {
        assert.ok(init.body instanceof FormData);
        assert.equal((init.body.get('file') as File).name, 'recording.webm');
      }
      if (protocol === 'deepgram')
        assert.deepEqual(Buffer.from(init.body as Uint8Array), audio.bytes);
      return response(
        url.endsWith('/upload')
          ? { upload_url: 'https://uploads.example/audio' }
          : { id: 'transcript', text: 'hello' },
      );
    });
    assert.equal(calls, protocol === 'assemblyai' ? 2 : 1);
  }
});
test('native asynchronous video requests retain the provider operation ID', async () => {
  for (const protocol of ['openai-video', 'gemini-video', 'replicate'] as const) {
    const c = connection(protocol, 'video');
    const r = await submitMedia(c, 'scene', {}, undefined, async () =>
      response(
        protocol === 'gemini-video' ? { name: 'operations/id' } : { id: 'id', status: 'queued' },
      ),
    );
    assert.ok(r.remoteId);
    assert.ok(r.statusUrl?.startsWith(c.baseUrl));
  }
});
test('media result parsing handles image, music, 3D and transcription without fetching input URLs', () => {
  assert.equal(extractMedia({ data: [{ b64_json: 'YWJj' }] }).assets[0].base64, 'YWJj');
  assert.equal(
    extractMedia({
      steps: [{ content: [{ type: 'audio', data: 'YWJj', mime_type: 'audio/mpeg' }] }],
    }).assets[0].mime,
    'audio/mpeg',
  );
  assert.equal(
    extractMedia({
      model_mesh: { url: 'https://assets.example/model.glb' },
      input: { image_url: 'https://private.example/source' },
    }).assets.length,
    1,
  );
  assert.equal(
    extractMedia({ results: { channels: [{ alternatives: [{ transcript: '中文' }] }] } }).text,
    '中文',
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-media-'));
  const store = new Store(join(dir, 'db.sqlite')),
    config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...config.get(),
    media: {
      connections: [connection('openai-image')],
      transcriptionId: '',
      autoApproveMaxUsd: null,
    },
  });
  store.put('conversation', { id: 'chat' });
  return { dir, store, config };
}
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRkcAAAAASUVORK5CYII=';
test('generation operation identity deduplicates concurrent submissions; local outputs are scoped', async () => {
  const f = await fixture();
  let requests = 0;
  const media = new MediaService(f.store, f.config, f.dir, async () => {
    requests++;
    return response({ data: [{ b64_json: png }] });
  });
  const args = {
    connectionId: 'service',
    conversationId: 'chat',
    operationKey: 'same',
    prompt: 'image',
  };
  const [a, b] = await Promise.all([media.submit(args), media.submit(args)]);
  assert.equal(a.id, b.id);
  await media.close();
  assert.equal(requests, 1);
  const job = media.get(a.id, 'chat');
  assert.equal(job.status, 'completed');
  assert.equal(job.outputs.length, 1);
  assert.throws(() => media.get(a.id, 'different'), { code: 'MEDIA_SCOPE' });
  const file = f.store.get<any>('media-file', a.id + ':0');
  assert.ok((await readFile(file.path)).length);
  f.store.close();
});
test('interrupted submission becomes unknown and is never automatically resubmitted', async () => {
  const f = await fixture();
  let requests = 0;
  f.store.put('media-job', {
    id: 'j',
    operationKey: 'old',
    conversationId: 'chat',
    status: 'submitting',
    createdAt: 1,
    outputs: [],
  });
  const media = new MediaService(f.store, f.config, f.dir, async () => {
    requests++;
    return response({});
  });
  media.start();
  await media.close();
  assert.equal(media.get('j', 'chat').status, 'unknown');
  assert.equal(requests, 0);
  f.store.close();
});
test('media keys never appear in public settings and are not reused after origin changes', async () => {
  const f = await fixture();
  assert.ok(!JSON.stringify(f.config.public()).includes('fixture-key'));
  const next = f.config.public();
  next.media.connections[0].baseUrl = 'https://other.example';
  f.config.save(next);
  assert.equal(f.config.get().media!.connections[0].apiKey, '');
  f.store.close();
});
test('safe GLB preview rejects external resources and malformed files', () => {
  const glb = (j: any) => {
    let s = JSON.stringify(j);
    s += ' '.repeat((4 - (s.length % 4)) % 4);
    const b = Buffer.alloc(20 + s.length);
    b.write('glTF');
    b.writeUInt32LE(2, 4);
    b.writeUInt32LE(b.length, 8);
    b.writeUInt32LE(s.length, 12);
    b.writeUInt32LE(0x4e4f534a, 16);
    b.write(s, 20);
    return b;
  };
  assert.equal(safeGlb(glb({ asset: { version: '2.0' } })), true);
  assert.equal(safeGlb(glb({ images: [{ uri: 'https://private.example/secret' }] })), false);
  assert.equal(safeGlb(Buffer.from('not a model')), false);
});

test('generated output handles support QA, references, no-clobber export and isolation', async () => {
  const { FileScope } = await import('../server/services/paths.js');
  const { normalizeImage } = await import('../server/services/images.js');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const sharp = (await import('sharp')).default;
  const f = await fixture();
  try {
    const pixels = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const media = new MediaService(f.store, f.config, f.dir, async () =>
      response({ data: [{ b64_json: pixels.toString('base64') }] }),
    );
    const job = await media.submit({
      connectionId: 'service',
      conversationId: 'chat',
      operationKey: 'chain',
      prompt: 'red',
    });
    await media.close();
    const receipt = media.public(media.get(job.id, 'chat'));
    const ref = receipt.outputs[0].reference;
    assert.match(ref, /^media:/);
    assert.equal(receipt.outputs[0].access.export.tool, 'export_media');
    assert.equal(receipt.outputs[0].access.export.arguments.reference, ref);
    assert.equal(receipt.outputs[0].access.view?.arguments.mediaRef, ref);
    assert.ok(receipt.outputs[0].url.includes('/files/0'));
    const output = await media.output(ref, 'chat');
    assert.deepEqual(output.bytes, pixels);
    assert.ok((await normalizeImage(output.bytes)).url.startsWith('data:image/'));
    const references = await media.referenceOptions('chat', {}, { image_url: [ref] });
    assert.equal(references.image_url, 'data:image/png;base64,' + pixels.toString('base64'));
    await assert.rejects(media.output(ref, 'other'), { code: 'MEDIA_SCOPE' });
    await assert.rejects(media.referenceOptions('other', {}, { image_url: [ref] }), {
      code: 'MEDIA_SCOPE',
    });
    const root = join(f.dir, 'workspace');
    await mkdir(root);
    const scope = new FileScope([root]);
    await scope.writeBytes('frames/key.png', output.bytes);
    assert.deepEqual(await readFile(join(root, 'frames/key.png')), pixels);
    await assert.rejects(scope.writeBytes('frames/key.png', Buffer.from('replacement')));
    assert.deepEqual(await readFile(join(root, 'frames/key.png')), pixels);
    await assert.rejects(scope.writeBytes('../outside.png', pixels));
    await assert.rejects(scope.writeBytes('.git/config', pixels));
    const file = f.store.get<any>('media-file', job.id + ':0');
    await writeFile(file.path, 'modified');
    await assert.rejects(media.output(ref, 'chat'), { code: 'MEDIA_INTEGRITY' });
  } finally {
    f.store.close();
  }
});

test('all generated media kinds expose export routes including historical receipts', async () => {
  const f = await fixture();
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { FileScope } = await import('../server/services/paths.js');
  try {
    const media = new MediaService(f.store, f.config, f.dir);
    const root = join(f.dir, 'exports');
    await mkdir(root);
    const files = new FileScope([root]);
    for (const [kind, mime, ext] of [
      ['image', 'image/png', 'png'],
      ['video', 'video/mp4', 'mp4'],
      ['music', 'audio/mpeg', 'mp3'],
      ['speech', 'audio/wav', 'wav'],
      ['model3d', 'model/gltf-binary', 'glb'],
    ]) {
      const jobId = 'fixture-' + kind,
        reference = 'media:' + jobId + ':0';
      const bytes = Buffer.from('fixture-bytes-' + kind),
        path = join(f.dir, jobId + '.' + ext);
      await writeFile(path, bytes);
      // Legacy shape has no access/reference fields: public receipt upgrades it dynamically.
      f.store.put('media-job', {
        id: jobId,
        conversationId: 'chat',
        kind,
        status: 'completed',
        outputs: [{ id: '0', name: '0.' + ext, mime }],
      });
      f.store.put('media-file', {
        id: jobId + ':0',
        conversationId: 'chat',
        jobId,
        path,
        mime,
        name: '0.' + ext,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const receipt = media.public(media.get(jobId, 'chat')).outputs[0];
      assert.equal(receipt.reference, reference);
      assert.equal(receipt.access.export.arguments.reference, reference);
      assert.equal(!!receipt.access.view, kind === 'image');
      const output = await media.output(reference, 'chat');
      await files.writeBytes(kind + '.' + ext, output.bytes);
      assert.deepEqual(await readFile(join(root, kind + '.' + ext)), bytes);
      if (kind === 'model3d')
        await assert.rejects(media.referenceOptions('chat', {}, { model: [reference] }), {
          code: 'MEDIA_REFERENCE',
        });
      else {
        const options = await media.referenceOptions('chat', {}, { inputs: [reference] });
        assert.deepEqual(options.inputs, ['data:' + mime + ';base64,' + bytes.toString('base64')]);
      }
      await assert.rejects(media.output(reference, 'other'), { code: 'MEDIA_SCOPE' });
    }
  } finally {
    f.store.close();
  }
});

test('media intent and recovery binding persist before provider submission', async () => {
  const f = await fixture();
  let effectId = '',
    seen = false;
  f.store.put('run', { id: 'r', conversationId: 'chat', status: 'running' });
  const media = new MediaService(f.store, f.config, f.dir, async () => {
    assert.ok(effectId);
    const ref = f.store.get<any>('effect-reference', effectId);
    assert.equal(f.store.get<any>('media-job', ref.jobId).status, 'submitting');
    seen = true;
    throw new Error('lost response');
  });
  await media.submit({
    connectionId: 'service',
    conversationId: 'chat',
    operationKey: 'receipt',
    prompt: 'image',
    run: f.store.get<any>('run', 'r'),
    prepared: (jobId) => {
      effectId = f.store.beginEffect('r', 'generate_media', {});
      f.store.put('effect-reference', { id: effectId, runId: 'r', protocol: 'media-job', jobId });
    },
  });
  await media.close();
  assert.equal(seen, true);
  assert.equal(f.store.unknownEffects('chat').length, 1);
  f.store.close();
});

test('speech submissions queue fairly, cancel before dispatch, and stay conversation scoped', async () => {
  const f = await fixture();
  f.config.save({
    ...f.config.get(),
    media: { ...f.config.get().media, connections: [connection('openai-speech', 'speech')] },
  });
  f.store.put('conversation', { id: 'other' });
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const seen: string[] = [];
  const media = new MediaService(f.store, f.config, f.dir, async (_url, init) => {
    const input = JSON.parse(String(init.body)).input;
    seen.push(input);
    if (input === 'first') await barrier;
    return new Response(Buffer.from('fixture audio'), { headers: { 'Content-Type': 'audio/wav' } });
  });
  const submit = (conversationId: string, prompt: string) =>
    media.submit({
      connectionId: 'service',
      conversationId,
      prompt,
      operationKey: prompt,
    });
  try {
    const first = await submit('chat', 'first');
    const second = await submit('chat', 'second');
    const cancelled = await submit('chat', 'cancelled');
    const other = await submit('other', 'other');
    assert.equal(second.status, 'queued');
    assert.equal(other.status, 'queued');
    assert.throws(() => media.get(second.id, 'other'), /another conversation/);
    await media.cancel(cancelled.id, 'chat');
    release();
    // close preserves waiting jobs, so wait for completion before shutdown.
    const end = Date.now() + 5000;
    while (media.get(second.id, 'chat').status !== 'completed') {
      assert(Date.now() < end);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(seen, ['first', 'other', 'second']);
    assert.equal(media.get(first.id, 'chat').status, 'completed');
    assert.equal(media.get(cancelled.id, 'chat').status, 'cancelled');
    assert.equal(f.store.list('speech-dispatch').length, 0);
  } finally {
    release();
    await media.close();
    f.store.close();
  }
});
test('only explicit local VOICE_BUSY is retryable, generic 429 remains an error', async () => {
  const c = { ...connection('openai-speech', 'speech'), baseUrl: 'http://127.0.0.1:8812/v1' };
  await assert.rejects(
    mediaHttp(
      c,
      c.baseUrl + '/audio/speech',
      {},
      async () =>
        new Response(JSON.stringify({ error: 'VOICE_BUSY: not accepted' }), {
          status: 429,
          headers: { 'Retry-After': '3' },
        }),
    ),
    (e: any) => e.code === 'MEDIA_VOICE_BUSY' && e.retryAfterMs === 3000,
  );
  await assert.rejects(
    mediaHttp(
      c,
      c.baseUrl + '/audio/speech',
      {},
      async () => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 }),
    ),
    (e: any) => e.code === 'MEDIA_HTTP',
  );
});

test('restart resumes only undispatched speech and never replays an uncertain submission', async () => {
  const f = await fixture();
  f.config.save({
    ...f.config.get(),
    media: { ...f.config.get().media, connections: [connection('openai-speech', 'speech')] },
  });
  const first = new MediaService(f.store, f.config, f.dir, async () => {
    throw Error('must not send');
  });
  const lease = await first.speechAdmission.acquire('https://media.example', 'blocker');
  const queued = await first.submit({
    connectionId: 'service',
    conversationId: 'chat',
    prompt: 'resume',
    operationKey: 'resume',
  });
  assert.equal(queued.status, 'queued');
  await first.close();
  lease();
  assert(f.store.maybe('speech-dispatch', queued.id));
  f.store.put('media-job', {
    ...f.store.get<any>('media-job', queued.id),
    id: 'uncertain',
    status: 'submitting',
  });
  let requests = 0;
  const restored = new MediaService(f.store, f.config, f.dir, async () => {
    requests++;
    return new Response(Buffer.from('audio'), { headers: { 'Content-Type': 'audio/wav' } });
  });
  try {
    restored.start();
    const end = Date.now() + 5000;
    while (restored.get(queued.id, 'chat').status !== 'completed') {
      assert(Date.now() < end);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(requests, 1);
    assert.equal(restored.get('uncertain', 'chat').status, 'unknown');
  } finally {
    await restored.close();
    f.store.close();
  }
});
