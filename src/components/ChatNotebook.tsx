import { useState, useRef } from 'react';
import { api } from '../api';
import {
  toneGroups,
  defaultTone as defaults,
  tonePresets,
  mbtiStyles,
  type ChatTone,
} from '../../shared/chat-tone';
export function ChatNotebook({
  id,
  zh,
  notify,
}: {
  id: string;
  zh: boolean;
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [history, setHistory] = useState<any>(null);
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const load = async () => {
    try {
      const d = await api('/chat-connections/' + id + '/notebook');
      setData({ ...d, tone: { ...defaults, ...d.tone }, mbti: d.mbti || '' });
      setDirty(false);
    } catch (e: any) {
      notify(e.message);
    }
  };
  const edit = (values: any) => {
    setData((d: any) => ({ ...d, ...values }));
    setDirty(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/chat-connections/' + id + '/notebook', {
        revision: data.revision,
        style: data.style,
        diary: data.diary,
        automatic: data.automatic,
        tone: data.tone,
        mbti: data.mbti,
        reason: 'Edited in chat settings',
        sourceEventIds: [],
      });
      await load();
      notify(tr('已保存，下轮接入聊天使用', 'Saved for the next remote turn'));
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="chat-notebook"
      onToggle={(e) => {
        if (e.currentTarget.open && !data) void load();
      }}
    >
      <summary>{tr('聊天设定、语气与日记', 'Style, tone and diary')}</summary>
      {!data ? (
        <p>{tr('加载中…', 'Loading…')}</p>
      ) : (
        <>
          <p className="muted">
            {tr(
              '仅此接入会话使用，不与其他群、私聊或本地对话共享。设定和日记不授予工具、审批或电脑权限。',
              'Only this remote chat. Not shared with other chats or local conversations. Notes never grant tools, approval or computer permissions.',
            )}
          </p>
          <details open>
            <summary>
              {tr('人格与表达快捷调整', 'Quick personality and expression controls')}
            </summary>
            <div className="chat-connection-actions">
              {tonePresets.map((preset) => (
                <button
                  key={preset.name[1]}
                  onClick={() => edit({ tone: { ...defaults, ...preset.values } })}
                >
                  {tr(...preset.name)}
                </button>
              ))}
            </div>
            <label>
              {tr('MBTI 风格参考（可选）', 'MBTI style inspiration (optional)')}{' '}
              <select value={data.mbti} onChange={(e) => edit({ mbti: e.target.value })}>
                <option value="">{tr('不指定', 'None')}</option>
                {mbtiStyles.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              {tr(
                '预设只是起点，不覆盖文字设定。MBTI 是创作参考，不是真实人格诊断。50 为中性；额外提醒调低可减少叠甲，但仍说明重要的不确定性。',
                'Presets are starting points, not fixed identities. MBTI is creative inspiration, not diagnosis. 50 is neutral; fewer optional caveats never suppress material uncertainty.',
              )}
            </p>
            {toneGroups.map((group) => (
              <details key={group.name[1]} open>
                <summary>{tr(group.name[0], group.name[1])}</summary>
                <ToneChart
                  axes={group.axes}
                  tone={data.tone}
                  onChange={(tone) => edit({ tone })}
                  zh={zh}
                />
              </details>
            ))}
            <p className="muted">
              {tr(
                '拖动各轴圆点或下方滑条。手动语气优先于学习风格；主动接话不改变发送权限或频率。保存后生效。',
                'Drag axis points or use sliders. Manual tone overrides learned style; engagement does not change sending permissions or frequency. Save to apply.',
              )}
            </p>
            <button onClick={() => edit({ tone: { ...defaults }, mbti: '' })}>
              {tr('恢复中性', 'Reset tone')}
            </button>
          </details>
          <label className="chat-notebook-auto">
            <input
              type="checkbox"
              checked={data.automatic}
              onChange={(e) => edit({ automatic: e.target.checked })}
            />{' '}
            {tr(
              '允许 Bot 按需学习并整理本会话设定和日记',
              'Allow contextual learning of this chat style and diary',
            )}
          </label>
          <details>
            <summary>{tr('聊天设定 / 人格底色', 'Style / persona preferences')}</summary>
            <textarea
              rows={10}
              maxLength={16000}
              value={data.style}
              onChange={(e) => edit({ style: e.target.value })}
              aria-label={tr('聊天设定', 'Chat style')}
            />
          </details>
          <details>
            <summary>
              {tr(
                '聊天日记 · 精简回顾，不是全部历史',
                'Diary · concise reflection, not full history',
              )}
            </summary>
            <textarea
              rows={8}
              maxLength={8000}
              value={data.diary}
              onChange={(e) => edit({ diary: e.target.value })}
              aria-label={tr('聊天日记', 'Chat diary')}
            />
            <p className="muted">
              {tr(
                'Bot 可根据有来源的交流整理；观察、推测和成员个人偏好应保留区别。完整历史仍在原会话。',
                'The bot may reflect on attributed exchanges; observations, inference and individual preferences remain distinct. Full history stays in the conversation.',
              )}
            </p>
          </details>
          <div className="chat-connection-actions">
            <button disabled={busy || !dirty} onClick={() => void save()}>
              {tr('保存', 'Save')}
            </button>
            <button disabled={busy || dirty} onClick={() => void load()}>
              {tr('刷新', 'Refresh')}
            </button>
            <small>
              {tr('修订', 'Revision')} {data.revision} · {data.author}
            </small>
          </div>
          <details>
            <summary>{tr('修订记录与恢复', 'Revisions and restore')}</summary>
            {data.revisions.map((r: any) => (
              <div key={r.revision}>
                <button
                  onClick={async () => {
                    try {
                      setHistory(await api('/chat-connections/' + id + '/notebook/' + r.revision));
                    } catch (e: any) {
                      notify(e.message);
                    }
                  }}
                >
                  #{r.revision} · {r.author} · {r.reason}
                </button>
              </div>
            ))}
            {history && (
              <>
                <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
                  {JSON.stringify(history, null, 2)}
                </pre>
                <button onClick={() => edit(history.previous)}>
                  {tr(
                    '将此修订前内容载入编辑器，保存后恢复',
                    'Load preceding version; save to restore',
                  )}
                </button>
              </>
            )}
          </details>
        </>
      )}
    </details>
  );
}

function ToneChart({
  axes,
  tone,
  onChange,
  zh,
}: {
  axes: readonly (readonly [keyof ChatTone, string, string])[];
  tone: ChatTone;
  onChange: (tone: ChatTone) => void;
  zh: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<number | null>(null);
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const point = (i: number, value: number) => {
    const angle = (i * Math.PI) / 3 - Math.PI / 2;
    return [180 + Math.cos(angle) * value * 1.05, 155 + Math.sin(angle) * value * 1.05];
  };
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current === null || !svg.current) return;
    const p = svg.current.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    const matrix = svg.current.getScreenCTM();
    if (!matrix) return;
    const local = p.matrixTransform(matrix.inverse());
    const i = drag.current,
      angle = (i * Math.PI) / 3 - Math.PI / 2;
    const value = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          ((local.x - 180) * Math.cos(angle) + (local.y - 155) * Math.sin(angle)) / 1.05,
        ),
      ),
    );
    onChange({ ...tone, [axes[i][0]]: value });
  };
  return (
    <div>
      <svg
        ref={svg}
        viewBox="0 0 360 310"
        style={{
          width: '100%',
          maxWidth: 400,
          touchAction: 'none',
          userSelect: 'none',
          display: 'block',
          margin: 'auto',
        }}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        aria-label={tr(
          '六维语气图，下方滑条支持键盘调整',
          'Tone chart; use the sliders below for keyboard adjustment',
        )}
      >
        {[25, 50, 75, 100].map((v) => (
          <polygon
            key={v}
            points={axes.map((_, i) => point(i, v).join(',')).join(' ')}
            fill="none"
            stroke="currentColor"
            opacity="0.15"
          />
        ))}
        {axes.map(([key, cn, en], i) => {
          const end = point(i, 100),
            label = point(i, 128);
          return (
            <g key={key}>
              <line
                x1="180"
                y1="155"
                x2={end[0]}
                y2={end[1]}
                stroke="currentColor"
                opacity="0.25"
              />
              <text
                x={label[0]}
                y={label[1]}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="currentColor"
                fontSize="12"
              >
                {tr(cn, en)}
              </text>
            </g>
          );
        })}
        <polygon
          points={axes.map(([key], i) => point(i, tone[key]).join(',')).join(' ')}
          fill="#8b7bd033"
          stroke="#a998ed"
          strokeWidth="2"
        />
        {axes.map(([key], i) => {
          const p = point(i, tone[key]);
          return (
            <circle
              key={key}
              cx={p[0]}
              cy={p[1]}
              r="8"
              fill="#a998ed"
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                e.preventDefault();
                drag.current = i;
                svg.current?.setPointerCapture(e.pointerId);
              }}
            />
          );
        })}
      </svg>
      <div className="chat-tone-sliders">
        {axes.map(([key, cn, en]) => (
          <label key={key}>
            {tr(cn, en)} <output>{tone[key]}</output>
            <input
              type="range"
              min="0"
              max="100"
              value={tone[key]}
              onChange={(e) => onChange({ ...tone, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
