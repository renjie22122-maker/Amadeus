import { basename } from 'node:path';
import { z } from 'zod';
import { assert } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
export function installMedia(registry: ToolRegistry) {
  registry.add({
    name: 'import_media',
    effect: 'read',
    description:
      'Read an existing image, audio or video from the authorized workspace and embed a saved copy at this point in the conversation. Returns attachment:id for inspect_media, read_image, export_media and generation references. No external upload, playback is not transcription or visual understanding. No fixed import file-size cap; reads and saves incrementally.',
    schema: z.object({ path: z.string().min(1).max(2048) }),
    run: async (a, c) => {
      const bytes = c.files.readChunks(a.path, c.signal);
      c.signal.throwIfAborted();
      return {
        content: JSON.stringify(
          await c.media.importLocal(bytes, basename(a.path), c.conversation.id, c.run.id, c.signal),
        ),
      };
    },
  });
  registry.add({
    name: 'media_services',
    description:
      'List enabled image, video, music, speech and 3D generation services. Model-specific reference image/multi-image options live in each service defaults; do not invent capabilities or pricing.',
    effect: 'read',
    schema: z.object({}),
    run: (_a, c) => ({ content: JSON.stringify(c.media.connections()) }),
  });
  registry.add({
    name: 'generate_media',
    description:
      'Submit a paid image/video/music/speech/3D generation task using a configured service. Approval covers the exact prompt/options. Returns a durable job ID; use media_status, never resubmit because waiting is slow. URLs and data URIs in options are sent to the provider. references maps provider input fields to attachment IDs, attachment:id or media:jobId:outputId handles from media_status (image/audio/video up to 25 MB). Use the actual provider field names and supported formats; data URI support varies. read_image accepts mediaRef for visual QA; export_media saves outputs to the workspace. No arbitrary local paths are read.',
    effect: 'coordinate',
    schema: z.object({
      serviceId: z.string(),
      prompt: z.string().max(20000).default(''),
      options: z.record(z.string(), z.unknown()).default({}),
      references: z.record(z.string(), z.array(z.string()).max(9)).default({}),
      reason: z.string().min(1),
    }),
    run: async (a, c) => {
      assert(
        c.conversation.permission !== 'read-only',
        'MEDIA_READONLY',
        'Generation is unavailable in read-only mode.',
      );
      const service = c.media.connection(a.serviceId);
      assert(
        service.kind !== 'transcription',
        'MEDIA_AUDIO',
        'Use microphone input for transcription.',
      );
      const limit = c.config.get().media?.autoApproveMaxUsd;
      await c.inputs.request(
        c.run,
        'approval',
        {
          command: 'Generate ' + service.kind + ' with ' + service.name,
          reason: a.reason,
          backend: 'media-service',
          cwd: new URL(service.baseUrl).origin,
          request: {
            model: service.model,
            prompt: a.prompt,
            options: { ...service.defaults, ...a.options },
            referenceAttachments: a.references,
          },
          estimatedUsd: service.estimatedUsd,
          forceHuman: limit == null || service.estimatedUsd == null || service.estimatedUsd > limit,
        },
        c.signal,
      );
      c.signal.throwIfAborted();
      return {
        content: JSON.stringify(
          await c.media.submit({
            connectionId: a.serviceId,
            conversationId: c.conversation.id,
            run: c.run,
            prepared: (id) => c.bindEffect?.('media-job', id),
            operationKey: c.run.id + ':' + c.callId,
            prompt: a.prompt,
            options: a.options,
            references: a.references,
            expectedConnection: JSON.stringify(service),
          }),
        ),
      };
    },
  });
  registry.add({
    name: 'list_media',
    effect: 'read',
    description:
      'Find generated image/video/music/speech/transcription/3D jobs in this conversation, including earlier turns. Returns job IDs, status and output references without host paths. Use when a job ID is missing; do not search the workspace or ask the user to reupload host-held media.',
    schema: z.object({
      kind: z.enum(['image', 'video', 'music', 'speech', 'transcription', 'model3d']).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(30).default(10),
    }),
    run: (a, c) => {
      const jobs = c.media
        .list(c.conversation.id)
        .filter((j) => !a.kind || j.kind === a.kind)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return {
        content: JSON.stringify({
          total: jobs.length,
          jobs: jobs.slice(a.offset, a.offset + a.limit).map((j) => ({
            id: j.id,
            kind: j.kind,
            model: j.model,
            status: j.status,
            createdAt: j.createdAt,
            outputs: j.outputs,
            hasText: typeof j.text === 'string',
          })),
          nextOffset: a.offset + a.limit < jobs.length ? a.offset + a.limit : null,
          note: 'Same-conversation results only. Use media_status for text/error/details, inspect_media for binary metadata, export_media for workspace bytes, read_image for image pixels.',
        }),
      };
    },
  });
  registry.add({
    name: 'media_status',
    description:
      'Read a media job receipt and locally saved outputs in this conversation. Host polls remote jobs automatically; no need for a rapid tool polling loop.',
    effect: 'read',
    schema: z.object({ jobId: z.string() }),
    run: (a, c) => ({
      content: JSON.stringify(c.media.public(c.media.get(a.jobId, c.conversation.id))),
    }),
  });
  registry.add({
    name: 'inspect_media',
    effect: 'read',
    description:
      'Inspect a same-conversation attachment:id or completed media:jobId:outputId reference: byte integrity, MIME and MP4 audio/video track declarations. Does not prove audible content or codec compatibility; unsupported containers report unknown. For visual QA use read_image(mediaRef).',
    schema: z.object({ reference: z.string() }),
    run: async (a, c) => {
      const output = c.media.streamOutput(a.reference, c.conversation.id, c.signal);
      for await (const _chunk of output.chunks) {
        c.signal.throwIfAborted();
      }
      return { content: JSON.stringify(output.metadata) };
    },
  });
  registry.add({
    name: 'export_media',
    effect: 'write',
    description:
      'Copy a local attachment:id or completed image/video/audio/3D output in this conversation into an authorized workspace path, preserving exact bytes. Never overwrites existing files. Returns hash and audio-track inspection; no model generation or conversion.',
    schema: z.object({ reference: z.string(), path: z.string().min(1) }),
    run: async (a, c) => {
      const output = c.media.streamOutput(a.reference, c.conversation.id, c.signal);
      c.signal.throwIfAborted();
      const path = await c.files.writeChunks(a.path, output.chunks);
      return { content: JSON.stringify({ path, ...output.metadata }) };
    },
  });
  registry.add({
    name: 'cancel_media',
    description:
      'Cancel a remote media job in this conversation if the provider supports cancellation. Cancellation does not guarantee a refund.',
    effect: 'coordinate',
    schema: z.object({ jobId: z.string() }),
    run: async (a, c) => ({
      content: JSON.stringify(await c.media.cancel(a.jobId, c.conversation.id)),
    }),
  });
}
