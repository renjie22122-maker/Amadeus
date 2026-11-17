import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UiState } from '../types';
export function PersonalPage({
  state,
  zh,
  notify,
  openChat,
}: {
  state: UiState;
  zh: boolean;
  notify: (s: string) => void;
  openChat: (id: string) => void;
}) {
  const [data, setData] = useState<any>(),
    [name, setName] = useState('Amadeus'),
    [chat, setChat] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [executionWindow, setExecutionWindow] = useState<any>(null);
  const [objective, setObjective] = useState(''),
    [success, setSuccess] = useState(''),
    [minutes, setMinutes] = useState(30),
    [runs, setRuns] = useState(24),
    [hours, setHours] = useState(24);
  const [deviceName, setDeviceName] = useState('My phone'),
    [approval, setApproval] = useState(false),
    [control, setControl] = useState(false),
    [workspace, setWorkspace] = useState(false),
    [invite, setInvite] = useState<any>(),
    [busy, setBusy] = useState(false);
  const t = (en: string, cn: string) => (zh ? cn : en);
  const refresh = () => api('/personal').then(setData);
  useEffect(() => {
    let live = true,
      loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      return api('/personal')
        .then((d) => {
          if (live) setData(d);
        })
        .catch((e) => {
          if (live) notify(e.message);
        })
        .finally(() => {
          loading = false;
        });
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <p role="status">{t('Loading personal agent…', '正在加载常驻助手…')}</p>;
  return (
    <div className="workspace-hub personal-agent">
      <h1>{t('Personal agent', '常驻助手')}</h1>
      <p>
        {t(
          'One identity, ongoing goals and paired devices. Work continues while the computer and service are awake; this is not cloud hosting.',
          '同一个身份，持续推进目标，连接你的设备。电脑与服务保持运行时可继续工作；这不是云端托管。',
        )}
      </p>
      <fieldset disabled={busy}>
        <section className="panel">
          {data.identity ? (
            <>
              <h2>{data.identity.name}</h2>
              <button onClick={() => openChat(data.identity.conversationId)}>
                {t('Open agent conversation', '打开助手会话')}
              </button>
            </>
          ) : (
            <>
              <h2>{t('Choose your primary agent', '设置主助手')}</h2>
              <label>
                {t('Name', '名称')}
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              </label>
              <label>
                {t('Persistent conversation', '长期会话')}
                <select value={chat} onChange={(e) => setChat(e.target.value)}>
                  <option value="">{t('Choose a conversation', '选择会话')}</option>
                  {state.conversations
                    .filter((c) => !c.archived && !c.parentId && !c.isolationId)
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={!chat || !name.trim()}
                onClick={() =>
                  void act(() => api('/personal/identity', { name, conversationId: chat }))
                }
              >
                {t('Create identity', '创建身份')}
              </button>
            </>
          )}
        </section>
        {data.identity && (
          <>
            <section className="panel">
              <h2>{t('New ongoing goal', '新的长期目标')}</h2>
              <label>
                {t('Objective', '希望完成什么')}
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  maxLength={6000}
                />
              </label>
              <label>
                {t('Completion criteria', '怎样才算完成')}
                <textarea
                  value={success}
                  onChange={(e) => setSuccess(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <div className="form-grid">
                <label>
                  {t('Check interval (minutes)', '检查间隔（分钟）')}
                  <input
                    type="number"
                    min="1"
                    value={minutes}
                    onChange={(e) => setMinutes(+e.target.value)}
                  />
                </label>
                <label>
                  {t('Maximum turns', '最多执行轮数')}
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={runs}
                    onChange={(e) => setRuns(+e.target.value)}
                  />
                </label>
                <label>
                  {t('Deadline from now (hours)', '多久后截止（小时）')}
                  <input
                    type="number"
                    min="1"
                    max="8784"
                    value={hours}
                    onChange={(e) => setHours(+e.target.value)}
                  />
                </label>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(executionWindow)}
                  onChange={(e) =>
                    setExecutionWindow(
                      e.target.checked
                        ? {
                            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                            start: '08:00',
                            end: '23:00',
                            weekdays: [0, 1, 2, 3, 4, 5, 6],
                          }
                        : null,
                    )
                  }
                />
                {t('Only run in an allowed time window', '只在允许时段执行')}
              </label>
              {executionWindow && (
                <div className="form-grid">
                  <label>
                    {t('Time zone', '时区')}
                    <input
                      value={executionWindow.timeZone}
                      onChange={(e) =>
                        setExecutionWindow({ ...executionWindow, timeZone: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t('Start', '开始')}
                    <input
                      type="time"
                      value={executionWindow.start}
                      onChange={(e) =>
                        setExecutionWindow({ ...executionWindow, start: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t('End', '结束')}
                    <input
                      type="time"
                      value={executionWindow.end}
                      onChange={(e) =>
                        setExecutionWindow({ ...executionWindow, end: e.target.value })
                      }
                    />
                  </label>
                  <div>
                    {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={executionWindow.weekdays.includes(day)}
                          onChange={(e) =>
                            setExecutionWindow({
                              ...executionWindow,
                              weekdays: e.target.checked
                                ? [...executionWindow.weekdays, day]
                                : executionWindow.weekdays.filter((d: number) => d !== day),
                            })
                          }
                        />
                        {t(
                          ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day],
                          ['日', '一', '二', '三', '四', '五', '六'][day],
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <button
                disabled={!objective.trim() || !success.trim()}
                onClick={() =>
                  void act(async () => {
                    await api(
                      editing ? '/personal/goals/' + editing.id : '/personal/goals',
                      {
                        executionWindow,
                        ...(editing ? { revision: editing.revision || 0 } : {}),
                        title: objective.slice(0, 100),
                        objective,
                        success,
                        intervalMs: minutes * 60000,
                        maxRuns: runs,
                        endAt: Math.round(Date.now() + hours * 3600000),
                      },
                      editing ? 'PATCH' : 'POST',
                    );
                    setEditing(null);
                    setExecutionWindow(null);
                    setObjective('');
                    setSuccess('');
                  })
                }
              >
                {editing ? t('Save changes', '保存目标修改') : t('Start goal', '启动目标')}
              </button>
            </section>
            {editing && (
              <button
                onClick={() => {
                  setEditing(null);
                  setObjective('');
                  setSuccess('');
                }}
              >
                {t('Cancel editing', '取消编辑')}
              </button>
            )}
            {data.goals.map((g: any) => (
              <section className="panel" key={g.id}>
                <h2>{g.title}</h2>
                <p>{g.objective}</p>
                <p>
                  {t('Completion criteria: ', '完成标准：')}
                  {g.success}
                </p>
                {g.progress && (
                  <details>
                    <summary>
                      {t('Milestones and checkpoint', '里程碑与进展记录')} ·{' '}
                      {t('Agent-reported', '助手报告')}
                    </summary>
                    <p>{g.progress.summary}</p>
                    <p>
                      {t('Next: ', '下一步：')}
                      {g.progress.nextAction}
                    </p>
                    {g.progress.blockers?.map((b: string, i: number) => (
                      <p key={i}>
                        {t('Blocked: ', '阻塞：')}
                        {b}
                      </p>
                    ))}
                    <ol>
                      {g.progress.milestones?.map((m: any, i: number) => (
                        <li key={i}>
                          {m.title} · {m.status}
                          <p>{m.evidence}</p>
                        </li>
                      ))}
                    </ol>
                    <small>
                      {t('Revision ', '修订 ')}
                      {g.progress.revision} · {new Date(g.progress.updatedAt).toLocaleString()}
                    </small>
                  </details>
                )}
                <button
                  disabled={Boolean(g.task?.runId)}
                  onClick={() => {
                    setEditing(g);
                    setExecutionWindow(g.executionWindow || null);
                    setObjective(g.objective);
                    setSuccess(g.success);
                    setMinutes(g.intervalMs / 60000);
                    setRuns(g.maxRuns);
                    setHours(Math.max(1, Math.ceil((g.endAt - Date.now()) / 3600000)));
                  }}
                >
                  {t('Edit this goal', '修改此目标')}
                </button>
                <p>
                  {g.task?.status} · {g.task?.dispatchCount || 0}/{g.maxRuns} ·{' '}
                  {new Date(g.endAt).toLocaleString()}
                </p>
                {g.task?.enabled && (
                  <p>
                    {t('Next check: ', '下次检查：')}
                    {new Date(g.task.deferredUntil || g.task.dueAt).toLocaleString()}
                  </p>
                )}
                {g.task?.error && <p role="alert">{g.task.error}</p>}
                {(['pause', 'resume', 'wake'] as const).map((action) => (
                  <button
                    key={action}
                    onClick={() =>
                      void act(() =>
                        api(`/personal/goals/${g.id}/action`, {
                          action,
                          eventId: crypto.randomUUID(),
                        }),
                      )
                    }
                  >
                    {
                      {
                        pause: t('Pause future turns', '暂停后续执行'),
                        resume: t('Resume', '恢复'),
                        wake: t('Check now', '现在检查'),
                      }[action]
                    }
                  </button>
                ))}
                <button onClick={() => openChat(g.conversationId)}>
                  {t('View progress', '查看进展')}
                </button>
              </section>
            ))}
            <section className="panel">
              <h2>{t('Pair a phone', '配对手机')}</h2>
              <p>
                {t(
                  'Use an HTTPS reverse proxy or private network tunnel to this separate gateway. Do not forward the local admin port. Pairing codes expire in five minutes.',
                  '将 HTTPS 反向代理或私人组网隧道指向这个独立入口；不要转发本地管理端口。配对码五分钟后失效。',
                )}
              </p>
              <button onClick={() => void act(() => api('/personal/gateway/start', {}))}>
                {t('Start device gateway', '启动设备连接入口')}
              </button>
              {data.gateway.address && (
                <p>
                  {t('Tunnel target', '隧道目标')}：<code>{data.gateway.address}</code>
                </p>
              )}
              {data.gateway.publicUrl && <p>HTTPS：{data.gateway.publicUrl}</p>}
              {data.gateway.error && <p role="alert">{data.gateway.error}</p>}
              <label>
                {t('Device name', '设备名称')}
                <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={approval}
                  onChange={(e) => setApproval(e.target.checked)}
                />
                {t(
                  'Allow this phone to answer agent approval requests',
                  '允许手机处理 Agent 的权限审批',
                )}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={control}
                  onChange={(e) => setControl(e.target.checked)}
                />
                {t('Allow approved agent actions on this phone', '允许 Agent 经审批后操作这台手机')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={workspace}
                  onChange={(e) => setWorkspace(e.target.checked)}
                />
                {t(
                  'Allow workspace conversations, projects and memory management',
                  '允许访问工作区会话、项目与记忆管理',
                )}
              </label>
              <button
                onClick={() =>
                  void act(async () =>
                    setInvite(
                      await api('/personal/invites', {
                        name: deviceName,
                        scopes: [
                          'read',
                          'message',
                          'stop',
                          'goals',
                          ...(approval ? ['approve'] : []),
                          ...(control ? ['device-control'] : []),
                          ...(workspace ? ['workspace'] : []),
                        ],
                      }),
                    ),
                  )
                }
              >
                {t('Generate pairing code', '生成配对码')}
              </button>
              {invite && (
                <p>
                  <code>{invite.code}</code> · {new Date(invite.expiresAt).toLocaleTimeString()}
                </p>
              )}
            </section>
            {data.devices.map((d: any) => (
              <section className="panel" key={d.id}>
                <h3>{d.name}</h3>
                <p>
                  {d.revokedAt
                    ? t('Revoked', '已撤销')
                    : d.lastSeenAt
                      ? new Date(d.lastSeenAt).toLocaleString()
                      : t('Not connected yet', '尚未连接')}
                </p>
                <p>{d.capabilities?.join(', ')}</p>
                <label>
                  <input
                    type="checkbox"
                    disabled={!!d.revokedAt}
                    checked={d.scopes.includes('workspace')}
                    onChange={(e) =>
                      void act(() =>
                        api(`/personal/devices/${d.id}/scopes`, {
                          scopes: e.target.checked
                            ? [...d.scopes, 'workspace']
                            : d.scopes.filter((scope: string) => scope !== 'workspace'),
                        }),
                      )
                    }
                  />
                  {t('Workspace conversations, projects and memory', '工作区会话、项目与记忆')}
                </label>
                <button
                  disabled={!!d.revokedAt}
                  onClick={() => void act(() => api(`/personal/devices/${d.id}/revoke`, {}))}
                >
                  {t('Revoke device', '撤销设备')}
                </button>
              </section>
            ))}
          </>
        )}
      </fieldset>
    </div>
  );
}
