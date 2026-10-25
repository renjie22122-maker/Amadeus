import { ScheduledTasks } from './ScheduledTasks';
import { useEffect, useState } from 'react';
import { api } from '../api';
export function BackgroundPage({ state, zh, notify, openConversation }: any) {
  const [mcpResults, setMcpResults] = useState<Record<string, unknown>>({});
  const [data, setData] = useState<any>({
    schedules: [],
    knowledge: [],
    memory: [],
    commands: [],
    mcp: [],
    teams: [],
    graphs: [],
    evaluations: [],
    skills: [],
  });
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
      <ScheduledTasks
        state={state}
        schedules={data.schedules}
        commands={data.commands}
        zh={zh}
        notify={notify}
        reload={load}
        openConversation={openConversation}
      />
      <section className="panel">
        <h3>{zh ? 'MCP 后台调用' : 'Background MCP calls'}</h3>
        {(data.mcp || []).slice(-30).map((job: any) => (
          <details key={job.id}>
            <summary>
              {job.tool} · {job.status}
            </summary>
            <p>{job.note || ''}</p>
            {job.remoteTask && (
              <p>
                {job.remoteTask.taskId} · {job.remoteTask.status}
              </p>
            )}
            <button onClick={() => openConversation?.(job.conversationId)}>
              {zh ? '打开对话' : 'Open conversation'}
            </button>{' '}
            <button
              onClick={() =>
                act(async () => {
                  const receipt = await api(
                    '/mcp/jobs/' +
                      encodeURIComponent(job.conversationId) +
                      '/' +
                      encodeURIComponent(job.id),
                  );
                  setMcpResults((old) => ({ ...old, [job.id]: receipt.result }));
                })
              }
            >
              {zh ? '查看结果' : 'Inspect result'}
            </button>{' '}
            {job.status === 'running' && (
              <button
                onClick={() =>
                  act(() =>
                    api(
                      '/mcp/jobs/' +
                        encodeURIComponent(job.conversationId) +
                        '/' +
                        encodeURIComponent(job.id) +
                        '/cancel',
                      {},
                    ),
                  )
                }
              >
                {zh ? '请求取消' : 'Request cancellation'}
              </button>
            )}
            {mcpResults[job.id] !== undefined && (
              <pre>{JSON.stringify(mcpResults[job.id], null, 2)}</pre>
            )}
          </details>
        ))}
      </section>
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
