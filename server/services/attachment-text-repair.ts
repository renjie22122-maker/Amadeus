import { identifyAttachment } from './attachment-identification.js';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeDocumentText } from './text-decoding.js';
import type { Store } from '../storage/store.js';
export const chatTextExtension =
  /\.(html?|svg|txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|tex|latex|css|js|ts|log)$/i;
export async function repairAttachmentText(store: Store, attachment: any) {
  if (
    !attachment.remoteInboxId ||
    attachment.text !== 'Remote file attachment. Content has not been interpreted.' ||
    attachment.size > 25 * 1024 * 1024
  )
    return attachment;
  if ((await stat(attachment.path)).size > 25 * 1024 * 1024) return attachment;
  const bytes = await readFile(attachment.path);
  if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) return attachment;
  const identified = await identifyAttachment(attachment.name, bytes);
  if (identified.executable) return attachment;
  const name = identified.name;
  if (!chatTextExtension.test(name)) return attachment;
  const text = decodeDocumentText(bytes).text;
  if (text.includes('\0')) return attachment;
  const updated = {
    ...attachment,
    name,
    text,
    mime: identified.mime || attachment.mime,
    originalName: attachment.originalName || attachment.name,
    textRecovery: 'verified-bytes-v1',
  };
  store.put('attachment-text-recovery', {
    id: attachment.id,
    originalName: attachment.name,
    originalMime: attachment.mime,
    originalText: attachment.text,
    sha256: attachment.sha256,
    recoveredAt: Date.now(),
  });
  store.put('attachment', updated);
  return updated;
}
