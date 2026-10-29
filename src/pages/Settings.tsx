import { VideoAccountSettings } from '../components/VideoAccountSettings';
import { RetrievalSettings } from '../components/RetrievalSettings';
import { ToolEcosystemSettings } from '../components/ToolEcosystemSettings';
import { McpConnectionSettings } from '../components/McpConnectionSettings';
import { McpExamples } from '../components/McpExamples';
import { ApprovalSettings } from '../components/ApprovalSettings';
import { MediaSettings } from '../components/MediaSettings';
import { matchModel } from '../../shared/model-metadata';
import { PlugZap, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
export function SettingsPage({ settings, t, refresh, notify }: any) {
  const [value, setValue] = useState(() => structuredClone(settings)),
    [selected, setSelected] = useState(settings.defaultProfileId),
    [busy, setBusy] = useState(false),
    [models, setModels] = useState<any[]>([]),
    [executionCheck, setExecutionCheck] = useState<any>(null);
  const profile = value.profiles.find((p: any) => p.id === selected);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setModels([]);
    if (!profile || !(profile.apiKey || profile.hasKey) || !profile.baseUrl) return;
    const timer = setTimeout(() => {
      api(
        '/models',
        { ...profile, model: profile.model || '__discovery__' },
        undefined,
        {},
        controller.signal,
      )
        .then((list) => {
          if (!cancelled) setModels(list);
        })
        .catch(() => {
          /* Explicit discovery button presents errors; manual configuration remains available. */
        });
    }, 400);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, profile?.baseUrl, profile?.transport, profile?.apiKey, profile?.hasKey]);
  const change = (key: string, v: any) =>
    setValue({
      ...value,
      profiles: value.profiles.map((p: any) => (p.id === selected ? { ...p, [key]: v } : p)),
    });
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  const add = () => {
    const p = {
      id: crypto.randomUUID(),
      name: 'New connection',
      transport: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      model: '',
      reasoning: 'auto',
      reasoningFormat: 'deepseek',
      efforts: ['auto'],
      contextWindow: 65536,
      maxOutputTokens: 8192,
      timeoutMs: 120000,
      vision: false,
      prices: { input: null, output: null, cached: null },
    };
    setValue({
      ...value,
      profiles: [...value.profiles, p],
      defaultProfileId: value.defaultProfileId || p.id,
    });
    setSelected(p.id);
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div className="eyebrow">{t('PREFERENCES')}</div>
        <h1>{t('settings')}</h1>
        <p>{t('Configure your models and choose how tools may run.')}</p>
      </div>
      <section className="panel">
        <label>
          {t('settings') !== 'Settings' ? '\u52a9\u624b\u540d\u79f0' : 'Assistant name'}
          <input
            maxLength={60}
            value={value.agentName || 'Amadeus'}
            onChange={(e) => setValue({ ...value, agentName: e.target.value })}
          />
        </label>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>
            <PlugZap size={18} />
            {t('connections')}
          </h2>
          <button onClick={add}>
            <Plus size={15} />
            {t('addConnection')}
          </button>
        </div>
        <div className="tabs">
          {value.profiles.map((p: any) => (
            <button
              key={p.id}
              className={selected === p.id ? 'selected' : ''}
              onClick={() => setSelected(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        {profile ? (
          <>
            <div className="form-grid">
              <label>
                {t('name')}
                <input value={profile.name} onChange={(e) => change('name', e.target.value)} />
              </label>
              <label>
                {t('Protocol')}
                <select
                  value={profile.transport}
                  onChange={(e) => {
                    const transport = e.target.value;
                    setValue({
                      ...value,
                      profiles: value.profiles.map((p: any) =>
                        p.id === selected
                          ? {
                              ...p,
                              transport,
                              reasoningFormat:
                                transport === 'openai-chat'
                                  ? 'none'
                                  : transport === 'openai-responses'
                                    ? 'openai'
                                    : transport,
                              efforts: ['auto'],
                              reasoning: 'auto',
                            }
                          : p,
                      ),
                    });
                  }}
                >
                  <option value="openai-chat">OpenAI-compatible Chat</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </label>
              <label className="wide">
                {t('Base URL')}
                <input
                  value={profile.baseUrl}
                  onChange={(e) => change('baseUrl', e.target.value)}
                  placeholder="https://api.deepseek.com"
                />
              </label>
              <label className="wide">
                {t('key')}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={profile.apiKey || ''}
                  placeholder={profile.hasKey ? 'Saved · leave unchanged to keep it' : 'Enter key'}
                  onChange={(e) => change('apiKey', e.target.value)}
                />
              </label>
              {models.length > 0 && (
                <label>
                  {t('Available models')}
                  <select
                    aria-label={t('Available models')}
                    value={models.some((m) => m.id === profile.model) ? profile.model : ''}
                    onChange={(e) => {
                      const metadata = models.find((m) => m.id === e.target.value);
                      if (metadata)
                        setValue({
                          ...value,
                          profiles: value.profiles.map((p: any) =>
                            p.id === selected ? matchModel(p, metadata) : p,
                          ),
                        });
                    }}
                  >
                    <option value="">{t('Select a discovered model')}</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.id}
                      </option>
                    ))}
                  </select>
                  <small>
                    {t(
                      'Selecting a model matches declared capabilities. Missing metadata keeps your manual settings.',
                    )}
                  </small>
                </label>
              )}
              <label>
                {t('model')}
                <input
                  list="model-list"
                  value={profile.model}
                  onChange={(e) => {
                    const model = e.target.value,
                      metadata = models.find((m) => m.id === model);
                    setValue({
                      ...value,
                      profiles: value.profiles.map((p: any) =>
                        p.id === selected
                          ? metadata
                            ? matchModel(p, metadata)
                            : { ...p, model }
                          : p,
                      ),
                    });
                  }}
                />
                <datalist id="model-list">
                  {models.map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </label>
              <label>
                {t('Reasoning protocol')}
                <select
                  value={profile.reasoningFormat}
                  onChange={(e) => change('reasoningFormat', e.target.value)}
                >
                  {['none', 'openai', 'deepseek', 'anthropic', 'gemini'].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('Context window')}
                <input
                  type="number"
                  min="4096"
                  value={profile.contextWindow}
                  onChange={(e) => change('contextWindow', Number(e.target.value))}
                />
              </label>
              <label>
                {t('Maximum output tokens')}
                <input
                  type="number"
                  aria-label={t('Maximum output tokens')}
                  value={profile.maxOutputTokens}
                  onChange={(e) => change('maxOutputTokens', Number(e.target.value))}
                />
                <small className="muted">
                  {t(
                    'Output allowance includes reasoning tokens. High reasoning may need a larger limit; the provider must support the value.',
                  )}
                </small>
              </label>
              <label>
                {t('Request timeout (seconds)')}
                <input
                  type="number"
                  value={profile.timeoutMs / 1000}
                  onChange={(e) => change('timeoutMs', Number(e.target.value) * 1000)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={profile.vision}
                  onChange={(e) => change('vision', e.target.checked)}
                />
                {t('Vision input supported')}
              </label>
            </div>
            <div className="field">
              <label>{t('Supported reasoning levels · confirm with the provider')}</label>
              <div className="choice-row">
                {['auto', 'none', 'low', 'medium', 'high', 'max'].map((level) => (
                  <label className="checkbox" key={level}>
                    <input
                      type="checkbox"
                      checked={profile.efforts.includes(level)}
                      disabled={level === 'auto'}
                      onChange={(e) =>
                        change(
                          'efforts',
                          e.target.checked
                            ? [...profile.efforts, level]
                            : profile.efforts.filter((v: string) => v !== level),
                        )
                      }
                    />
                    {level}
                  </label>
                ))}
              </div>
            </div>
            <details>
              <summary>{t('Optional pricing · USD per million tokens')}</summary>
              <div className="form-grid">
                {['input', 'output', 'cached'].map((k) => (
                  <label key={k}>
                    {k}
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={profile.prices[k] ?? ''}
                      placeholder={t('Unknown')}
                      onChange={(e) =>
                        change('prices', {
                          ...profile.prices,
                          [k]: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="muted">
                {t(
                  'Usage comes from API responses. These rates produce an estimate, not a provider bill.',
                )}
              </p>
            </details>
            <div className="row wrap">
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setModels(await api('/models', profile));
                    notify(
                      'Model list loaded. Missing capability metadata remains manually configured.',
                    );
                  })
                }
              >
                {t('discover')}
              </button>
              <button
                disabled={busy || !models.length}
                onClick={() =>
                  run(async () => {
                    const result = await api('/models/import', profile);
                    setValue(result.settings);
                    await refresh();
                    notify(
                      t('Models added') +
                        ': ' +
                        (result.added.join(', ') || t('Already configured')),
                    );
                  })
                }
              >
                {t('Add discovered models to chat selector')}
              </button>

              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await api('/test-connection', profile);
                    notify(t('connected') + ' · ' + result.model + ' · ' + result.text);
                  })
                }
              >
                {t('test')}
              </button>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={value.defaultProfileId === profile.id}
                  onChange={() => setValue({ ...value, defaultProfileId: profile.id })}
                />
                {t('Default')}
              </label>
              <button
                className="danger icon"
                title={t('delete')}
                onClick={() => {
                  const profiles = value.profiles.filter((p: any) => p.id !== selected);
                  setValue({ ...value, profiles, defaultProfileId: profiles[0]?.id || '' });
                  setSelected(profiles[0]?.id || '');
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </>
        ) : (
          <div className="empty">{t('noModel')}</div>
        )}
      </section>
      <section className="panel">
        <h2>
          <ShieldCheck size={18} />
          {t('hostFacts')}
        </h2>
        <div className="execution-diagnostics">
          <button
            disabled={busy}
            onClick={() => run(async () => setExecutionCheck(await api('/execution/check', {})))}
          >
            {t('settings') !== 'Settings'
              ? '检查已保存的执行环境'
              : 'Check saved execution environment'}
          </button>
          <p className="muted">
            {t('settings') !== 'Settings'
              ? '运行固定的无害就绪检查，显示缺失依赖或预检原因；不会切换后端或自动安装 Docker。检查通过不等于安全性已被全面证明。'
              : 'Runs a fixed harmless readiness check. Shows missing dependencies or preflight failures; never switches backends or installs Docker. Passing is not a comprehensive security proof.'}
          </p>
          {executionCheck && <pre role="status">{JSON.stringify(executionCheck, null, 2)}</pre>}
        </div>
        <fieldset className="execution-modes">
          <legend>
            {t('settings') !== 'Settings'
              ? '默认执行环境（对话中可覆盖）'
              : 'Default execution environment (overridable per chat)'}
          </legend>
          {[
            {
              key: 'host',
              backend: 'approval-host',
              network: 'host',
              en: 'Host approval',
              cn: '宿主审批',
              detail: 'No OS file isolation; commands use your account permissions.',
              note: '无 OS 文件隔离；命令使用宿主账号权限。',
            },
            {
              key: 'native-host',
              backend: 'native-windows',
              network: 'host',
              en: 'AppContainer · file isolation',
              cn: 'AppContainer · 文件隔离',
              detail: 'Restricts filesystem access; host network remains available.',
              note: '限制文件访问；允许宿主网络。',
            },
            {
              key: 'native-deny',
              backend: 'native-windows',
              network: 'deny',
              en: 'AppContainer · strict offline',
              cn: 'AppContainer · 严格离线',
              detail:
                'File isolation plus offline preflight. Refuses commands if verification fails.',
              note: '文件隔离并检查断网能力；预检失败则拒绝执行。',
            },
            {
              key: 'docker',
              backend: 'docker',
              network: 'deny',
              en: 'Docker · offline container',
              cn: 'Docker · 离线容器',
              detail: 'Requires Docker and an installed image; mounts the execution folder.',
              note: '需 Docker 和已安装镜像；挂载当前执行目录。',
            },
          ].map((mode) => (
            <label key={mode.key} className="execution-mode">
              <input
                type="radio"
                name="execution-mode"
                checked={
                  value.commandBackend === mode.backend &&
                  (mode.backend !== 'native-windows' || value.nativeNetwork === mode.network)
                }
                onChange={() =>
                  setValue({
                    ...value,
                    commandBackend: mode.backend,
                    ...(mode.backend === 'native-windows' ? { nativeNetwork: mode.network } : {}),
                  })
                }
              />
              <span>
                <strong>{t('settings') !== 'Settings' ? mode.cn : mode.en}</strong>
                <small>{t('settings') !== 'Settings' ? mode.note : mode.detail}</small>
              </span>
            </label>
          ))}
          <small>
            {t('settings') !== 'Settings'
              ? '保存后对后续命令生效；不会终止已有进程或改变会话审批权限。'
              : 'Applies to subsequent commands after saving; does not terminate existing processes or change conversation approval permissions.'}
          </small>
        </fieldset>
        <ApprovalSettings value={value} setValue={setValue} zh={t('settings') !== 'Settings'} />
        <p className="execution-boundary" role="note">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!value.approveFileWrites}
              onChange={(e) => setValue({ ...value, approveFileWrites: e.target.checked })}
            />
            {t('settings') !== 'Settings'
              ? '文件写入也需审批（完全访问模式除外）；关闭时仅命令需审批'
              : 'Also approve file writes (except Full access); otherwise approval applies to commands'}
          </label>
          <label>
            {t('settings') !== 'Settings' ? 'Docker 执行用户 UID:GID' : 'Docker execution UID:GID'}
            <input
              value={value.dockerUser || '1000:1000'}
              onChange={(e) => setValue({ ...value, dockerUser: e.target.value })}
            />
          </label>
          {value.commandBackend === 'approval-host'
            ? t('settings') !== 'Settings'
              ? '宿主执行 · 无 OS 文件隔离。批准后命令可访问当前 Windows 账号可访问的文件与网络；工作目录不是安全边界。可信模式可跳过审批。'
              : 'Host execution · No OS file isolation. Approved commands can access files and network available to your account. The working directory is not a boundary. Trusted mode may bypass approval.'
            : value.commandBackend === 'native-windows'
              ? t('settings') !== 'Settings'
                ? 'AppContainer 文件隔离。运行时与系统公共资源可能可读；网络策略单独设置，预检失败不会退回宿主执行。'
                : 'AppContainer file isolation. Runtime and public system resources may remain readable. Network policy is separate; failed preflight never falls back to host execution.'
              : t('settings') !== 'Settings'
                ? 'Docker：仅挂载当前执行目录，禁用网络；容器不可用时不会退回宿主。'
                : 'Docker: mounts the execution folder with networking disabled; no host fallback.'}
        </p>
        <div className="form-grid">
          <label>
            {t('Native Python interpreter')}
            <input
              placeholder="C:\Python311\python.exe"
              value={value.nativePython || ''}
              onChange={(e) => setValue({ ...value, nativePython: e.target.value })}
            />
          </label>
          <label>
            {t('Native network policy')}
            <select
              value={value.nativeNetwork || 'deny'}
              onChange={(e) => setValue({ ...value, nativeNetwork: e.target.value })}
            >
              <option value="deny">{t('Strict offline · fail closed')}</option>
              <option value="host">{t('File isolation · network not guaranteed blocked')}</option>
            </select>
          </label>
          <label>
            {t('Docker image')}
            <input
              value={value.dockerImage}
              onChange={(e) => setValue({ ...value, dockerImage: e.target.value })}
            />
          </label>
          <label>
            {t('settings') === 'Settings'
              ? 'Parallel model requests per conversation (including children)'
              : '每个对话的模型并发（含子 Agent）'}
            <input
              type="number"
              min="0"
              max="12"
              value={value.maxParallelRuns}
              onChange={(e) => setValue({ ...value, maxParallelRuns: Number(e.target.value) })}
            />
            <small>{t('settings') === 'Settings' ? '0 = unlimited' : '0 = 不设上限'}</small>
          </label>
          <label>
            {t('Maximum delegation depth')}
            <input
              type="number"
              min="0"
              max="5"
              value={value.maxAgentDepth}
              onChange={(e) => setValue({ ...value, maxAgentDepth: Number(e.target.value) })}
            />
          </label>
          <label>
            {t('settings') === 'Settings'
              ? 'Active children per run tree'
              : '每棵任务树同时活跃的子任务'}
            <input
              type="number"
              min="0"
              max="32"
              value={value.maxChildren}
              onChange={(e) => setValue({ ...value, maxChildren: Number(e.target.value) })}
            />
            <small>
              {t('settings') === 'Settings'
                ? '0 = unlimited; finished children release slots. No cumulative continuation quota. Depth still applies.'
                : '0 = 不设上限；完成后释放名额，续跑次数不累计限额。委派深度仍独立生效'}
            </small>
          </label>
          <label>
            {t('Context compaction threshold')}
            <input
              type="number"
              min=".3"
              max=".9"
              step=".05"
              value={value.compactionRatio}
              onChange={(e) => setValue({ ...value, compactionRatio: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="muted">
          {t('trustedWarning')} Docker requires a working installation and image; errors never fall
          back to host execution.
        </p>
      </section>
      <section className="panel">
        <h2>{t('Embedding connection')}</h2>
        <label>
          {t('settings') === 'Settings' ? 'Embedding backend' : '向量模型执行位置'}
          <select
            value={value.embedding.backend || 'remote'}
            onChange={(e) =>
              setValue({
                ...value,
                embedding: { ...value.embedding, backend: e.target.value as 'local' | 'remote' },
              })
            }
          >
            <option value="local">Local · multilingual-e5-small · 中文 / English · CPU</option>
            <option value="remote">API · Remote / local endpoint</option>
          </select>
        </label>
        <p className="muted">
          {t('settings') === 'Settings'
            ? 'Local multilingual E5 runs on CPU; first use downloads model files. Documents stay local. API mode sends chunks to the configured endpoint. Default retrieval uses local FTS and HNSW; optional services are configured below.'
            : '本地多语言 E5 使用 CPU，首次下载模型，文档不上传。API 模式将分块发送到配置的服务。默认 FTS 与 HNSW 检索在本机执行，可选服务在下方配置。'}
        </p>
        <div className="form-grid">
          <label>
            {t('Base URL')}
            <input
              value={value.embedding.baseUrl}
              onChange={(e) =>
                setValue({ ...value, embedding: { ...value.embedding, baseUrl: e.target.value } })
              }
            />
          </label>
          <label>
            {t('Model')}
            <input
              value={value.embedding.model}
              onChange={(e) =>
                setValue({ ...value, embedding: { ...value.embedding, model: e.target.value } })
              }
            />
          </label>
          <label className="wide">
            {t('API key')}
            <input
              type="password"
              value={value.embedding.apiKey || ''}
              placeholder={value.embedding.hasKey ? 'Saved · unchanged to retain' : ''}
              onChange={(e) =>
                setValue({ ...value, embedding: { ...value.embedding, apiKey: e.target.value } })
              }
            />
          </label>
        </div>
      </section>
      <RetrievalSettings value={value} setValue={setValue} zh={t('settings') !== 'Settings'} />
      <ToolEcosystemSettings value={value} setValue={setValue} zh={t('settings') !== 'Settings'} />
      <section className="panel">
        <div className="section-title">
          <h2>{t('MCP servers')}</h2>
          <button
            onClick={() =>
              setValue({
                ...value,
                mcp: [
                  ...value.mcp,
                  {
                    id: crypto.randomUUID(),
                    name: 'New server',
                    command: '',
                    args: [],
                    enabled: false,
                  },
                ],
              })
            }
          >
            <Plus size={15} />
            {t('Add server')}
          </button>
        </div>
        <p className="muted">
          {t('settings') === 'Settings'
            ? 'Trust the configured executable or remote endpoint before enabling. Discovery and tool calls require approval.'
            : '启用前请确认信任本地程序或远程服务。发现工具和调用工具仍需审批。'}
        </p>
        <McpExamples
          zh={t('settings') !== 'Settings'}
          add={(server) => setValue({ ...value, mcp: [...value.mcp, server] })}
        />
        {value.mcp.map((server: any, index: number) => (
          <div className="panel" key={server.id}>
            <McpConnectionSettings
              server={server}
              zh={t('settings') !== 'Settings'}
              update={(patch) =>
                setValue({
                  ...value,
                  mcp: value.mcp.map((s: any, i: number) => (i === index ? { ...s, ...patch } : s)),
                })
              }
            />
            <div className="form-grid">
              {(server.transport === 'http' ? ['name'] : ['name', 'command']).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    disabled={!!server.builtin && key === 'command'}
                    placeholder={server.builtin ? 'Bundled adapter' : undefined}
                    value={server[key]}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        mcp: value.mcp.map((s: any, i: number) =>
                          i === index ? { ...s, [key]: e.target.value } : s,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              {server.transport !== 'http' && (
                <label className="wide">
                  {t('Arguments · one per line')}
                  <textarea
                    disabled={!!server.builtin}
                    value={server.args.join('\n')}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        mcp: value.mcp.map((s: any, i: number) =>
                          i === index ? { ...s, args: e.target.value.split('\n') } : s,
                        ),
                      })
                    }
                  />
                </label>
              )}
            </div>
            {server.builtin === 'browser' && (
              <div className="form-grid">
                <label>
                  {t('settings') === 'Settings'
                    ? 'Allowed hosts (one per line; empty = host network)'
                    : '允许域名（每行一个；留空使用宿主网络）'}
                  <textarea
                    value={(server.browser?.allowedHosts || []).join('\n')}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        mcp: value.mcp.map((s: any, i: number) =>
                          i === index
                            ? {
                                ...s,
                                browser: {
                                  persistSession: s.browser?.persistSession || false,
                                  allowedHosts: e.target.value
                                    .split('\n')
                                    .map((v) => v.trim().toLowerCase())
                                    .filter(Boolean),
                                },
                              }
                            : s,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={server.browser?.persistSession || false}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        mcp: value.mcp.map((s: any, i: number) =>
                          i === index
                            ? {
                                ...s,
                                browser: {
                                  allowedHosts: s.browser?.allowedHosts || [],
                                  persistSession: e.target.checked,
                                },
                              }
                            : s,
                        ),
                      })
                    }
                  />
                  {t('settings') === 'Settings'
                    ? 'Keep cookies and local storage per conversation on this computer'
                    : '在本机按对话保存 Cookie 和本地存储'}
                </label>
                <p className="muted">
                  {t('settings') === 'Settings'
                    ? 'Host filtering is an application rule, not OS network isolation. Downloads require a new path in an existing project folder.'
                    : '域名过滤是应用规则，不是 OS 网络隔离。下载需指定项目已有文件夹中的新文件路径。'}
                </p>
              </div>
            )}
            <div className="row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => {
                    if (
                      e.target.checked &&
                      !confirm(
                        server.transport === 'http'
                          ? 'Trust this endpoint to receive MCP requests and the configured credential?'
                          : 'Trust this executable to run with host user permissions?',
                      )
                    )
                      return;
                    setValue({
                      ...value,
                      mcp: value.mcp.map((s: any, i: number) =>
                        i === index ? { ...s, enabled: e.target.checked } : s,
                      ),
                    });
                  }}
                />
                {t('Enabled')}
              </label>
              <button
                onClick={() =>
                  setValue({ ...value, mcp: value.mcp.filter((_: any, i: number) => i !== index) })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>{t('settings') !== 'Settings' ? '网页访问' : 'Web access'}</h2>
        <p>
          {t('settings') !== 'Settings'
            ? '搜索与抓取由宿主网络服务处理，和命令沙箱的网络策略独立。关闭此开关同时禁用主任务与子任务的内置网页工具；不控制独立配置的 MCP。'
            : 'Search and fetch use host-managed networking, independently of command sandbox policy. Disabling this switch removes built-in web tools from parent and child tasks; separately configured MCP servers are not controlled here.'}
        </p>
        <label>
          <input
            type="checkbox"
            checked={value.web?.enabled !== false}
            onChange={(e) =>
              setValue({ ...value, web: { ...value.web, enabled: e.target.checked } })
            }
          />
          {t('settings') !== 'Settings' ? '启用公开网页工具' : 'Enable public web tools'}
        </label>
        <div className="form-grid">
          <label>
            {t('settings') !== 'Settings' ? '搜索使用的模型连接' : 'Search connection'}
            <select
              value={value.web?.searchProfileId || ''}
              onChange={(e) =>
                setValue({ ...value, web: { ...value.web, searchProfileId: e.target.value } })
              }
            >
              <option value="">
                {t('settings') !== 'Settings'
                  ? '自动选择 DeepSeek 官方连接'
                  : 'Auto-select official DeepSeek connection'}
              </option>
              {value.profiles.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('settings') !== 'Settings' ? '搜索 Messages 基础地址' : 'Search Messages base URL'}
            <input
              value={value.web?.searchBaseUrl || 'https://api.deepseek.com/anthropic/v1'}
              onChange={(e) =>
                setValue({ ...value, web: { ...value.web, searchBaseUrl: e.target.value } })
              }
            />
          </label>
          <label>
            {t('settings') !== 'Settings'
              ? '搜索模型（留空沿用连接）'
              : 'Search model (blank uses connection)'}
            <input
              value={value.web?.searchModel || ''}
              onChange={(e) =>
                setValue({ ...value, web: { ...value.web, searchModel: e.target.value } })
              }
            />
          </label>
        </div>
        <p className="muted">
          {t('settings') !== 'Settings'
            ? '复用所选连接的凭据，仅发送到同源端点。搜索是额外的付费模型请求；来源缺失会报错，不用模型记忆冒充检索。抓取仅支持公开 HTTP(S)，每次重定向重新校验地址。'
            : 'Reuses the selected connection credential only on the same origin. Search is an additional billed model request; missing search evidence is an error. Fetch allows public HTTP(S) only and revalidates redirects.'}
        </p>
      </section>
      <VideoAccountSettings zh={t('settings') !== 'Settings'} notify={notify} />
      <MediaSettings value={value} setValue={setValue} zh={t('settings') !== 'Settings'} />
      <div className="sticky-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api('/settings', value, 'PUT');
              await refresh();
              notify('Settings saved');
            })
          }
        >
          {busy ? 'Working…' : t('save')}
        </button>
      </div>
    </div>
  );
}
