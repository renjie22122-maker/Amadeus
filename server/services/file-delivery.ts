import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Attachment } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { saveMediaStream } from './media-stream.js';

export const documentMime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.tex': 'application/x-tex',
  '.rtf': 'application/rtf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};
/** An immutable, authenticated chat download; never retain workspace paths in public metadata. */
export async function deliverFile(
  store: Store,
  conversationId: string,
  runId: string,
  name: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal?: AbortSignal,
  presentation?: { event: 'interaction.frame'; adapter: string; capability: string; tool: string },
) {
  const key = id(),
    folder = join(dirname(store.path), 'attachments', key);
  await mkdir(folder, { recursive: true });
  try {
    const path = join(folder, 'file');
    const saved = await saveMediaStream(source, path, signal);
    signal?.throwIfAborted();
    name = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_');
    const prior = store
      .attachmentMetadata(conversationId)
      .find((a: any) => a.deliveryRunId === runId && a.name === name && a.sha256 === saved.sha256);
    if (prior) {
      await rm(folder, { recursive: true, force: true });
      return {
        id: prior.id,
        name,
        mime: prior.mime,
        bytes: saved.size,
        sha256: saved.sha256,
        downloadUrl: '/api/attachments/' + prior.id,
      };
    }
    const mime = documentMime[extname(name).toLowerCase()] || 'application/octet-stream';
    const attachment: Attachment & { deliveryRunId: string } = {
      id: key,
      conversationId,
      name,
      mime,
      size: saved.size,
      sha256: saved.sha256,
      path,
      text: '',
      createdAt: Date.now(),
      messageEventId: -1,
      deliveryRunId: runId,
    };
    const publicFile = {
      id: key,
      name,
      mime,
      bytes: saved.size,
      sha256: saved.sha256,
      downloadUrl: '/api/attachments/' + key,
    };
    store.transaction(() => {
      const event = store.event(conversationId, runId, presentation?.event || 'file.attached', {
        attachment: publicFile,
        ...(presentation || {}),
      });
      store.put('attachment', { ...attachment, messageEventId: event.id });
    });
    return publicFile;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
