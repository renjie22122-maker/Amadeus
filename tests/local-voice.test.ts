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
    '\uFEFF' + JSON.stringify({ token: 'x'.repeat(40), listenPort: 9876 }),
  );
  const settings = config.get();
  settings.media!.transcriptionId = 'existing';
  config.save(settings);
  configureLocalVoice(config, root);
  configureLocalVoice(config, root);
  assert.equal(config.get().media!.transcriptionId, 'existing');
  assert.equal(config.get().media!.connections.length, 3);
  const speech = config.get().media!.connections.find((c) => c.kind === 'speech')!;
  assert.equal(speech.baseUrl, 'http://127.0.0.1:9876/v1');
  assert.equal(speech.capabilities?.readAloud?.protocol, 'wav-ndjson-v1');
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
  assert.equal(sent.read_aloud_units, undefined);
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

test('speech budgets bound mixed-language segments and reject invalid sizes without losing text', () => {
  const text = '你好，这是本地朗读。 Hello, please read the next message. 👋 '.repeat(6);
  const chunks = speechChunks(text, 20, true);
  assert(
    chunks.every(
      (part) =>
        Array.from(part).reduce((n, c) => n + (/^[\x00-\x7f]$/.test(c) ? 0.25 : 1), 0) <= 20,
    ),
  );
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(speechChunks('abc', 0).join(''), 'abc');
  assert.equal(speechChunks('abc', NaN).join(''), 'abc');
});

test('narration can finish a sentence past its soft budget without unbounded segments', () => {
  const sentence = '找到原因了，不是剪辑加的，是提示词中的一段描述被模型画成了画面。';
  const parts = speechChunks(sentence.repeat(4), 20, true, true);
  assert(parts.every((part) => part.endsWith('。')));
  assert.equal(parts.join(''), sentence.repeat(4));
  const long = speechChunks('字'.repeat(1000), 20, true, true);
  assert(long.every((part) => part.length <= 60));
  assert.equal(long.join('').length, 1000);
});
