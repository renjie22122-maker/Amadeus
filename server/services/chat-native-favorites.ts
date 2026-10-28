import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assert } from '../core/errors.js';
import type { Store } from '../storage/store.js';
import type { ChatConnection } from '../../shared/chat-connections.js';
import { chatRoute } from './chat-recall.js';
import { saveChatSticker, stickerReferences, type ChatSticker } from './chat-stickers.js';
type Request = (action: string, params: unknown) => Promise<any>;
export type NativeFavorite = {
  state: 'confirmed' | 'unconfirmed' | 'failed';
  md5: string;
  resId?: string;
  at: number;
};
export function favoriteDetails(value: unknown): { md5: string; resId: string; url: string }[] {
  assert(Array.isArray(value), 'CHAT_FAVORITES_UNSUPPORTED', 'Bridge has no favorite details API.');
  return value
    .filter(
      (x: any) =>
        x &&
        /^[a-f0-9]{32}$/i.test(x.md5) &&
        typeof x.resId === 'string' &&
        typeof x.url === 'string',
    )
    .map((x: any) => ({ md5: x.md5.toLowerCase(), resId: x.resId, url: x.url }));
}
export async function saveNativeFavorite(
  store: Store,
  c: ChatConnection,
  input: unknown,
  request: Request,
  current: () => boolean,
) {
  const row = saveChatSticker(store, c, input);
  if (c.transport !== 'onebot11') return row;
  const a = store.get<any>('attachment', row.reference.slice(11));
  const bytes = await readFile(a.path);
  assert(
    bytes.length <= 8 * 1024 * 1024,
    'CHAT_STICKER_SIZE',
    'Native favorites limited to 8 MiB.',
  );
  assert(
    createHash('sha256').update(bytes).digest('hex') === row.sha256,
    'CHAT_STICKER_CHANGED',
    'Attachment changed before native import.',
  );
  const md5 = createHash('md5').update(bytes).digest('hex');
  const update = (native: NativeFavorite) => {
    assert(current(), 'CHAT_CHANGED', 'Chat changed during native favorite operation.');
    const latest = store.get<ChatSticker>('chat-sticker', row.id);
    const saved = { ...latest, native };
    store.put('chat-sticker', saved);
    return saved;
  };
  let attempted = false;
  try {
    let found = favoriteDetails(await request('fetch_custom_face_detail', { count: 200 })).find(
      (x) => x.md5 === md5,
    );
    if (!found) {
      if (row.native?.state === 'unconfirmed' || row.native?.state === 'confirmed')
        return {
          ...row,
          note: 'Favorite absent from the bounded listing. Prior state retained; no duplicate add was sent.',
        };
      assert(current(), 'CHAT_CHANGED', 'Chat changed before adding favorite.');
      update({ state: 'unconfirmed', md5, at: Date.now() });
      attempted = true;
      const result = await request('add_custom_face', {
        file: a.path,
        md5,
        file_size: bytes.length,
        is_origin: true,
      });
      if (result?.result !== 0) {
        return update({
          state: typeof result?.result === 'number' ? 'failed' : 'unconfirmed',
          md5,
          at: Date.now(),
        });
      }
      found = favoriteDetails(await request('fetch_custom_face_detail', { count: 200 })).find(
        (x) => x.md5 === md5,
      );
    }
    return update({
      state: found ? 'confirmed' : 'unconfirmed',
      md5,
      resId: found?.resId,
      at: Date.now(),
    });
  } catch {
    if (!current()) throw Error('Chat changed during native favorite operation');
    if (!attempted && row.native)
      return {
        ...row,
        note: 'Native collection could not be checked; prior verification timestamp retained.',
      };
    return {
      ...update({
        state: attempted ? 'unconfirmed' : row.native?.state || 'failed',
        md5,
        resId: row.native?.resId,
        at: Date.now(),
      }),
      note: 'QQ favorite could not be verified; local cache retained. No success claim.',
    };
  }
}
export async function favoriteBytes(
  store: Store,
  c: ChatConnection,
  reference: string,
  request: Request,
  download: (url: string) => Promise<Buffer>,
  current: () => boolean,
) {
  const row = store
    .list<ChatSticker>('chat-sticker')
    .find(
      (x) =>
        x.route === chatRoute(c) &&
        x.conversationId === c.conversationId &&
        x.reference === reference &&
        x.native?.state === 'confirmed',
    );
  if (!row?.native) return undefined;
  try {
    const found = favoriteDetails(await request('fetch_custom_face_detail', { count: 200 })).find(
      (x) => x.md5 === row.native!.md5,
    );
    if (!found) return undefined;
    const bytes = await download(found.url);
    assert(current(), 'CHAT_CHANGED', 'Chat changed while reading favorite.');
    assert(
      createHash('md5').update(bytes).digest('hex') === found.md5,
      'CHAT_STICKER_CHANGED',
      'Native favorite bytes do not match.',
    );
    return bytes;
  } catch {
    if (!current()) throw Error('Chat changed while reading favorite');
    stickerReferences(store, c, [row.id]);
    return undefined;
  }
}
