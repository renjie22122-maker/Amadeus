import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app.js';
import { FileScope } from '../server/services/paths.js';
import { deliverFile } from '../server/services/file-delivery.js';

test('delivered files are immutable, authenticated, deduplicated per run, and downloadable as attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amadeus-delivery-'));
  const { app, store } = await createApp({ directory: dir });
  try {
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
    const headers = {
      host: 'localhost',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
      'x-csrf-token': boot.json().csrf,
    };
    const chat = (
      await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} })
    ).json();
    const path = join(dir, 'report.md');
    await writeFile(path, 'original 内容');
    const files = new FileScope([dir]);
    const item = await deliverFile(
      store,
      chat.id,
      'run-1',
      '报告.md',
      files.readChunks('report.md'),
    );
    const repeated = await deliverFile(
      store,
      chat.id,
      'run-1',
      '报告.md',
      files.readChunks('report.md'),
    );
    assert.equal(item.id, repeated.id);
    await writeFile(path, 'later edits');
    const denied = await app.inject({ url: item.downloadUrl, headers: { host: 'localhost' } });
    assert.equal(denied.statusCode, 401);
    const download = await app.inject({ url: item.downloadUrl, headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, 'original 内容');
    assert.match(String(download.headers['content-disposition']), /^attachment;/);
    assert.match(String(download.headers['content-disposition']), /%E6%8A%A5/);
    assert.equal(store.events(chat.id).filter((e) => e.type === 'file.attached').length, 1);
    assert.equal(store.attachmentMetadata(chat.id)[0].path, undefined);
    const cancelled = AbortSignal.abort();
    await assert.rejects(
      deliverFile(store, chat.id, 'run-1', 'bad.txt', [Buffer.from('x')], cancelled),
    );
    assert.equal(store.attachmentMetadata(chat.id).length, 1);
    await assert.rejects(
      deliverFile(store, chat.id, 'run-1', 'bad.txt', files.readChunks('../outside.txt')),
    );
    assert.equal(store.attachmentMetadata(chat.id).length, 1);
    const preview = await app.inject({ url: item.downloadUrl + '?view=text', headers });
    assert.equal(preview.json().text, 'original 内容');
    assert.equal(preview.json().truncated, false);
    const large = await deliverFile(store, chat.id, 'run-large', 'large.txt', [
      Buffer.alloc(300000, 97),
    ]);
    const bounded = await app.inject({ url: large.downloadUrl + '?view=text', headers });
    assert.equal(bounded.json().text.length, 256 * 1024);
    assert.equal(bounded.json().truncated, true);
    const invalidPdf = await app.inject({ url: item.downloadUrl + '?view=pdf', headers });
    assert.notEqual(invalidPdf.statusCode, 200);
    const frame = await deliverFile(
      store,
      chat.id,
      'capture',
      'frame.png',
      [Buffer.from('test')],
      undefined,
      {
        event: 'interaction.frame',
        adapter: 'test browser',
        capability: 'browser',
        tool: 'screenshot',
      },
    );
    assert.ok(
      store
        .events(chat.id)
        .some((e) => e.type === 'interaction.frame' && e.data.attachment.id === frame.id),
    );
    const html = await deliverFile(store, chat.id, 'run-2', 'active.html', [
      Buffer.from('<script>alert(1)</script>'),
    ]);
    const response = await app.inject({ url: html.downloadUrl, headers });
    const safeText = await app.inject({ url: html.downloadUrl + '?view=text', headers });
    assert.equal(safeText.json().text, '<script>alert(1)</script>');
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.match(String(response.headers['content-disposition']), /^attachment;/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
