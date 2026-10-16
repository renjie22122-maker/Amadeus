import { documentInput, generateDocument } from '../services/document-generation.js';
import { deliverFile } from '../services/file-delivery.js';
import { createHash } from 'node:crypto';
import { approvalSnapshot } from './approval-snapshot.js';
import { z } from 'zod';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { extractIsolated } from '../services/document-parser.js';
import { NotStartedError } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
export function installDocumentTools(registry: ToolRegistry) {
  registry.add({
    name: 'create_document',
    effect: 'write',
    description:
      'Generate a real DOCX/PDF from structured blocks, PPTX from slides, or XLSX from sheets of literal cells; save a NEW file in the authorized workspace and attach a download card. Existing files are never overwritten. Basic layout, not arbitrary conversion or visual QA. PDF uses a fixed local browser renderer with networking/scripts disabled and may require approval. For Markdown, HTML, CSV, JSON, LaTeX source or custom formats use write_file or approved tools, then register_artifact; never just rename an extension. TeX compilation requires an available approved compiler. File creation is not proof of content/layout quality.',
    schema: documentInput,
    run: async (a, c) => {
      const revalidate = approvalSnapshot(c);
      const destination = await c.files.resolve(a.path, true);
      try {
        await stat(destination);
        throw new NotStartedError(
          'DOCUMENT_EXISTS',
          'Choose a new output path; existing documents are never overwritten.',
        );
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (a.format === 'pdf') {
        if (c.conversation.permission !== 'trusted')
          await c.inputs.request(
            c.run,
            'approval',
            {
              command: 'Render structured document to PDF using a fixed local browser',
              path: a.path,
              backend: 'document-renderer',
              reason:
                'No scripts, external assets or network. Writes only the requested output through FileScope.',
            },
            c.signal,
          );
        revalidate();
      }
      c.beforeExecution?.();
      const bytes = await generateDocument(a, c.signal);
      c.signal.throwIfAborted();
      revalidate();
      await c.files.writeChunks(
        a.path,
        (async function* () {
          c.signal.throwIfAborted();
          yield bytes;
        })(),
      );
      const delivery = await deliverFile(
        c.store,
        c.run.conversationId,
        c.run.id,
        a.path,
        c.files.readChunks(a.path, c.signal),
        c.signal,
      );
      return {
        content: JSON.stringify({
          path: a.path,
          format: a.format,
          delivery,
          verified: false,
          notice:
            'Generated and attached. Content and rendered layout have not been independently verified.',
        }),
      };
    },
  });
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
