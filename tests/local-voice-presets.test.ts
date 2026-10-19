import { MediaService } from '../server/services/media.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveLocalVoice,
  deleteLocalVoice,
  inspectReferencePcm,
  localVoiceCapabilities,
  listLocalVoices,
  useLocalVoice,
  previewLocalVoice,
} from '../server/services/local-voice-presets.js';
import { Configuration } from '../server/services/settings.js';
import { configureLocalVoice } from '../server/services/local-voice.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'voice-presets-'));
  await mkdir(join(root, 'voice-service'));
  await writeFile(
    join(root, 'voice-service/config.json'),
    JSON.stringify({
      token: 'x'.repeat(40),
      device: 'auto',
      voices: { default: { audio: 'private-path', text: 'source transcript' } },
    }),
  );
  return root;
}
test('voice import normalizes to an owned UUID WAV and preserves secrets and existing voices', async () => {
  const root = await fixture();
  try {
    const saved = await saveLocalVoice(
      root,
      { name: '../../reference', text: 'こんにちは。', consent: 'true', language: 'ja' },
      Buffer.from('encoded'),
      async (_, output) => {
        await writeFile(output, Buffer.alloc(48000 * 4, 12));
      },
    );
    assert.equal(saved.duration, 4);
    assert.equal(saved.language, 'ja');
    assert.equal(saved.text, 'こんにちは。');
    const config = JSON.parse(await readFile(join(root, 'voice-service/config.json'), 'utf8'));
    assert.equal(config.token, 'x'.repeat(40));
    assert.equal(config.device, 'auto');
    assert.equal(config.voices.default.audio, 'private-path');
    assert.equal(
      config.voices[saved.id].audio,
      join(root, 'voice-service/voices', saved.id + '.wav'),
    );
    assert.equal((await readFile(config.voices[saved.id].audio)).subarray(0, 4).toString(), 'RIFF');
    const listing = JSON.stringify(listLocalVoices(root));
    assert(!listing.includes('private-path'));
    assert(!listing.includes('x'.repeat(40)));
    assert.deepEqual(await readdir(join(root, 'voice-service/voices')), [saved.id + '.wav']);
    const settings = new Configuration(join(root, 'settings.json'));
    configureLocalVoice(settings, root);
    useLocalVoice(settings, root, saved.id);
    assert.equal(
      settings.get().media!.connections.find((c) => c.kind === 'speech')!.defaults.voice,
      saved.id,
    );
    assert.throws(() => useLocalVoice(settings, root, '../../other'), /configured voice/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('invalid, overlong and undecodable voice uploads do not create usable presets', async () => {
  const root = await fixture();
  try {
    const fields = { name: 'test', text: 'words', consent: 'true' };
    await assert.rejects(
      saveLocalVoice(root, { ...fields, consent: 'false' }, Buffer.from('audio')),
    );
    await assert.rejects(saveLocalVoice(root, fields, Buffer.alloc(0)), /Reference recording/);
    await assert.rejects(
      saveLocalVoice(root, fields, Buffer.from('audio'), async (_, output) => {
        await writeFile(output, Buffer.alloc(48000 * 31));
      }),
      /30 seconds/,
    );
    await assert.rejects(
      saveLocalVoice(root, fields, Buffer.from('audio'), async () => {
        throw Error('decoder failure');
      }),
      /decoder/,
    );
    assert.deepEqual(await readdir(join(root, 'voice-service/voices')), []);
    assert.equal(listLocalVoices(root).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('voice preview uses a configured ID and fixed authenticated loopback endpoint', async () => {
  const root = await fixture();
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8812/v1/audio/speech');
      assert.equal(options?.redirect, 'error');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.voice, 'default');
      assert.equal(body.response_format, 'wav');
      return new Response(Buffer.from('RIFFtest'));
    }) as typeof fetch;
    await assert.rejects(
      previewLocalVoice(root, { id: '../file', language: 'en' }),
      /configured voice/,
    );
    assert.equal(calls, 0);
    const result = await previewLocalVoice(root, { id: 'default', language: 'en' });
    assert.equal(Buffer.from(result.audio, 'base64').toString(), 'RIFFtest');
    assert.equal(calls, 1);
    await previewLocalVoice(root, { id: 'default', language: 'ja' });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('reference limits follow CosyVoice and technical checks distinguish silence from quiet audio', () => {
  assert.equal(localVoiceCapabilities.maxReferenceSeconds, 30);
  assert.throws(() => inspectReferencePcm(Buffer.alloc(48000 * 3)), /silent/);
  assert.throws(() => inspectReferencePcm(Buffer.alloc(48000 * 30 + 2, 1)), /30 seconds/);
  const quiet = Buffer.alloc(48000 * 3);
  for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(10, i);
  assert.deepEqual(inspectReferencePcm(quiet).warnings, ['quiet']);
  const clipped = Buffer.alloc(48000 * 30);
  for (let i = 0; i < clipped.length; i += 2) clipped.writeInt16LE(32767, i);
  assert(inspectReferencePcm(clipped).warnings.includes('clipping'));
  assert.equal(inspectReferencePcm(clipped).duration, 30);
  assert(inspectReferencePcm(Buffer.alloc(48000, 12)).warnings.includes('short'));
});

test('pretrained and reference voices share a catalog without changing references', async () => {
  const root = await fixture();
  try {
    const model = join(root, 'model');
    await mkdir(model);
    await writeFile(join(model, 'preset-voices.json'), JSON.stringify(['speaker-a', 'speaker-b']));
    const path = join(root, 'voice-service/config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.models = { 'cosyvoice-sft': model };
    await writeFile(path, JSON.stringify(config));
    const voices = listLocalVoices(root);
    assert.deepEqual(
      voices.map((v) => v.id),
      ['default', 'preset:speaker-a', 'preset:speaker-b'],
    );
    assert.equal(voices[1].source, 'preset');
    assert.equal(voices[1].text, '');
    const settings = new Configuration(join(root, 'settings.json'));
    configureLocalVoice(settings, root);
    const media = new MediaService({} as any, settings, root);
    const publicCatalog = media.connections().find((c) => c.kind === 'speech')!;
    assert.equal(publicCatalog.voices!.length, 3);
    assert(!JSON.stringify(publicCatalog).includes('source transcript'));
    assert(!JSON.stringify(publicCatalog).includes('private-path'));
    assert(!JSON.stringify(publicCatalog).includes('x'.repeat(40)));
    useLocalVoice(settings, root, 'preset:speaker-b');
    assert.equal(
      settings.get().media!.connections.find((c) => c.kind === 'speech')!.defaults.voice,
      'preset:speaker-b',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only uploaded clones can be revoked; defaults, presets and generated audio remain protected', async () => {
  const root = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 202 });
  try {
    const voice = await saveLocalVoice(
      root,
      { name: 'test clone', text: 'ordinary reference', consent: 'true' },
      Buffer.from('audio'),
      async (_, output) => {
        await writeFile(output, Buffer.alloc(48000, 12));
      },
    );
    const settings = new Configuration(join(root, 'settings.json'));
    configureLocalVoice(settings, root);
    useLocalVoice(settings, root, voice.id);
    await assert.rejects(deleteLocalVoice(settings, root, voice.id), /another default/);
    await assert.rejects(deleteLocalVoice(settings, root, 'default'));
    await assert.rejects(deleteLocalVoice(settings, root, 'preset:Chinese'));
    useLocalVoice(settings, root, 'default');
    const receipt = await deleteLocalVoice(settings, root, voice.id);
    assert.equal(receipt.cleanupPending, true);
    assert(!listLocalVoices(root).some((v) => v.id === voice.id));
    assert.throws(() => useLocalVoice(settings, root, voice.id), /configured voice/);
    const saved = JSON.parse(await readFile(join(root, 'voice-service/config.json'), 'utf8'));
    assert.equal(saved.voices[voice.id].text, undefined);
    assert.equal(saved.voices[voice.id].deleted, true);
    assert.equal(saved.voices.default.text, 'source transcript');
    assert.equal(saved.token, 'x'.repeat(40));
    assert(
      (await readFile(saved.voices[voice.id].audio)).length > 0,
      'reference remains until active worker releases it',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
