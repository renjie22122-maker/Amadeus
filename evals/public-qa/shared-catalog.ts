import { z } from 'zod';
import { responseContractSchema } from '../../server/core/response-contract.js';
export const sharedCatalog = [
  {
    name: 'research_search',
    description:
      'Discover public source URLs. Generated search summaries are withheld. Fetch originals to obtain evidence. Excluded sources are not proof of absence.',
    schema: z.object({
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(12).optional(),
    }),
  },
  {
    name: 'research_fetch',
    description:
      'Fetch public source text under the source policy. Redirects are checked. Read remote images with inspect_remote_image. Tool errors are not evidence.',
    schema: z.object({ url: z.string().url() }),
  },
  {
    name: 'inspect_attachment',
    description:
      'Read a task attachment or generated workspace artifact. Images supply pixels; optional crop uses original pixel coordinates. Documents supply paginated text; XLSX includes stored cell styles and coordinates. ZIP member reads text. Video/audio bytes are available to calculate for FFmpeg processing; transcription is not configured.',
    schema: z.object({
      name: z.string(),
      offset: z.number().int().min(0).optional(),
      member: z.string().optional(),
      left: z.number().int().min(0).optional(),
      top: z.number().int().min(0).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
  },
  {
    name: 'calculate',
    description:
      'Run Python in the same offline non-root Docker image. Only this task workspace is mounted. Attachments are available by filename; write artifacts then inspect_attachment. Standard library and FFmpeg are available, extra packages are not guaranteed. No host fallback, installation or network. 30-second command limit.',
    schema: z.object({ code: z.string().min(1).max(10000) }),
  },
  {
    name: 'inspect_remote_image',
    description:
      'Fetch pixels from a public image URL under source policy. No screenshot of HTML. Inspect original evidence, not search descriptions.',
    schema: z.object({ url: z.string().url() }),
  },
  {
    name: 'inspect_remote_document',
    description:
      'Download a public PDF under the source policy, extract paginated text in the resource-limited local parser. Saves the PDF into the task workspace for subsequent inspection or computation. No PDF scripts execute.',
    schema: z.object({ url: z.string().url(), offset: z.number().int().min(0).optional() }),
  },
  {
    name: 'declare_output_contract',
    description:
      'Record only the requested output constraints: numeric precision, list item count/order or JSON. Does not verify facts. Do not invent constraints.',
    schema: responseContractSchema,
  },
] as const;
export const sharedSpecs = sharedCatalog.map((d) => ({
  name: d.name,
  description: d.description,
  parameters: z.toJSONSchema(d.schema),
  effect:
    d.name === 'calculate' || d.name === 'inspect_remote_document'
      ? ('execute' as const)
      : d.name === 'research_search' ||
          d.name === 'research_fetch' ||
          d.name === 'inspect_remote_image'
        ? ('network' as const)
        : ('read' as const),
}));
