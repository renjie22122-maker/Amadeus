import { diffLines } from 'diff';
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
    const parts = diffLines(old, after, { timeout: 250 });
    const tooLarge = () =>
      new NotStartedError(
        'FILE_REVIEW_TOO_LARGE',
        'No files changed. Complete change evidence exceeds the review budget. Split the mutation into smaller independently reviewable edits and retry; do not omit changes.',
      );
    if (!parts) throw tooLarge();
    let beforeText = '',
      afterText = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.added) afterText += part.value;
      else if (part.removed) beforeText += part.value;
      else {
        const lines = part.value.match(/[^\n]*\n|[^\n]+$/g) || [];
        const head = i > 0 ? 3 : 0;
        const tail = i < parts.length - 1 ? 3 : 0;
        const context =
          lines.length <= head + tail
            ? part.value
            : lines.slice(0, head).join('') +
              `\n[unchanged context omitted: ${lines.length - head - tail} lines]\n` +
              (tail ? lines.slice(-tail).join('') : '');
        beforeText += context;
        afterText += context;
      }
    }
    remaining -= beforeText.length + afterText.length;
    if (remaining < 0) throw tooLarge();
    return {
      path,
      operation: before === null ? 'create' : 'edit',
      beforeSha256: before === null ? null : hash(old),
      afterSha256: hash(after),
      before: beforeText,
      after: afterText,
      truncated: false,
      completeChangedRegions: true,
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
