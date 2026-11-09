import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { identifyAttachment } from '../server/services/attachment-identification.js';

test('content recovers HTML even with missing or misleading extensions', async () => {
  for (const name of ['file', 'file.bin', 'file.txt']) {
    const found = await identifyAttachment(
      name,
      Buffer.from('<!doctype html><html><script>never executed</script></html>'),
    );
    assert.equal(found.name, 'file.html');
    assert.equal(found.mime, 'text/html');
  }
  assert.equal((await identifyAttachment('file', Buffer.from('%PDF-1.7\n'))).name, 'file.pdf');
});
test('Office containers are identified from entries, not a ZIP filename', async () => {
  for (const [entry, extension] of [
    ['word/document.xml', 'docx'],
    ['xl/workbook.xml', 'xlsx'],
    ['ppt/presentation.xml', 'pptx'],
  ]) {
    const zip = new JSZip().file('[Content_Types].xml', '<Types/>').file(entry, '<document/>');
    const result = await identifyAttachment(
      'file',
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    assert.equal(result.name, 'file.' + extension);
  }
  const plain = await new JSZip().file('note.txt', 'hello').generateAsync({ type: 'nodebuffer' });
  assert.equal((await identifyAttachment('claimed.docx', plain)).name, 'claimed.zip');
});
test('media signatures and executable rejection do not trust names', async () => {
  assert.equal((await identifyAttachment('file', Buffer.from('GIF89a'))).name, 'file.gif');
  assert.equal(
    (await identifyAttachment('safe.html', Buffer.from('MZ executable'))).executable,
    true,
  );
  assert.equal((await identifyAttachment('file', Buffer.from([0, 1, 2, 3]))).name, 'file');
});
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/storage/store.js';
import { repairAttachmentText } from '../server/services/attachment-text-repair.js';
import { storeChatAttachment } from '../server/services/chat-media.js';

test('HTML reception and verified legacy repair preserve bytes and ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-recovery-'));
  const store = new Store(join(dir, 'test.db'));
  try {
    const bytes = Buffer.from('<!doctype html><html><body>真实 HTML 文档</body></html>');
    const key = await storeChatAttachment(
      store,
      dir,
      'conversation',
      'inbox',
      { name: 'file', kind: 'file' } as any,
      bytes,
      new AbortController().signal,
    );
    const saved = store.get<any>('attachment', key);
    assert.equal(saved.name, 'file.html');
    assert.match(saved.text, /真实 HTML/);
    assert.deepEqual(await readFile(saved.path), bytes);
    const legacy = {
      ...saved,
      name: 'file',
      mime: 'application/octet-stream',
      text: 'Remote file attachment. Content has not been interpreted.',
    };
    store.put('attachment', legacy);
    const repaired = await repairAttachmentText(store, legacy);
    assert.equal(repaired.conversationId, 'conversation');
    assert.equal(repaired.remoteInboxId, 'inbox');
    assert.equal(repaired.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(repaired.name, 'file.html');
    assert.equal(store.get<any>('attachment-text-recovery', key).originalName, 'file');
    await writeFile(saved.path, 'changed');
    assert.equal(await repairAttachmentText(store, legacy), legacy);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive signatures recognize containers and retain compressed TAR suffixes', async () => {
  const cases: [string, Buffer, string][] = [
    ['file', Buffer.from([55, 122, 188, 175, 39, 28]), 'file.7z'],
    ['file', Buffer.from([31, 139, 8, 0]), 'file.gz'],
    ['bundle.tar.gz', Buffer.from([31, 139, 8, 0]), 'bundle.tar.gz'],
    ['file', Buffer.from('BZh9'), 'file.bz2'],
    ['file', Buffer.from([253, 55, 122, 88, 90, 0]), 'file.xz'],
  ];
  for (const [name, bytes, expected] of cases)
    assert.equal((await identifyAttachment(name, bytes)).name, expected);
  const tar = Buffer.alloc(512);
  tar.write('ustar', 257);
  assert.equal((await identifyAttachment('file', tar)).name, 'file.tar');
});
import { incoming } from '../server/services/chat-protocols.js';
test('OneBot preserves alternate file names and opaque file IDs', () => {
  for (const field of ['file_name', 'filename']) {
    const messages = incoming(
      {
        transport: 'onebot11',
        peerId: '123',
        senderId: '123',
        accountId: '456',
        kind: 'private',
      } as any,
      {
        post_type: 'message',
        time: Date.now() / 1000,
        message_type: 'private',
        user_id: 123,
        self_id: 456,
        message_id: 1,
        message: [{ type: 'file', data: { file_id: 'opaque-file-id', [field]: 'notes.html' } }],
      },
    );
    assert.equal(messages[0]?.media?.[0]?.name, 'notes.html');
    assert.equal(messages[0]?.media?.[0]?.id, 'opaque-file-id');
  }
});
