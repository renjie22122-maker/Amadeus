import { createHash, randomUUID } from 'node:crypto';
import {
  supportsReadAloud,
  supportsTranscriptionPreview,
  speechStreamEndpoints,
  mediaReferenceBudget,
} from '../../shared/media-capabilities.js';
import { boundedBytes } from '../services/media-adapters.js';
import { Readable } from 'node:stream';
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
  references: z.record(z.string(), z.array(z.string()).max(mediaReferenceBudget.count)).default({}),
  operationKey: z.string().min(1).max(160),
});
export function mediaRoutes(app: FastifyInstance, runtime: Runtime) {
  const { store, media } = runtime;
  app.get('/api/media/services', async () => media.connections());
  const previews = new Set<string>();
  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/transcription-preview',
    async (req, reply) => {
      store.get('conversation', req.params.id);
      const a = z
        .object({ serviceId: z.string(), sequence: z.coerce.number().int().min(0).max(10000) })
        .parse(req.query);
      const connection = media.connection(a.serviceId);
      assert(
        supportsTranscriptionPreview(connection),
        'STT_PREVIEW_UNAVAILABLE',
        'Select a prepared incremental transcription service.',
        409,
      );
      const base = new URL(connection.baseUrl);
      assert(
        (base.protocol === 'https:' ||
          (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) &&
          !base.username &&
          !base.password &&
          !base.search &&
          !base.hash,
        'STT_TARGET',
        'Preview requires HTTPS or loopback HTTP.',
      );
      assert(!previews.has(req.params.id), 'STT_BUSY', 'A preview is already running.', 429);
      previews.add(req.params.id);
      const abort = new AbortController();
      const close = () => abort.abort();
      reply.raw.once('close', close);
      try {
        const file = await req.file();
        assert(
          file && /^(audio\/|video\/webm)/.test(file.mimetype),
          'AUDIO_REQUIRED',
          'Upload audio.',
        );
        const bytes = await file.toBuffer();
        assert(
          !file.file.truncated && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024,
          'AUDIO_SIZE',
          'Preview audio must be 1 byte to 8 MiB.',
        );
        const form = new FormData();
        form.append('model', connection.model);
        form.append(
          'file',
          new Blob([new Uint8Array(bytes)], { type: file.mimetype }),
          'preview.audio',
        );
        if (typeof connection.defaults.language === 'string')
          form.append('language', connection.defaults.language);
        const began = Date.now();
        const response = await fetch(
          connection.baseUrl.replace(/\/$/, '') + '/audio/transcriptions',
          {
            method: 'POST',
            body: form,
            headers: { Authorization: 'Bearer ' + connection.apiKey },
            redirect: 'error',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(150000)]),
          },
        );
        assert(
          response.ok,
          'STT_PREVIEW_FAILED',
          `Transcription unavailable (${response.status}).`,
          response.status === 429 ? 429 : 503,
        );
        const data = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString());
        const result = z
          .object({
            text: z.string().max(20000),
            language: z.string().optional(),
            device: z.string().optional(),
            hasSpeech: z.boolean().optional(),
            speechEnd: z.number().nullable().optional(),
            audioSeconds: z.number().optional(),
            timings: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(data);
        return {
          ...result,
          sequence: a.sequence,
          elapsedMs: Date.now() - began,
          provisional: true,
        };
      } finally {
        previews.delete(req.params.id);
        reply.raw.off('close', close);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read-aloud', async (req, reply) => {
    const c = store.get<Conversation>('conversation', req.params.id);
    assert(
      c.permission !== 'read-only',
      'MEDIA_READONLY',
      'Select a writable permission mode before generating speech.',
    );
    const a = z
      .object({ serviceId: z.string(), text: z.string().trim().min(1).max(4000) })
      .parse(req.body);
    const connection = media.connection(a.serviceId);
    assert(
      supportsReadAloud(connection),
      'VOICE_STREAM_UNAVAILABLE',
      'Native streaming is unavailable for this service.',
      409,
    );
    const endpoints = speechStreamEndpoints(connection);
    const headers = {
      Authorization: 'Bearer ' + connection.apiKey,
      'Content-Type': 'application/json',
    };
    const health = await fetch(endpoints.health, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    assert(
      health.ok && JSON.parse((await boundedBytes(health, 65536)).toString()).streaming === true,
      'VOICE_STREAM_UNAVAILABLE',
      'Restart the updated local voice service to enable streaming.',
      409,
    );
    const abort = new AbortController();
    const close = () => abort.abort();
    reply.raw.once('close', close);
    try {
      const response = await fetch(endpoints.speech, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(610000)]),
        body: JSON.stringify({
          model: connection.model,
          input: a.text,
          voice: connection.defaults.voice || 'default',
          language: connection.defaults.language,
          response_format: 'wav',
          stream: true,
        }),
      });
      assert(
        response.ok &&
          response.body &&
          response.headers.get('content-type')?.startsWith('application/x-ndjson'),
        'VOICE_STREAM_FAILED',
        `Local speech unavailable (${response.status}); no automatic resubmission.`,
        503,
      );
      reply
        .header('Content-Type', 'application/x-ndjson')
        .header('Cache-Control', 'no-store')
        .header('X-Accel-Buffering', 'no')
        .header('X-Read-Aloud-Request-Id', randomUUID())
        .header('X-Read-Aloud-Text-SHA256', createHash('sha256').update(a.text).digest('hex'));
      return reply.send(Readable.fromWeb(response.body as any));
    } catch (error) {
      close();
      reply.raw.off('close', close);
      throw error;
    }
  });
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
