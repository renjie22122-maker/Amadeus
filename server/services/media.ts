import { createReadStream } from 'node:fs';
import { saveMediaStream } from './media-stream.js';
import { attachmentMediaType, mediaAttachmentText } from './attachment-media.js';
import { inspectMedia } from './media-inspection.js';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { MediaJob, MediaKind } from '../../shared/media.js';
import type { Run, Attachment } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { Configuration } from './settings.js';
import { assert } from '../core/errors.js';
import { fetchPublic } from './network.js';
import {
  submitMedia,
  pollMedia,
  cancelMedia,
  extractMedia,
  mediaHttp,
  boundedBytes,
  type MediaRequest,
} from './media-adapters.js';
export class MediaService {
  private busy = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private config: Configuration,
    private directory: string,
    private request?: MediaRequest,
  ) {}
  start() {
    for (const j of this.store.list<MediaJob>('media-job'))
      if (j.status === 'submitting')
        this.save({
          ...j,
          status: 'unknown',
          error:
            'Submission was interrupted. Check the provider dashboard; it will not be resubmitted automatically.',
        });
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
  }
  connections() {
    return (this.config.get().media?.connections || [])
      .filter((c) => c.enabled)
      .map(({ apiKey, ...c }) => ({ ...c, hasKey: !!apiKey }));
  }
  connection(key: string) {
    const c = this.config.get().media?.connections.find((c) => c.id === key && c.enabled);
    assert(
      c && c.apiKey,
      'MEDIA_NOT_CONFIGURED',
      'Configure an enabled media connection and API key in Settings.',
    );
    return c;
  }
  list(conversationId: string) {
    return this.store
      .forConversation<MediaJob>('media-job', conversationId)
      .map((j) => this.public(j));
  }
  public(j: MediaJob) {
    const { statusUrl, resultUrl, cancelUrl, origin, baseUrl, operationKey, ...rest } = j;
    return {
      ...rest,
      purpose:
        j.kind === 'speech' && j.operationKey?.startsWith('ui:read-aloud:')
          ? 'read-aloud'
          : 'generation',
      outputs: rest.outputs.map((f) => ({
        ...f,
        reference: 'media:' + j.id + ':' + f.id,
        access: {
          storage: 'conversation-media',
          export: {
            tool: 'export_media',
            arguments: { reference: 'media:' + j.id + ':' + f.id },
            requires:
              'Provide an authorized destination path; existing files are not overwritten. No ffmpeg needed for export.',
          },
          inspect: {
            tool: 'inspect_media',
            arguments: { reference: 'media:' + j.id + ':' + f.id },
          },
          ...(f.mime.startsWith('image/')
            ? {
                view: { tool: 'read_image', arguments: { mediaRef: 'media:' + j.id + ':' + f.id } },
              }
            : {}),
          guidance: f.mime.startsWith('image/')
            ? 'Read pixels directly or export exact bytes.'
            : 'Binary bytes are available via export_media. read_image cannot decode video/audio/3D. Export first for authorized frame extraction, transcription or assembly; no manual download/upload required.',
        },
        url: '/api/conversations/' + j.conversationId + '/media/' + j.id + '/files/' + f.id,
      })),
    };
  }
  async importLocal(
    source: Buffer | AsyncIterable<Uint8Array>,
    name: string,
    conversationId: string,
    runId: string,
    signal?: AbortSignal,
  ) {
    const key = id(),
      folder = join(this.directory, 'attachments', key);
    await mkdir(folder, { recursive: true });
    const path = join(folder, 'media');
    try {
      const saved = await saveMediaStream(
        Buffer.isBuffer(source) ? [source] : source,
        path,
        signal,
      );
      const mime = attachmentMediaType(saved.head);
      assert(mime, 'MEDIA_TYPE', 'Import a supported image, audio or video.');
      const prior = this.store
        .forConversation<Attachment>('attachment', conversationId)
        .find(
          (a) =>
            a.sha256 === saved.sha256 &&
            a.name === name &&
            a.text.includes('Imported by run: ' + runId),
        );
      if (prior) {
        await rm(folder, { recursive: true, force: true });
        return { reference: 'attachment:' + prior.id, name, mime, bytes: saved.size };
      }
      signal?.throwIfAborted();
      const a: Attachment = {
        id: key,
        conversationId,
        name,
        mime,
        size: saved.size,
        path,
        text: mediaAttachmentText(key, mime) + ' Imported by run: ' + runId,
        sha256: saved.sha256,
        createdAt: Date.now(),
        messageEventId: -1,
      };
      this.store.transaction(() => {
        const event = this.store.event(conversationId, runId, 'media.attached', {
          attachment: { id: key, name, mime },
        });
        this.store.put('attachment', { ...a, messageEventId: event.id });
      });
      return { reference: 'attachment:' + key, name, mime, bytes: saved.size };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }
  streamOutput(reference: string, conversationId: string, signal?: AbortSignal) {
    let file: {
      path: string;
      mime: string;
      name: string;
      sha256?: string;
      size?: number;
      conversationId: string;
    };
    if (reference.startsWith('attachment:'))
      file = this.store.get<Attachment>('attachment', reference.slice(11));
    else {
      const match = /^media:([a-zA-Z0-9-]+):([0-9]+)$/.exec(reference);
      assert(match, 'MEDIA_REFERENCE', 'Use attachment:id or media:jobId:outputId.');
      const job = this.get(match[1], conversationId);
      assert(
        job.status === 'completed' && job.outputs.some((o) => o.id === match[2]),
        'MEDIA_STATE',
        'Output is not complete.',
      );
      file = this.store.get('media-file', match[1] + ':' + match[2]);
    }
    assert(
      file.conversationId === conversationId,
      'MEDIA_SCOPE',
      'Media belongs to another conversation.',
      403,
    );
    const metadata = {
      reference,
      mime: file.mime,
      name: file.name,
      bytes: 0,
      sha256: '',
      inspection: { audio: 'unknown', method: 'bounded-header-only' } as ReturnType<
        typeof inspectMedia
      >,
    };
    async function* chunks() {
      const hash = createHash('sha256');
      let head = Buffer.alloc(0);
      for await (const chunk of createReadStream(file.path, {
        highWaterMark: 256 * 1024,
        signal,
      })) {
        metadata.bytes += chunk.length;
        hash.update(chunk);
        if (head.length < 1024 * 1024)
          head = Buffer.concat([head, chunk.subarray(0, 1024 * 1024 - head.length)]);
        yield chunk as Buffer;
      }
      metadata.sha256 = hash.digest('hex');
      assert(
        (file.size === undefined || metadata.bytes === file.size) &&
          (!file.sha256 || metadata.sha256 === file.sha256),
        'MEDIA_INTEGRITY',
        'Saved media changed.',
      );
      if (metadata.bytes === head.length) metadata.inspection = inspectMedia(head, file.mime);
    }
    return { metadata, chunks: chunks() };
  }
  async output(reference: string, conversationId: string) {
    if (reference.startsWith('attachment:')) {
      const a = this.store.get<Attachment>('attachment', reference.slice(11));
      assert(
        a.conversationId === conversationId,
        'MEDIA_SCOPE',
        'Attachment belongs to another conversation.',
        403,
      );
      assert(
        (await stat(a.path)).size <= 25 * 1024 * 1024,
        'MEDIA_PROCESSING_SIZE',
        'This full-buffer processing route accepts up to 25 MB. The original remains available for playback/download; use the workspace source for chunked processing.',
      );
      const bytes = await readFile(a.path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert(
        bytes.length <= 25 * 1024 * 1024 &&
          bytes.length === a.size &&
          (!a.sha256 || a.sha256 === sha256),
        'MEDIA_INTEGRITY',
        'Attachment changed or exceeds the size limit.',
      );
      assert(/^(image|audio|video)\//.test(a.mime), 'MEDIA_TYPE', 'Use a media attachment.');
      return { bytes, mime: a.mime, name: a.name, sha256, inspection: inspectMedia(bytes, a.mime) };
    }
    const match = /^media:([a-zA-Z0-9-]+):([0-9]+)$/.exec(reference);
    assert(match, 'MEDIA_REFERENCE', 'Use the media:jobId:outputId reference from media_status.');
    const job = this.get(match[1], conversationId);
    assert(
      job.status === 'completed' && job.outputs.some((f) => f.id === match[2]),
      'MEDIA_STATE',
      'This output is not complete.',
    );
    const file = this.store.get<any>('media-file', match[1] + ':' + match[2]);
    assert(
      file.conversationId === conversationId,
      'MEDIA_SCOPE',
      'Output belongs to another conversation.',
      403,
    );
    const bytes = await readFile(file.path);
    assert(
      bytes.length <= 150 * 1024 * 1024 &&
        createHash('sha256').update(bytes).digest('hex') === file.sha256,
      'MEDIA_INTEGRITY',
      'Saved media changed or exceeds the size limit.',
    );
    return {
      bytes,
      mime: file.mime,
      name: file.name,
      sha256: file.sha256,
      inspection: inspectMedia(bytes, file.mime),
    };
  }
  private save(j: MediaJob) {
    j.updatedAt = Date.now();
    this.store.put('media-job', j);
    this.store.event(j.conversationId, j.runId || null, 'media.updated', { job: this.public(j) });
    return j;
  }
  private track(task: Promise<unknown>) {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
  }
  async referenceOptions(
    conversationId: string,
    options: Record<string, unknown>,
    references: Record<string, string[]> = {},
  ) {
    const out = { ...options };
    for (const [field, ids] of Object.entries(references)) {
      assert(
        /^[a-zA-Z][\w]*$/.test(field) && ids.length > 0 && ids.length <= 9,
        'MEDIA_REFERENCE',
        'Invalid reference field/count.',
      );
      assert(
        field.endsWith('s') || ids.length === 1,
        'MEDIA_REFERENCE',
        'A singular reference field accepts exactly one asset.',
      );
      const values = [];
      for (const key of ids) {
        let bytes: Buffer, mime: string;
        if (key.startsWith('media:') || key.startsWith('attachment:')) {
          const output = await this.output(key, conversationId);
          bytes = output.bytes;
          mime = output.mime;
        } else {
          const output = await this.output('attachment:' + key, conversationId);
          bytes = output.bytes;
          mime = output.mime;
        }
        assert(
          /^(image|audio|video)\//.test(mime),
          'MEDIA_REFERENCE',
          'Reference must be an image, audio or video.',
        );
        assert(
          bytes.length <= 25 * 1024 * 1024,
          'MEDIA_SIZE',
          'Inline media reference exceeds 25 MB; export it and use a provider-supported upload flow.',
        );
        values.push('data:' + mime + ';base64,' + bytes.toString('base64'));
      }
      out[field] = field.endsWith('s') ? values : values[0];
    }
    return out;
  }
  async submit(args: {
    connectionId: string;
    conversationId: string;
    run?: Run;
    operationKey: string;
    prepared?: (jobId: string) => void;
    prompt: string;
    options?: Record<string, unknown>;
    references?: Record<string, string[]>;
    expectedConnection?: string;
    audio?: { bytes: Buffer; mime: string; name: string };
  }) {
    const existing = this.store
      .list<MediaJob>('media-job')
      .find(
        (j) => j.conversationId === args.conversationId && j.operationKey === args.operationKey,
      );
    if (existing) return this.public(existing);
    const c = this.connection(args.connectionId);
    assert(
      !args.expectedConnection || args.expectedConnection === JSON.stringify(c),
      'MEDIA_CHANGED',
      'Service configuration changed after approval. Request a fresh approval.',
    );
    const options = await this.referenceOptions(
      args.conversationId,
      args.options || {},
      args.references,
    );
    assert(
      c.kind !== 'transcription' || args.audio,
      'MEDIA_AUDIO',
      'Use the microphone or transcription upload for audio input.',
    );
    const raced = this.store
      .list<MediaJob>('media-job')
      .find(
        (j) => j.conversationId === args.conversationId && j.operationKey === args.operationKey,
      );
    if (raced) return this.public(raced);
    const j: MediaJob = {
      id: id(),
      conversationId: args.conversationId,
      runId: args.run?.id,
      operationKey: args.operationKey,
      connectionId: c.id,
      protocol: c.protocol,
      kind: c.kind,
      model: c.model,
      origin: new URL(c.baseUrl).origin,
      baseUrl: c.baseUrl,
      prompt: args.prompt,
      status: 'submitting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      estimatedUsd: c.estimatedUsd,
      actualUsd: null,
      outputs: [],
    };
    this.store.transaction(() => {
      this.save(j);
      args.prepared?.(j.id);
    });
    const task = (async () => {
      this.busy.add(j.id);
      try {
        const result = await submitMedia(c, args.prompt, options, args.audio, this.request);
        Object.assign(j, {
          remoteId: result.remoteId,
          statusUrl: result.statusUrl,
          resultUrl: result.resultUrl,
          cancelUrl: result.cancelUrl,
        });
        if (result.remoteId) {
          j.status = 'queued';
          this.save(j);
        } else await this.finish(j, result);
      } catch (error) {
        j.status = this.store.maybe('media-result', j.id)
          ? 'running'
          : ['MEDIA_HTTP', 'MEDIA_PROVIDER'].includes((error as any)?.code)
            ? 'failed'
            : 'unknown';
        j.error = ['MEDIA_HTTP', 'MEDIA_PROVIDER'].includes((error as any)?.code)
          ? String((error as Error).message)
          : 'Submission outcome is unknown. Check provider records before creating another job.';
        this.save(j);
      } finally {
        this.busy.delete(j.id);
      }
    })();
    this.track(task);
    return this.public(j);
  }
  async tick() {
    for (const j of this.store
      .list<MediaJob>('media-job')
      .filter(
        (j) =>
          ['queued', 'running'].includes(j.status) && (!j.nextPollAt || j.nextPollAt <= Date.now()),
      )) {
      if (this.busy.has(j.id)) continue;
      this.busy.add(j.id);
      const task = (async () => {
        try {
          const stored = this.store.maybe<any>('media-result', j.id);
          if (stored) {
            await this.finish(j, stored);
            return;
          }
          const c = this.connection(j.connectionId);
          assert(
            c.protocol === j.protocol && c.baseUrl === j.baseUrl,
            'MEDIA_CONNECTION_CHANGED',
            'Restore the original service endpoint before polling this task.',
          );
          const r = await pollMedia(c, j, this.request);
          if (r.state === 'done') await this.finish(j, r);
          else {
            j.status =
              r.state === 'failed' ? 'failed' : r.state === 'cancelled' ? 'cancelled' : 'running';
            j.error = r.state === 'failed' ? 'Provider reported generation failure.' : undefined;
            j.nextPollAt = Date.now() + 5000;
            this.save(j);
          }
        } catch {
          j.error = 'Status/download unavailable. No new generation submitted; polling will retry.';
          j.nextPollAt = Date.now() + 30000;
          this.save(j);
        } finally {
          this.busy.delete(j.id);
        }
      })();
      this.track(task);
    }
  }
  private async finish(
    j: MediaJob,
    result: { data: any; binary?: { bytes: Buffer; mime: string } },
  ) {
    const folder = join(this.directory, 'media', j.id);
    await mkdir(folder, { recursive: true });
    // Durable result before downloading; crash recovery never submits a second generation.
    if (result.binary) {
      await writeFile(join(folder, 'response.bin'), result.binary.bytes);
      result = { data: { localBinary: true, mime: result.binary.mime } };
    }
    this.store.put('media-result', { id: j.id, ...result });
    j.status = 'running';
    this.save(j);
    const extracted = extractMedia(result.data);
    const inputs: { bytes?: Buffer; mime: string; url?: string; name?: string }[] = [];
    if (result.data.localBinary)
      inputs.push({ bytes: await readFile(join(folder, 'response.bin')), mime: result.data.mime });
    for (const a of extracted.assets.slice(0, 16))
      inputs.push({
        ...(a.base64 ? { bytes: Buffer.from(a.base64, 'base64') } : { url: a.url }),
        mime: a.mime,
        name: a.name,
      });
    const outputs: MediaJob['outputs'] = [];
    for (let index = 0; index < inputs.length; index++) {
      let { bytes, mime, url, name } = inputs[index];
      if (!bytes && url) {
        const c = this.connection(j.connectionId);
        if (c.protocol === 'gemini-video' && new URL(url).origin === j.origin) {
          const r = await mediaHttp(c, url, {}, this.request);
          bytes = await boundedBytes(r);
          mime = r.headers.get('content-type') || mime;
        } else {
          const r = await fetchPublic(
            url,
            new AbortController().signal,
            0,
            AbortSignal.timeout(120000),
            'media',
          );
          assert(
            r.status === 200 && !r.truncated && r.imageBytes,
            'MEDIA_DOWNLOAD',
            'Media download failed or exceeds 150 MB.',
          );
          bytes = r.imageBytes;
          mime = r.contentType;
        }
      }
      assert(
        bytes && bytes.length && bytes.length <= 150 * 1024 * 1024,
        'MEDIA_SIZE',
        'Empty or oversized media.',
      );
      const extension = mediaExtension(bytes, mime, name || url || '', j.kind);
      mime = mediaMime(extension);
      const outputId = String(index),
        fileName = outputId + '.' + extension;
      await writeFile(join(folder, fileName), bytes);
      this.store.put('media-file', {
        id: j.id + ':' + outputId,
        jobId: j.id,
        conversationId: j.conversationId,
        path: join(folder, fileName),
        mime,
        name: fileName,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      outputs.push({
        id: outputId,
        mime,
        name: fileName,
        preview: extension === 'glb' && safeGlb(bytes),
        inspection: inspectMedia(bytes, mime),
      });
    }
    assert(
      outputs.length || typeof extracted.text === 'string',
      'MEDIA_RESULT',
      'Provider returned no supported output.',
    );
    j.outputs = outputs;
    j.text = extracted.text;
    j.error = undefined;
    j.status = 'completed';
    this.save(j);
    this.store.remove('media-result', j.id);
  }
  get(key: string, conversationId: string) {
    const j = this.store.get<MediaJob>('media-job', key);
    assert(
      j.conversationId === conversationId,
      'MEDIA_SCOPE',
      'Media task belongs to another conversation.',
      403,
    );
    return j;
  }
  async cancel(key: string, conversationId: string) {
    const j = this.get(key, conversationId);
    assert(
      ['queued', 'running'].includes(j.status),
      'MEDIA_STATE',
      'Only remote running jobs can be cancelled.',
    );
    assert(
      !this.busy.has(j.id),
      'MEDIA_BUSY',
      'A status update is in flight; retry cancellation shortly.',
      409,
    );
    this.busy.add(j.id);
    try {
      await cancelMedia(this.connection(j.connectionId), j, this.request);
      j.status = 'cancelled';
      this.save(j);
    } finally {
      this.busy.delete(j.id);
    }
    return this.public(j);
  }
}
export function mediaExtension(bytes: Buffer, mime: string, name: string, kind: MediaKind) {
  if (bytes.subarray(0, 4).toString() === 'glTF') return 'glb';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'jpg';
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'model/gltf-binary': 'glb',
    'model/gltf+json': 'gltf',
    'application/zip': 'zip',
  };
  const ext = known[mime.split(';')[0]];
  if (ext) return ext;
  const fromName = extname(name.split('?')[0]).slice(1).toLowerCase();
  if (
    [
      'png',
      'jpg',
      'jpeg',
      'webp',
      'gif',
      'mp3',
      'wav',
      'ogg',
      'flac',
      'm4a',
      'mp4',
      'webm',
      'glb',
      'gltf',
      'obj',
      'fbx',
      'stl',
      'ply',
      'zip',
    ].includes(fromName)
  )
    return fromName;
  if (kind === 'model3d') return 'bin';
  throw new Error('Unsupported generated file type.');
}
function mediaMime(ext: string) {
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        flac: 'audio/flac',
        m4a: 'audio/mp4',
        mp4: 'video/mp4',
        webm: 'video/webm',
        glb: 'model/gltf-binary',
        gltf: 'model/gltf+json',
      } as Record<string, string>
    )[ext] || 'application/octet-stream'
  );
}

export function safeGlb(bytes: Buffer) {
  try {
    if (
      bytes.length < 20 ||
      bytes.subarray(0, 4).toString() !== 'glTF' ||
      bytes.readUInt32LE(4) !== 2
    )
      return false;
    const n = bytes.readUInt32LE(12);
    if (n > 4 * 1024 * 1024 || 20 + n > bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
      return false;
    const json = JSON.parse(bytes.subarray(20, 20 + n).toString('utf8'));
    const safe = (x: any): boolean =>
      !x ||
      typeof x !== 'object' ||
      Object.entries(x).every(([k, v]) =>
        k === 'uri' ? typeof v === 'string' && v.startsWith('data:') : safe(v),
      );
    // Compressed assets may load external decoder resources. Keep these download-only.
    return (
      safe(json) &&
      !(json.extensionsRequired || []).some((x: string) =>
        ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(x),
      )
    );
  } catch {
    return false;
  }
}
