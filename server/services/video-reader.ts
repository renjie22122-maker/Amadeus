import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rename, rm, readdir, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { z } from 'zod';
import { assert } from '../core/errors.js';
import type { ToolContext } from '../tools/registry.js';
import { checkSourceText } from './source-policy.js';

export const videoConfigSchema = z
  .object({
    python: z.string().optional(),
    ffmpeg: z.string().optional(),
    ffprobe: z.string().optional(),
    accounts: z
      .object({
        bilibili: z
          .object({
            cookiesFile: z.string(),
            conversationIds: z.array(z.string()).default([]),
            allowLocalConversations: z.boolean().default(false),
            privateChatTransports: z.array(z.string().min(1).max(40)).default([]),
          })
          .optional(),
        youtube: z
          .object({
            cookiesFile: z.string(),
            conversationIds: z.array(z.string()).default([]),
            allowLocalConversations: z.boolean().default(false),
            privateChatTransports: z.array(z.string().min(1).max(40)).default([]),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();
export function videoUrl(input: string) {
  const u = new URL(input);
  assert(
    u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443'),
    'VIDEO_URL',
    'Use a public HTTPS video URL.',
  );
  const bili = [
    'bilibili.com',
    'www.bilibili.com',
    'm.bilibili.com',
    'b23.tv',
    't.bilibili.com',
    'space.bilibili.com',
  ];
  const yt = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    'www.youtube-nocookie.com',
  ];
  assert(
    [...bili, ...yt].includes(u.hostname),
    'VIDEO_URL',
    'Supported online adapters: Bilibili and YouTube. Import other videos as conversation attachments.',
  );
  const platform: 'bilibili' | 'youtube' = bili.includes(u.hostname) ? 'bilibili' : 'youtube';
  assert(
    platform === 'bilibili'
      ? /\/video\/(BV[\w]+|av\d+)|\/opus\/\d+/.test(u.pathname) ||
          u.hostname === 'b23.tv' ||
          u.hostname === 't.bilibili.com'
      : (u.pathname === '/watch' && !!u.searchParams.get('v')) ||
          /^\/(shorts|embed|live)\/[\w-]+/.test(u.pathname) ||
          u.hostname === 'youtu.be',
    'VIDEO_URL',
    'Provide an individual video or Bilibili dynamic link, not a feed or playlist.',
  );
  u.hash = '';
  // Preserve part selection and video identity; strip tracking and playlist expansion.
  for (const key of [...u.searchParams.keys()])
    if (!['p', 'v'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, platform };
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export interface VideoSource {
  id: string;
  conversationId: string;
  url?: string;
  reference?: string;
  metadata: any;
  updatedAt: number;
}
const roots = (c: ToolContext) => join(dirname(c.store.path), 'video-reader');
// Cache is disposable; original attachments and source/history records are never removed.
async function pruneVideoCache(c: ToolContext, keep?: string) {
  const root = join(roots(c), 'sources');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const sizes: { path: string; bytes: number; at: number; id: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const path = join(root, entry.name),
      info = await stat(path);
    let bytes = 0;
    for (const child of await readdir(path, { withFileTypes: true }))
      if (child.isFile()) bytes += (await stat(join(path, child.name))).size;
    sizes.push({ path, bytes, at: info.mtimeMs, id: entry.name });
  }
  let total = sizes.reduce((n, item) => n + item.bytes, 0);
  for (const item of sizes.sort((a, b) => a.at - b.at)) {
    if (item.id === keep) continue;
    if (total <= 2 * 1024 ** 3 && Date.now() - item.at < 7 * 86400000) continue;
    await rm(item.path, { recursive: true, force: true });
    total -= item.bytes;
  }
}
async function configuration(c: ToolContext) {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(join(dirname(c.store.path), 'video-reader.json'), 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw Error('VIDEO_CONFIG: invalid local video-reader.json');
  }
  const parsed = videoConfigSchema.parse(raw);
  const venv = join(
    dirname(c.store.path),
    'video-reader-env',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const python =
    parsed.python ||
    (await stat(venv).then(
      () => venv,
      () => (process.platform === 'win32' ? 'python' : 'python3'),
    ));
  return {
    ...parsed,
    python,
    ffmpeg: parsed.ffmpeg || 'ffmpeg',
    ffprobe: parsed.ffprobe || 'ffprobe',
  };
}
export async function videoProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  input?: string,
  maxBytes = 12 * 1024 * 1024,
  timeout = 120000,
): Promise<Buffer> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    OMP_NUM_THREADS: '1',
  };
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
  ])
    if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let size = 0,
      stderrSize = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill();
        }
      }
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 4 * 1024 * 1024) stop();
    });
    child.on('error', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(
        Error('VIDEO_DEPENDENCY: required Python, yt-dlp or FFmpeg executable is unavailable.'),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) return reject(signal.reason);
      if (size > maxBytes || stderrSize > 4 * 1024 * 1024)
        return reject(Error('VIDEO_OUTPUT_LIMIT: narrow the requested window.'));
      const bytes = Buffer.concat(chunks);
      // Python adapter emits a sanitized structured error even on nonzero exit.
      if (code !== 0 && !(input && bytes.length))
        return reject(Error('VIDEO_PROCESS: decoding failed or exceeded its deadline.'));
      resolveResult(bytes);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
// A shared, cancellable queue caps CPU/IO use across all conversations. No GPU model is loaded.
let tail: Promise<unknown> = Promise.resolve();
let queued = 0;
export async function videoQueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  assert(queued < 16, 'VIDEO_BUSY', 'Video reading queue is full; wait for existing requests.');
  queued++;
  const job = tail
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      return operation();
    });
  tail = job
    .finally(() => {
      queued--;
    })
    .catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
