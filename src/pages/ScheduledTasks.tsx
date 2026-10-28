import { useEffect, useState } from 'react';
import { api } from '../api';
const timeInput = (n: number) => {
  const d = new Date(n);
  return new Date(n - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function ScheduledTasks({
  state,
  schedules,
  commands,
  zh,
  notify,
  reload,
  openConversation,
  conversationId,
}: any) {
  const resultsUrl =
    '/schedule-results' +
    (conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : '');
  const chats = state.conversations.filter(
    (c: any) =>
      !c.archived && !c.parentId && !c.isolationId && (!conversationId || c.id === conversationId),
  );
  const blank = () => ({
    id: '',
    name: '',
    prompt: '',
    conversationId: chats[0]?.id || '',
    when: '',
    repeat: 'once',
    every: '1',
    unit: '60000',
    destination: 'same-chat',
    notifications: 'meaningful',
    maxRuns: '',
    endAt: '',
    jobId: '',
    trigger: 'time',
    windowEnabled: false,
    windowZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    windowStart: '09:00',
    windowEnd: '18:00',
    windowDays: [0, 1, 2, 3, 4, 5, 6],
  });
  const [form, setForm] = useState(blank),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [results, setResults] = useState<any[]>([]);
  const tr = (a: string, b: string) => (zh ? a : b);
  const field = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  useEffect(() => {
    let closed = false;
    const load = () =>
      api(resultsUrl)
        .then((v) => {
          if (!closed) setResults(v);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [resultsUrl]);
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      setResults(await api(resultsUrl));
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (s: any, copy = false) => {
    setForm({
      windowEnabled: !!s.executionWindow,
      windowZone: s.executionWindow?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      windowStart: s.executionWindow?.start || '09:00',
      windowEnd: s.executionWindow?.end || '18:00',
      windowDays: s.executionWindow?.weekdays || [0, 1, 2, 3, 4, 5, 6],
      id: copy ? '' : s.id,
      name: s.name || '',
      prompt: s.prompt,
      conversationId: s.conversationId,
      when: timeInput(copy ? Date.now() + 60000 : s.dueAt),
      repeat: s.intervalMs ? 'interval' : 'once',
      every: String((s.intervalMs || 60000) / 60000),
      unit: '60000',
      destination: s.destination || 'same-chat',
      notifications: s.notifications || 'all',
      jobId: s.jobId || '',
      trigger: s.jobId ? 'command' : 'time',
      maxRuns: s.maxRuns ? String(s.maxRuns) : '',
      endAt: s.endAt ? timeInput(s.endAt) : '',
    });
    setEditing(true);
  };
  const status = (s: string) =>
    ({
      waiting_window: tr('等待允许时段 · 未调用模型', 'Waiting for allowed hours · no model call'),
      waiting: tr('已安排', 'Scheduled'),
      limit_reached: tr('已到停止条件', 'Launch limit reached'),
      running: tr('运行中', 'Running'),
      dispatching: tr('启动中', 'Starting'),
      paused: tr('已暂停', 'Paused'),
      completed: tr('已完成', 'Completed'),
      needs_attention: tr('需要处理', 'Needs attention'),
      interrupted: tr('已中断', 'Interrupted'),
      failed: tr('失败', 'Failed'),
      cancelled: tr('已取消', 'Cancelled'),
    })[s] || s;
  return (
    <section className="schedule-section">
      <header className="schedule-heading">
        <div>
          <h2>{tr('定时任务', 'Scheduled tasks')}</h2>
          <p className="muted">
            {tr(
              '安排稍后继续，或定期检查。结果与通知保留在这里。',
              'Continue later or check regularly. Results and notifications stay here.',
            )}
          </p>
        </div>
        <button
          onClick={() => {
            setForm(blank());
            setEditing(true);
          }}
        >
          {tr('＋ 新建任务', '＋ New task')}
        </button>
      </header>
      <div className="schedule-actions" aria-label={tr('快捷安排', 'Quick schedule')}>
        {[
          ['later', tr('稍后继续', 'Continue later')],
          ['review', tr('完成后检查', 'Review after completion')],
          ['monitor', tr('定期检查', 'Monitor')],
        ].map(([kind, label]) => (
          <button
            key={kind}
            onClick={() => {
              const draft = blank();
              setForm({
                ...draft,
                name: label,
                trigger: kind === 'review' ? 'command' : 'time',
                when: timeInput(Date.now() + (kind === 'later' ? 30 * 60000 : 0)),
                repeat: kind === 'monitor' ? 'interval' : 'once',
                every: '30',
                maxRuns: kind === 'monitor' ? '8' : '',
                prompt:
                  kind === 'review'
                    ? tr(
                        '检查所选后台任务的实际输出，按本对话验收要求核实；未通过时不要启动依赖步骤，报告问题和下一步。',
                        'Inspect actual outputs of the selected job against this conversation’s acceptance criteria. Do not launch dependent steps on failed review; report findings and next steps.',
                      )
                    : '',
              });
              setEditing(true);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {results.some((r) => r.unread) && (
        <details className="panel" open>
          <summary>
            {tr('任务通知', 'Task notifications')} · {results.filter((r) => r.unread).length}
          </summary>
          {results
            .filter((r) => r.unread)
            .map((r) => (
              <div className="schedule-result" key={r.id}>
                {r.summary && <p>{r.summary}</p>}
                {r.error && <p role="status">{r.error}</p>}
                <button onClick={() => openConversation(r.conversationId)}>
                  {r.name} · {status(r.status)}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    act(() => api('/schedule-results/' + encodeURIComponent(r.id), {}, 'PATCH'))
                  }
                >
                  {tr('标为已读', 'Mark read')}
                </button>
              </div>
            ))}
        </details>
      )}
      {editing && (
        <form
          className="panel schedule-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const data: any = {
                executionWindow: form.windowEnabled
                  ? {
                      timeZone: form.windowZone,
                      start: form.windowStart,
                      end: form.windowEnd,
                      weekdays: form.windowDays,
                    }
                  : null,
                name: form.name,
                prompt: form.prompt,
                dueAt: form.when ? new Date(form.when).getTime() : Date.now(),
                intervalMs: form.repeat === 'once' ? null : Number(form.every) * Number(form.unit),
                destination: form.destination,
                notifications: form.notifications,
                jobId: form.jobId || null,
                maxRuns: form.maxRuns ? Number(form.maxRuns) : null,
                endAt: form.endAt ? new Date(form.endAt).getTime() : null,
              };
              if (!form.id) data.conversationId = form.conversationId;
              await api(
                '/scheduled-work' + (form.id ? '/' + form.id : ''),
                data,
                form.id ? 'PATCH' : 'POST',
              );
              setEditing(false);
            });
          }}
        >
          <h3>{form.id ? tr('编辑任务', 'Edit task') : tr('新建任务', 'New task')}</h3>
          <label>
            {tr('名称', 'Name')}
            <input
              maxLength={120}
              value={form.name}
              onChange={(e) => field('name', e.target.value)}
              placeholder={tr('例如：检查下载进度', 'Example: check download progress')}
            />
          </label>
          <label>
            {tr('执行内容', 'Instructions')}
            <textarea
              required
              maxLength={10000}
              rows={5}
              value={form.prompt}
              onChange={(e) => field('prompt', e.target.value)}
            />
          </label>
          <div className="schedule-options">
            <label>
              {tr('运行位置／继承设置', 'Run in / inherit settings')}
              <select
                required
                disabled={!!form.id}
                value={form.conversationId}
                onChange={(e) => {
                  field('conversationId', e.target.value);
                  field('jobId', '');
                }}
              >
                <option value="">{tr('选择对话', 'Choose conversation')}</option>
                {chats.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {state.projects?.find((p: any) => p.id === c.projectId)?.name ||
                      tr('普通对话', 'General')}{' '}
                    · {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr('首次运行（本机时间）', 'First run (local time)')}
              <input
                type="datetime-local"
                value={form.when}
                onChange={(e) => field('when', e.target.value)}
              />
            </label>
            <label>
              {tr('重复', 'Repeat')}
              <select
                aria-label={tr('重复', 'Repeat')}
                value={form.repeat}
                onChange={(e) => field('repeat', e.target.value)}
              >
                <option value="once">{tr('仅一次', 'Once')}</option>
                <option value="interval">{tr('固定间隔', 'Fixed interval')}</option>
              </select>
            </label>
            {form.repeat === 'interval' && (
              <label>
                {tr('每隔', 'Every')}
                <div className="schedule-inline">
                  <input
                    aria-label="Interval"
                    step="any"
                    required
                    type="number"
                    min="1"
                    max={Math.floor((366 * 86400000) / Number(form.unit))}
                    value={form.every}
                    onChange={(e) => field('every', e.target.value)}
                  />
                  <select
                    aria-label="Interval unit"
                    value={form.unit}
                    onChange={(e) => field('unit', e.target.value)}
                  >
                    <option value="60000">{tr('分钟', 'minutes')}</option>
                    <option value="3600000">{tr('小时', 'hours')}</option>
                    <option value="86400000">{tr('天（24小时）', 'days (24 hours)')}</option>
                    <option value="604800000">{tr('周（7天）', 'weeks (7 days)')}</option>
                  </select>
                </div>
              </label>
            )}
            <label>
              {tr('通知', 'Notifications')}
              <select
                aria-label={tr('通知', 'Notifications')}
                value={form.notifications}
                onChange={(e) => field('notifications', e.target.value)}
              >
                <option value="all">{tr('每次结束时通知', 'Every finished run')}</option>
                <option value="meaningful">
                  {tr('有变化、完成或异常', 'Changes, completion or errors')}
                </option>
                <option value="failures">
                  {tr('仅失败或需要处理', 'Only failures / attention')}
                </option>
                <option value="off">{tr('静默，保留运行记录', 'Silent, keep history')}</option>
              </select>
            </label>
            <label>
              {tr('触发条件', 'Trigger')}
              <select
                value={form.trigger}
                onChange={(e) => {
                  field('trigger', e.target.value);
                  if (e.target.value === 'time') field('jobId', '');
                }}
              >
                <option value="time">{tr('到达设定时间', 'Scheduled time')}</option>
                <option value="command">
                  {tr('到达时间且后台命令完成', 'Scheduled time and command completed')}
                </option>
              </select>
              {tr('关联后台命令', 'Background command')}
              <select
                required={form.trigger === 'command'}
                disabled={form.trigger !== 'command'}
                value={form.jobId}
                onChange={(e) => field('jobId', e.target.value)}
              >
                <option value="">{tr('不等待', 'None')}</option>
                {commands
                  .filter((j: any) => j.conversationId === form.conversationId)
                  .map((j: any) => (
                    <option key={j.id} value={j.id}>
                      {j.command || j.id} · {j.status}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="schedule-options">
            <label>
              {tr('最多自动启动次数（留空不限）', 'Maximum launches (blank: unlimited)')}
              <input
                type="number"
                min="1"
                max="10000"
                value={form.maxRuns}
                onChange={(e) => field('maxRuns', e.target.value)}
              />
            </label>
            <label>
              {tr('停止安排新运行的时间（可选）', 'Stop launching after (optional)')}
              <input
                type="datetime-local"
                value={form.endAt}
                onChange={(e) => field('endAt', e.target.value)}
              />
            </label>
          </div>
          <p className="muted">
            {tr(
              '完成后检查：请在上方选择后台命令。限制只阻止新运行，不中止已启动任务；达到限制不代表验收通过。',
              'For completion review, select a command above. Limits prevent new launches, not active work; reaching a limit is not verification success.',
            )}
          </p>
          <fieldset>
            <legend>
              {tr('宿主运行条件（调用模型前检查）', 'Host conditions (before model calls)')}
            </legend>
            <label>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={form.windowEnabled}
                onChange={(e) => setForm((f) => ({ ...f, windowEnabled: e.target.checked }))}
              />
              {tr('仅在允许时段运行', 'Run only during allowed hours')}
            </label>
            {form.windowEnabled && (
              <>
                <label>
                  {tr('时区（IANA）', 'Time zone (IANA)')}
                  <input
                    required
                    value={form.windowZone}
                    onChange={(e) => field('windowZone', e.target.value)}
                    placeholder="Asia/Shanghai"
                  />
                </label>
                <div className="schedule-fields">
                  <label>
                    {tr('开始（包含）', 'Start (inclusive)')}
                    <input
                      type="time"
                      required
                      value={form.windowStart}
                      onChange={(e) => field('windowStart', e.target.value)}
                    />
                  </label>
                  <label>
                    {tr('结束（不包含）', 'End (exclusive)')}
                    <input
                      type="time"
                      required
                      value={form.windowEnd}
                      onChange={(e) => field('windowEnd', e.target.value)}
                    />
                  </label>
                </div>
                <div className="schedule-actions">
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={form.windowDays.includes(day)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            windowDays: e.target.checked
                              ? [...f.windowDays, day]
                              : f.windowDays.filter((d: number) => d !== day),
                          }))
                        }
                      />
                      {
                        (zh
                          ? ['日', '一', '二', '三', '四', '五', '六']
                          : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[day]
                      }
                    </label>
                  ))}
                </div>
                <p className="muted">
                  {tr(
                    '时段外自动延后，不调用模型、不消耗启动次数；跨午夜按开始日计，相同起止表示全天。错过的触发合并一次，不积压补跑。此条件限制启动，不强制中断已开始的工作。',
                    'Outside these hours, defer without model calls or launch usage. Overnight windows belong to the starting day; equal endpoints mean all day. Missed triggers coalesce. This limits starts, not work already running.',
                  )}
                </p>
              </>
            )}
          </fieldset>
          <fieldset className="schedule-destinations">
            <legend>{tr('对话方式', 'Conversation mode')}</legend>
            {['same-chat', 'new-chat'].map((mode) => (
              <label key={mode} className={form.destination === mode ? 'selected' : ''}>
                <input
                  type="radio"
                  name="destination"
                  value={mode}
                  checked={form.destination === mode}
                  onChange={() => field('destination', mode)}
                />
                <strong>
                  {mode === 'same-chat'
                    ? tr('在原对话继续', 'Continue in this chat')
                    : tr('每次新建对话', 'New chat for each run')}
                </strong>
                <small>
                  {mode === 'same-chat'
                    ? tr('可使用原对话上下文', 'Uses existing conversation context')
                    : tr(
                        '仅继承项目、模型和权限；不复制历史消息',
                        'Inherits project, model and permissions; no message history',
                      )}
                </small>
              </label>
            ))}
          </fieldset>
          <p className="muted">
            {tr(
              '服务和电脑需保持运行，执行会消耗模型额度。错过的周期合并为一次；失败不会自动重放。通知显示在应用内，关闭浏览器后可回来查看。',
              'Keep the computer and service running. Runs use model quota. Missed intervals coalesce; failures are not replayed. Notifications are in-app and remain available on return.',
            )}
          </p>
          <div className="schedule-actions">
            <button type="submit" disabled={busy || !form.conversationId}>
              {busy ? tr('保存中…', 'Saving…') : tr('保存任务', 'Save task')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {tr('取消', 'Cancel')}
            </button>
          </div>
        </form>
      )}
      <div className="schedule-grid">
        {schedules.map((s: any) => {
          const c = state.conversations.find((x: any) => x.id === s.conversationId);
          const history = results.filter((r) => r.scheduleId === s.id);
          return (
            <article className="panel schedule-card" key={s.id}>
              <header>
                <h3>{s.name || s.prompt.slice(0, 65)}</h3>
                <span className={'schedule-badge ' + (s.error ? 'attention' : '')}>
                  {status(s.status)}
                </span>
              </header>
              <p className="schedule-prompt">{s.prompt}</p>
              <dl>
                <dt>{tr('运行位置', 'Runs in')}</dt>
                <dd>{c?.title || tr('原对话不可用', 'Source unavailable')}</dd>
                <dt>{tr('触发', 'Trigger')}</dt>
                <dd>
                  {s.jobId
                    ? tr('等待关联后台命令完成', 'Wait for linked command completion')
                    : tr('按时间', 'By time')}
                </dd>
                <dt>{tr('已启动／上限', 'Launches / limit')}</dt>
                <dd>
                  {s.dispatchCount || 0} / {s.maxRuns || tr('不限', 'unlimited')}
                </dd>
                {s.endAt && (
                  <>
                    <dt>{tr('截止', 'Cutoff')}</dt>
                    <dd>{new Date(s.endAt).toLocaleString()}</dd>
                  </>
                )}
                <dt>{tr('频率', 'Repeat')}</dt>
                <dd>
                  {s.intervalMs
                    ? tr(
                        '每 ' + s.intervalMs / 60000 + ' 分钟',
                        'Every ' + s.intervalMs / 60000 + ' minutes',
                      )
                    : tr('仅一次', 'Once')}
                </dd>
                <dt>{tr('下次运行', 'Next run')}</dt>
                <dd>
                  {s.enabled
                    ? new Date(Math.max(s.dueAt, s.deferredUntil || 0)).toLocaleString()
                    : '—'}
                </dd>
                {s.executionWindow && (
                  <>
                    <dt>{tr('允许运行', 'Allowed hours')}</dt>
                    <dd>
                      {s.executionWindow.timeZone} · {s.executionWindow.start}–
                      {s.executionWindow.end} ·{' '}
                      {s.executionWindow.weekdays
                        .map(
                          (d: number) =>
                            (zh
                              ? ['日', '一', '二', '三', '四', '五', '六']
                              : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[d],
                        )
                        .join(', ')}
                    </dd>
                  </>
                )}
                {s.hostDeferredAt && (
                  <>
                    <dt>
                      {tr('最近宿主延后（无模型调用）', 'Last host deferral (no model call)')}
                    </dt>
                    <dd>{new Date(s.hostDeferredAt).toLocaleString()}</dd>
                  </>
                )}
                <dt>{tr('对话方式', 'Conversation')}</dt>
                <dd>
                  {s.destination === 'new-chat'
                    ? tr('每次新建', 'New each run')
                    : tr('原对话', 'Original chat')}
                </dd>
                <dt>{tr('通知', 'Notifications')}</dt>
                <dd>
                  {s.notifications === 'off'
                    ? tr('静默', 'Silent')
                    : s.notifications === 'meaningful'
                      ? tr('变化／完成／异常', 'Changes / completion / errors')
                      : s.notifications === 'failures'
                        ? tr('仅需处理', 'Attention only')
                        : tr('每次结束', 'Every finished run')}
                </dd>
              </dl>
              {s.error && <p role="alert">{s.error}</p>}
              <div className="schedule-actions">
                <button
                  disabled={busy || (!s.enabled && s.status === 'needs_attention' && !!s.runId)}
                  onClick={() =>
                    act(() => api('/scheduled-work/' + s.id, { enabled: !s.enabled }, 'PATCH'))
                  }
                >
                  {s.enabled ? tr('暂停', 'Pause') : tr('启用', 'Enable')}
                </button>
                <button disabled={!!s.runId} onClick={() => edit(s)}>
                  {tr('编辑', 'Edit')}
                </button>
                <button onClick={() => edit(s, true)}>{tr('复制', 'Duplicate')}</button>
                <button
                  disabled={busy || (!!s.runId && s.status !== 'needs_attention')}
                  onClick={() => act(() => api('/scheduled-work/' + s.id, undefined, 'DELETE'))}
                >
                  {tr('删除计划', 'Delete schedule')}
                </button>
              </div>
              {s.runId && (
                <button onClick={() => openConversation(s.runConversationId || s.conversationId)}>
                  {tr('查看当前／中断运行', 'Open current / interrupted run')}
                </button>
              )}
              {history.length > 0 && (
                <details>
                  <summary>
                    {tr('运行记录', 'Run history')} · {history.length}
                  </summary>
                  <div className="schedule-history">
                    {history.map((r) => (
                      <div className="schedule-result" key={r.id}>
                        {r.summary && <p>{r.summary}</p>}
                        {r.error && <p role="status">{r.error}</p>}
                        <button onClick={() => openConversation(r.conversationId)}>
                          {new Date(r.finishedAt).toLocaleString()} · {status(r.status)}
                        </button>
                        {r.summary && <p>{r.summary}</p>}
                        {r.error && <p>{r.error}</p>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {!schedules.length && !editing && (
        <div className="panel">
          <p>
            {tr(
              '还没有定时任务。可安排定期检查、稍后继续或下载完成后处理。',
              'No scheduled tasks yet. Schedule a check, continue later or wait for a download.',
            )}
          </p>
          <button
            onClick={() => {
              setForm(blank());
              setEditing(true);
            }}
          >
            {tr('创建第一个任务', 'Create your first task')}
          </button>
        </div>
      )}
    </section>
  );
}
