import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Caller supplies a private, scope/source-specific directory, never a document-controlled path.
export class PdfCheckpoints {
  private constructor(
    private directory: string,
    private fingerprint: string,
  ) {}
  static async open(directory: string, bytes: Uint8Array, ocr: boolean) {
    await mkdir(directory, { recursive: true });
    // Expire abandoned private fragments on subsequent attempts; never traverse directories.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^[a-f0-9]{64}\.(page-\d+|tile-\d+-\d+)\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      try {
        if ((await stat(path)).mtimeMs < Date.now() - 7 * 86400000) await unlink(path);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const fingerprint = createHash('sha256')
      .update('pdf-tiles-v1:' + ocr + ':')
      .update(bytes)
      .digest('hex');
    return new PdfCheckpoints(directory, fingerprint);
  }
  private path(key: string) {
    if (!/^(page-\d+|tile-\d+-\d+)$/.test(key)) throw Error('Invalid PDF checkpoint key');
    return join(this.directory, this.fingerprint + '.' + key + '.json');
  }
  async read(key: string): Promise<string | undefined> {
    const path = this.path(key);
    try {
      if ((await stat(path)).size > 32_000_000) return undefined;
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (
        typeof record?.text !== 'string' ||
        record.text.length > 5_000_000 ||
        record.digest !== createHash('sha256').update(record.text).digest('hex')
      )
        return undefined;
      return record.text;
    } catch (error: any) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  async write(key: string, text: string) {
    if (text.length > 5_000_000) throw Error('PDF checkpoint text budget exceeded');
    const path = this.path(key),
      temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(
      temporary,
      JSON.stringify({ text, digest: createHash('sha256').update(text).digest('hex') }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }
}
