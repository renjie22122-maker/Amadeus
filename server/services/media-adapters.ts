import type { MediaConnection, MediaJob } from '../../shared/media.js';
import { assert, AppError } from '../core/errors.js';
export type MediaRequest = (url: string, init: RequestInit) => Promise<Response>;
export type Submission = {
  data: any;
  remoteId?: string;
  statusUrl?: string;
  resultUrl?: string;
  cancelUrl?: string;
  binary?: { bytes: Buffer; mime: string };
};
export async function boundedBytes(response: Response, max = 150 * 1024 * 1024) {
  const reader = response.body?.getReader();
  assert(reader, 'MEDIA_EMPTY', 'Empty media response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('Media exceeds download limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export function mediaAuth(c: MediaConnection): Record<string, string> {
  if (c.protocol.startsWith('gemini')) return { 'x-goog-api-key': c.apiKey };
  if (c.protocol.startsWith('eleven')) return { 'xi-api-key': c.apiKey };
  if (c.protocol === 'assemblyai') return { authorization: c.apiKey };
  return {
    Authorization:
      (c.protocol === 'fal' ? 'Key ' : c.protocol === 'deepgram' ? 'Token ' : 'Bearer ') + c.apiKey,
  };
}
export function sameOrigin(c: MediaConnection, url: string) {
  const u = new URL(url, c.baseUrl + '/');
  assert(
    u.origin === new URL(c.baseUrl).origin && !u.username && !u.password,
    'MEDIA_ORIGIN',
    'Service attempted to redirect credentials to another origin.',
  );
  return u.href;
}
export async function mediaHttp(
  c: MediaConnection,
  url: string,
  init: RequestInit = {},
  request: MediaRequest = fetch,
) {
  const response = await request(sameOrigin(c, url), {
    ...init,
    headers: { ...mediaAuth(c), ...init.headers },
    redirect: 'error',
    signal: init.signal || AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    let detail = '';
    const endpoint = new URL(c.baseUrl);
    if (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
      try {
        const body = JSON.parse((await boundedBytes(response, 4096)).toString());
        if (typeof body.error === 'string') detail = ' ' + body.error.slice(0, 500);
      } catch {
        /* Keep a bounded generic error when the local provider has no JSON diagnostic. */
      }
    } else await response.body?.cancel();
    throw new AppError(
      'MEDIA_HTTP',
      'Media provider returned HTTP ' + response.status + '. No automatic resubmission.' + detail,
      502,
    );
  }
  return response;
}
async function json(
  c: MediaConnection,
  url: string,
  body?: any,
  request?: MediaRequest,
  method = body ? 'POST' : 'GET',
) {
  const r = await mediaHttp(
    c,
    url,
    {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    },
    request,
  );
  return JSON.parse((await boundedBytes(r)).toString('utf8'));
}
function checkMiniMax(data: any) {
  const code = data.base_resp?.status_code;
  if (data.error || (code !== undefined && Number(code) !== 0))
    throw new AppError(
      'MEDIA_PROVIDER',
      'MiniMax rejected the request (code ' +
        String(code ?? data.error?.type ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '') +
        '). Check model access, balance and parameters. No automatic resubmission.',
      502,
    );
  return data;
}
export async function submitMedia(
  c: MediaConnection,
  prompt: string,
  options: Record<string, any>,
  audio?: { bytes: Buffer; mime: string; name: string },
  request?: MediaRequest,
): Promise<Submission> {
  const base = c.baseUrl.replace(/\/$/, '');
  const input = { ...c.defaults, ...options };
  const model = encodeURIComponent(c.model);

  if (c.protocol.startsWith('minimax-')) {
    const root = base.replace(/\/v[12]$/, '');
    const call = async (route: string, body?: any) =>
      checkMiniMax(await json(c, root + route, body, request));
    if (c.protocol === 'minimax-transcription') {
      assert(audio, 'AUDIO_REQUIRED', 'Upload an audio recording.');
      const form = new FormData();
      for (const [k, v] of Object.entries(input))
        form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      form.set('model', c.model);
      form.set('stream', 'false');
      form.set('response_format', 'json');
      form.set('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), audio.name);
      const r = await mediaHttp(
        c,
        root + '/v1/speech_to_text',
        { method: 'POST', body: form },
        request,
      );
      return { data: checkMiniMax(JSON.parse((await boundedBytes(r)).toString('utf8'))) };
    }
    if (c.protocol === 'minimax-video') {
      const h3 = /^MiniMax-H3(?:-|$)/i.test(c.model);
      const { first_frame_image, last_frame_image, reference_images, content, ...parameters } =
        input;
      const parts = [
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
        ...(Array.isArray(content) ? content : []),
      ];
      for (const [role, value] of [
        ['first_frame', first_frame_image],
        ['last_frame', last_frame_image],
      ]) {
        if (value) parts.push({ type: 'image_url', image_url: { url: value }, role });
      }
      for (const url of reference_images || [])
        parts.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
      const d = await call(
        h3 ? '/v2/video_generation' : '/v1/video_generation',
        h3
          ? { ...parameters, model: c.model, content: parts }
          : { ...input, model: c.model, prompt },
      );
      assert(
        typeof d.task_id === 'string' && d.task_id,
        'MEDIA_RECEIPT',
        'MiniMax did not return a task ID.',
      );
      return {
        data: d,
        remoteId: d.task_id,
        statusUrl:
          root +
          (h3 ? '/v2/query/video_generation/' : '/v1/query/video_generation?task_id=') +
          encodeURIComponent(d.task_id),
      };
    }
    if (c.protocol === 'minimax-image') {
      const { reference_images, ...params } = input;
      const d = await call('/v1/image_generation', {
        ...params,
        ...(reference_images
          ? {
              subject_reference: reference_images.map((image_file: string) => ({
                type: 'character',
                image_file,
              })),
            }
          : {}),
        model: c.model,
        prompt,
        response_format: 'base64',
      });
      const images = d.data?.image_base64;
      assert(
        Array.isArray(images) &&
          images.length &&
          images.every((x: any) => typeof x === 'string' && x.length),
        'MEDIA_RESULT',
        'MiniMax returned no image data.',
      );
      return { data: { images: images.map((b64_json: string) => ({ b64_json })) } };
    }
    const speech = c.protocol === 'minimax-speech';
    const d = await call(speech ? '/v1/t2a_v2' : '/v1/music_generation', {
      ...input,
      model: c.model,
      ...(speech ? { text: prompt } : { prompt }),
      stream: false,
      output_format: 'hex',
      audio_setting: { ...input.audio_setting, format: 'mp3' },
    });
    const hex = d.data?.audio;
    assert(
      typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(hex),
      'MEDIA_RESULT',
      'MiniMax returned invalid or empty audio.',
    );
    return { data: {}, binary: { bytes: Buffer.from(hex, 'hex'), mime: 'audio/mpeg' } };
  }

  if (c.protocol === 'meshy') {
    const route = input.image_urls
      ? '/openapi/v1/multi-image-to-3d'
      : input.image_url
        ? '/openapi/v1/image-to-3d'
        : '/openapi/v2/text-to-3d';
    const d = await json(
      c,
      base + route,
      {
        ...(route.includes('text-to') ? { mode: 'preview', prompt } : {}),
        ...input,
        ai_model: c.model,
      },
      request,
    );
    assert(d.result, 'MEDIA_RECEIPT', 'Missing Meshy task ID.');
    return {
      data: d,
      remoteId: d.result,
      statusUrl: base + route + '/' + encodeURIComponent(d.result),
    };
  }
  if (c.protocol === 'tripo') {
    const route = input.files
      ? '/generation/multiview-to-model'
      : input.file
        ? '/generation/image-to-model'
        : '/generation/text-to-model';
    const d = await json(
      c,
      base + route,
      { ...(route.includes('text-to') ? { prompt } : {}), ...input, model_version: c.model },
      request,
    );
    const key = d.data?.task_id || d.task_id;
    assert(key, 'MEDIA_RECEIPT', 'Missing Tripo task ID.');
    return { data: d, remoteId: key, statusUrl: base + '/tasks/' + encodeURIComponent(key) };
  }
  if (c.protocol === 'fal') {
    assert(
      /^[\w./-]+$/.test(c.model) && !c.model.split('/').includes('..'),
      'MEDIA_MODEL',
      'Invalid endpoint ID.',
    );
    const d = await json(
      c,
      base + '/' + c.model,
      { ...(prompt ? { prompt } : {}), ...input },
      request,
    );
    assert(
      d.request_id && d.status_url && d.response_url,
      'MEDIA_RECEIPT',
      'Provider did not return a task receipt.',
    );
    return {
      data: d,
      remoteId: d.request_id,
      statusUrl: sameOrigin(c, d.status_url),
      resultUrl: sameOrigin(c, d.response_url),
      cancelUrl: d.cancel_url ? sameOrigin(c, d.cancel_url) : undefined,
    };
  }
  if (c.protocol === 'replicate') {
    const version = input.version;
    delete input.version;
    const endpoint = version
      ? base + '/predictions'
      : base + '/models/' + c.model.split('/').map(encodeURIComponent).join('/') + '/predictions';
    const d = await json(
      c,
      endpoint,
      { ...(version ? { version } : {}), input: { ...(prompt ? { prompt } : {}), ...input } },
      request,
    );
    assert(d.id, 'MEDIA_RECEIPT', 'Provider did not return a prediction ID.');
    return {
      data: d,
      remoteId: d.id,
      statusUrl: base + '/predictions/' + encodeURIComponent(d.id),
      cancelUrl: base + '/predictions/' + encodeURIComponent(d.id) + '/cancel',
    };
  }
  if (c.protocol === 'openai-image') {
    if (input.input_image) {
      const { input_image, ...other } = input;
      const match = String(input_image).match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
      assert(
        match,
        'IMAGE_REFERENCE',
        'OpenAI image editing requires an image attachment via input_image.',
      );
      const form = new FormData();
      form.set('model', c.model);
      form.set('prompt', prompt);
      form.set(
        'image',
        new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }),
        'reference.' + match[1].split('/')[1],
      );
      for (const [k, v] of Object.entries(other)) form.set(k, String(v));
      const r = await mediaHttp(c, base + '/images/edits', { method: 'POST', body: form }, request);
      return { data: JSON.parse((await boundedBytes(r)).toString()) };
    }
    return {
      data: await json(
        c,
        base + '/images/generations',
        { ...input, model: c.model, prompt },
        request,
      ),
    };
  }
  if (c.protocol === 'gemini-image')
    return {
      data: await json(
        c,
        base + '/models/' + model + ':generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: prompt }, ...(input.parts || [])] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(input.generationConfig || {}),
          },
        },
        request,
      ),
    };
  if (c.protocol === 'gemini-music')
    return {
      data: await json(
        c,
        base + '/interactions',
        { ...input, model: c.model, input: input.input || prompt },
        request,
      ),
    };
  if (c.protocol === 'gemini-video') {
    const d = await json(
      c,
      base + '/models/' + model + ':predictLongRunning',
      {
        instances: [{ prompt, ...(input.image ? { image: input.image } : {}) }],
        parameters: input.parameters || input,
      },
      request,
    );
    assert(d.name, 'MEDIA_RECEIPT', 'Missing video operation name.');
    return { data: d, remoteId: d.name, statusUrl: sameOrigin(c, base + '/' + d.name) };
  }
  if (c.protocol === 'openai-video') {
    const form = new FormData();
    form.set('model', c.model);
    form.set('prompt', prompt);
    for (const [k, v] of Object.entries(input)) form.set(k, String(v));
    const r = await mediaHttp(c, base + '/videos', { method: 'POST', body: form }, request);
    const d = JSON.parse((await boundedBytes(r)).toString());
    assert(d.id, 'MEDIA_RECEIPT', 'Missing video ID.');
    return {
      data: d,
      remoteId: d.id,
      statusUrl: base + '/videos/' + encodeURIComponent(d.id),
      resultUrl: base + '/videos/' + encodeURIComponent(d.id) + '/content',
    };
  }
  if (c.protocol === 'openai-transcription') {
    assert(audio, 'MEDIA_AUDIO', 'Audio file required.');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), audio.name);
    form.set('model', c.model);
    for (const [k, v] of Object.entries(input)) form.set(k, String(v));
    form.set('response_format', 'json');
    const r = await mediaHttp(
      c,
      base + '/audio/transcriptions',
      { method: 'POST', body: form },
      request,
    );
    return { data: JSON.parse((await boundedBytes(r)).toString()) };
  }
  if (c.protocol === 'deepgram') {
    assert(audio, 'MEDIA_AUDIO', 'Audio file required.');
    const q = new URLSearchParams({ model: c.model, smart_format: 'true', ...input });
    const r = await mediaHttp(
      c,
      base + '/listen?' + q,
      {
        method: 'POST',
        headers: { 'Content-Type': audio.mime },
        body: new Uint8Array(audio.bytes),
      },
      request,
    );
    return { data: JSON.parse((await boundedBytes(r)).toString()) };
  }
  if (c.protocol === 'assemblyai') {
    assert(audio, 'MEDIA_AUDIO', 'Audio file required.');
    const r = await mediaHttp(
      c,
      base + '/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(audio.bytes),
      },
      request,
    );
    const upload = JSON.parse((await boundedBytes(r)).toString());
    assert(upload.upload_url, 'MEDIA_UPLOAD', 'Missing upload URL.');
    const d = await json(
      c,
      base + '/transcript',
      { ...input, audio_url: upload.upload_url, speech_models: [c.model] },
      request,
    );
    assert(d.id, 'MEDIA_RECEIPT', 'Missing transcription ID.');
    return { data: d, remoteId: d.id, statusUrl: base + '/transcript/' + encodeURIComponent(d.id) };
  }
  // UI segmentation metadata must never be sent to speech providers.
  const { read_aloud_units: _readAloudUnits, ...speechInput } = input;
  const speech = c.protocol === 'openai-speech';
  const elevenSpeech = c.protocol === 'eleven-speech';
  const endpoint = speech
    ? '/audio/speech'
    : elevenSpeech
      ? '/text-to-speech/' + encodeURIComponent(String(input.voiceId || ''))
      : '/music';
  if (elevenSpeech) assert(input.voiceId, 'VOICE_REQUIRED', 'Set voiceId in service defaults.');
  const body = speech
    ? { voice: 'alloy', response_format: 'mp3', ...speechInput, model: c.model, input: prompt }
    : elevenSpeech
      ? { ...speechInput, model_id: c.model, text: prompt }
      : { ...input, prompt, model_id: c.model };
  const r = await mediaHttp(
    c,
    base + endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    request,
  );
  return {
    data: {},
    binary: { bytes: await boundedBytes(r), mime: r.headers.get('content-type') || 'audio/mpeg' },
  };
}
export async function pollMedia(
  c: MediaConnection,
  job: MediaJob,
  request?: MediaRequest,
): Promise<{
  state: 'pending' | 'failed' | 'done' | 'cancelled';
  data: any;
  binary?: { bytes: Buffer; mime: string };
}> {
  assert(job.statusUrl, 'MEDIA_RECEIPT', 'No remote status receipt.');
  const raw = await json(c, job.statusUrl, undefined, request);

  if (c.protocol === 'minimax-video') {
    checkMiniMax(raw);
    const task = raw.task || raw,
      status = String(task.status).toLowerCase();
    if (['failed', 'fail', 'error'].includes(status)) return { state: 'failed', data: task };
    if (['cancelled', 'canceled'].includes(status)) return { state: 'cancelled', data: task };
    if (!['success', 'succeeded'].includes(status)) return { state: 'pending', data: task };
    if (raw.task) {
      assert(
        typeof task.content?.url === 'string',
        'MEDIA_RESULT',
        'MiniMax video result URL is missing.',
      );
      return {
        state: 'done',
        data: { output: { url: task.content.url, content_type: 'video/mp4' } },
      };
    }
    assert(task.file_id, 'MEDIA_RESULT', 'MiniMax video file ID is missing.');
    const root = c.baseUrl.replace(/\/$/, '').replace(/\/v[12]$/, '');
    const receipt = checkMiniMax(
      await json(
        c,
        root + '/v1/files/retrieve?file_id=' + encodeURIComponent(task.file_id),
        undefined,
        request,
      ),
    );
    assert(
      typeof receipt.file?.download_url === 'string',
      'MEDIA_RESULT',
      'MiniMax video download URL is missing.',
    );
    return {
      state: 'done',
      data: { output: { url: receipt.file.download_url, content_type: 'video/mp4' } },
    };
  }

  const data = c.protocol === 'tripo' ? raw.data || raw : raw;
  if (data.error || ['failed', 'error', 'FAILED', 'FAILURE'].includes(data.status))
    return { state: 'failed', data };
  if (['cancelled', 'canceled', 'CANCELLED'].includes(data.status))
    return { state: 'cancelled', data };
  const done =
    data.done === true ||
    ['succeeded', 'success', 'SUCCEEDED', 'completed', 'COMPLETED'].includes(data.status);
  if (!done) return { state: 'pending', data };
  if (c.protocol === 'fal')
    return { state: 'done', data: await json(c, job.resultUrl!, undefined, request) };
  if (c.protocol === 'openai-video') {
    const r = await mediaHttp(c, job.resultUrl!, {}, request);
    return { state: 'done', data, binary: { bytes: await boundedBytes(r), mime: 'video/mp4' } };
  }
  return { state: 'done', data };
}
export async function cancelMedia(c: MediaConnection, job: MediaJob, request?: MediaRequest) {
  assert(
    job.cancelUrl,
    'CANCEL_UNSUPPORTED',
    'This service has no configured cancellation endpoint; the remote job may continue.',
  );
  const r = await mediaHttp(
    c,
    job.cancelUrl,
    { method: c.protocol === 'fal' ? 'PUT' : 'POST' },
    request,
  );
  await r.body?.cancel();
}
export function extractMedia(data: any): {
  text?: string;
  assets: { url?: string; base64?: string; mime: string; name?: string }[];
} {
  const assets: { url?: string; base64?: string; mime: string; name?: string }[] = [];
  const seen = new Set<string>();
  const walk = (x: any, depth = 0) => {
    if (!x || depth > 12) return;
    if (typeof x === 'string') {
      if (/^https:\/\//.test(x) && !seen.has(x)) {
        seen.add(x);
        assets.push({ url: x, mime: '' });
      }
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((v) => walk(v, depth + 1));
      return;
    }
    if (typeof x !== 'object') return;
    if (x.inlineData || x.inline_data) {
      const d = x.inlineData || x.inline_data;
      assets.push({ base64: d.data, mime: d.mimeType || d.mime_type });
      return;
    }
    if (x.b64_json) {
      assets.push({ base64: x.b64_json, mime: 'image/png' });
      return;
    }
    if (['audio', 'image', 'video'].includes(x.type) && x.data) {
      assets.push({
        base64: x.data,
        mime:
          x.mime_type ||
          x.mimeType ||
          ({ audio: 'audio/mpeg', image: 'image/png', video: 'video/mp4' } as any)[x.type],
      });
      return;
    }
    if (x.url || x.uri) {
      const url = x.url || x.uri;
      if (/^https:\/\//.test(url) && !seen.has(url)) {
        seen.add(url);
        assets.push({ url, mime: x.content_type || x.mimeType || '', name: x.file_name });
      }
      return;
    }
    for (const [k, v] of Object.entries(x))
      if (
        !['logs', 'input', 'metrics', 'usage', 'urls', 'prompt', 'request_id', 'name'].includes(k)
      )
        walk(v, depth + 1);
  };
  // Only walk result payloads, never queue status URLs or input references.
  walk(
    data.output ??
      data.data ??
      data.images ??
      data.candidates ??
      data.steps ??
      data.outputs ??
      data.response ??
      data,
  );
  const text = data.text ?? data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return { assets, text: typeof text === 'string' ? text : undefined };
}
