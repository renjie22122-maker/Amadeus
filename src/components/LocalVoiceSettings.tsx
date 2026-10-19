import { useState } from 'react';
import { api } from '../api';

type Voice = { id: string; name: string; text: string };
export function LocalVoiceSettings({ zh, onUse }: { zh: boolean; onUse: (id: string) => void }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selected, setSelected] = useState('default');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [audio, setAudio] = useState('');
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
    const next = await api<{ voices: Voice[]; selected: string }>('/media/local-voice/voices');
    setVoices(next.voices);
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
        {zh ? '本地音色 · 参考音频克隆与试听' : 'Local voices · Reference cloning and preview'}
      </summary>
      <p className="muted">
        {zh
          ? '上传清晰的单人录音（3–30 秒，最多 25 MiB），填写录音的准确文字。录音只保存在本机；这是参考音色合成，不是训练新模型。保存后即时可用。'
          : 'Upload clear single-speaker audio (3–30 seconds, up to 25 MiB) and its exact transcript. Stored locally; reference-conditioned synthesis, not training a new model. Saved voices are immediately available.'}
      </p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
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
                if (next && next.size > 25 * 1024 * 1024) {
                  setMessage(zh ? '录音超过 25 MiB。' : 'Recording exceeds 25 MiB.');
                  e.target.value = '';
                  setFile(null);
                } else setFile(next);
              }}
            />
          </label>
        </div>
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
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
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
              </option>
            ))}
          </select>
        </label>
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
          {(['zh', 'en'] as const).map((language) => (
            <button
              key={language}
              type="button"
              disabled={!voices.length}
              onClick={() =>
                void action(async () => {
                  setAudio('');
                  setMessage(
                    zh
                      ? '正在本机合成试听，CPU 可能需要一两分钟…'
                      : 'Generating locally; CPU may need a minute or two…',
                  );
                  const result = await api<{ audio: string; mime: string }>(
                    '/media/local-voice/preview',
                    { id: selected, language },
                  );
                  setAudio('data:audio/wav;base64,' + result.audio);
                  setMessage(
                    zh ? '试听已生成，点击播放器播放。' : 'Preview ready. Press Play to listen.',
                  );
                })
              }
            >
              {language === 'zh'
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
      {audio && <audio controls src={audio} style={{ maxWidth: '100%' }} />}
    </details>
  );
}
