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
}): Promise<boolean> {
  const { signal, context } = args;
  const response = await streamReadAloud(args.conversationId, args.serviceId, args.text, signal);
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
          if (frame.chunks !== sequence) throw Error('Incomplete speech stream');
          finished = true;
          continue;
        }
        if (frame.type !== 'audio') continue;
        if (finished || frame.sequence !== sequence++ || typeof frame.audio !== 'string')
          throw Error('Invalid speech stream sequence');
        // Bound scheduled audio, including when paused. Fetch backpressure limits client buffering.
        while (context.state === 'suspended' || until - context.currentTime > 30) await wait();
        const bytes = Uint8Array.from(atob(frame.audio), (c) => c.charCodeAt(0));
        const decoded = await context.decodeAudioData(bytes.buffer);
        signal.throwIfAborted();
        if (decoded.duration <= 0 || decoded.duration > 60)
          throw Error('Invalid speech chunk duration');
        const source = context.createBufferSource();
        source.buffer = decoded;
        source.playbackRate.value = args.rate;
        source.connect(context.destination);
        source.onended = () => source.disconnect();
        const at = Math.max(context.currentTime + 0.025, until);
        source.start(at);
        until = at + decoded.duration / args.rate;
        args.onAudio();
      }
      if (result.done) break;
    }
    if (!finished || !sequence || buffer.trim())
      throw Error('Speech stream interrupted before completion');
    while (context.currentTime < until) await wait();
    return true;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
