import { mediaRange } from '../services/media-inspection.js';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Conversation } from '../../shared/types.js';
import type { Runtime } from '../core/runtime.js';
import { assert } from '../core/errors.js';
const generation = z.object({
  serviceId: z.string(),
  prompt: z.string().max(20000).default(''),
  options: z.record(z.string(), z.unknown()).default({}),
  references: z.record(z.string(), z.array(z.string()).max(9)).default({}),
  operationKey: z.string().min(1).max(160),
});
export function mediaRoutes(app: FastifyInstance, runtime: Runtime) {
  const { store, media } = runtime;
  app.get('/api/media/services', async () => media.connections());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/media', async (req) => {
    store.get('conversation', req.params.id);
    return media.list(req.params.id);
  });
  app.get<{ Params: { id: string; job: string } }>(
    '/api/conversations/:id/media/:job',
    async (req) => media.public(media.get(req.params.job, req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/conversations/:id/media', async (req) => {
    const c = store.get<Conversation>('conversation', req.params.id);
    assert(
      c.permission !== 'read-only',
      'MEDIA_READONLY',
      'Select a writable permission mode before generating media.',
    );
    const a = generation.parse(req.body);
    return media.submit({
      connectionId: a.serviceId,
      conversationId: c.id,
      operationKey: 'ui:' + a.operationKey,
      prompt: a.prompt,
      options: a.options,
      references: a.references,
    });
  });
  app.post<{ Params: { id: string; job: string } }>(
    '/api/conversations/:id/media/:job/cancel',
    async (req) => media.cancel(req.params.job, req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/conversations/:id/transcribe', async (req) => {
    store.get('conversation', req.params.id);
    const file = await req.file();
    assert(file, 'AUDIO_REQUIRED', 'Upload audio.');
    assert(/^(audio\/|video\/webm)/.test(file.mimetype), 'AUDIO_TYPE', 'Use an audio recording.');
    const bytes = await file.toBuffer();
    assert(
      !file.file.truncated && bytes.length,
      'AUDIO_SIZE',
      'Recording is empty or exceeds 25 MB.',
    );
    const service = runtime.config.get().media?.transcriptionId;
    assert(service, 'STT_NOT_CONFIGURED', 'Select a speech-to-text service in Settings.');
    assert(
      media.connection(service).kind === 'transcription',
      'STT_SERVICE',
      'Selected service is not speech-to-text.',
    );
    const token = z.string().min(1).max(160).parse(req.headers['x-operation-id']);
    return media.submit({
      connectionId: service,
      conversationId: req.params.id,
      operationKey: 'voice:' + token,
      prompt: '',
      audio: { bytes, mime: file.mimetype, name: file.filename },
    });
  });
  app.get<{ Params: { id: string; job: string; file: string } }>(
    '/api/conversations/:id/media/:job/files/:file',
    async (req, reply) => {
      media.get(req.params.job, req.params.id);
      const f = store.get<any>('media-file', req.params.job + ':' + req.params.file);
      assert(
        f.conversationId === req.params.id,
        'MEDIA_SCOPE',
        'File belongs to another conversation.',
        403,
      );
      reply
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', 'inline; filename="' + f.name + '"')
        .type(f.mime);
      const bytes = await readFile(f.path);
      reply.header('Accept-Ranges', 'bytes');
      const range = mediaRange(req.headers.range, bytes.length);
      if (range === false)
        return reply
          .code(416)
          .header('Content-Range', 'bytes */' + bytes.length)
          .send();
      if (range)
        return reply
          .code(206)
          .header('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + bytes.length)
          .header('Content-Length', range.end - range.start + 1)
          .send(bytes.subarray(range.start, range.end + 1));
      return reply.header('Content-Length', bytes.length).send(bytes);
    },
  );
}
