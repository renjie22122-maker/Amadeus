import { useEffect, useState } from 'react';
import { api } from '../api';
export function BackgroundPage({ state, zh, notify, openConversation }: any) {
  const [data, setData] = useState<any>({
    schedules: [],
    knowledge: [],
    memory: [],
    commands: [],
    teams: [],
    graphs: [],
    evaluations: [],
    skills: [],
  });
  const [chat, setChat] = useState(state.conversations[0]?.id || ''),
    [prompt, setPrompt] = useState(''),
    [when, setWhen] = useState(''),
    [minutes, setMinutes] = useState(''),
    [job, setJob] = useState('');
  const load = () => api('/background').then(setData);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api('/background', undefined, undefined, {}, controller.signal);
        if (!controller.signal.aborted) setData(value);
      } catch (e: any) {
        if (!controller.signal.aborted) notify(e.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const act = async (fn: () => Promise<any>) => {
    try {
      await fn();
      await load();
    } catch (e: any) {
      notify(e.message);
    }
  };
  return (
    <div className="page">
      <h1>{zh ? '后台任务' : 'Background work'}</h1>
      <section className="panel">
        <h3>{zh ? '稍后继续 / 定时执行' : 'Continue later / scheduled work'}</h3>
        <select
          aria-label="Conversation"
          value={chat}
          onChange={(e) => {
            setChat(e.target.value);
            setJob('');
          }}
        >
          {state.conversations
            .filter((c: any) => !c.archived)
            .map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
        </select>
        <textarea
          aria-label="Task"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            zh
              ? '届时执行的任务；继续使用此对话的权限'
              : 'Task to execute using this conversation’s permissions'
          }
        />
        <label>
          {zh ? '本地时间（留空立即）' : 'Local time (blank: now)'}
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <label>
          {zh ? '重复间隔（分钟，留空一次）' : 'Repeat every minutes (blank: once)'}
          <input
            type="number"
            min="1"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <label>
          {zh ? '等待此命令完成（可选）' : 'Wait for command completion (optional)'}
          <select value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="">—</option>
            {data.commands
              .filter((j: any) => j.conversationId === chat)
              .map((j: any) => (
                <option key={j.id} value={j.id}>
                  {j.id} · {j.status}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!chat || !prompt}
          onClick={() =>
            act(() =>
              api('/scheduled-work', {
                conversationId: chat,
                prompt,
                dueAt: when ? new Date(when).getTime() : Date.now(),
                intervalMs: minutes ? Number(minutes) * 60000 : undefined,
                jobId: job || undefined,
              }),
            )
          }
        >
          {zh ? '创建任务' : 'Create schedule'}
        </button>
        <p className="muted">
          {zh
            ? '需保持服务运行。错过的周期不会突发补跑；未知副作用不会自动重放。暂停不会中止已启动的任务。'
            : 'Keep the service running. Missed intervals coalesce; unknown effects are never replayed. Pausing does not stop a dispatched run.'}
        </p>
      </section>
      {data.schedules.map((s: any) => (
        <article className="panel" key={s.id}>
          <strong>{s.prompt}</strong>
          <p>
            {s.status} · {s.error || new Date(s.dueAt).toLocaleString()}
          </p>
          <button
            onClick={() =>
              act(() => api('/scheduled-work/' + s.id, { enabled: !s.enabled }, 'PATCH'))
            }
          >
            {s.enabled ? (zh ? '暂停' : 'Pause') : zh ? '启用' : 'Enable'}
          </button>
          <button onClick={() => act(() => api('/scheduled-work/' + s.id, undefined, 'DELETE'))}>
            {zh ? '移除计划' : 'Remove schedule'}
          </button>
        </article>
      ))}
      {(
        ['knowledge', 'memory', 'commands', 'teams', 'graphs', 'evaluations', 'skills'] as const
      ).map((kind) => (
        <section className="panel" key={kind}>
          <h3>{kind}</h3>
          {data[kind].slice(-30).map((x: any) => (
            <details key={x.id}>
              <summary>
                {x.scope || x.id} · {x.status}
              </summary>
              <p>{x.error || x.reason || ''}</p>
              {x.diagnosis && (
                <div role="status">
                  <strong>{zh ? x.diagnosis.titleZh : x.diagnosis.title}</strong>
                  <p>{zh ? x.diagnosis.actionZh : x.diagnosis.action}</p>
                </div>
              )}
              {kind === 'knowledge' && x.status === 'needs_attention' && (
                <button onClick={() => act(() => api('/background/recheck', { scope: x.id }))}>
                  {zh ? '修复后重新检查' : 'Recheck after repair'}
                </button>
              )}
              {kind === 'skills' && x.status === 'needs_attention' && (
                <button
                  onClick={() =>
                    act(async () => {
                      const result = await api('/background/repair-skill', { id: x.id });
                      openConversation?.(result.conversationId);
                      notify(
                        zh
                          ? '已在原对话启动诊断；必要操作仍需审批。'
                          : 'Diagnosis started in the original conversation; required approvals still apply.',
                      );
                    })
                  }
                >
                  {zh ? '让 Agent 诊断并协助修复' : 'Ask Agent to diagnose and repair'}
                </button>
              )}

              {x.nextRetryAt && (
                <p>
                  {zh ? '下次自动尝试：' : 'Next attempt: '}
                  {new Date(x.nextRetryAt).toLocaleString()}
                </p>
              )}
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
