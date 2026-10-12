import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
/** Bounded memory copy; failed/cancelled streams never leave a publishable file. */
export async function saveMediaStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  path: string,
  signal?: AbortSignal,
) {
  const hash = createHash('sha256');
  let size = 0,
    head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      size += chunk.length;
      hash.update(chunk);
      if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
      cb(null, chunk);
    },
  });
  const owned = await open(path, 'wx');
  try {
    await pipeline(Readable.from(source), meter, owned.createWriteStream(), {
      signal,
    });
  } catch (error) {
    await owned.close().catch(() => {});
    await rm(path, { force: true });
    throw error;
  }
  return { size, head, sha256: hash.digest('hex') };
}
export async function mediaHeader(path: string) {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return { head: head.subarray(0, bytesRead), size: (await file.stat()).size };
  } finally {
    await file.close();
  }
}
