import { useEffect, useRef, useState } from 'react';
import { Volume2, Square } from 'lucide-react';
import { api } from '../api';
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
  const [progress, setProgress] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<AbortController | null>(null);
  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    audio.current?.pause();
    audio.current?.removeAttribute('src');
    audio.current?.load();
    setBusy(false);
    setProgress('');
  };
  useEffect(() => {
    const halt = () => stop();
    window.addEventListener('amadeus-stop-read-aloud', halt);
    return () => {
      window.removeEventListener('amadeus-stop-read-aloud', halt);
      controller.current?.abort();
      audio.current?.pause();
    };
  }, [conversationId]);
  const prepare = async () => {
    try {
      const list = (await api<MediaConnection[]>('/media/services')).filter(
        (c) => c.kind === 'speech',
      );
      if (!list.length)
        throw Error(
          zh
            ? '请先在设置中配置并启用语音合成服务。'
            : 'Configure and enable a speech service in Settings first.',
        );
      setServices(list);
      setSelected(list.find((c) => c.id === 'amadeus-local-cosyvoice')?.id || list[0].id);
      setOpen(true);
    } catch (error) {
      notify(String(error));
    }
  };
  const start = async () => {
    window.dispatchEvent(new Event('amadeus-stop-read-aloud'));
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    const chunks = speechChunks(text);
    const path = '/conversations/' + encodeURIComponent(conversationId) + '/media';
    try {
      if (!chunks.length)
        throw Error(
          zh ? '没有可朗读的正文（代码块不朗读）。' : 'No prose to read (code blocks are skipped).',
        );
      for (let i = 0; i < chunks.length; i++) {
        current.signal.throwIfAborted();
        setProgress(`${i + 1}/${chunks.length}`);
        let job = await api<any>(
          path,
          {
            serviceId: selected,
            prompt: chunks[i],
            operationKey: 'read-aloud:' + crypto.randomUUID(),
          },
          undefined,
          {},
          current.signal,
        );
        const deadline = Date.now() + 240000;
        while (job.status !== 'completed') {
          current.signal.throwIfAborted();
          if (['failed', 'unknown', 'cancelled'].includes(job.status))
            throw Error(job.error || job.status);
          if (Date.now() > deadline)
            throw Error(
              zh
                ? '朗读生成仍未完成，可在媒体任务查看；未自动重试。'
                : 'Speech is not finished; inspect Media tasks. No automatic resubmission.',
            );
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          current.signal.throwIfAborted();
          job = await api<any>(path + '/' + job.id, undefined, undefined, {}, current.signal);
        }
        current.signal.throwIfAborted();
        const output = job.outputs.find((file: any) => file.mime.startsWith('audio/'));
        if (!output || !audio.current) throw Error('No playable speech output');
        const element = audio.current;
        element.src = output.url;
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
          void element.play().catch(() => {
            if (!current.signal.aborted)
              notify(
                zh
                  ? '浏览器阻止自动播放，请点击播放器的播放按钮。'
                  : 'Browser blocked playback; press Play in the audio controls.',
              );
          });
        });
      }
    } catch (error) {
      if (!current.signal.aborted) notify(String(error));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setBusy(false);
        setProgress('');
      }
    }
  };
  return (
    <span className="read-aloud">
      <button
        type="button"
        title={busy ? (zh ? '停止朗读' : 'Stop reading') : zh ? '朗读' : 'Read aloud'}
        aria-label={busy ? (zh ? '停止朗读' : 'Stop reading') : zh ? '朗读' : 'Read aloud'}
        onClick={() => (busy ? stop() : open ? setOpen(false) : void prepare())}
      >
        {busy ? <Square size={14} /> : <Volume2 size={14} />}
      </button>
      {open && (
        <span className="read-aloud-options">
          <select
            aria-label={zh ? '朗读服务' : 'Speech service'}
            disabled={busy}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => void start()}>
            {zh ? '开始朗读' : 'Start reading'}
          </button>
          <small>
            {progress ||
              (zh
                ? '仅朗读这条回复；所选服务可能收费。停止后当前已提交的生成可能继续，后续段落不再提交。'
                : 'Reads this reply only; provider charges may apply. Stop prevents later segments; already submitted generation may continue.')}
          </small>
          <audio ref={audio} controls preload="none" />
        </span>
      )}
    </span>
  );
}
