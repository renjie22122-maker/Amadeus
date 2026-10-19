import { speechChunks } from '../shared/read-aloud.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '../server/services/settings.js';
import { configureLocalVoice } from '../server/services/local-voice.js';
import { submitMedia } from '../server/services/media-adapters.js';

test('local voice setup is idempotent and preserves existing microphone and other services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-voice-'));
  const config = new Configuration(join(root, 'settings.json'));
  await mkdir(join(root, 'voice-service'));
  await writeFile(
    join(root, 'voice-service/config.json'),
    '\uFEFF' + JSON.stringify({ token: 'x'.repeat(40) }),
  );
  const settings = config.get();
  settings.media!.transcriptionId = 'existing';
  config.save(settings);
  configureLocalVoice(config, root);
  configureLocalVoice(config, root);
  assert.equal(config.get().media!.transcriptionId, 'existing');
  assert.equal(config.get().media!.connections.length, 3);
  const speech = config.get().media!.connections.find((c) => c.kind === 'speech')!;
  let sent: any;
  const output = await submitMedia(
    speech,
    '你好 hello',
    speech.defaults,
    undefined,
    async (_url, init) => {
      sent = JSON.parse(String(init.body));
      return new Response('RIFFfixture', { headers: { 'content-type': 'audio/wav' } });
    },
  );
  assert.equal(sent.response_format, 'wav');
  assert.equal(sent.voice, 'default');
  assert.equal(output.binary?.mime, 'audio/wav');
});

test('plain HTTP media endpoints cannot reach LAN or remote hosts', () => {
  const config = new Configuration(join(tmpdir(), 'absent-voice-' + crypto.randomUUID()));
  for (const baseUrl of [
    'http://192.168.1.5:8812/v1',
    'http://example.com/v1',
    'http://127.0.0.1:8812/v1?secret=x',
  ]) {
    const settings = config.get();
    settings.media!.connections = [
      {
        id: 'bad',
        name: 'bad',
        protocol: 'openai-speech',
        kind: 'speech',
        baseUrl,
        model: 'cosyvoice',
        enabled: true,
        apiKey: '',
        defaults: {},
        estimatedUsd: null,
      },
    ];
    assert.throws(() => config.save(settings), /HTTPS or literal loopback/);
  }
});

test('read aloud preserves prose order, skips fenced code and splits without breaking Unicode', () => {
  const text = '你好 hello 👋。'.repeat(200);
  const chunks = speechChunks(text + '\n```js\nsecret()\n```\n[说明](https://example.com)');
  assert(chunks.length > 1);
  assert(chunks.every((part) => Array.from(part).length <= 600));
  assert(!chunks.join('').includes('secret'));
  assert(!chunks.join('').includes('https'));
  assert.equal(chunks.join('').replace(/\s/g, ''), (text + '说明').replace(/\s/g, ''));
});
