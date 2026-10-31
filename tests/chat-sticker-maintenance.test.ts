import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Store, id } from '../server/storage/store.js';
import { ChatStickerMaintenance } from '../server/services/chat-sticker-maintenance.js';
import {
  saveChatSticker,
  listChatStickers,
  stickerContext,
  recordStickerUse,
  removeChatSticker,
} from '../server/services/chat-stickers.js';
async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-auto-'));
  const store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.db.exec(
    'CREATE TABLE chat_received(connection_id TEXT,message_id TEXT,sender TEXT,payload TEXT,at INTEGER)',
  );
  const c: any = {
    id: 'connection',
    conversationId: 'chat',
    peerId: 'group',
    peerType: 'group',
    senderId: 'owner',
    allGroupMembers: true,
    accessMode: 'chat',
    transport: 'onebot11',
    accountId: 'bot',
    revision: 1,
    enabled: true,
  };
  store.put('chat-connection', c);
  store.put('conversation', { id: 'chat', profileId: 'p' });
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const aid = id(),
    path = join(dir, 'image.png');
  writeFileSync(path, bytes);
  store.put('attachment', {
    id: aid,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png',
    conversationId: 'chat',
    messageEventId: 1,
  });
  const add = (mid: string, peerId = 'group') =>
    store.db.prepare('INSERT INTO chat_received VALUES(?,?,?,?,?)').run(
      c.id,
      mid,
      'owner',
      JSON.stringify({
        peerId,
        peerType: 'group',
        senderId: 'owner',
        text: 'hello',
        media: [{ kind: 'image' }],
      }),
      Date.now(),
    );
  add('one');
  let calls = 0,
    saves = 0;
  let suitable = true;
  let mutate = () => {};
  const profile: any = { vision: true, timeoutMs: 1000 };
  const channels: any = {
    store,
    list: () => [c],
    authorize: () => {},
    runtime: { config: { profile: () => profile } },
  };
  const worker = () =>
    new ChatStickerMaintenance(
      channels,
      {
        query: async () => ({}),
        importMedia: async () => ['attachment:' + aid],
        saveSticker: async (c, a) => {
          saves++;
          return saveChatSticker(store, c, a);
        },
      },
      () => ({
        complete: async () => {
          calls++;
          mutate();
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                suitable,
                name: 'greeting',
                tags: ['hello'],
                reason: 'visible reaction',
              }),
            },
            usage: { input: 1, output: 1, cached: 0, measured: true },
          };
        },
      }),
    );
  return {
    store,
    c,
    add,
    worker,
    profile,
    calls: () => calls,
    saves: () => saves,
    setSuitable: (v: boolean) => (suitable = v),
    setMutation: (fn: () => void) => (mutate = fn),
  };
}
test('automatic collection persists once across worker restarts and repeated image messages', async (t) => {
  const f = await fixture(t);
  await f.worker().tick();
  assert.equal(f.saves(), 1);
  await f.worker().tick();
  f.add('two');
  await f.worker().tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.saves(), 1);
  const x = listChatStickers(f.store, f.c).items[0];
  recordStickerUse(f.store, f.c, x.reference, 'delivery');
  recordStickerUse(f.store, f.c, x.reference, 'delivery');
  assert.equal(f.store.get<any>('chat-sticker-use', x.id).count, 1);
  assert.match(stickerContext(f.store, f.c, 'hello'), /greeting/);
  assert.doesNotMatch(stickerContext(f.store, { ...f.c, peerId: 'foreign' }, 'hello'), /greeting/);
  removeChatSticker(f.store, f.c, x.id);
  f.add('three');
  await f.worker().tick();
  assert.equal(f.saves(), 1);
});
test('unsuitable images and foreign routes never enter library', async (t) => {
  const f = await fixture(t);
  f.setSuitable(false);
  f.add('foreign', 'another');
  await f.worker().tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.saves(), 0);
  await f.worker().tick();
  assert.equal(f.calls(), 1);
});
test('disabled vision and revoked connection cannot cause collection', async (t) => {
  const f = await fixture(t);
  f.profile.vision = false;
  await f.worker().tick();
  assert.equal(f.calls(), 0);
  f.profile.vision = true;
  f.setMutation(() => f.store.put('chat-connection', { ...f.c, enabled: false }));
  await f.worker().tick();
  assert.equal(f.saves(), 0);
});

test('repeated classification failure stops after five attempts', async (t) => {
  const f = await fixture(t);
  f.setMutation(() => {
    throw Error('temporary provider failure');
  });
  for (let i = 0; i < 7; i++) {
    for (const r of f.store.list<any>('chat-sticker-review'))
      f.store.put('chat-sticker-review', { ...r, nextAt: 0 });
    await f.worker().tick();
  }
  assert.equal(f.calls(), 5);
  assert.equal(f.saves(), 0);
  assert.equal(f.store.get<any>('chat-sticker-maintenance', f.c.id).state, 'needs_attention');
});
