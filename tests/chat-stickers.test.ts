import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../server/storage/store.js';
import {
  listChatStickers,
  saveChatSticker,
  stickerReferences,
  removeChatSticker,
} from '../server/services/chat-stickers.js';
import type { ChatConnection } from '../shared/chat-connections.js';
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'stickers-')),
    store = new Store(join(dir, 'test.db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = {
    id: id(),
    transport: 'onebot11',
    conversationId: 'chat',
    accountId: 'bot',
    peerId: 'group',
    peerType: 'group',
    endpoint: 'ws://127.0.0.1:3009',
  } as ChatConnection;
  function image(chat = 'chat', hash = 'abc') {
    const key = id(),
      path = join(dir, key + '.png');
    writeFileSync(path, Buffer.from('image fixture'));
    store.put('attachment', {
      id: key,
      path,
      mime: 'image/png',
      sha256: hash,
      conversationId: chat,
      messageEventId: 1,
    });
    return 'attachment:' + key;
  }
  return { store, c, image };
}
test('library deduplicates bytes, updates labels and preserves originals on removal', (t) => {
  const { store, c, image } = fixture(t),
    ref = image();
  const x = saveChatSticker(store, c, { reference: ref, name: 'happy', tags: ['smile', 'smile'] });
  const y = saveChatSticker(store, c, { reference: image(), name: 'joy', tags: ['smile'] });
  assert.equal(x.id, y.id);
  assert.equal(listChatStickers(store, c, 'JOY').total, 1);
  assert.deepEqual(stickerReferences(store, c, [y.id]), [y.reference]);
  removeChatSticker(store, c, y.id);
  assert.equal(listChatStickers(store, c).total, 0);
  assert.ok(store.maybe('attachment', ref.slice(11)));
});
test('library cannot leak across conversation, peer, account or endpoint', (t) => {
  const { store, c, image } = fixture(t),
    x = saveChatSticker(store, c, { reference: image(), name: 'x' });
  assert.throws(() => saveChatSticker(store, c, { reference: image('other'), name: 'x' }));
  for (const change of [
    { conversationId: 'other' },
    { peerId: 'other' },
    { accountId: 'other' },
    { endpoint: 'ws://127.0.0.1:9999' },
  ]) {
    const other = { ...c, ...change };
    assert.equal(listChatStickers(store, other).total, 0);
    assert.throws(() => stickerReferences(store, other, [x.id]));
    assert.throws(() => removeChatSticker(store, other, x.id));
  }
});
test('missing files and unattached files cannot masquerade as sendable stickers', (t) => {
  const { store, c, image } = fixture(t),
    ref = image(),
    x = saveChatSticker(store, c, { reference: ref, name: 'x' });
  const a = store.get<any>('attachment', ref.slice(11));
  rmSync(a.path);
  assert.equal(listChatStickers(store, c).items[0].available, false);
  assert.throws(() => stickerReferences(store, c, [x.id]));
  const ref2 = image(),
    a2 = store.get<any>('attachment', ref2.slice(11));
  store.put('attachment', { ...a2, messageEventId: undefined });
  assert.throws(() => saveChatSticker(store, c, { reference: ref2, name: 'x' }));
});

test('favorites importer uses the declared API, deduplicates and never sends messages', async (t) => {
  const { store, c } = fixture(t);
  const { ChatTransports } = await import('../server/services/chat-transports.js');
  const dir = mkdtempSync(join(tmpdir(), 'sticker-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transports: any = new ChatTransports({ store, directory: dir } as any);
  const session = { abort: new AbortController() };
  transports.chatSession = () => session;
  transports.current = () => true;
  const actions: string[] = [];
  transports.socketRequest = async (_c: any, _s: any, action: string) => {
    actions.push(action);
    return ['https://example.com/1', 'https://example.com/1', 'https://example.com/fail'];
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tZAAAAAASUVORK5CYII=',
    'base64',
  );
  transports.downloadMedia = async (url: string) => {
    if (url.endsWith('fail')) throw Error('unavailable');
    return png;
  };
  const result = await transports.importFavoriteStickers(c);
  assert.deepEqual(actions, ['fetch_custom_face']);
  assert.equal(result.imported.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(listChatStickers(store, c).total, 1);
  assert.equal(listChatStickers(store, c).items[0].available, true);
  const again = await transports.importFavoriteStickers(c);
  assert.deepEqual(again.imported, result.imported);
  assert.equal(listChatStickers(store, c).total, 1);
});
test('favorites importer does not save after route changes during download', async (t) => {
  const { store, c } = fixture(t);
  const { ChatTransports } = await import('../server/services/chat-transports.js');
  const transports: any = new ChatTransports({ store } as any);
  let current = true;
  transports.chatSession = () => ({ abort: new AbortController() });
  transports.current = () => current;
  transports.socketRequest = async () => ['https://example.com/1'];
  transports.downloadMedia = async () => {
    current = false;
    return Buffer.from('89504e470d0a1a0a', 'hex');
  };
  const result = await transports.importFavoriteStickers(c);
  assert.equal(result.failed, 1);
  assert.equal(listChatStickers(store, c).total, 0);
});

test('reply plans resolve persistent stickers to local upload references without claiming delivery', async (t) => {
  const { store, c, image } = fixture(t);
  c.enabled = true;
  c.revision = 1;
  const { registerChatInteraction } = await import('../server/services/chat-interaction.js');
  registerChatInteraction({ store, get: () => c, authorize: () => {} } as any, {
    query: async () => [],
    importMedia: async () => [],
  });
  store.db.exec(
    'CREATE TABLE chat_inbox(id TEXT, connection_id TEXT, received_at INTEGER, state TEXT, text TEXT, run_id TEXT, sender_id TEXT)',
  );
  store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES('active',?,?,'running','','r')",
    )
    .run(c.id, Date.now());
  const x = saveChatSticker(store, c, { reference: image(), name: 'reaction' }),
    defs: any[] = [];
  (await import('../server/tools/chat-tools.js')).installChatTools({
    add: (x: any) => defs.push(x),
  } as any);
  const tool = defs.find((x) => x.name === 'prepare_chat_reply'),
    checked: string[] = [];
  const ctx: any = {
    store,
    conversation: { id: c.conversationId },
    run: { id: 'r' },
    media: { streamOutput: (ref: string) => checked.push(ref) },
  };
  const result = JSON.parse(
    (await tool.run(tool.schema.parse({ stickerIds: [x.id], mediaOnly: true }), ctx)).content,
  );
  assert.equal(result.prepared, true);
  assert.equal(result.finalTextWillBeSent, false);
  assert.match(result.note, /not delivered/);
  assert.deepEqual(checked, [x.reference]);
  assert.deepEqual(store.get<any>('chat-reply-plan', 'r').references, [x.reference]);
});
