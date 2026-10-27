import { styleReferences, blendStyleReferences } from '../../shared/chat-personas';
import { useState, useRef, useEffect } from 'react';
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
  const [open, setOpen] = useState(false);
  const [maintenance, setMaintenance] = useState<any>(null);
  const [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [history, setHistory] = useState<any>(null);
  const [search, setSearch] = useState(''),
    [customName, setCustomName] = useState(''),
    [customDescription, setCustomDescription] = useState(''),
    [presetName, setPresetName] = useState('');
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const load = async () => {
    try {
      const d = await api('/chat-connections/' + id + '/notebook');
      setMaintenance(d.maintenance);
      setData({
        brief: '',
        references: [],
        presets: [],
        ...d,
        tone: { ...defaults, ...d.tone },
        mbti: d.mbti || '',
      });
      setDirty(false);
    } catch (e: any) {
      notify(e.message);
    }
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const timer = setInterval(() => {
      void api('/chat-connections/' + id + '/notebook')
        .then((d: any) => {
          if (disposed) return;
          setMaintenance(d.maintenance);
          if (!dirty && !busy) setData({ ...d, tone: { ...defaults, ...d.tone } });
        })
        .catch(() => {});
    }, 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id, open, dirty, busy]);
  const edit = (values: any) => {
    setData((d: any) => ({ ...d, ...values }));
    setDirty(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/chat-connections/' + id + '/notebook', {
        brief: data.brief,
        references: data.references,
        presets: data.presets,
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
        setOpen(e.currentTarget.open);
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
            <label>
              {tr('一句话风格意图', 'Style intent')}
              <textarea
                aria-label={tr('一句话风格意图', 'Style intent')}
                rows={2}
                maxLength={2000}
                value={data.brief || ''}
                onChange={(e) => edit({ brief: e.target.value })}
              />
            </label>
            <details>
              <summary>
                {tr('属性参考库与混合组合', 'Style references and combinations')} ·{' '}
                {(data.references || []).length}
              </summary>
              <p className="muted">
                {tr(
                  '包含附件 30 种 OC 参考及补充类别；不是百科完整镜像。描述可混合，维度数值只是创作起点。',
                  'Includes 30 OC references and additional categories; not a complete encyclopedia mirror. Axis values are editorial starting points.',
                )}{' '}
                <a href="https://zh.moegirl.org.cn/萌属性" target="_blank" rel="noreferrer">
                  {tr('萌属性目录', 'Reference taxonomy')}
                </a>
              </p>
              <input
                aria-label={tr('搜索属性', 'Search references')}
                placeholder={tr('搜索名称、分类或描述', 'Search name, category or description')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div style={{ maxHeight: 240, overflow: 'auto' }}>
                {styleReferences
                  .filter((r) => (r.name + r.category + r.description).includes(search))
                  .map((r) => (
                    <label key={r.id} className="chat-notebook-auto">
                      <input
                        type="checkbox"
                        checked={data.references.some((x: any) => x.name === r.name)}
                        disabled={
                          data.references.length >= 32 &&
                          !data.references.some((x: any) => x.name === r.name)
                        }
                        onChange={(e) =>
                          edit({
                            references: e.target.checked
                              ? [
                                  ...data.references,
                                  { name: r.name, description: r.description, strength: 70 },
                                ]
                              : data.references.filter((x: any) => x.name !== r.name),
                          })
                        }
                      />
                      <span>
                        <strong>{r.name}</strong> · {r.category}
                        <br />
                        {r.description}
                      </span>
                    </label>
                  ))}
              </div>
              {data.references.map((r: any, i: number) => (
                <div key={i}>
                  <label>
                    {r.name} · {r.strength}
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={r.strength}
                      onChange={(e) =>
                        edit({
                          references: data.references.map((v: any, j: number) =>
                            j === i ? { ...v, strength: Number(e.target.value) } : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <small>{r.description}</small>
                  <button
                    onClick={() =>
                      edit({ references: data.references.filter((_: any, j: number) => j !== i) })
                    }
                  >
                    {tr('移除', 'Remove')}
                  </button>
                </div>
              ))}
              <input
                aria-label="Reference name"
                placeholder={tr('自定义属性名称', 'Custom reference name')}
                maxLength={80}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
              <textarea
                aria-label="Reference description"
                placeholder={tr(
                  '用自己的话描述表现、情境或例外',
                  'Describe expression, context or exceptions',
                )}
                maxLength={400}
                value={customDescription}
                onChange={(e) => setCustomDescription(e.target.value)}
              />
              <button
                disabled={
                  !customName.trim() || !customDescription.trim() || data.references.length >= 32
                }
                onClick={() => {
                  edit({
                    references: [
                      ...data.references,
                      {
                        name: customName.trim(),
                        description: customDescription.trim(),
                        strength: 70,
                      },
                    ],
                  });
                  setCustomName('');
                  setCustomDescription('');
                }}
              >
                {tr('添加自定义参考', 'Add custom reference')}
              </button>
              <button onClick={() => edit({ tone: blendStyleReferences(data.references) })}>
                {tr('按所选组合调整三个维度图', 'Apply combination to tone charts')}
              </button>
              <p className="muted">
                {tr(
                  '外观、身份和自定义描述保留为文字，不自动推断维度。调整组合不会覆盖日记。',
                  'Appearance, identity and custom descriptions stay textual; no inferred axis scores. Diary stays separate.',
                )}
              </p>
            </details>
            <details>
              <summary>{tr('我的快捷组合', 'My saved combinations')}</summary>
              <input
                aria-label="Combination name"
                maxLength={80}
                value={presetName}
                placeholder={tr('组合名称', 'Combination name')}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                disabled={!presetName.trim() || data.presets.length >= 20}
                onClick={() => {
                  edit({
                    presets: [
                      ...data.presets,
                      {
                        name: presetName.trim(),
                        brief: data.brief,
                        references: data.references,
                        tone: data.tone,
                        mbti: data.mbti,
                      },
                    ],
                  });
                  setPresetName('');
                }}
              >
                {tr('保存当前组合', 'Keep current combination')}
              </button>
              {data.presets.map((p: any, i: number) => (
                <div key={i}>
                  <button
                    onClick={() =>
                      edit({ brief: p.brief, references: p.references, tone: p.tone, mbti: p.mbti })
                    }
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() =>
                      edit({ presets: data.presets.filter((_: any, j: number) => j !== i) })
                    }
                  >
                    {tr('删除组合', 'Delete combination')}
                  </button>
                </div>
              ))}
              <small>
                {tr(
                  '仅保存风格意图、属性、维度和 MBTI；点击下方保存后持久化。',
                  'Keeps intent, references, axes and MBTI only. Save below to persist.',
                )}
              </small>
            </details>

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
          <p role="status">
            {tr('后台整理：', 'Background maintenance: ')}
            {!data.automatic
              ? tr('已关闭', 'Disabled')
              : {
                  pending: tr('等待增量整理', 'Pending'),
                  running: tr('整理中', 'Processing'),
                  updated: tr('已修订', 'Updated'),
                  unchanged: tr('已检查，无变化', 'Checked, no change'),
                  retrying: tr('失败，等待自动重试', 'Retry scheduled'),
                  needs_attention: tr(
                    '连续五次失败，需检查模型连接；关闭并保存后重新开启可重试',
                    'Five attempts failed; check model connection, then disable/save and re-enable to retry',
                  ),
                  waiting_model: tr('等待配置模型', 'Waiting for model'),
                }[maintenance?.status as string] || tr('等待增量整理', 'Pending')}
            {maintenance?.at && <> · {new Date(maintenance.at).toLocaleString()}</>}
            {maintenance?.checkedMessages != null && (
              <>
                {' '}
                · {tr('本批消息', 'Batch messages')} {maintenance.checkedMessages}
              </>
            )}
            {data.automatic && maintenance?.status === 'retrying' && maintenance.nextAt && (
              <>
                {' '}
                · {tr('下次重试', 'Next retry')} {new Date(maintenance.nextAt).toLocaleTimeString()}
              </>
            )}
            {dirty && (
              <span> · {tr('草稿未保存，自动刷新不会覆盖', 'Unsaved draft retained')}</span>
            )}
          </p>
          <label className="chat-notebook-auto">
            <input
              type="checkbox"
              checked={data.automatic}
              onChange={(e) => edit({ automatic: e.target.checked })}
            />{' '}
            {tr(
              '允许后台自动增量整理本会话设定和日记',
              'Allow background incremental learning of this chat style and diary',
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
                'Bot 可根据有来源的交流整理；观察、推测和成员个人偏好应保留区别。完整历史仍在原会话。后台使用本会话配置的模型，可能消耗 API 额度。',
                'The bot may reflect on attributed exchanges; observations, inference and individual preferences remain distinct. Full history stays in the conversation. Background maintenance uses this chat model and may incur API usage.',
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
