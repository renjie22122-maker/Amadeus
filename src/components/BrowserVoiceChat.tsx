import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { playLocalSpeech } from '../read-aloud-stream';
import { speechChunks } from '../../shared/read-aloud';
import { supportsReadAloud, supportsTranscriptionPreview } from '../../shared/media-capabilities';
import type { ChatConnection } from '../../shared/chat-connections';

/** Explicit, half-duplex browser voice. Never enables a microphone on mount. */
export function BrowserVoiceChat({
  connection,
  zh,
  close,
  openConversation,
}: {
  connection: ChatConnection;
  zh: boolean;
  close: () => void;
  openConversation: (id: string) => void;
}) {
  const [previewServices, setPreviewServices] = useState<any[]>([]),
    [previewService, setPreviewService] = useState(''),
    [partial, setPartial] = useState(''),
    [autoEnd, setAutoEnd] = useState(true),
    [previewInfo, setPreviewInfo] = useState('');
  const pendingPreview = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let mounted = true;
    void api('/media/services')
      .then((services) => {
        if (mounted) setPreviewServices(services.filter(supportsTranscriptionPreview));
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  const [phase, setPhase] = useState('idle'),
    [error, setError] = useState(''),
    [heard, setHeard] = useState(''),
    [answer, setAnswer] = useState('');
  const ctl = useRef<AbortController | null>(null),
    mic = useRef<MediaStream | null>(null),
    recorder = useRef<MediaRecorder | null>(null),
    audio = useRef<AudioContext | null>(null),
    ownedRun = useRef(''),
    job = useRef(''),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = '/chat-connections/' + encodeURIComponent(connection.id) + '/voice-turn';
  const tr = (cn: string, en: string) => (zh ? cn : en);
  function release(cancelWork = false) {
    ctl.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    mic.current?.getTracks().forEach((t) => t.stop());
    void audio.current?.close().catch(() => {});
    audio.current = null;
    if (cancelWork && ownedRun.current)
      void api(base + '/' + ownedRun.current + '/stop', {}).catch(() => {});
    if (cancelWork && job.current)
      void api(
        '/conversations/' + connection.conversationId + '/media/' + job.current + '/cancel',
        {},
      ).catch(() => {});
    ownedRun.current = '';
    job.current = '';
  }
  useEffect(() => () => release(), [connection.id]);
  async function wait(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(t);
        reject(new DOMException('Stopped', 'AbortError'));
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 1000);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function process(blob: Blob, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      setPhase('transcribing');
      const form = new FormData();
      form.append(
        'file',
        blob,
        'voice.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'),
      );
      if (previewService) {
        await pendingPreview.current;
        signal.throwIfAborted();
        const final = await api(
          '/conversations/' +
            connection.conversationId +
            '/transcription-preview?serviceId=' +
            encodeURIComponent(previewService) +
            '&sequence=10000',
          form,
          undefined,
          {},
          signal,
        );
        if (!final.text?.trim() || final.hasSpeech === false)
          throw Error(tr('未识别到语音，没有发送。', 'No speech; nothing sent.'));
        setHeard(final.text);
        setPartial('');
        await respond(final.text, signal);
        return;
      }
      const submitted = await api(
        '/conversations/' + connection.conversationId + '/transcribe',
        form,
        undefined,
        { 'X-Operation-Id': crypto.randomUUID() },
        signal,
      );
      job.current = submitted.id;
      let text = '';
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const jobs = await api(
          '/conversations/' + connection.conversationId + '/media',
          undefined,
          undefined,
          {},
          signal,
        );
        const result = jobs.find((j: any) => j.id === job.current);
        if (result?.status === 'completed') {
          text = result.text || '';
          job.current = '';
          break;
        }
        if (['failed', 'cancelled', 'unknown'].includes(result?.status))
          throw Error(result.error || result.status);
        await wait(signal);
      }
      signal.throwIfAborted();
      if (!text.trim())
        throw Error(
          tr('没有得到转写结果；不会自动猜测或发送。', 'No transcript; nothing was sent.'),
        );
      setHeard(text);
      await respond(text, signal);
    } catch (e: any) {
      if (!signal.aborted) {
        if (job.current) {
          void api(
            '/conversations/' + connection.conversationId + '/media/' + job.current + '/cancel',
            {},
          ).catch(() => {});
          job.current = '';
        }
        setError(e.message);
        setPhase(ownedRun.current ? 'attention' : 'idle');
      }
    }
  }
  async function respond(text: string, signal: AbortSignal) {
    setPhase('thinking');
    const started = await api(base, { text }, undefined, {}, signal);
    ownedRun.current = started.runId;
    const until = Date.now() + 600000;
    let reply = '';
    while (Date.now() < until) {
      const result = await api(base + '/' + started.runId, undefined, undefined, {}, signal);
      if (result.status === 'completed') {
        reply = result.text;
        ownedRun.current = '';
        break;
      }
      if (['waiting_approval', 'waiting_user'].includes(result.status)) {
        setPhase('attention');
        throw Error(
          tr(
            '需要审批或补充信息，请打开会话处理。',
            'Open the conversation for approval or clarification.',
          ),
        );
      }
      if (['failed', 'cancelled', 'interrupted', 'needs_attention'].includes(result.status))
        throw Error(result.status);
      await wait(signal);
    }
    signal.throwIfAborted();
    if (!reply)
      throw Error(
        tr(
          '本轮尚未得到最终回复，请在会话中查看。',
          'No final reply yet; inspect the conversation.',
        ),
      );
    setAnswer(reply);
    setPhase('speaking');
    const services = await api('/media/services', undefined, undefined, {}, signal);
    const service = services.find((s: any) => s.kind === 'speech' && supportsReadAloud(s));
    if (!service || !audio.current)
      throw Error(
        tr(
          '未配置流式朗读服务，文字回复已保留。',
          'No streaming speech service; text reply is retained.',
        ),
      );
    for (const part of speechChunks(reply, 2500)) {
      if (
        !(await playLocalSpeech({
          conversationId: connection.conversationId,
          serviceId: service.id,
          text: part,
          signal,
          context: audio.current,
          rate: 1,
          onAudio: () => setPhase('speaking'),
        }))
      )
        throw Error(tr('当前服务不支持流式朗读。', 'Speech streaming unavailable.'));
    }
    setPhase('idle');
  }
  async function assistantFirst() {
    setError('');
    setHeard('');
    setAnswer('');
    setPhase('thinking');
    const current = new AbortController();
    ctl.current = current;
    try {
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
      await respond(
        tr(
          '请开始一段语音交流，先自然地说一句开场，然后等我回应。',
          'Please start a voice conversation with a brief natural opening, then wait for my reply.',
        ),
        current.signal,
      );
    } catch (e: any) {
      if (!current.signal.aborted) {
        setError(e.message);
        setPhase(ownedRun.current ? 'attention' : 'idle');
      }
    }
  }
  async function speak() {
    if (phase === 'recording') {
      recorder.current?.stop();
      return;
    }
    setError('');
    setAnswer('');
    setHeard('');
    setPartial('');
    setPreviewInfo('');
    const current = new AbortController();
    ctl.current = current;
    setPhase('connecting');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
        throw Error(
          tr(
            '录音需要 HTTPS 或 localhost 和支持录音的浏览器。',
            'Use HTTPS or localhost and a recording-capable browser.',
          ),
        );
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
      setPhase('connecting');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (current.signal.aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.current = stream;
      let lastVoice = Date.now(),
        meterReady = false;
      let meter: ReturnType<typeof setInterval> | undefined;
      let source: MediaStreamAudioSourceNode | undefined;
      try {
        source = audio.current.createMediaStreamSource(stream);
        const analyser = audio.current.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        meter = setInterval(() => {
          if (current.signal.aborted || !stream.active) {
            clearInterval(meter);
            source?.disconnect();
            return;
          }
          analyser.getFloatTimeDomainData(samples);
          if (Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length) > 0.012)
            lastVoice = Date.now();
          meterReady = true;
        }, 100);
      } catch {
        /* Without a live meter, keep manual endpointing rather than trusting stale audio. */
      }
      const stopMeter = () => {
        if (meter) clearInterval(meter);
        source?.disconnect();
      };
      current.signal.addEventListener('abort', stopMeter, { once: true });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
      recorder.current = rec;
      const chunks: Blob[] = [];
      let bytes = 0,
        sequence = 0,
        lastPreview = Date.now(),
        previewDelay = 1500;
      let previewPaused = false;
      const preview = async () => {
        if (
          !previewService ||
          previewPaused ||
          pendingPreview.current ||
          rec.state !== 'recording' ||
          Date.now() - lastPreview < previewDelay
        )
          return;
        lastPreview = Date.now();
        const captured = lastPreview;
        const index = ++sequence;
        const form = new FormData();
        form.append('file', new Blob(chunks, { type: rec.mimeType }), 'preview.webm');
        const work = (async () => {
          try {
            const result = await api(
              '/conversations/' +
                connection.conversationId +
                '/transcription-preview?serviceId=' +
                encodeURIComponent(previewService) +
                '&sequence=' +
                index,
              form,
              undefined,
              {},
              current.signal,
            );
            if (current.signal.aborted || rec.state !== 'recording' || result.sequence !== index)
              return;
            setPartial(result.text);
            if (result.device === 'cpu' && result.elapsedMs > 4000) {
              previewPaused = true;
              setPreviewInfo(
                tr(
                  'CPU 转写较慢，已暂停预览；请手动结束，随后完整识别。',
                  'CPU is slow; preview paused. Finish manually for full transcription.',
                ),
              );
              return;
            }
            previewDelay = Math.max(1500, Math.min(10000, result.elapsedMs || 1500));
            setPreviewInfo((result.device || '') + ' · ' + Math.round(result.elapsedMs) + ' ms');
            // Only a fresh VAD decision may end a turn; stale CPU previews cannot cut later speech.
            if (
              autoEnd &&
              meterReady &&
              Date.now() - lastVoice >= 1200 &&
              result.hasSpeech &&
              result.speechEnd != null &&
              result.audioSeconds - result.speechEnd >= 1.2 &&
              Date.now() - captured < 1500
            )
              rec.stop();
          } catch (e: any) {
            if (!current.signal.aborted) {
              previewDelay = Math.min(10000, previewDelay * 2);
              setPreviewInfo(
                tr(
                  '预览暂不可用，可手动结束后识别。',
                  'Preview unavailable; finish manually to transcribe.',
                ),
              );
            }
          }
        })();
        pendingPreview.current = work;
        try {
          await work;
        } finally {
          if (pendingPreview.current === work) pendingPreview.current = null;
        }
      };
      rec.ondataavailable = (e) => {
        chunks.push(e.data);
        bytes += e.data.size;
        if (bytes > 7 * 1024 * 1024 && rec.state === 'recording') rec.stop();
        else void preview();
      };
      rec.onerror = () => {
        stopMeter();
        stream.getTracks().forEach((t) => t.stop());
        current.abort();
        setError(tr('录音失败，请重新打开语音对话。', 'Recording failed; reopen voice chat.'));
        setPhase('idle');
      };
      rec.onstop = () => {
        stopMeter();
        current.signal.removeEventListener('abort', stopMeter);
        if (timer.current) clearTimeout(timer.current);
        stream.getTracks().forEach((t) => t.stop());
        if (!current.signal.aborted)
          void process(new Blob(chunks, { type: rec.mimeType }), current.signal);
      };
      rec.start(500);
      setPhase('recording');
      timer.current = setTimeout(() => {
        if (rec.state === 'recording') rec.stop();
      }, 120000);
    } catch (e: any) {
      mic.current?.getTracks().forEach((t) => t.stop());
      if (!current.signal.aborted) {
        setError(e.message);
        setPhase('idle');
      }
    }
  }
  const labels: Record<string, string> = {
    idle: tr('等待说话', 'Ready'),
    connecting: tr('请求麦克风', 'Microphone permission'),
    recording: tr('录音中 · 再点一次结束', 'Recording · click again to finish'),
    transcribing: tr('转写中', 'Transcribing'),
    thinking: tr('正在回应', 'Thinking'),
    speaking: tr('正在朗读', 'Speaking'),
    attention: tr('需要处理', 'Needs attention'),
  };
  return (
    <section
      className="chat-connection-card"
      role="region"
      aria-label={tr('网页语音对话', 'Browser voice chat')}
    >
      <strong>
        {tr('网页语音对话 · 轮流说话', 'Browser voice · alternating turns')} — {connection.name}
      </strong>
      <p>
        {tr(
          '点击说话，再点结束后自动转写、回复并朗读。内容保存在当前会话，只在网页回复；不是 QQ 电话。麦克风不会持续监听；可选增量预览，临时文字不会发送给模型。',
          'Click to speak, then finish to transcribe, respond and read aloud. Saved to this conversation; replies stay in the browser. Not a native platform call or always-on microphone. Optional incremental previews are provisional; only the final transcript is sent.',
        )}
      </p>
      <label>
        {tr('转写方式', 'Transcription')}{' '}
        <select
          value={previewService}
          disabled={phase !== 'idle'}
          onChange={(e) => setPreviewService(e.target.value)}
        >
          <option value="">
            {tr('整句识别（当前设置）', 'Whole sentence (current settings)')}
          </option>
          {previewServices.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} · {tr('增量预览', 'incremental preview')}
            </option>
          ))}
        </select>
      </label>
      {previewService && (
        <label>
          <input
            type="checkbox"
            checked={autoEnd}
            disabled={phase !== 'idle'}
            onChange={(e) => setAutoEnd(e.target.checked)}
          />
          {tr(
            '停顿后自动结束（仍可手动结束）',
            'Finish after silence (manual finish remains available)',
          )}
        </label>
      )}
      {partial && (
        <p aria-label={tr('临时转写', 'Provisional transcript')}>
          {tr('临时：', 'Provisional: ')}
          {partial}
        </p>
      )}
      {previewInfo && <small>{previewInfo}</small>}
      <p role="status">{labels[phase] || phase}</p>
      <button onClick={() => void assistantFirst()} disabled={phase !== 'idle'}>
        {tr('让模型先说', 'Assistant speaks first')}
      </button>
      <button onClick={() => void speak()} disabled={!['idle', 'recording'].includes(phase)}>
        {phase === 'recording' ? tr('结束这句', 'Finish speaking') : tr('说话', 'Speak')}
      </button>
      <button
        onClick={() => {
          release(true);
          close();
        }}
      >
        {tr('挂断', 'Hang up')}
      </button>
      <button onClick={() => openConversation(connection.conversationId)}>
        {tr('打开会话／审批', 'Open chat / approvals')}
      </button>
      {heard && (
        <p>
          {tr('你：', 'You: ')}
          {heard}
        </p>
      )}
      {answer && (
        <p>
          {tr('回复：', 'Reply: ')}
          {answer}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
