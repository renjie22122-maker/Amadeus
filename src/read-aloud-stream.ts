import { speechSchedule, type ReadAloudDiagnostics } from './read-aloud-diagnostics';
import { streamReadAloud } from './api';

/** Native local-model WAV chunks scheduled on one audio clock; never retained as chat artifacts. */
export async function playLocalSpeech(args: {
  conversationId: string;
  serviceId: string;
  text: string;
  signal: AbortSignal;
  context: AudioContext;
  rate: number;
  onAudio: () => void;
  diagnostics?: ReadAloudDiagnostics;
  part?: number;
}): Promise<boolean> {
  const { signal, context } = args;
  const record = (type: string, data: Record<string, unknown> = {}) =>
    args.diagnostics?.record(type, {
      part: args.part ?? 0,
      audioTime: context.currentTime,
      ...data,
    });
  signal.throwIfAborted();
  if (!Number.isFinite(args.rate) || args.rate <= 0) throw Error('Invalid playback rate');
  record('request', { text: args.text, serviceId: args.serviceId, rate: args.rate });
  const response = await streamReadAloud(args.conversationId, args.serviceId, args.text, signal);
  record('response', {
    status: response.status,
    requestId: response.headers.get('x-read-aloud-request-id'),
    forwardedTextSha256: response.headers.get('x-read-aloud-text-sha256'),
  });
  // Explicit capability rejection occurs before synthesis; only this case permits fallback.
  if (response.status === 409 || response.status === 404) return false;
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.startsWith('application/x-ndjson')
  ) {
    throw Error(`Speech stream unavailable (${response.status}); no automatic resubmission.`);
  }
  const reader = response.body.getReader();
  const sources = new Map<AudioBufferSourceNode, number>();
  const stopSources = () => {
    for (const [source, sequence] of sources) {
      try {
        record('source_stop', { sequence });
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
    sources.clear();
  };
  const abort = () => {
    record('abort');
    stopSources();
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = '',
    sequence = 0,
    finished = false,
    until = context.currentTime;
  const wait = async () => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Stopped', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 50);
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      record('network_read', { bytes: result.value?.byteLength ?? 0, eof: result.done });
      buffer += decoder.decode(result.value, { stream: !result.done });
      if (buffer.length > 6 * 1024 * 1024) throw Error('Oversized speech stream frame');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'error') throw Error(String(frame.error || 'Speech stream failed'));
        if (frame.type === 'done') {
          if (finished || frame.chunks !== sequence) throw Error('Incomplete speech stream');
          record('done', { chunks: frame.chunks });
          finished = true;
          continue;
        }
        if (frame.type !== 'audio') continue;
        if (finished || frame.sequence !== sequence++ || typeof frame.audio !== 'string')
          throw Error('Invalid speech stream sequence');
        const chunk = frame.sequence;
        record('audio_received', { sequence: chunk, wavBase64: frame.audio });
        // Bound scheduled audio, including when paused. Fetch backpressure limits client buffering.
        while (context.state === 'suspended' || until - context.currentTime > 30) await wait();
        const bytes = Uint8Array.from(atob(frame.audio), (c) => c.charCodeAt(0));
        record('decode_start', { sequence: chunk });
        const decoded = await context.decodeAudioData(bytes.buffer);
        signal.throwIfAborted();
        if (decoded.duration <= 0 || decoded.duration > 60)
          throw Error('Invalid speech chunk duration');
        record('decoded', {
          sequence: chunk,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.numberOfChannels,
        });
        const source = context.createBufferSource();
        source.buffer = decoded;
        source.playbackRate.value = args.rate;
        source.connect(context.destination);
        sources.set(source, chunk);
        source.onended = () => {
          record('ended_callback', { sequence: chunk });
          sources.delete(source);
          source.disconnect();
        };
        const schedule = speechSchedule(until, context.currentTime, chunk === 0);
        const at = schedule.start;
        source.start(at);
        until = at + decoded.duration / args.rate;
        record('scheduled', {
          sequence: chunk,
          scheduledStart: at,
          scheduledEnd: until,
          gapSeconds: schedule.gapSeconds,
        });
        args.onAudio();
      }
      if (result.done) break;
    }
    if (!finished || !sequence || buffer.trim())
      throw Error('Speech stream interrupted before completion');
    while (context.currentTime < until) await wait();
    record('playback_complete');
    return true;
  } catch (error) {
    record('failure', { message: String(error), aborted: signal.aborted });
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    stopSources();
    await reader.cancel().catch(() => {});
  }
}
