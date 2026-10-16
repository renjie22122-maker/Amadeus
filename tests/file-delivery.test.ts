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
    const html = await deliverFile(store, chat.id, 'run-2', 'active.html', [
      Buffer.from('<script>alert(1)</script>'),
    ]);
    const response = await app.inject({ url: html.downloadUrl, headers });
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.match(String(response.headers['content-disposition']), /^attachment;/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
