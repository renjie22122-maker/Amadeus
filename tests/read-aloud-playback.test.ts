import { ReadAloudDiagnostics, speechSchedule } from '../src/read-aloud-diagnostics.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { playLocalSpeech } from '../src/read-aloud-stream.js';

function tone(frequency: number) {
  const rate = 8000,
    count = 80;
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    data.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / rate)),
      44 + i * 2,
    );
  return data;
}
function harness(frames: unknown[]) {
  const decoded: Buffer[] = [],
    started: number[] = [],
    stopped: number[] = [];
  let clock = 0;
  const context = {
    get currentTime() {
      return (clock += 0.1);
    },
    state: 'running',
    destination: {},
    async decodeAudioData(bytes: ArrayBuffer) {
      decoded.push(Buffer.from(bytes));
      return { duration: 0.01 };
    },
    createBufferSource() {
      const id = started.length;
      return {
        buffer: null,
        playbackRate: { value: 1 },
        connect() {},
        disconnect() {},
        start() {
          started.push(id);
        },
        stop() {
          stopped.push(id);
        },
        onended: null,
      };
    },
  } as unknown as AudioContext;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).text, '普通测试 Hello');
    return new Response(frames.map((f) => JSON.stringify(f)).join('\n') + '\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }) as typeof fetch;
  return {
    context,
    decoded,
    started,
    stopped,
    restore() {
      globalThis.fetch = original;
    },
  };
}
const frame = (sequence: number, data: Buffer) => ({
  type: 'audio',
  sequence,
  audio: data.toString('base64'),
});
function args(context: AudioContext, signal = new AbortController().signal) {
  return {
    conversationId: 'fixture',
    serviceId: 'fixture',
    text: '普通测试 Hello',
    context,
    signal,
    rate: 1,
    onAudio() {},
  };
}
test('synthetic WAV chunks reach decoder unchanged, once and in sequence', async () => {
  const a = tone(440),
    b = tone(880);
  const h = harness([frame(0, a), frame(1, b), { type: 'done', chunks: 2 }]);
  try {
    assert.equal(await playLocalSpeech(args(h.context)), true);
    assert.deepEqual(h.decoded, [a, b]);
    assert.equal(h.started.length, 2);
  } finally {
    h.restore();
  }
});
test('stream error stops all scheduled sources instead of leaving old audio queued', async () => {
  const h = harness([frame(0, tone(440)), { type: 'error', error: 'fixture failure' }]);
  try {
    await assert.rejects(playLocalSpeech(args(h.context)), /fixture failure/);
    assert.deepEqual(h.stopped, [0]);
  } finally {
    h.restore();
  }
});
test('duplicate chunk is rejected and cannot play a second time', async () => {
  const a = frame(0, tone(440));
  const h = harness([a, a]);
  try {
    await assert.rejects(playLocalSpeech(args(h.context)), /sequence/);
    assert.equal(h.started.length, 1);
    assert.deepEqual(h.stopped, [0]);
  } finally {
    h.restore();
  }
});
test('abort during audio decode never schedules the decoded old request', async () => {
  const h = harness([frame(0, tone(440))]);
  const controller = new AbortController();
  h.context.decodeAudioData = async () => {
    controller.abort();
    return { duration: 0.01 } as AudioBuffer;
  };
  try {
    await assert.rejects(playLocalSpeech(args(h.context, controller.signal)), {
      name: 'AbortError',
    });
    assert.equal(h.started.length, 0);
  } finally {
    h.restore();
  }
});

test('diagnostics capture exact returned audio without altering playback', async () => {
  const audio = tone(440);
  const h = harness([frame(0, audio), { type: 'done', chunks: 1 }]);
  const trace = new ReadAloudDiagnostics();
  try {
    await playLocalSpeech({ ...args(h.context), diagnostics: trace });
    const events = trace.snapshot().events;
    assert.equal(events.find((e) => e.type === 'request')?.text, '普通测试 Hello');
    assert.deepEqual(
      Buffer.from(String(events.find((e) => e.type === 'audio_received')?.wavBase64), 'base64'),
      audio,
    );
    assert.equal(events.filter((e) => e.type === 'scheduled').length, 1);
    assert.equal(events.at(-1)?.type, 'source_stop');
  } finally {
    h.restore();
  }
});
test('initial playback lead absorbs jitter and reports actual underruns', () => {
  const first = speechSchedule(0, 0, true);
  assert.equal(first.start, 1.5);
  assert.equal(speechSchedule(first.start + 0.15, 0.2, false).gapSeconds, 0);
  assert(speechSchedule(first.start + 0.15, 2, false).gapSeconds >= 0.5);
});
test('diagnostics memory cap never prevents later playback', () => {
  const trace = new ReadAloudDiagnostics(1);
  trace.record('audio_received', { wavBase64: 'oversize' });
  assert.equal(trace.snapshot().truncated, true);
  assert.equal(trace.snapshot().events.length, 0);
});

test('measured normal-voice startup timing has no scheduling underrun with buffered start', () => {
  const arrivals = [17.437, 18.906, 21.844, 24.375, 27.172, 31.422, 34.75, 37.281, 38.562];
  const durations = [1.36, 2, 4, 4, 3.72, 4.36, 4, 4, 2.24];
  let end = 0;
  for (let i = 0; i < arrivals.length; i++) {
    const next = speechSchedule(end, arrivals[i], i === 0);
    assert.equal(next.gapSeconds, 0);
    end = next.start + durations[i];
  }
});
