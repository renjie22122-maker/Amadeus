import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentMediaType } from '../server/services/attachment-media.js';
import { createApp } from '../server/http/app.js';

test('local media upload, range playback, scope and integrity are preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amadeus-attachment-'));
  const { app, store, runtime } = await createApp({ directory });
  try {
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
    const headers = {
      host: 'localhost',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
      'x-csrf-token': boot.json().csrf,
    };
    const chat = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload: {},
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const cid = chat.json().id;
    const wav = Buffer.alloc(48);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(40, 4);
    wav.write('WAVE', 8);
    const upload = async (
      bytes: Buffer,
      name: string,
      mime: string,
      query = 'conversationId=' + cid,
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/upload?' + query,
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=fixture' },
        payload: Buffer.concat([
          Buffer.from(
            '--fixture\r\nContent-Disposition: form-data; name="file"; filename="' +
              name +
              '"\r\nContent-Type: ' +
              mime +
              '\r\n\r\n',
          ),
          bytes,
          Buffer.from('\r\n--fixture--\r\n'),
        ]),
      });
    const uploaded = await upload(wav, 'recording.wav', 'application/octet-stream');
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const imported = await runtime.media.importLocal(wav, 'from-workspace.wav', cid, 'fixture-run');
    const repeated = await runtime.media.importLocal(wav, 'from-workspace.wav', cid, 'fixture-run');
    assert.equal(imported.reference, repeated.reference);
    assert.deepEqual((await runtime.media.output(imported.reference, cid)).bytes, wav);
    const importedRecord = store.get<any>('attachment', imported.reference.slice(11));
    assert(
      importedRecord.messageEventId > 0,
      'imported media must be displayed in history, not queued as an unsent draft',
    );
    const id = uploaded.json().id,
      a = store.get<any>('attachment', id);
    assert.equal(a.mime, 'audio/wav');
    assert.match(a.text, /attachment:/);
    assert.match(a.text, /not been transcribed/);
    const preview = await app.inject({
      url: '/api/attachments/' + id + '?inline=1',
      headers: { ...headers, range: 'bytes=4-11' },
    });
    assert.equal(preview.statusCode, 206);
    assert.deepEqual(preview.rawPayload, wav.subarray(4, 12));
    assert.equal(preview.headers['content-range'], 'bytes 4-11/48');
    const invalid = await app.inject({
      url: '/api/attachments/' + id + '?inline=1',
      headers: { ...headers, range: 'bytes=100-200' },
    });
    assert.equal(invalid.statusCode, 416);
    assert.deepEqual((await runtime.media.output('attachment:' + id, cid)).bytes, wav);
    await assert.rejects(runtime.media.output('attachment:' + id, 'other'), {
      code: 'MEDIA_SCOPE',
    });
    const refs = await runtime.media.referenceOptions(cid, {}, { audio: ['attachment:' + id] });
    assert.match(String(refs.audio), /data:audio\/wav;base64/);
    await writeFile(a.path, Buffer.alloc(48));
    await assert.rejects(runtime.media.output('attachment:' + id, cid), {
      code: 'MEDIA_INTEGRITY',
    });
    const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
    const v = await upload(mp4, 'clip.mp4', 'video/mp4');
    assert.equal(v.statusCode, 200, v.body);
    assert.equal(store.get<any>('attachment', v.json().id).mime, 'video/mp4');
    const bad = await upload(Buffer.from('<html>bad</html>'), 'fake.mp4', 'video/mp4');
    assert.notEqual(bad.statusCode, 200);
    const kb = await upload(wav, 'recording.wav', 'audio/wav', 'scope=general');
    assert.notEqual(kb.statusCode, 200, 'media must not become a pretend document transcript');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('media sniffing does not treat HTML or SVG as playable media', () => {
  assert.equal(attachmentMediaType(Buffer.from('<svg onload="evil()"/>')), undefined);
  assert.equal(attachmentMediaType(Buffer.from('<html>video/mp4</html>')), undefined);
  assert.equal(attachmentMediaType(Buffer.from('ID3fixture')), 'audio/mpeg');
  assert.equal(attachmentMediaType(Buffer.from('fLaCfixture')), 'audio/flac');
});

test('import_media reads through FileScope and rejects files outside the authorized root', async () => {
  const { installMedia } = await import('../server/tools/media.js');
  const { FileScope } = await import('../server/services/paths.js');
  const directory = await mkdtemp(join(tmpdir(), 'amadeus-import-tool-'));
  const definitions: any[] = [];
  installMedia({ add: (d: any) => definitions.push(d) } as any);
  const tool = definitions.find((d) => d.name === 'import_media');
  let calls = 0;
  try {
    await writeFile(join(directory, 'sound.mp3'), Buffer.from('ID3fixture'));
    const ctx: any = {
      files: new FileScope([directory]),
      signal: new AbortController().signal,
      conversation: { id: 'chat' },
      run: { id: 'run' },
      media: {
        importLocal: async (bytes: Buffer, name: string) => {
          calls++;
          return { bytes: bytes.length, name };
        },
      },
    };
    assert.equal(
      JSON.parse((await tool.run({ path: 'sound.mp3' }, ctx)).content).name,
      'sound.mp3',
    );
    await assert.rejects(tool.run({ path: '../secret.mp3' }, ctx), { code: 'OUTSIDE_PROJECT' });
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
