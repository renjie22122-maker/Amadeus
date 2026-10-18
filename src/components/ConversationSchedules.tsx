import { Clock3, Plus, Pause, Play, Settings2, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ScheduledTasks } from '../pages/ScheduledTasks';
export function ConversationSchedules({
  conversationId,
  state,
  zh,
  notify,
  openConversation,
}: any) {
  const [data, setData] = useState<any>({ schedules: [], commands: [] });
  const [error, setError] = useState('');
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const url = '/conversation-schedules?conversationId=' + encodeURIComponent(conversationId);
  const load = async () => {
    const next = await api(url);
    setData(next);
    setError('');
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api(url, undefined, undefined, {}, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (e: any) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url]);
  const status = (task: any) => {
    const labels: Record<string, string[]> = {
      running: ['运行中', 'Running'],
      dispatching: ['启动中', 'Starting'],
      waiting: ['已安排', 'Scheduled'],
      paused: ['已暂停', 'Paused'],
      completed: ['已完成', 'Completed'],
      needs_attention: ['需要处理', 'Needs attention'],
      limit_reached: ['已到停止条件', 'Limit reached'],
    };
    return labels[task.status]?.[zh ? 0 : 1] || task.status;
  };
  const toggle = async (task: any) => {
    setBusy(task.id);
    try {
      await api('/scheduled-work/' + task.id, { enabled: !task.enabled }, 'PATCH');
      await load();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="conversation-schedules">
      {error && <p role="status">{error}</p>}
      <div className="chat-schedule-heading">
        <span>
          <Clock3 size={14} />
          {zh ? '定时任务' : 'Scheduled tasks'}
          {data.schedules.length > 0 && (
            <span className="chat-schedule-count">{data.schedules.length}</span>
          )}
        </span>
        <button
          className="chat-schedule-manage"
          aria-expanded={manage}
          onClick={() => setManage(!manage)}
        >
          {manage ? (
            <ChevronRight size={14} style={{ transform: 'rotate(90deg)' }} />
          ) : data.schedules.length ? (
            <Settings2 size={14} />
          ) : (
            <Plus size={14} />
          )}
          {manage
            ? zh
              ? '收起'
              : 'Close'
            : data.schedules.length
              ? zh
                ? '管理'
                : 'Manage'
              : zh
                ? '添加'
                : 'Add'}
        </button>
      </div>
      {!manage && (
        <div className="chat-schedule-list">
          {data.schedules.map((task: any) => (
            <article className="chat-schedule-card" key={task.id}>
              <span className="chat-schedule-icon">
                <Clock3 size={18} />
              </span>
              <div className="chat-schedule-copy">
                <strong title={task.name || task.prompt}>{task.name || task.prompt}</strong>
                <div className="chat-schedule-meta">
                  <span
                    className={task.status === 'needs_attention' ? 'chat-schedule-attention' : ''}
                  >
                    {status(task)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {task.runId
                      ? zh
                        ? '正在处理本次任务'
                        : 'Processing this run'
                      : !task.enabled
                        ? zh
                          ? '暂无后续运行'
                          : 'No upcoming run'
                        : task.jobId
                          ? zh
                            ? '命令完成后'
                            : 'After command completion'
                          : (zh ? '下次 ' : 'Next ') +
                            new Date(task.dueAt).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                  </span>
                </div>
              </div>
              <div className="chat-schedule-controls">
                <button
                  title={task.enabled ? (zh ? '暂停' : 'Pause') : zh ? '启用' : 'Enable'}
                  aria-label={task.enabled ? (zh ? '暂停' : 'Pause') : zh ? '启用' : 'Enable'}
                  disabled={
                    busy === task.id ||
                    (!task.enabled && task.status === 'needs_attention' && !!task.runId)
                  }
                  onClick={() => void toggle(task)}
                >
                  {task.enabled ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button
                  title={zh ? '详情与设置' : 'Details and settings'}
                  aria-label={zh ? '详情与设置' : 'Details and settings'}
                  onClick={() => setManage(true)}
                >
                  <Settings2 size={15} />
                </button>
                {task.runId && (
                  <button
                    title={zh ? '查看执行对话' : 'Open run conversation'}
                    aria-label={zh ? '查看执行对话' : 'Open run conversation'}
                    onClick={() => openConversation(task.runConversationId || task.conversationId)}
                  >
                    <ChevronRight size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {manage && (
        <div className="chat-schedule-editor">
          <ScheduledTasks
            state={state}
            schedules={data.schedules}
            commands={data.commands}
            conversationId={conversationId}
            zh={zh}
            notify={notify}
            reload={load}
            openConversation={openConversation}
          />
        </div>
      )}
    </section>
  );
}
