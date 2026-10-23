import { createHash } from 'node:crypto';
import type { FileScope } from './paths.js';
import { NotStartedError } from '../core/errors.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const supported = new Set(['write_file', 'edit_file', 'apply_patch']);
export const reviewableFileMutation = (name: string) => supported.has(name);
export async function prepareFileReview(files: FileScope, name: string, args: Record<string, any>) {
  if (!supported.has(name)) return undefined;
  const rows = name === 'apply_patch' ? args.files : [args];
  const snapshots: { path: string; before: string | null; after: string }[] = [];
  const read = async (path: string, creation = false) => {
    await files.resolve(path, true);
    try {
      return await files.read(path, 1000000);
    } catch (e: any) {
      if (creation && e.code === 'ENOENT') return null;
      throw e;
    }
  };
  for (const row of rows) {
    const before = await read(row.path, name === 'write_file');
    let after = before || '';
    if (name === 'write_file') after = row.content;
    else {
      if (before === null) throw new NotStartedError('EDIT_READ_FAILED', 'File missing');
      if (name === 'apply_patch' && hash(before) !== row.expectedSha256)
        throw new NotStartedError('PATCH_STALE', 'File changed before review');
      for (const edit of name === 'apply_patch' ? row.edits : [row]) {
        if (!edit.oldText || after.split(edit.oldText).length !== 2)
          throw new NotStartedError('EDIT_CONFLICT', 'Expected exactly one match before review');
        after = after.replace(edit.oldText, edit.newText);
      }
    }
    snapshots.push({ path: row.path, before, after });
  }
  let remaining = 24000;
  const evidence = snapshots.map(({ path, before, after }) => {
    const old = before || '';
    let start = 0,
      end = 0;
    while (start < old.length && start < after.length && old[start] === after[start]) start++;
    while (
      end < old.length - start &&
      end < after.length - start &&
      old[old.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    const from = Math.max(0, start - 300);
    const oldPart = old.slice(from, Math.min(old.length, old.length - end + 300));
    const newPart = after.slice(from, Math.min(after.length, after.length - end + 300));
    const cap = Math.min(6000, Math.floor(remaining / 2));
    remaining -= Math.min(cap, oldPart.length) + Math.min(cap, newPart.length);
    return {
      path,
      operation: before === null ? 'create' : 'edit',
      beforeSha256: before === null ? null : hash(old),
      afterSha256: hash(after),
      contextStartCharacter: from,
      before: oldPart.slice(0, cap),
      after: newPart.slice(0, cap),
      truncated: oldPart.length > cap || newPart.length > cap,
      beforeCharacters: old.length,
      afterCharacters: after.length,
    };
  });
  return {
    evidence,
    revalidate: async () => {
      for (const row of snapshots)
        if ((await read(row.path, name === 'write_file')) !== row.before)
          throw new NotStartedError(
            'FILE_REVIEW_STALE',
            'File changed during review; request fresh approval.',
          );
    },
  };
}
