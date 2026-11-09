import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeDocumentText } from './text-decoding.js';
export const archiveExtension = /\.(zip|7z|rar|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i;
export async function inspectArchive(path: string, member?: string, signal?: AbortSignal) {
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        fileURLToPath(new URL('./archive-reader.py', import.meta.url)),
        path,
        ...(member ? [member] : []),
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: { ...process.env, PYTHONUTF8: '1' },
      },
      (error, stdout) =>
        error
          ? reject(Error('Archive inspection unavailable or exceeded its time/output budget.'))
          : resolve(stdout),
    );
  });
  const value = JSON.parse(result);
  if (value.bytesBase64) {
    const bytes = Buffer.from(value.bytesBase64, 'base64');
    delete value.bytesBase64;
    try {
      value.text = decodeDocumentText(bytes).text;
    } catch {
      value.error = 'Binary member: text decoding is not available; original archive preserved.';
    }
  }
  return value;
}
export async function readArchiveAttachment(
  attachment: any,
  member: string | undefined,
  signal?: AbortSignal,
) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(attachment.path, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== attachment.sha256) throw Error('Attachment integrity mismatch');
  return inspectArchive(attachment.path, member, signal);
}
