import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { assert } from '../core/errors.js';
import { documentAt } from './knowledge-versions.js';
import { FileScope } from './paths.js';
import { saveMediaStream } from './media-stream.js';
import { deliverFile } from './file-delivery.js';
import type { ToolContext } from '../tools/registry.js';

export async function deliverKnowledge(
  c: ToolContext,
  documentId: string,
  format: 'original' | 'extracted-text',
) {
  const check = () => {
    const doc = c.store.get<any>('document', documentId);
    assert(
      c.scopes.includes(doc.scope) && documentAt(doc, Date.now()),
      'KNOWLEDGE_SCOPE',
      'Document is outside the current accessible version.',
    );
    c.signal.throwIfAborted();
    c.beforeExecution?.();
    return doc;
  };
  const doc = check();
  if (format === 'extracted-text') {
    async function* chunks() {
      yield Buffer.from('Extracted text export (not the original file)\n' + doc.name + '\n\n');
      for (const row of c.store.db
        .prepare('SELECT text FROM chunks WHERE document_id=? ORDER BY ordinal')
        .iterate(doc.id)) {
        check();
        yield Buffer.from(String(row.text) + '\n\n');
      }
    }
    const delivery = await deliverFile(
      c.store,
      c.conversation.id,
      c.run.id,
      basename(doc.name) + '.extracted.txt',
      chunks(),
      c.signal,
    );
    return {
      format,
      documentId,
      delivery,
      notice:
        'Extracted indexed passages; chunk overlap and lost layout may remain. This is not the original file.',
    };
  }
  let sourceDoc = doc;
  const seen = new Set<string>();
  while (sourceDoc.reusedFrom) {
    assert(!seen.has(sourceDoc.id), 'KNOWLEDGE_SOURCE', 'Cyclic document provenance.');
    seen.add(sourceDoc.id);
    const source = c.store.get<any>('document', sourceDoc.reusedFrom.documentId);
    assert(
      source.hash === sourceDoc.reusedFrom.hash && source.scope === sourceDoc.reusedFrom.scope,
      'KNOWLEDGE_SOURCE',
      'Reused source version no longer matches.',
    );
    sourceDoc = source;
  }
  const original =
    c.store.maybe<any>('knowledge-original', sourceDoc.id) ||
    c.store
      .list<any>('knowledge-source')
      .find((s) => s.documentId === sourceDoc.id && s.scope === sourceDoc.scope && !s.removed);
  assert(
    original?.path && original.scope === sourceDoc.scope && /^[a-f0-9]{64}$/.test(original.hash),
    'KNOWLEDGE_ORIGINAL_UNAVAILABLE',
    'No verified original file is available. Ask whether an explicitly labeled extracted-text export is wanted.',
  );
  // Never interpret document.source metadata or a model-provided path as host-file authority.
  const files = new FileScope([dirname(original.path)]);
  const temporary = await mkdtemp(join(dirname(c.store.path), 'knowledge-delivery-'));
  try {
    const staged = join(temporary, 'file');
    const saved = await saveMediaStream(
      files.readChunks(basename(original.path), c.signal),
      staged,
      c.signal,
    );
    assert(
      saved.sha256 === original.hash,
      'KNOWLEDGE_SOURCE_CHANGED',
      'Original file differs from the indexed version; synchronize the source before sending.',
    );
    const latest = check();
    assert(
      latest.hash === doc.hash,
      'KNOWLEDGE_SOURCE_CHANGED',
      'Document changed during delivery.',
    );
    const delivery = await deliverFile(
      c.store,
      c.conversation.id,
      c.run.id,
      doc.name,
      createReadStream(staged),
      c.signal,
    );
    return {
      format,
      documentId,
      delivery,
      notice:
        'Verified original attached to this conversation. Remote delivery uses the current chat route; platform receipt is separate.',
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