export function requireVideoNetwork(c: ToolContext) {
  assert(
    c.config.get().web?.enabled !== false,
    'NETWORK_DISABLED',
    'Public web tools are disabled.',
  );
  assert(
    !c.sourcePolicy,
    'SOURCE_POLICY',
    'Platform extractors are unavailable under a constrained evidence policy; use the policy-aware web tools.',
  );
}
export function videoAccountAllowed(
  c: ToolContext,
  account:
    | {
        conversationIds: string[];
        allowLocalConversations?: boolean;
        privateChatTransports?: string[];
      }
    | undefined,
) {
  if (!account) return false;
  if (account.conversationIds.includes(c.conversation.id)) return true;
  const bindings =
    typeof c.store.list === 'function'
      ? c.store.list<any>('chat-connection').filter((v) => v.conversationId === c.conversation.id)
      : [];
  if (bindings.length)
    return bindings.every(
      (v) =>
        v.enabled &&
        (v.peerType || 'private') === 'private' &&
        account.privateChatTransports?.includes(v.transport),
    );
  return (
    account.allowLocalConversations === true &&
    !c.conversation.remoteChatOnly &&
    !c.conversation.remoteMemoryOnly
  );
}
export async function videoSite(
  c: ToolContext,
  args: Record<string, unknown> & { url: string },
  folder?: string,
) {
  requireVideoNetwork(c);
  const source = videoUrl(args.url),
    conf = await configuration(c);
  const work = folder || join(roots(c), 'requests', randomUUID());
  await mkdir(work, { recursive: true });
  try {
    const bytes = await videoProcess(
      conf.python,
      [fileURLToPath(new URL('./video-reader-worker.py', import.meta.url))],
      c.signal,
      JSON.stringify({
        ...args,
        url: source.url,
        folder: work,
        ffmpeg: conf.ffmpeg,
        cookiesFile: videoAccountAllowed(c, conf.accounts?.[source.platform])
          ? conf.accounts?.[source.platform]?.cookiesFile
          : undefined,
      }),
      12 * 1024 * 1024,
      180000,
    );
    const result = JSON.parse(bytes.toString('utf8'));
    assert(
      result.ok,
      result.code || 'VIDEO_EXTRACT',
      (result.error || 'Video extraction failed.') +
        (result.httpStatus ? ' HTTP ' + result.httpStatus : '') +
        (result.platformCode != null ? ' Platform code ' + result.platformCode : ''),
    );
    checkSourceText(JSON.stringify(result.data), c.sourcePolicy);
    return result.data;
  } finally {
    await rm(join(work, 'session.cookies'), { force: true });
    if (!folder) await rm(work, { recursive: true, force: true });
  }
}
export async function probeVideo(
  c: ToolContext,
  input: { url?: string; reference?: string; refresh?: boolean },
) {
  assert(
    !!input.url !== !!input.reference,
    'VIDEO_SOURCE',
    'Provide exactly one URL or same-conversation media reference.',
  );
  const url = input.url ? videoUrl(input.url).url : undefined;
  if (url) requireVideoNetwork(c);
  const id = digest(c.conversation.id + '\0' + (url || input.reference));
  const old = c.store.maybe<VideoSource>('video-source', id);
  if (old && !input.refresh && Date.now() - old.updatedAt < 600000) return { ...old, cached: true };
  let metadata: any;
  if (url) metadata = await videoSite(c, { url, action: 'probe' });
  else {
    const stream = c.media.streamOutput(input.reference!, c.conversation.id, c.signal);
    assert(
      stream.metadata.mime.startsWith('video/'),
      'VIDEO_TYPE',
      'Reference must contain video bytes.',
    );
    const source: VideoSource = {
      id,
      conversationId: c.conversation.id,
      reference: input.reference,
      metadata: {},
      updatedAt: Date.now(),
    };
    const file = await localVideo(c, source);
    const conf = await configuration(c);
    const info = JSON.parse(
      (
        await videoProcess(
          conf.ffprobe,
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            'mov,matroska,webm,avi,flv,ogg,mpegts',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            file,
          ],
          c.signal,
        )
      ).toString('utf8'),
    );
    metadata = {
      title: stream.metadata.name,
      duration: Number(info.format?.duration),
      streams: (info.streams || []).map((s: any) => ({
        index: s.index,
        type: s.codec_type,
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        language: s.tags?.language,
      })),
      tracks: (info.streams || [])
        .filter(
          (s: any) =>
            s.codec_type === 'subtitle' &&
            ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(s.codec_name),
        )
        .map((s: any) => ({
          id: 'embedded:' + s.index,
          language: s.tags?.language || 'unknown',
          kind: 'embedded',
        })),
      platform: 'attachment',
    };
  }
  const source: VideoSource = {
    id,
    conversationId: c.conversation.id,
    url,
    reference: input.reference,
    metadata,
    updatedAt: Date.now(),
  };
  c.store.put('video-source', source);
  return { ...source, cached: false };
}
export function getVideoSource(c: ToolContext, id: string) {
  const source = c.store.get<VideoSource>('video-source', id);
  assert(
    source.conversationId === c.conversation.id,
    'SCOPE',
    'Video belongs to another conversation.',
  );
  if (source.url) requireVideoNetwork(c);
  return source;
}
async function localVideo(c: ToolContext, source: VideoSource): Promise<string> {
  const folder = join(roots(c), 'sources', source.id);
  await pruneVideoCache(c, source.id);
  await mkdir(folder, { recursive: true });
  await utimes(folder, new Date(), new Date());
  const receipt = join(folder, 'local.json');
  try {
    const saved = JSON.parse(await readFile(receipt, 'utf8'));
    const path = join(folder, saved.file);
    assert(dirname(resolve(path)) === resolve(folder), 'VIDEO_CACHE', 'Invalid cache path.');
    if ((await stat(path)).size > 0) return path;
  } catch {}
  let path: string;
  assert(!source.url, 'VIDEO_RANGE_REQUIRED', 'Online videos require partial range reads.');
  {
    const stream = c.media.streamOutput(source.reference!, c.conversation.id, c.signal);
    assert(stream.metadata.mime.startsWith('video/'), 'VIDEO_TYPE', 'Video input required.');
    path = join(folder, 'video.input');
    const temporary = path + '.partial';
    const { open } = await import('node:fs/promises');
    const handle = await open(temporary, 'w');
    let size = 0;
    try {
      for await (const chunk of stream.chunks) {
        size += chunk.length;
        assert(
          size <= 300 * 1024 * 1024,
          'VIDEO_SIZE',
          'Inspection copy exceeds 300 MB; provide a shorter clip.',
        );
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }
  await writeFile(receipt, JSON.stringify({ file: path.slice(folder.length + 1) }));
  return path;
}
export interface VideoCue {
  start: number;
  end: number;
  text: string;
}
const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
export function parseVideoSubtitles(raw: string, format: string): VideoCue[] {
  let cues: VideoCue[] = [];
  if (format === 'json' || format === 'json3') {
    const data = JSON.parse(raw);
    if (Array.isArray(data.body))
      cues = data.body.map((r: any) => ({
        start: Number(r.from),
        end: Number(r.to),
        text: String(r.content || ''),
      }));
    else if (Array.isArray(data.events))
      cues = data.events
        .filter((r: any) => r.segs)
        .map((r: any) => ({
          start: Number(r.tStartMs) / 1000,
          end: (Number(r.tStartMs) + Number(r.dDurationMs || 0)) / 1000,
          text: r.segs.map((s: any) => s.utf8 || '').join(''),
        }));
  } else {
    const seconds = (s: string) =>
      s
        .replace(',', '.')
        .split(':')
        .reduce((n, v) => n * 60 + Number(v), 0);
    const lines = raw.replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(
        /((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)/,
      );
      if (!match) continue;
      const text: string[] = [];
      while (++i < lines.length && lines[i].trim()) text.push(lines[i]);
      cues.push({ start: seconds(match[1]), end: seconds(match[2]), text: text.join('\n') });
    }
  }
  const seen = new Set<string>();
  return cues
    .map((c) => ({ ...c, text: decode(c.text).trim() }))
    .filter((c) => {
      if (
        !Number.isFinite(c.start) ||
        !Number.isFinite(c.end) ||
        c.start < 0 ||
        c.end < c.start ||
        !c.text
      )
        return false;
      const key = JSON.stringify(c);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start);
}
export async function videoTranscript(c: ToolContext, source: VideoSource, track: string) {
  assert(
    source.metadata.tracks?.some((t: any) => t.id === track),
    'SUBTITLE_TRACK',
    'Select a track ID returned by video_probe.',
  );
  const folder = join(roots(c), 'sources', source.id);
  await pruneVideoCache(c, source.id);
  await mkdir(folder, { recursive: true });
  await utimes(folder, new Date(), new Date());
  const file = join(folder, 'subtitle-' + digest(track) + '.json');
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - cached.savedAt < 3600000) return { ...cached, cached: true };
  } catch {}
  let result: any;
  if (source.url) {
    const data = await videoSite(c, { url: source.url, action: 'subtitle', track });
    result = {
      track,
      kind: data.kind,
      language: data.language,
      cues: parseVideoSubtitles(data.raw, data.format),
    };
  } else {
    assert(/^embedded:\d+$/.test(track), 'SUBTITLE_TRACK', 'Invalid embedded track.');
    const conf = await configuration(c),
      path = await localVideo(c, source);
    const bytes = await videoProcess(
      conf.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'mov,matroska,webm,avi,flv,ogg,mpegts',
        '-i',
        path,
        '-map',
        '0:' + track.slice(9),
        '-f',
        'srt',
        'pipe:1',
      ],
      c.signal,
    );
    result = { track, kind: 'embedded', cues: parseVideoSubtitles(bytes.toString('utf8'), 'srt') };
  }
  result.savedAt = Date.now();
  await writeFile(file, JSON.stringify(result));
  return { ...result, cached: false };
}
export function videoWindow(duration: number, from: number, seconds: number) {
  assert(
    Number.isFinite(duration) && duration > 0,
    'VIDEO_DURATION',
    'Source duration unavailable; cannot claim coverage.',
  );
  assert(
    Number.isFinite(from) && from >= 0 && from < duration && seconds > 0 && seconds <= 600,
    'VIDEO_WINDOW',
    'Choose a valid window up to 600 seconds inside the video.',
  );
  return { from, to: Math.min(duration, from + seconds) };
}
export function selectVideoFrames(raw: Buffer, from: number, step: number, cells: number) {
  const size = 64 * 36 * 3,
    count = Math.floor(raw.length / size);
  assert(count > 0, 'VIDEO_DECODE', 'No video frames decoded.');
  const scores: number[] = [];
  for (let i = 0; i < count; i++) {
    let difference = 0,
      sharpness = 0;
    for (let j = 3; j < size; j += 3) {
      sharpness += Math.abs(raw[i * size + j] - raw[i * size + j - 3]);
      if (i) difference += Math.abs(raw[i * size + j] - raw[(i - 1) * size + j]);
    }
    scores.push(difference / size + (sharpness / size) * 0.15);
  }
  const selected: number[] = [];
  for (let b = 0; b < Math.min(cells, count); b++) {
    const start = Math.floor((b * count) / Math.min(cells, count)),
      end = Math.floor(((b + 1) * count) / Math.min(cells, count));
    let best = Math.floor((start + end - 1) / 2);
    for (let i = start; i < end; i++) if (scores[i] > scores[best] + 0.1) best = i;
    selected.push(from + best * step);
  }
  return selected;
}
export async function videoStoryboard(
  c: ToolContext,
  source: VideoSource,
  from: number,
  seconds: number,
  cells: number,
) {
  const win = videoWindow(Number(source.metadata.duration), from, seconds);
  const folder = join(roots(c), 'sources', source.id);
  await pruneVideoCache(c, source.id);
  await mkdir(folder, { recursive: true });
  await utimes(folder, new Date(), new Date());
  const key = digest(JSON.stringify([win, cells, 3]));
  const manifest = join(folder, key + '.json'),
    image = join(folder, key + '.png');
  try {
    return {
      ...JSON.parse(await readFile(manifest, 'utf8')),
      bytes: await readFile(image),
      cached: true,
    };
  } catch {}
  const started = Date.now();
  const tileW = cells === 1 ? 1280 : 320,
    tileH = cells === 1 ? 720 : 180;
  let times: number[] = [],
    frames: Buffer[] = [],
    remote: any;
  if (source.url) {
    remote = await videoSite(
      c,
      { url: source.url, action: 'frames', from: win.from, seconds: win.to - win.from, cells },
      folder,
    );
    times = remote.frames.map((f: any) => f.actualTime);
    for (let i = 0; i < times.length; i++)
      frames.push(
        await sharp(await readFile(join(folder, `range-${i}.png`)))
          .resize(tileW, tileH, { fit: 'contain', background: '#17191e' })
          .png()
          .toBuffer(),
      );
  } else {
    const path = await localVideo(c, source),
      conf = await configuration(c);
    const step = Math.min(1, (win.to - win.from) / cells);
    const input = [
      '-nostdin',
      '-v',
      'error',
      '-threads',
      '1',
      '-filter_threads',
      '1',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'mov,matroska,webm,avi,flv,ogg,mpegts',
      '-ss',
      String(win.from),
      '-i',
      path,
      '-t',
      String(win.to - win.from),
    ];
    const samples = await videoProcess(
      conf.ffmpeg,
      [
        ...input,
        '-vf',
        `fps=${1 / step},scale=64:36`,
        '-an',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      c.signal,
    );
    times = selectVideoFrames(samples, win.from, step, cells).filter((t) => t < win.to);
    for (const time of times) {
      frames.push(
        await videoProcess(
          conf.ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-threads',
            '1',
            '-filter_threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            'mov,matroska,webm,avi,flv,ogg,mpegts',
            '-ss',
            String(time),
            '-i',
            path,
            '-frames:v',
            '1',
            '-vf',
            `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2`,
            '-threads',
            '1',
            '-f',
            'image2pipe',
            '-vcodec',
            'png',
            'pipe:1',
          ],
          c.signal,
        ),
      );
    }
  }
  const cols = Math.min(3, frames.length),
    rows = Math.ceil(frames.length / cols),
    height = tileH + 24;
  const composites: OverlayOptions[] = frames.map((buffer, i) => ({
    input: buffer,
    left: (i % cols) * tileW,
    top: Math.floor(i / cols) * height,
  }));
  const labels = times
    .map(
      (time, i) =>
        `<text x="${(i % cols) * tileW + 8}" y="${Math.floor(i / cols) * height + tileH + 17}" fill="white" font-size="14">${i + 1} | ${time.toFixed(2)}s</text>`,
    )
    .join('');
  composites.push({
    input: Buffer.from(`<svg width="${cols * tileW}" height="${rows * height}">${labels}</svg>`),
    left: 0,
    top: 0,
  });
  const bytes = await sharp({
    create: { width: cols * tileW, height: rows * height, channels: 3, background: '#17191e' },
  })
    .composite(composites)
    .png()
    .toBuffer();
  const result = {
    sourceId: source.id,
    window: win,
    sourceDuration: source.metadata.duration,
    frames: remote?.frames || times.map((time, i) => ({ cell: i + 1, requestedTime: time })),
    transfer: remote
      ? {
          mode: remote.mode,
          bytes: remote.transferredBytes,
          requests: remote.rangeRequests,
          sourceBytes: remote.sourceBytes,
        }
      : { mode: 'local-cache' },
    sampling: remote
      ? 'uniform timestamp sampling over the requested window, actual decoded times reported; no full download'
      : 'one representative per time bucket, low-resolution frame-change and sharpness score; not exhaustive scene detection',
    nextFrom: win.to < source.metadata.duration ? win.to : null,
    elapsedMs: Date.now() - started,
  };
  await writeFile(image, bytes);
  await writeFile(manifest, JSON.stringify(result));
  return { ...result, bytes, cached: false };
}
export async function videoAudio(
  c: ToolContext,
  source: VideoSource,
  from: number,
  seconds: number,
) {
  const win = videoWindow(Number(source.metadata.duration), from, seconds);
  let bytes: Buffer, transfer: any;
  if (source.url) {
    const folder = join(roots(c), 'sources', source.id);
    await pruneVideoCache(c, source.id);
    await mkdir(folder, { recursive: true });
    transfer = await videoSite(
      c,
      { url: source.url, action: 'audio', from: win.from, seconds: win.to - win.from },
      folder,
    );
    bytes = await readFile(join(folder, 'range-audio.wav'));
  } else {
    const conf = await configuration(c),
      path = await localVideo(c, source);
    bytes = await videoProcess(
      conf.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'mov,matroska,webm,avi,flv,ogg,mpegts',
        '-ss',
        String(win.from),
        '-i',
        path,
        '-t',
        String(win.to - win.from),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        'pipe:1',
      ],
      c.signal,
      undefined,
      22 * 1024 * 1024,
    );
  }
  const attachment = await c.media.importLocal(
    bytes,
    `video-audio-${from}-${win.to}.wav`,
    c.conversation.id,
    c.run.id,
    c.signal,
  );
  return {
    ...attachment,
    sourceId: source.id,
    window: win,
    nextFrom: win.to < source.metadata.duration ? win.to : null,
    transfer,
    note: 'Use transcribe_media on this reference. ASR timestamps are relative to this clip; add window.from. Transcription is not yet available.',
  };
}
