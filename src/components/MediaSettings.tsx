import { LocalVoiceSettings } from './LocalVoiceSettings';
import { useState } from 'react';
import { api } from '../api';
import { mediaProtocols } from '../../shared/media';
export function MediaSettings({ value, setValue, zh }: any) {
  const [localMessage, setLocalMessage] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const media = value.media || { connections: [], transcriptionId: '', autoApproveMaxUsd: null };
  const update = (patch: any) => setValue({ ...value, media: { ...media, ...patch } });
  const change = (id: string, patch: any) =>
    update({
      connections: media.connections.map((c: any) => (c.id === id ? { ...c, ...patch } : c)),
    });
  return (
    <section className="panel media-settings">
      <h2>{zh ? '媒体与语音服务' : 'Media and voice services'}</h2>
      <p className="muted">
        {zh
          ? '服务密钥只保存在本机。选择协议后填写服务商实际模型 ID；不同模型的价格、参考图、首尾帧和音频能力各不相同。'
          : 'Keys remain on the host. Enter an actual provider model ID; prices and reference-frame/audio capabilities vary by model.'}
      </p>
      <p className="muted">
        {zh
          ? '本地中英语音：先运行 Setup-Local-Voice.cmd。配置后随应用启动，模型仅在请求时加载；优先 GPU，ComfyUI 忙碌、显存不足或 GPU 不可用时回退 CPU。下方可添加参考音色。'
          : 'Local Chinese/English voice: run Setup-Local-Voice.cmd first. The service starts with the app; models load per request. GPU preferred; busy ComfyUI, low memory or unavailable CUDA falls back to CPU. Add reference voices below.'}
      </p>
      <button
        type="button"
        disabled={localBusy}
        onClick={async () => {
          setLocalBusy(true);
          try {
            const next = await api('/media/local-voice', {});
            setValue(next);
            setLocalMessage(
              zh
                ? '已添加本地连接；已有录音服务选择保持不变。请启动本地语音服务后测试。'
                : 'Local connections added. Existing microphone selection preserved. Start the voice service and test inference.',
            );
          } catch (error) {
            setLocalMessage(String(error));
          } finally {
            setLocalBusy(false);
          }
        }}
      >
        {zh
          ? '添加本地语音连接（先保存其他修改）'
          : 'Add local voice connections (save other edits first)'}
      </button>
      <p role="status">{localMessage}</p>
      <LocalVoiceSettings
        zh={zh}
        onUse={(voice) => {
          change('amadeus-local-cosyvoice', {
            defaults: {
              ...media.connections.find((c: any) => c.id === 'amadeus-local-cosyvoice')?.defaults,
              voice,
            },
          });
        }}
      />
      <select
        aria-label="Add media service"
        value=""
        onChange={(e) => {
          const p = mediaProtocols.find((p) => p.id === e.target.value)!;
          update({
            connections: [
              ...media.connections,
              {
                ...p,
                id: crypto.randomUUID(),
                protocol: p.id,
                apiKey: '',
                enabled: false,
                defaults: {},
                estimatedUsd: null,
              },
            ],
          });
        }}
      >
        <option value="">{zh ? '＋ 添加媒体服务' : '＋ Add media service'}</option>
        {mediaProtocols.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {media.connections.map((c: any) => (
        <details className="media-config" key={c.id} open={!c.model}>
          <summary>
            {c.name} · {c.kind} {c.enabled ? '●' : '○'}
          </summary>
          {c.protocol.startsWith('minimax-') && (
            <p className="muted">
              {zh
                ? '\u4f7f\u7528 MiniMax \u5b98\u65b9\u6309\u91cf\u4ed8\u8d39 API Key\uff0c\u5730\u5740 https://api.minimax.io\u3002\u8bed\u97f3\u5408\u6210\u9700\u5728 JSON \u4e2d\u8bbe\u7f6e voice_setting.voice_id\uff1b\u97f3\u4e50 API \u53ef\u7528\u6027\u53d6\u51b3\u4e8e\u8d26\u53f7\u6743\u9650\u3002'
                : 'Use a MiniMax pay-as-you-go API key at https://api.minimax.io. Speech requires voice_setting.voice_id in JSON. Music API access depends on your account.'}
            </p>
          )}
          <div className="form-grid">
            <label>
              {zh ? '名称' : 'Name'}
              <input value={c.name} onChange={(e) => change(c.id, { name: e.target.value })} />
            </label>
            <label>
              {zh ? '类型' : 'Type'}
              <select
                value={c.kind}
                disabled={!['fal', 'replicate'].includes(c.protocol)}
                onChange={(e) => change(c.id, { kind: e.target.value })}
              >
                {['image', 'video', 'music', 'speech', 'transcription', 'model3d'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              {zh ? '服务地址' : 'Endpoint'}
              <input
                value={c.baseUrl}
                onChange={(e) => change(c.id, { baseUrl: e.target.value })}
              />
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={c.apiKey || ''}
                placeholder={
                  c.hasKey ? (zh ? '已保存（留空保留）' : 'Saved (blank preserves)') : ''
                }
                onChange={(e) => change(c.id, { apiKey: e.target.value || undefined })}
              />
            </label>
            <label>
              {zh
                ? '模型 / fal 路由 / Replicate owner/model'
                : 'Model / fal endpoint / Replicate owner/model'}
              <input value={c.model} onChange={(e) => change(c.id, { model: e.target.value })} />
            </label>
            <label>
              {zh ? '单次费用估算 USD（留空未知）' : 'Estimated USD per job (blank = unknown)'}
              <input
                type="number"
                min="0"
                step="0.001"
                value={c.estimatedUsd ?? ''}
                onChange={(e) =>
                  change(c.id, {
                    estimatedUsd: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            {zh
              ? '模型参数 JSON（例如时长、分辨率、voiceId）'
              : 'Model defaults JSON (duration, resolution, voiceId, etc.)'}
            <textarea
              defaultValue={JSON.stringify(c.defaults, null, 2)}
              onBlur={(e) => {
                try {
                  const v = JSON.parse(e.target.value);
                  if (!v || Array.isArray(v) || typeof v !== 'object') throw Error();
                  change(c.id, { defaults: v });
                  e.target.setCustomValidity('');
                } catch {
                  e.target.setCustomValidity('Invalid JSON object');
                  e.target.reportValidity();
                }
              }}
            />
          </label>
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => change(c.id, { enabled: e.target.checked })}
              />
              {zh ? '启用' : 'Enabled'}
            </label>
            <a
              href={mediaProtocols.find((p) => p.id === c.protocol)?.docs}
              target="_blank"
              rel="noreferrer"
            >
              {zh ? '官方文档 / 模型目录' : 'Official docs / models'}
            </a>
            <button
              onClick={() =>
                update({ connections: media.connections.filter((p: any) => p.id !== c.id) })
              }
            >
              {zh ? '移除' : 'Remove'}
            </button>
          </div>
        </details>
      ))}
      <div className="form-grid">
        <label>
          {zh ? '录音转文字服务' : 'Dictation service'}
          <select
            value={media.transcriptionId}
            onChange={(e) => update({ transcriptionId: e.target.value })}
          >
            <option value="">{zh ? '未配置' : 'Not configured'}</option>
            {media.connections
              .filter((c: any) => c.kind === 'transcription')
              .map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {zh
            ? '允许自动审核的单次媒体估算上限 USD'
            : 'Per-job estimate eligible for auto-review (USD)'}
          <input
            type="number"
            min="0"
            step="0.01"
            value={media.autoApproveMaxUsd ?? ''}
            onChange={(e) =>
              update({ autoApproveMaxUsd: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </label>
      </div>
      <p className="muted">
        {zh
          ? '费用是手动估算，不是服务商账单或硬预算。留空、未知或超出阈值时，Agent 生成请求会询问你。录音停止后上传转文字，填入草稿供你编辑，不自动发送；这不是实时语音对话。'
          : 'Prices are estimates, not invoices or hard spending caps. Missing/unknown/above-threshold estimates require manual generation approval. Dictation uploads after recording stops, inserts editable text, and never auto-sends; this is not a live voice conversation.'}
      </p>
    </section>
  );
}
