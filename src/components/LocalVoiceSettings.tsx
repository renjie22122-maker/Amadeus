import { useState, useEffect } from 'react';
import { api } from '../api';

type Voice = {
  id: string;
  name: string;
  text: string;
  source?: string;
  deletable?: boolean;
  language?: string;
  quality?: { duration: number; warnings: string[] };
};
type Capabilities = {
  recommendedReferenceSeconds: number;
  maxReferenceSeconds: number;
  maxUploadBytes: number;
};
export function LocalVoiceSettings({ zh, onUse }: { zh: boolean; onUse: (id: string) => void }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selected, setSelected] = useState('default');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('auto');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [referenceAudio, setReferenceAudio] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    if (!file) {
      setReferenceAudio('');
      return;
    }
    const url = URL.createObjectURL(file);
    setReferenceAudio(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [audio, setAudio] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<{
    available: boolean;
    busy: boolean;
    device: 'cuda' | 'cpu' | null;
    reason: string | null;
  } | null>(null);
  useEffect(() => {
    if (!previewing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api<NonNullable<typeof deviceStatus>>('/media/local-voice/status');
        if (!disposed) setDeviceStatus(status);
      } catch {
        if (!disposed)
          setDeviceStatus({ available: false, busy: false, device: null, reason: null });
      } finally {
        if (!disposed) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [previewing]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const next = await api<{ voices: Voice[]; selected: string; capabilities: Capabilities }>(
      '/media/local-voice/voices',
    );
    setVoices(next.voices);
    setCapabilities(next.capabilities);
    setSelected(next.selected);
  };
  return (
    <details
      className="media-config"
      onToggle={(event) => {
        if (event.currentTarget.open && !voices.length && !busy) void action(refresh);
      }}
    >
      <summary>
        {zh ? '本地音色 · 预置、克隆与试听' : 'Local voices · Presets, cloning and preview'}
      </summary>
      <p className="muted">
        {zh
          ? '上传清晰的单人录音并填写逐字对应的原文。参考语言与输出语言可以不同；不要把日语原文翻译成中文填入。录音只保存在本机，这是参考音色合成，不是训练新模型。跨语言音色与口音需要试听确认。'
          : 'Upload clear single-speaker audio and its exact original-language transcript, not a translation. Reference and output languages may differ. Stored locally; reference-conditioned synthesis, not model training. Check voice similarity and accent by listening.'}
      </p>
      {capabilities && (
        <p className="muted">
          {zh
            ? `CosyVoice 参考音频硬上限 ${capabilities.maxReferenceSeconds} 秒；建议至少 ${capabilities.recommendedReferenceSeconds} 秒，较短录音仅提示；上传保护上限 ${capabilities.maxUploadBytes / 1048576} MiB。长录音请先选取片段并填写对应原文；不会自动截断。这不是朗读长度上限。`
            : `CosyVoice reference maximum: ${capabilities.maxReferenceSeconds}s. Recommended minimum: ${capabilities.recommendedReferenceSeconds}s; shorter references receive a warning. Upload limit: ${capabilities.maxUploadBytes / 1048576} MiB. Select an excerpt and matching transcript from longer recordings; no silent truncation. This is not the read-aloud length limit.`}
        </p>
      )}
      <fieldset disabled={busy || !capabilities} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <div className="form-grid">
          <label>
            {zh ? '音色名称' : 'Voice name'}
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {zh ? '参考录音' : 'Reference recording'}
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => {
                const next = e.target.files?.[0] || null;
                if (next && capabilities && next.size > capabilities.maxUploadBytes) {
                  setMessage(zh ? '录音超过上传保护上限。' : 'Recording exceeds the upload limit.');
                  e.target.value = '';
                  setFile(null);
                } else setFile(next);
              }}
            />
          </label>
        </div>
        {referenceAudio && (
          <audio controls preload="metadata" src={referenceAudio} style={{ maxWidth: '100%' }} />
        )}
        <label>
          {zh
            ? '参考录音语言（记录用途，不强制输出语言）'
            : 'Reference language (metadata, not output-language control)'}
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {['auto', 'zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'ru'].map((code) => (
              <option key={code} value={code}>
                {
                  (
                    {
                      auto: zh ? '未指定／混合' : 'Unspecified / mixed',
                      zh: '中文',
                      en: 'English',
                      ja: '日本語',
                      ko: '한국어',
                      de: 'Deutsch',
                      es: 'Español',
                      fr: 'Français',
                      it: 'Italiano',
                      ru: 'Русский',
                    } as Record<string, string>
                  )[code]
                }
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? '录音原文（逐字一致）' : 'Exact recording transcript'}
          <textarea
            rows={3}
            maxLength={1500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            style={{ width: 'auto', margin: 0 }}
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {zh ? '我有权使用此录音及音色' : 'I have permission to use this recording and voice'}
        </label>
        <button
          type="button"
          disabled={!file || !name.trim() || !text.trim() || !consent}
          onClick={() =>
            void action(async () => {
              if (!file) return;
              const form = new FormData();
              form.set('name', name);
              form.set('text', text);
              form.set('language', language);
              form.set('consent', 'true');
              form.set('audio', file);
              const saved = await api<Voice>('/media/local-voice/voices', form);
              await refresh();
              setSelected(saved.id);
              setMessage(
                zh
                  ? '音色已保存，可试听或设为默认朗读音色。'
                  : 'Voice saved. Preview it or choose it for read-aloud.',
              );
            })
          }
        >
          {zh ? '保存音色' : 'Save voice'}
        </button>
        <hr />
        <label>
          {zh ? '已保存音色' : 'Saved voices'}
          <select
            aria-label={zh ? '已保存音色' : 'Saved voices'}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setAudio('');
            }}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
                {voice.source === 'preset' ? (zh ? ' · 预置' : ' · Preset') : ''}
              </option>
            ))}
          </select>
        </label>
        {voices.find((v) => v.id === selected)?.quality && (
          <p className="muted">
            {zh
              ? '技术检查仅检查静音、音量和削波，不验证说话人、转写或音色相似度。'
              : 'Technical checks cover silence, level and clipping, not speaker identity, transcript accuracy or voice similarity.'}
            {voices
              .find((v) => v.id === selected)
              ?.quality?.warnings.map((warning) => (
                <span key={warning}>
                  {' '}
                  {warning === 'short'
                    ? zh
                      ? '录音较短，音色稳定性可能不足。'
                      : 'Short recording; voice consistency may be limited.'
                    : warning === 'quiet'
                      ? zh
                        ? '音量偏低，建议更换录音。'
                        : 'Low volume; consider another recording.'
                      : zh
                        ? '检测到削波，建议更换录音。'
                        : 'Clipping detected; consider another recording.'}
                </span>
              ))}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={() => void action(refresh)}>
            {zh ? '刷新' : 'Refresh'}
          </button>
          <button
            type="button"
            disabled={!voices.length}
            onClick={() =>
              void action(async () => {
                await api('/media/local-voice/use', { id: selected });
                onUse(selected);
                setMessage(
                  zh
                    ? '已设为默认朗读音色；其他设置未改动。'
                    : 'Default read-aloud voice saved; other settings preserved.',
                );
              })
            }
          >
            {zh ? '设为默认朗读音色' : 'Use for read-aloud'}
          </button>
          {voices.find((v) => v.id === selected)?.deletable && (
            <button
              type="button"
              onClick={() => {
                const voice = voices.find((v) => v.id === selected);
                if (
                  !window.confirm(
                    zh
                      ? `删除自建音色“${voice?.name}”？已生成音频保留。`
                      : `Delete uploaded voice “${voice?.name}”? Generated audio is kept.`,
                  )
                )
                  return;
                void action(async () => {
                  const result = await api<{ cleanupPending: boolean }>(
                    '/media/local-voice/delete',
                    { id: selected },
                  );
                  setAudio('');
                  await refresh();
                  setMessage(
                    result.cleanupPending
                      ? zh
                        ? '音色已移除。参考录音将在语音服务空闲且运行时清理；已生成音频保留。'
                        : 'Voice removed. Reference cleanup waits for an idle running voice service; generated audio is kept.'
                      : zh
                        ? '自建音色及参考录音已删除；已生成音频保留。'
                        : 'Uploaded voice and reference deleted; generated audio is kept.',
                  );
                });
              }}
            >
              {zh ? '删除自建音色' : 'Delete uploaded voice'}
            </button>
          )}
          {(['zh', 'en', 'ja'] as const).map((language) => (
            <button
              key={language}
              type="button"
              disabled={!voices.length}
              onClick={() =>
                void action(async () => {
                  setAudio('');
                  setMessage(zh ? '正在本机合成试听…' : 'Generating preview locally…');
                  setDeviceStatus(null);
                  setPreviewing(true);
                  try {
                    const result = await api<{ audio: string; mime: string }>(
                      '/media/local-voice/preview',
                      { id: selected, language },
                    );
                    setAudio('data:audio/wav;base64,' + result.audio);
                    setMessage(
                      zh ? '试听已生成，点击播放器播放。' : 'Preview ready. Press Play to listen.',
                    );
                  } finally {
                    setPreviewing(false);
                    setDeviceStatus(null);
                  }
                })
              }
            >
              {language === 'ja'
                ? zh
                  ? '日语试听'
                  : 'Japanese preview'
                : language === 'zh'
                  ? zh
                    ? '中文试听'
                    : 'Chinese preview'
                  : zh
                    ? '英文试听'
                    : 'English preview'}
            </button>
          ))}
        </div>
      </fieldset>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {previewing && (
        <p className="muted" role="status" aria-live="polite">
          {zh ? '语音服务：' : 'Voice service: '}
          {!deviceStatus
            ? zh
              ? '正在读取设备状态…'
              : 'Reading device status…'
            : !deviceStatus.available
              ? zh
                ? '设备状态暂不可用，合成仍在等待结果。'
                : 'Device status unavailable; still awaiting synthesis.'
              : !deviceStatus.busy
                ? zh
                  ? '服务空闲／请求准备中'
                  : 'Idle / preparing request'
                : deviceStatus.device === 'cuda'
                  ? zh
                    ? 'GPU · 正在处理'
                    : 'GPU · Processing'
                  : deviceStatus.device === 'cpu'
                    ? zh
                      ? 'CPU · 正在处理'
                      : 'CPU · Processing'
                    : zh
                      ? '正在选择设备…'
                      : 'Selecting device…'}
          {deviceStatus?.busy && deviceStatus.reason && <> · {deviceStatus.reason}</>}
        </p>
      )}
      {audio && <audio controls src={audio} style={{ maxWidth: '100%' }} />}
    </details>
  );
}
