import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash, createDecipheriv } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { publicAddress } from './network.js';
import { assert } from '../core/errors.js';
import { saveMediaStream } from './media-stream.js';
import { attachmentMediaType, mediaAttachmentText } from './attachment-media.js';
import { extract } from './documents.js';
import { documentMime } from './file-delivery.js';
import { Store, id } from '../storage/store.js';
import type { Attachment } from '../../shared/types.js';
import type { ChatRemoteFile } from '../../shared/chat-connections.js';
export const chatMediaLimit = 50 * 1024 * 1024;
/** Public HTTPS only, pinned DNS, no redirects or local-file URLs, bounded in memory. */
export async function downloadChatBytes(
  input: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  limit = chatMediaLimit,
) {
  const url = new URL(input);
  if (url.protocol === 'http:' && (!url.port || url.port === '80')) {
    url.protocol = 'https:';
    url.port = '';
  }
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443'),
    'CHAT_MEDIA_URL',
    'Only public HTTPS media is accepted.',
  );
  const addresses = await lookup(url.hostname, { all: true });
  signal.throwIfAborted();
  assert(
    addresses.length && addresses.every((a) => publicAddress(a.address)),
    'CHAT_MEDIA_URL',
    'Private media addresses are forbidden.',
  );
  const address = addresses[0];
  return new Promise<Buffer>((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers,
        signal,
        lookup: (_host, options, cb: any) =>
          options?.all ? cb(null, [address]) : cb(null, address.address, address.family),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error('Remote file download rejected (no redirects).'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) {
            res.destroy(Error('Remote media exceeds transfer budget.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
  });
}
export function decryptWecomFile(bytes: Buffer, aeskey: string) {
  const key = Buffer.from(aeskey, 'base64');
  assert(key.length === 32, 'CHAT_MEDIA_KEY', 'Invalid WeCom file key.');
  const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const plain = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const padding = plain.at(-1) || 0;
  assert(
    padding >= 1 &&
      padding <= 32 &&
      padding <= plain.length &&
      plain.subarray(-padding).every((v) => v === padding),
    'CHAT_MEDIA_PADDING',
    'Invalid WeCom file padding.',
  );
  return plain.subarray(0, -padding);
}
export async function storeChatAttachment(
  store: Store,
  directory: string,
  conversationId: string,
  inboxId: string,
  file: ChatRemoteFile,
  bytes: Buffer,
  signal: AbortSignal,
) {
  assert(
    bytes.length > 0 && bytes.length <= chatMediaLimit,
    'CHAT_MEDIA_SIZE',
    'Empty or oversized media.',
  );
  if (file.sha256)
    assert(
      createHash('sha256').update(bytes).digest('hex') === file.sha256.toLowerCase(),
      'CHAT_MEDIA_HASH',
      'Media digest mismatch.',
    );
  const key = id(),
    folder = join(directory, 'attachments', key);
  const name =
    basename(file.name.replaceAll('\\', '/'))
      .replace(/[<>:"|?*\x00-\x1f]/g, '_')
      .slice(0, 180) || 'attachment';
  const extension = extname(name).toLowerCase();
  assert(
    !['.exe', '.dll', '.com', '.msi', '.lnk', '.scr'].includes(extension),
    'CHAT_MEDIA_TYPE',
    'Executable attachments are not accepted.',
  );
  await mkdir(folder, { recursive: true });
  try {
    const path = join(folder, 'file' + extension),
      saved = await saveMediaStream([bytes], path, signal);
    const mime = attachmentMediaType(saved.head);
    let text = mime
      ? mediaAttachmentText(key, mime)
      : 'Remote file attachment. Content has not been interpreted.';
    if (!mime && /\.(pdf|docx|xlsx|csv|txt|md|json)$/i.test(name)) {
      assert(
        saved.size <= 25 * 1024 * 1024,
        'CHAT_DOCUMENT_SIZE',
        'Document parsing budget is 25 MiB.',
      );
      text = await extract(path, { ocr: true });
    }
    signal.throwIfAborted();
    const a: Attachment & { remoteInboxId: string } = {
      id: key,
      conversationId,
      name,
      mime: mime || documentMime[extension] || 'application/octet-stream',
      path,
      size: saved.size,
      sha256: saved.sha256,
      text,
      createdAt: Date.now(),
      remoteInboxId: inboxId,
    };
    store.put('attachment', a);
    store.event(conversationId, null, 'attachment.added', {
      id: key,
      name,
      size: saved.size,
      origin: 'chat-connection',
    });
    return key;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
