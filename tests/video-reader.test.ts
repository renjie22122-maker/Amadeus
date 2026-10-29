import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  videoUrl,
  parseVideoSubtitles,
  videoWindow,
  selectVideoFrames,
  videoProcess,
  probeVideo,
  getVideoSource,
  videoStoryboard,
  videoAudio,
  videoTranscript,
  videoConfigSchema,
} from '../server/services/video-reader.js';
import { installVideoTools } from '../server/tools/video-tools.js';
import { socialChatTools } from '../server/services/chat-access.js';
import { coreTools } from '../server/tools/discovery.js';

const signal = () => new AbortController().signal;
test('platform URLs preserve part IDs but reject arbitrary endpoints and credentials', () => {
  assert.equal(
    videoUrl('https://www.bilibili.com/video/BVabc123?p=2&spm_id_from=foo').url,
    'https://www.bilibili.com/video/BVabc123?p=2',
  );
  assert.equal(
    videoUrl('https://www.youtube.com/watch?v=abc&list=private').url,
    'https://www.youtube.com/watch?v=abc',
  );
  assert.equal(videoUrl('https://t.bilibili.com/12345').platform, 'bilibili');
  for (const url of [
    'https://127.0.0.1/a.mp4',
    'file:///secret',
    'https://youtube.com.attacker.test/watch?v=x',
    'https://name:secret@youtube.com/watch?v=x',
    'https://youtube.com:8123/watch?v=x',
    'https://youtube.com/playlist?list=x',
  ])
    assert.throws(() => videoUrl(url));
  assert.deepEqual(
    videoConfigSchema.parse({ accounts: { youtube: { cookiesFile: 'private.txt' } } }).accounts
      ?.youtube?.conversationIds,
    [],
  );
});
test('subtitle adapters retain timing, repeated speech and provenance without HTML instructions', () => {
  const rows = parseVideoSubtitles(
    'WEBVTT\n\n00:01.000 --> 00:03.000\n<b>Hello</b> &amp; goodbye\n\n00:04.000 --> 00:05.000\nHello\n',
    'vtt',
  );
  assert.deepEqual(rows, [
    { start: 1, end: 3, text: 'Hello & goodbye' },
    { start: 4, end: 5, text: 'Hello' },
  ]);
  assert.deepEqual(parseVideoSubtitles('{"body":[{"from":0,"to":1,"content":"你好"}]}', 'json'), [
    { start: 0, end: 1, text: '你好' },
  ]);
  assert.deepEqual(
    parseVideoSubtitles(
      '{"events":[{"tStartMs":1200,"dDurationMs":800,"segs":[{"utf8":"hello"}]}]}',
      'json3',
    ),
    [{ start: 1.2, end: 2, text: 'hello' }],
  );
  assert.equal(
    parseVideoSubtitles('1\n01:02:03,100 --> 01:02:04,300\nword\n', 'srt')[0].start,
    3723.1,
  );
});
test('window validation and visual sampling preserve beginning, middle and ending coverage', () => {
  assert.deepEqual(videoWindow(100, 90, 30), { from: 90, to: 100 });
  assert.throws(() => videoWindow(100, 100, 20));
  assert.throws(() => videoWindow(NaN, 0, 20));
  const raw = Buffer.alloc(64 * 36 * 3 * 9);
  for (let i = 0; i < 9; i++) raw.fill(i * 25, i * 64 * 36 * 3, (i + 1) * 64 * 36 * 3);
  const times = selectVideoFrames(raw, 10, 1, 3);
  assert.equal(times.length, 3);
  assert(
    times[0] >= 10 &&
      times[0] < 13 &&
      times[1] >= 13 &&
      times[1] < 16 &&
      times[2] >= 16 &&
      times[2] < 19,
  );
});
test('all chat types discover video tools; private records and nonvision models remain protected', async () => {
  const tools: any[] = [];
  installVideoTools({ add: (t: any) => tools.push(t) } as any);
  for (const tool of tools) {
    assert(socialChatTools.has(tool.name));
    assert(coreTools.has(tool.name));
  }
  const c: any = {
    conversation: { id: 'other' },
    store: { get: () => ({ conversationId: 'private' }) },
    signal: signal(),
    run: { profileId: 'model' },
    config: { profile: () => ({ vision: false }) },
  };
  assert.throws(() => getVideoSource(c, 'id'), /another conversation/);
  await assert.rejects(
    () =>
      tools
        .find((t) => t.name === 'video_storyboard')
        .run({ sourceId: 'a'.repeat(64), from: 0, seconds: 30, cells: 9 }, c),
    /image-capable/,
  );
  await assert.rejects(
    () =>
      probeVideo(
        { ...c, config: { get: () => ({ web: { enabled: false } }) } },
        { url: 'https://youtu.be/abc' },
      ),
    /disabled/,
  );
});
const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
test(
  'real FFmpeg: attachment probe, embedded subtitles, storyboard cache/zoom and ASR audio',
  { skip: !hasFfmpeg },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'amadeus-video-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'clip.mp4'),
      subtitle = join(root, 'sub.srt');
    await writeFile(
      subtitle,
      '1\n00:00:00,000 --> 00:00:01,500\nfirst\n\n2\n00:00:02,000 --> 00:00:03,500\nsecond\n',
    );
    await videoProcess(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=10:duration=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4',
        '-i',
        subtitle,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-c:a',
        'aac',
        '-c:s',
        'mov_text',
        '-y',
        path,
      ],
      signal(),
    );
    const records = new Map<string, any>();
    const video = await readFile(path);
    const c: any = {
      conversation: { id: 'c' },
      run: { id: 'r' },
      signal: signal(),
      config: { get: () => ({}) },
      store: {
        path: join(root, 'agent.sqlite'),
        maybe: (kind: string, id: string) => records.get(kind + id),
        get: (kind: string, id: string) => records.get(kind + id),
        put: (kind: string, item: any) => {
          records.set(kind + item.id, item);
          return item;
        },
      },
      media: {
        streamOutput: (reference: string, conversationId: string) => {
          assert.equal(reference, 'attachment:video');
          assert.equal(conversationId, 'c');
          return { metadata: { mime: 'video/mp4', name: 'clip.mp4' }, chunks: [video] };
        },
        importLocal: async (bytes: Buffer) => {
          assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
          return { reference: 'attachment:audio' };
        },
      },
    };
    const source = await probeVideo(c, { reference: 'attachment:video' });
    assert.equal(source.metadata.tracks.length, 1);
    assert(source.metadata.duration >= 4);
    assert.equal((await probeVideo(c, { reference: 'attachment:video' })).cached, true);
    const transcript = await videoTranscript(c, source, source.metadata.tracks[0].id);
    assert.deepEqual(
      transcript.cues.map((v: any) => v.text),
      ['first', 'second'],
    );
    const sheet = await videoStoryboard(c, source, 0, 4, 4);
    assert.equal(sheet.frames.length, 4);
    assert(sheet.bytes.length > 1000);
    assert.equal(sheet.nextFrom, null);
    assert.equal((await videoStoryboard(c, source, 0, 4, 4)).cached, true);
    const zoom = await videoStoryboard(c, source, 2, 1, 1);
    assert.equal(zoom.frames.length, 1);
    assert.equal(zoom.window.from, 2);
    const audio = await videoAudio(c, source, 1, 2);
    assert.deepEqual(audio.window, { from: 1, to: 3 });
    assert.equal(audio.reference, 'attachment:audio');
    // Swapping conversation IDs must not grant access to an existing sourceId.
    assert.throws(() => getVideoSource({ ...c, conversation: { id: 'elsewhere' } }, source.id));
  },
);

test('platform worker security, cookie scoping and Bilibili fixtures', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/video-reader-worker.py'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
});
