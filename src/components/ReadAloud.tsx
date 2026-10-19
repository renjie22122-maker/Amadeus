import { supportsReadAloud } from '../../shared/media-capabilities';
import { useEffect, useRef, useState } from 'react';
import { Volume2, Square, Play, Pause, Settings2, Loader2 } from 'lucide-react';
import { api } from '../api';
import { playLocalSpeech } from '../read-aloud-stream';
import { speechChunks } from '../../shared/read-aloud';
import type { MediaConnection } from '../../shared/media';

export function ReadAloud({
  conversationId,
  text,
  zh,
  notify,
}: {
  conversationId: string;
  text: string;
  zh: boolean;
  notify: (message: string) => void;
}) {
  const [services, setServices] = useState<MediaConnection[]>([]);
  const [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState<'preparing' | 'playing'>('preparing');
  const [progress, setProgress] = useState('');
  const [rate, setRate] = useState(1);
  const context = useRef<AudioContext | null>(null);
  const native = useRef(false);
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<AbortController | null>(null);
  const isPaused = useRef(false);
  const rateRef = useRef(1);
  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
    native.current = false;
    audio.current?.pause();
    audio.current?.removeAttribute('src');
    audio.current?.load();
    isPaused.current = false;
    setPaused(false);
    setBusy(false);
    setProgress('');
  };
  useEffect(() => {
    window.addEventListener('amadeus-stop-read-aloud', stop);
    return () => {
      window.removeEventListener('amadeus-stop-read-aloud', stop);
      controller.current?.abort();
      audio.current?.pause();
      void context.current?.close().catch(() => {});
    };
  }, [conversationId]);
  const togglePause = async () => {
    isPaused.current = !isPaused.current;
    setPaused(isPaused.current);
    if (native.current && context.current) {
      try {
        if (isPaused.current) await context.current.suspend();
        else await context.current.resume();
      } catch (error) {
        notify(String(error));
      }
      return;
    }
    if (isPaused.current) audio.current?.pause();
    else if (audio.current?.getAttribute('src')) {
      try {
        await audio.current.play();
      } catch {
        isPaused.current = true;
        setPaused(true);
        notify(zh ? '无法播放，请再次点击播放。' : 'Playback blocked; press Play again.');
      }
    }
  };
  const start = async () => {
    window.dispatchEvent(new Event('amadeus-stop-read-aloud'));
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setPhase('preparing');
    setOpen(false);
    // Create/resume within the click gesture, before network awaits, for autoplay policies.
    try {
      context.current = new AudioContext();
      void context.current.resume().catch(() => {});
    } catch {
      context.current = null;
    }
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        current.signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Stopped', 'AbortError'));
        };
        const timer = setTimeout(() => {
          current.signal.removeEventListener('abort', abort);
          resolve();
        }, ms);
        current.signal.addEventListener('abort', abort, { once: true });
      });
    const waitForResume = async () => {
      while (isPaused.current) await sleep(100);
      current.signal.throwIfAborted();
    };
    try {
      const list = (
        await api<MediaConnection[]>('/media/services', undefined, undefined, {}, current.signal)
      ).filter((c) => c.kind === 'speech');
      current.signal.throwIfAborted();
      if (!list.length)
        throw Error(
          zh ? '请先在设置中启用语音合成服务。' : 'Enable a speech service in Settings first.',
        );
      const service =
        list.find((c) => c.id === selected) || list.find(supportsReadAloud) || list[0];
      setServices(list);
      setSelected(service.id);
      if (supportsReadAloud(service) && context.current) {
        const parts = speechChunks(text, 2500);
        native.current = true;
        for (let i = 0; i < parts.length; i++) {
          await waitForResume();
          setProgress(parts.length > 1 ? `${i + 1}/${parts.length}` : '');
          setPhase('preparing');
          const supported = await playLocalSpeech({
            conversationId,
            serviceId: service.id,
            text: parts[i],
            signal: current.signal,
            context: context.current,
            rate: rateRef.current,
            onAudio: () => setPhase('playing'),
          });
          if (!supported) {
            if (i > 0)
              throw Error('Speech streaming became unavailable; playback was not replayed.');
            native.current = false;
            break;
          }
        }
        if (native.current) return;
      }
      await context.current?.close();
      context.current = null;
      const budget = service.defaults.read_aloud_units;
      const bounded = typeof budget === 'number' && Number.isFinite(budget) && budget >= 1;
      const chunks = speechChunks(text, bounded ? Math.min(budget, 600) : 600, bounded, true);
      if (!chunks.length) throw Error(zh ? '没有可朗读的正文。' : 'No prose to read.');
      const path = '/conversations/' + encodeURIComponent(conversationId) + '/media';
      const generate = async (index: number): Promise<string> => {
        await waitForResume();
        let job = await api<any>(
          path,
          {
            serviceId: service.id,
            prompt: chunks[index],
            operationKey: 'read-aloud:' + crypto.randomUUID(),
          },
          undefined,
          {},
          current.signal,
        );
        const deadline = Date.now() + 240000;
        while (job.status !== 'completed') {
          if (['failed', 'unknown', 'cancelled'].includes(job.status))
            throw Error(job.error || job.status);
          if (Date.now() > deadline)
            throw Error(zh ? '朗读生成超时，未重复提交。' : 'Speech timed out; no resubmission.');
          await sleep(1500);
          job = await api<any>(path + '/' + job.id, undefined, undefined, {}, current.signal);
        }
        current.signal.throwIfAborted();
        const output = job.outputs.find((file: any) => file.mime.startsWith('audio/'));
        if (!output) throw Error('No playable speech output');
        return output.url;
      };
      // Keep at most one ahead. Catch immediately so failures while playing cannot be unhandled.
      const pending = (index: number) =>
        generate(index).then(
          (url) => ({ url, error: null as unknown }),
          (error) => ({ url: '', error }),
        );
      let next = pending(0);
      for (let i = 0; i < chunks.length; i++) {
        setProgress(`${i + 1}/${chunks.length}`);
        setPhase('preparing');
        const result = await next;
        if (result.error) throw result.error;
        await waitForResume();
        const element = audio.current;
        if (!element) throw Error('Audio player unavailable');
        element.src = result.url;
        element.playbackRate = rateRef.current;
        if (i + 1 < chunks.length) next = pending(i + 1);
        await new Promise<void>((resolve, reject) => {
          const clean = () => {
            element.removeEventListener('ended', ended);
            element.removeEventListener('error', failed);
            current.signal.removeEventListener('abort', aborted);
          };
          const ended = () => {
            clean();
            resolve();
          };
          const failed = () => {
            clean();
            reject(Error(zh ? '音频播放失败' : 'Audio playback failed'));
          };
          const aborted = () => {
            clean();
            reject(new DOMException('Stopped', 'AbortError'));
          };
          element.addEventListener('ended', ended);
          element.addEventListener('error', failed);
          current.signal.addEventListener('abort', aborted, { once: true });
          if (current.signal.aborted) {
            aborted();
            return;
          }
          void element
            .play()
            .then(() => {
              if (!current.signal.aborted) setPhase('playing');
            })
            .catch(() => {
              if (!current.signal.aborted) {
                isPaused.current = true;
                setPaused(true);
                notify(zh ? '点击播放以继续朗读。' : 'Press Play to continue reading.');
              }
            });
        });
      }
    } catch (error) {
      if (!current.signal.aborted) notify(String(error));
    } finally {
      if (controller.current === current) stop();
    }
  };
  const label = busy
    ? paused
      ? zh
        ? '继续朗读'
        : 'Resume reading'
      : zh
        ? '暂停朗读'
        : 'Pause reading'
    : zh
      ? '朗读'
      : 'Read aloud';
  return (
    <span className="read-aloud">
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => void (busy ? togglePause() : start())}
      >
        {busy ? paused ? <Play size={14} /> : <Pause size={14} /> : <Volume2 size={14} />}
      </button>
      {busy && (
        <>
          <span className="read-aloud-status" role="status" aria-live="polite">
            {!paused && phase === 'preparing' && (
              <Loader2 size={12} className="read-aloud-spinner" />
            )}
            {paused
              ? zh
                ? '已暂停'
                : 'Paused'
              : phase === 'preparing'
                ? zh
                  ? '准备语音'
                  : 'Preparing'
                : zh
                  ? '朗读中'
                  : 'Reading'}
            <small>{progress}</small>
          </span>
          <button
            type="button"
            title={zh ? '停止朗读' : 'Stop reading'}
            aria-label={zh ? '停止朗读' : 'Stop reading'}
            onClick={stop}
          >
            <Square size={12} />
          </button>
        </>
      )}
      <button
        type="button"
        title={zh ? '朗读设置' : 'Reading settings'}
        aria-label={zh ? '朗读设置' : 'Reading settings'}
        onClick={() => {
          setOpen(!open);
          if (!services.length)
            void api<MediaConnection[]>('/media/services')
              .then((list) => {
                const speech = list.filter((c) => c.kind === 'speech');
                setServices(speech);
                setSelected(speech.find(supportsReadAloud)?.id || speech[0]?.id || '');
              })
              .catch((error) => notify(String(error)));
        }}
      >
        <Settings2 size={12} />
      </button>
      {open && (
        <span className="read-aloud-options">
          {!!services.length && (
            <select
              aria-label={zh ? '朗读服务' : 'Speech service'}
              disabled={busy}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label={zh ? '播放速度' : 'Playback speed'}
            disabled={busy && native.current}
            value={rate}
            onChange={(e) => {
              const value = Number(e.target.value);
              setRate(value);
              rateRef.current = value;
              if (audio.current) audio.current.playbackRate = value;
            }}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          <small>
            {zh
              ? '所选服务可能收费。最多提前准备一段；停止后已提交的生成可能继续。'
              : 'Provider charges may apply. At most one segment ahead; submitted generation may continue after Stop.'}
          </small>
        </span>
      )}
      <audio ref={audio} preload="auto" hidden />
    </span>
  );
}
