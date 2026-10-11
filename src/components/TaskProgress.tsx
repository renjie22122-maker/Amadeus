import { useState, useId } from 'react';
import { ChevronUp, ChevronDown, ListChecks, ArrowUpRight } from 'lucide-react';
import type { ConversationDetail, RunView } from '../types';
export function TaskProgress({
  detail,
  run,
  zh,
  onInspect,
}: {
  detail: ConversationDetail;
  run?: RunView;
  zh: boolean;
  onInspect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    panelId = useId();
  const board = detail.taskBoard;
  if (!board?.tasks.length) return null;
  const tasks = board.tasks,
    done = tasks.filter((t) => t.status === 'done').length;
  const active = tasks.find((t) => t.status === 'running'),
    blocked = tasks.filter((t) => t.status === 'blocked');
  const running = tasks.filter((t) => t.status === 'running').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const delivered = new Set(
    detail.events.filter((e) => e.type === 'user.delivered').flatMap((e) => e.data.eventIds || []),
  );
  const queued = detail.events.filter(
    (e) =>
      e.runId === run?.id && e.type === 'user.message' && e.data.steering && !delivered.has(e.id),
  ).length;
  const waiting = detail.inputs.some((i) => i.status === 'pending');
  const label = waiting
    ? zh
      ? '等待你的处理'
      : 'Needs your input'
    : run?.status === 'interrupted'
      ? zh
        ? '任务已中断'
        : 'Interrupted'
      : run?.status === 'failed'
        ? zh
          ? '运行失败'
          : 'Run failed'
        : blocked.length
          ? zh
            ? '有任务受阻'
            : 'Tasks blocked'
          : active?.title ||
            (done === tasks.length
              ? zh
                ? '任务均已提交'
                : 'All tasks reported done'
              : zh
                ? '任务计划'
                : 'Task plan');
  const status = (s: string) =>
    ({
      pending: zh ? '待开始' : 'Pending',
      running: zh ? '进行中' : 'Working',
      done: zh ? '已提交' : 'Reported done',
      blocked: zh ? '受阻' : 'Blocked',
    })[s] || s;
  return (
    <section
      className="task-progress"
      aria-label={zh ? '任务进度' : 'Task progress'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false);
          document.getElementById(panelId + '-toggle')?.focus();
        }
      }}
    >
      {open && (
        <div className="task-progress-panel" id={panelId}>
          <header>
            <strong>{zh ? '任务计划' : 'Task plan'}</strong>
            <small>
              {zh ? '版本' : 'Revision'} {board.revision}
            </small>
          </header>
          <p className="muted">
            {zh
              ? '数量表示执行者提交状态，不代表工作量百分比或独立验收通过。'
              : 'Counts reflect reported completion, not effort percentage or independent acceptance.'}
          </p>
          <ol>
            {tasks.map((task) => {
              const member = detail.teamMembers?.find((m) => m.runId === task.owner);
              const deps = task.dependsOn.filter(
                (id) =>
                  tasks.find((t) => t.id === id)?.status !== 'done' ||
                  tasks.find((t) => t.id === id)?.verification?.status === 'stale',
              );
              const verification =
                task.verification?.status === 'stale'
                  ? zh
                    ? '证据已过期'
                    : 'Evidence stale'
                  : task.verification?.status === 'checked'
                    ? zh
                      ? '已绑定版本证据'
                      : 'Version-bound evidence'
                    : zh
                      ? '未绑定版本证据'
                      : 'No version-bound evidence';
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className="task-progress-item"
                    onClick={() => {
                      onInspect(task.id);
                      setOpen(false);
                    }}
                  >
                    <span className={'task-progress-dot ' + task.status} />
                    <span className="task-progress-copy">
                      <strong>{task.title}</strong>
                      <small>
                        {status(task.status)} ·{' '}
                        {task.owner
                          ? member?.role === 'lead'
                            ? zh
                              ? '主 Agent'
                              : 'Lead'
                            : (zh ? '成员 ' : 'Worker ') + task.owner.slice(-6)
                          : zh
                            ? '待分配'
                            : 'Unassigned'}
                        {member?.status === 'waiting_approval'
                          ? zh
                            ? ' · 等待授权'
                            : ' · Awaiting approval'
                          : member?.status === 'waiting_user'
                            ? zh
                              ? ' · 等待回答'
                              : ' · Awaiting answer'
                            : ''}
                      </small>
                      {!!deps.length && (
                        <small>
                          {zh ? '等待依赖：' : 'Waiting for: '}
                          {deps.map((id) => tasks.find((t) => t.id === id)?.title || id).join(', ')}
                        </small>
                      )}
                      {task.status === 'done' && <small>{verification}</small>}
                      {task.status === 'blocked' && task.note && <small>{task.note}</small>}
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <div className="task-progress-counts" role="status" aria-live="polite">
        <span>
          {zh ? '已提交' : 'Reported done'} {done}
        </span>
        <span>
          {zh ? '进行中' : 'Working'} {running}
        </span>
        <span>
          {zh ? '待开始' : 'Pending'} {pending}
        </span>
        {blocked.length > 0 && (
          <span>
            {zh ? '受阻' : 'Blocked'} {blocked.length}
          </span>
        )}
        {queued > 0 && (
          <span>
            {zh ? '新消息待接收' : 'New messages queued'} {queued}
          </span>
        )}
      </div>
      <button
        type="button"
        className="task-progress-toggle"
        id={panelId + '-toggle'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        <ListChecks size={16} />
        <span className="task-progress-current">{label}</span>
        <small>
          {done}/{tasks.length} {zh ? '项已提交' : 'reported'}
        </small>
        {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
    </section>
  );
}
