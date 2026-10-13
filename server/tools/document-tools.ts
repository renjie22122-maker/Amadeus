import { createHash } from 'node:crypto';
import { approvalSnapshot } from './approval-snapshot.js';
import { z } from 'zod';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { extractIsolated } from '../services/document-parser.js';
import { NotStartedError } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
export function installDocumentTools(registry: ToolRegistry) {
  registry.add({
    name: 'read_document',
    effect: 'execute',
    description:
      'Extract paginated text from a scoped PDF, DOCX, XLSX, text or image using the existing resource-limited document parser and local OCR. Runs a fixed parser subprocess, not arbitrary code and not an OS sandbox. Approval required outside trusted mode. Returns sha256 and nextOffset; pass expectedSha256 on later pages to detect source changes; OCR availability depends on the local platform. For image understanding use read_image.',
    schema: z.object({
      path: z.string().min(1),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(24000).default(12000),
    }),
    run: async (a, c) => {
      const revalidate = approvalSnapshot(c);
      const ext = extname(a.path).toLowerCase();
      if (
        ![
          '.pdf',
          '.docx',
          '.xlsx',
          '.txt',
          '.md',
          '.csv',
          '.json',
          '.png',
          '.jpg',
          '.jpeg',
          '.gif',
          '.webp',
        ].includes(ext)
      )
        throw new NotStartedError(
          'DOCUMENT_FORMAT',
          'Unsupported document format. Use another discovered reader.',
        );
      await c.files.resolve(a.path);
      if (c.conversation.permission !== 'trusted')
        await c.inputs.request(
          c.run,
          'approval',
          {
            command: 'Parse document with local OCR',
            path: a.path,
            reason:
              'Run the fixed resource-limited parser on an authorized file snapshot; no upload.',
            backend: 'document-parser',
          },
          c.signal,
        );
      revalidate();
      c.beforeExecution?.();
      const dir = await mkdtemp(join(tmpdir(), 'amadeus-document-'));
      try {
        const path = join(dir, 'source' + ext);
        const hash = createHash('sha256');
        const f = await open(path, 'wx');
        try {
          for await (const chunk of c.files.readChunks(a.path, c.signal)) {
            hash.update(chunk);
            await f.writeFile(chunk);
          }
        } finally {
          await f.close();
        }
        const sha256 = hash.digest('hex');
        if (a.expectedSha256 && a.expectedSha256 !== sha256)
          throw new Error(
            'Document changed between pages; restart pagination with the current version.',
          );
        const text = await extractIsolated(path, 120000, c.signal);
        return {
          content: JSON.stringify({
            source: a.path,
            sha256,
            text: text.slice(a.offset, a.offset + a.limit),
            offset: a.offset,
            totalCharacters: text.length,
            nextOffset: a.offset + a.limit < text.length ? a.offset + a.limit : null,
            notice:
              'Extracted/OCR text may contain errors. This is not visual verification; use original pages for exact layout.',
          }),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  });
}
