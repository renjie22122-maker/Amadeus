import { TeamRelations } from './TeamRelations';
import { relatedRuns } from '../team-relations';
import { useEffect, useState, useRef } from 'react';
import { Users } from 'lucide-react';
import { api } from '../api';
import type { ConversationDetail, UiState } from '../types';
import { Markdown } from './Markdown';
import { Activity, InputCard } from './Message';

export function TeamChat(props: Parameters<typeof TeamRound>[0]) {
  const { state, detail, zh, runId } = props;
  const latest = state.runs.filter((r) => r.conversationId === detail.conversation.id).at(-1);
  const selected = runId || latest?.id;
  const related = relatedRuns(state.runs, selected ? [selected] : []);
  const members = related.filter((r) => r.conversationId !== detail.conversation.id);
  const [open, setOpen] = useState(
    detail.teamSpace?.mode === 'creative' && selected === latest?.id,
  );
  const [snapshot, setSnapshot] = useState<{ id: string; value: ConversationDetail } | null>(null);
  const [loadError, setLoadError] = useState('');
  const attention = members
    .filter((r) => r.status === 'waiting_approval' || r.status === 'waiting_user')
    .map((r) => r.id + ':' + r.status)
    .sort()
    .join(',');
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  useEffect(() => {
    if (!open || !selected || selected === latest?.id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const value = await api<ConversationDetail>(
          '/conversations/' +
            detail.conversation.id +
            '?limit=1&runId=' +
            encodeURIComponent(selected),
        );
        if (!disposed) {
          setSnapshot({ id: selected, value });
          setLoadError('');
        }
      } catch {
        if (!disposed)
          setLoadError(zh ? '记录加载失败，正在重试' : 'Could not load records. Retrying.');
      }
      if (!disposed) timer = setTimeout(update, 5000);
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [open, selected, latest?.id, detail.conversation.id, zh]);
  if (!members.length) return null;
  const chosen =
    selected === latest?.id ? detail : snapshot && snapshot.id === selected ? snapshot.value : null;
  return (
    <details
      className="team-chat team-round-relations"
      open={open}
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        <Users size={17} />
        <strong>{zh ? '协作关系与成员' : 'Collaboration & members'}</strong>
        <span>
          {members.length} {zh ? '位成员' : 'members'} · {zh ? '本轮' : 'This round'}
          {attention ? (zh ? ' · 等待你处理' : ' · Needs your attention') : ''}
        </span>
      </summary>
      {open && (
        <>
          {loadError && <p role="status">{loadError}</p>}
          {chosen ? (
            <TeamRound {...props} detail={chosen} runId={selected} />
          ) : (
            <p role="status">{zh ? '正在加载本轮记录…' : 'Loading this round…'}</p>
          )}
        </>
      )}
    </details>
  );
}

function TeamRound({
  state,
  runId,
  detail,
  zh,
  t,
  notify,
}: {
  state: UiState;
  runId?: string;
  detail: ConversationDetail;
  zh: boolean;
  t: (s: string) => string;
  notify: (s: string) => void;
}) {
  const own = runId
    ? state.runs.find((r) => r.id === runId)
    : state.runs.filter((r) => r.conversationId === detail.conversation.id).at(-1);
  const ids = new Set(detail.teamMembers?.map((m) => m.runId) || []);
  if (own) ids.add(own.id);
  const related = relatedRuns(state.runs, [...ids]);
  const members = related.filter((r) => r.conversationId !== detail.conversation.id);
  const key = members
    .map((r) => r.conversationId)
    .sort()
    .join(',');
  const [views, setViews] = useState<Record<string, ConversationDetail>>({});
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const memberCache = useRef<Record<string, ConversationDetail>>({});
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setViews({});
    memberCache.current = {};
    setFilter('');
    const update = async () => {
      const results = await Promise.allSettled(
        [...new Set(key.split(',').filter(Boolean))].map(async (id) => {
          const cached = memberCache.current[id];
          const after = cached?.events.at(-1)?.id || 0;
          const value = await api<ConversationDetail>(
            '/conversations/' + id + (after ? '?after=' + after : '?limit=500'),
          );
          return [
            id,
            {
              ...value,
              hasOlderEvents: value.hasOlderEvents ?? cached?.hasOlderEvents,
              events: [
                ...new Map(
                  [...(cached?.events || []), ...value.events].map((e) => [e.id, e]),
                ).values(),
              ].sort((a, b) => a.id - b.id),
            },
          ] as const;
        }),
      );
      if (disposed) return;
      setViews((previous) => {
        const next = { ...previous };
        for (const result of results)
          if (result.status === 'fulfilled') {
            const [id, value] = result.value;
            next[id] = {
              ...value,
              hasOlderEvents: previous[id]?.hasOlderEvents ?? value.hasOlderEvents,
              events: [
                ...new Map(
                  [...(previous[id]?.events || []), ...value.events].map((e) => [e.id, e]),
                ).values(),
              ].sort((a, b) => a.id - b.id),
            };
          }
        memberCache.current = next;
        return next;
      });
      setError(
        results.some((r) => r.status === 'rejected')
          ? zh
            ? '部分成员更新失败，正在重试'
            : 'Some members could not refresh. Retrying.'
          : '',
      );
      timer = setTimeout(update, 2500);
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, detail.conversation.id, zh, revision]);
  if (!members.length) return null;
  const name = (id: string) =>
    state.conversations.find((c) => c.id === id)?.title || id.slice(0, 8);
  const visible = members.filter((m) => !filter || m.conversationId === filter);
  const allowed = new Set(visible.map((m) => m.id));
  const messages = visible
    .flatMap((m) =>
      (views[m.conversationId]?.events || [])
        .filter((e) => e.runId === m.id && e.type === 'assistant.message')
        .map((e) => ({ ...e, member: m })),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  return (
    <section className="team-chat" aria-label={zh ? '团队群聊' : 'Team chat'}>
      <div className="team-chat-content">
        <div className="team-summary" role="status">
          <strong>
            {detail.teamSpace
              ? detail.teamSpace.mode === 'creative'
                ? zh
                  ? '团队讨论'
                  : 'Team discussion'
                : zh
                  ? '任务协作'
                  : 'Task coordination'
              : zh
                ? '普通子任务委派'
                : 'Independent delegation'}
          </strong>
          <p>
            {zh ? '成员完成' : 'Members completed'}{' '}
            {members.filter((m) => m.status === 'completed').length}/{members.length}
            {' · '}
            {zh ? '运行中' : 'Running'}{' '}
            {members.filter((m) => ['running', 'queued'].includes(m.status)).length}
            {' · '}
            {zh ? '需关注' : 'Needs attention'}{' '}
            {
              members.filter((m) =>
                ['failed', 'interrupted', 'waiting_approval', 'waiting_user'].includes(m.status),
              ).length
            }
          </p>
          {detail.taskBoard && (
            <p>
              {zh ? '任务完成' : 'Tasks done'}{' '}
              {detail.taskBoard.tasks.filter((t) => t.status === 'done').length}/
              {detail.taskBoard.tasks.length}
            </p>
          )}
          <p className="muted">
            {zh
              ? '成员结束不代表团队验收完成。下方可切换成员关系、任务依赖和实际通讯。'
              : 'Member completion is not team acceptance. Explore member relations, dependencies and recorded communication below.'}
          </p>
          {detail.teamSpace?.selection?.reason && <p>{detail.teamSpace.selection.reason}</p>}
        </div>
        <TeamRelations
          runs={related}
          state={state}
          detail={detail}
          views={views}
          zh={zh}
          onMember={(id) => setFilter(id === detail.conversation.id ? '' : id)}
        />
        <div className="team-chat-members" aria-label={zh ? '筛选成员' : 'Filter members'}>
          <button aria-pressed={!filter} onClick={() => setFilter('')}>
            {zh ? '全部' : 'All'}
          </button>
          {members.map((m) => (
            <button
              key={m.id}
              aria-pressed={filter === m.conversationId}
              onClick={() => setFilter(m.conversationId)}
            >
              <span>{name(m.conversationId)}</span>
              <small>{m.status.replaceAll('_', ' ')}</small>
            </button>
          ))}
        </div>
        {error && <p role="status">{error}</p>}
        <div className="team-chat-feed">
          {!messages.length && (
            <p className="muted">
              {zh
                ? '成员正在工作，回复会显示在这里。'
                : 'Members are working. Their replies will appear here.'}
            </p>
          )}
          {messages.map((e) => (
            <article className="team-chat-message" key={e.id}>
              <header>
                <span className="avatar">{name(e.conversationId).slice(0, 1)}</span>
                <strong>{name(e.conversationId)}</strong>
                <time>
                  {new Date(e.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </header>
              <Markdown text={e.data.text || ''} />
            </article>
          ))}
          {visible.flatMap((m) =>
            (views[m.conversationId]?.streams || [])
              .filter((s) => s.runId === m.id)
              .map((s) => (
                <article className="team-chat-message" key={'stream-' + s.runId}>
                  <header>
                    <strong>{name(m.conversationId)}</strong>
                    <span className="working-dot" />
                  </header>
                  <Markdown text={s.text} />
                </article>
              )),
          )}
          {detail.teamSpace?.messages
            .filter((m) => !filter || allowed.has(m.sender))
            .map((m) => (
              <article className="team-chat-message discussion" key={m.id}>
                <header>
                  <strong>
                    {name(state.runs.find((r) => r.id === m.sender)?.conversationId || m.sender)}
                  </strong>
                  <small>{zh ? '团队讨论' : 'Team discussion'}</small>
                </header>
                <Markdown text={m.text} />
              </article>
            ))}
        </div>
        {visible.map((m) => (
          <div key={m.id} className="team-chat-work">
            <details>
              <summary>
                {name(m.conversationId)} · {zh ? '执行步骤' : 'Execution steps'}
              </summary>
              {views[m.conversationId]?.hasOlderEvents && (
                <button
                  onClick={async () => {
                    try {
                      const current = memberCache.current[m.conversationId];
                      if (!current?.events.length) return;
                      const page = await api<ConversationDetail>(
                        '/conversations/' +
                          m.conversationId +
                          '?limit=500&before=' +
                          current.events[0].id,
                      );
                      const latest = memberCache.current[m.conversationId];
                      const next = {
                        ...latest,
                        hasOlderEvents: page.hasOlderEvents,
                        events: [
                          ...new Map(
                            [...page.events, ...latest.events].map((e) => [e.id, e]),
                          ).values(),
                        ].sort((a, b) => a.id - b.id),
                      };
                      memberCache.current = { ...memberCache.current, [m.conversationId]: next };
                      setViews(memberCache.current);
                    } catch (e: any) {
                      notify(e.message);
                    }
                  }}
                >
                  {zh ? '加载成员更早记录' : 'Load earlier member records'}
                </button>
              )}
              <Activity
                events={(views[m.conversationId]?.events || []).filter(
                  (e) =>
                    e.runId === m.id && !['user.message', 'assistant.message'].includes(e.type),
                )}
                t={t}
              />
            </details>
          </div>
        ))}
      </div>
      {members.map((m) =>
        (views[m.conversationId]?.inputs || [])
          .filter((q) => q.runId === m.id && q.status === 'pending')
          .map((q) => (
            <div className="team-chat-attention" key={q.id}>
              <strong>{name(m.conversationId)}</strong>
              <InputCard
                input={q}
                t={t}
                notify={notify}
                refresh={() => setRevision((n) => n + 1)}
              />
            </div>
          )),
      )}
    </section>
  );
}
