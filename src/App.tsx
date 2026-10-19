import { ProcessHistory } from './components/ProcessHistory';
import { collapsibleProcess } from './conversation-process';
import { WorkbenchProvider } from './components/Workbench';
import { useScheduleNotifications } from './useScheduleNotifications';
import { AttachmentPreview } from './components/AttachmentPreview';
import { mergeConversationEvents } from './conversation-events';
const BackgroundPage = lazy(() =>
  import('./pages/Background').then((m) => ({ default: m.BackgroundPage })),
);
import { conversationMarkdown } from './conversation-copy';
import { ConversationSchedules } from './components/ConversationSchedules';
import { mediaTimeline } from './media-timeline';
import { MediaGallery } from './components/MediaGallery';
import { TeamManagement } from './components/TeamManagement';
import { TeamChat } from './components/TeamChat';
import { ConversationStatus } from './components/ConversationStatus';
import { DisplaySettings } from './components/DisplaySettings';
import { connectLive } from './live';
import { Attention } from './components/Attention';
import { Elapsed } from './components/Elapsed';
import { DiffGroup } from './components/Diff';
import {
  BookOpen,
  Folder,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pin,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, Conversation, Project } from '../shared/types';
import { api, bootstrap } from './api';
import { Composer } from './components/Composer';
import { Inspector } from './components/Inspector';
import { Markdown } from './components/Markdown';
import { Activity, InputCard, Message } from './components/Message';
import { ProjectDialog } from './components/ProjectDialog';
import { Sidebar } from './components/Sidebar';
import { translator, type Language } from './i18n';
const Library = lazy(() => import('./pages/Library').then((m) => ({ default: m.Library })));
const SettingsPage = lazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.SettingsPage })),
);
import type { ConversationDetail, UiState } from './types';
const ended = (s: string) => ['completed', 'failed', 'interrupted'].includes(s);
export function App() {
  const [state, setState] = useState<UiState | null>(null),
    [selected, setSelected] = useState<string | null>(() => localStorage.getItem('agentdemo.chat')),
    [detail, setDetail] = useState<ConversationDetail | null>(null),
    [page, setPage] = useState('chat');
  const [language, setLanguage] = useState<Language>(
      () => (localStorage.getItem('agentdemo.language') as Language) || 'en',
    ),
    [theme, setTheme] = useState(() => localStorage.getItem('agentdemo.theme') || 'dark');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleteTitle, setDeleteTitle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760),
    [inspector, setInspector] = useState(false),
    [inspectorTab, setInspectorTab] = useState<'settings' | 'context' | 'files'>('settings'),
    [query, setQuery] = useState(''),
    [archived, setArchived] = useState(false),
    [draft, setDraft] = useState(''),
    [toast, setToast] = useState(''),
    [sending, setSending] = useState(false),
    [streams, setStreams] = useState<Record<string, any>>({});
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectDialog, setProjectDialog] = useState(false),
    [projectName, setProjectName] = useState(''),
    [projectFolders, setProjectFolders] = useState(''),
    [menu, setMenu] = useState<string | null>(null),
    [drag, setDrag] = useState(false);
  const [connection, setConnection] = useState('Connecting');
  const reconnect = useRef<() => void>(() => {});
  const [anchor, setAnchor] = useState('');
  const [visibleTurns, setVisibleTurns] = useState(6);
  const [expandedProcesses, setExpandedProcesses] = useState<Record<string, boolean>>({});
  const jump = useCallback((conversation: string, input: string) => {
    stick.current = false;
    setPage('chat');
    setSelected(conversation);
    setAnchor('input-' + input);
  }, []);
  useEffect(() => {
    if (!anchor) return;
    const target = document.getElementById(anchor);
    if (target) {
      stick.current = false;
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
      setAnchor('');
    }
  }, [anchor, detail, visibleTurns]);
  const finishedMessages = useRef(new Set<string>());
  const selectedRef = useRef(selected),
    scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    stick = useRef(true),
    upload = useRef<HTMLInputElement>(null),
    draftRef = useRef<HTMLTextAreaElement>(null);
  const translate = translator(language);
  const agentName = state?.settings.agentName || 'Amadeus';
  const t = (key: string) => (key === 'Amadeus' ? agentName : translate(key));
  useEffect(() => {
    document.title = agentName;
  }, [agentName]);
  const notify = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(''), 6500);
  }, []);
  useScheduleNotifications(notify, language === 'zh');
  const pageRef = useRef(page);
  pageRef.current = page;
  const refreshPending = useRef(new Map<string, Promise<any>>());
  const refresh = useCallback(() => {
    const view = ['knowledge', 'memory', 'memories'].includes(pageRef.current) ? 'full' : 'shell';
    let pending = refreshPending.current.get(view);
    if (!pending) {
      pending = api('/state?view=' + view)
        .then((value) => {
          setState((old) => ({ memories: [], documents: [], ...old, ...value }));
          return value;
        })
        .finally(() => {
          refreshPending.current.delete(view);
        });
      refreshPending.current.set(view, pending);
    }
    return pending;
  }, []);
  useEffect(() => {
    if (['knowledge', 'memory', 'memories'].includes(page))
      void refresh().catch((e) => notify(e.message));
  }, [page, refresh, notify]);
  const authenticated = useRef(false);
  const detailCache = useRef(new Map<string, ConversationDetail>());
  const patches = useRef(new Map<string, Record<string, unknown>>());
  const updateQueue = useRef<Promise<unknown>>(Promise.resolve());
  const sendingRef = useRef(false);
  const loadVersions = useRef(new Map<string, number>());
  const loading = useRef(new Map<string, Promise<any>>());
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const load = useCallback(async (id: string) => {
    let request = loading.current.get(id);
    if (!request) {
      loadVersions.current.set(id, (loadVersions.current.get(id) || 0) + 1);
      const cached = detailCache.current.get(id);
      const after = anchorRef.current ? 0 : cached?.events.at(-1)?.id || 0;
      request = api(
        '/conversations/' +
          id +
          '?after=' +
          after +
          (!after && !anchorRef.current ? '&limit=500' : ''),
      ).then((value) => ({
        ...value,
        hasOlderEvents:
          value.hasOlderEvents ??
          (after ? detailCache.current.get(id)?.hasOlderEvents : false) ??
          false,
        events: mergeConversationEvents(
          detailCache.current.get(id)?.events || [],
          value.events,
          value.deliveries,
        ),
      }));
      loading.current.set(id, request);
    }
    const version = loadVersions.current.get(id);
    let value: any;
    try {
      value = await request;
      value = { ...value, conversation: { ...value.conversation, ...patches.current.get(id) } };
    } finally {
      if (loading.current.get(id) === request) loading.current.delete(id);
    }
    if (loadVersions.current.get(id) !== version) return;
    detailCache.current.delete(id);
    detailCache.current.set(id, value);
    if (detailCache.current.size > 5)
      detailCache.current.delete(detailCache.current.keys().next().value!);
    if (selectedRef.current === id) {
      setDetail((old: any) => ({
        ...value,
        events: mergeConversationEvents(
          old?.conversation.id === id ? old.events : [],
          value.events,
          value.deliveries,
        ),
      }));
      setStreams((old) =>
        Object.fromEntries(
          value.streams
            .filter((s: any) => !finishedMessages.current.has(s.messageId))
            .map((s: any) => [
              s.runId,
              old[s.runId]?.messageId === s.messageId && old[s.runId].text.length > s.text.length
                ? old[s.runId]
                : s,
            ]),
        ),
      );
    }
  }, []);
  useEffect(() => {
    selectedRef.current = selected;
    localStorage.setItem('agentdemo.chat', selected || '');
    setVisibleTurns(anchor ? Number.MAX_SAFE_INTEGER : 6);
    setDetail(selected ? detailCache.current.get(selected) || null : null);
    setStreams({});
    stick.current = !anchor;
    setDraft(localStorage.getItem('agentdemo.draft.' + selected) || '');
    if (selected && authenticated.current) void load(selected).catch((e) => notify(e.message));
  }, [selected, load, notify]);
  useEffect(() => {
    localStorage.setItem('agentdemo.draft.' + selected, draft);
  }, [draft, selected]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agentdemo.theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem('agentdemo.language', language);
  }, [language]);
  useEffect(() => {
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks = new Map<string, { event: any; parts: string[] }>();
    const flush = () => {
      flushTimer = undefined;
      const pending = [...chunks.values()];
      chunks.clear();
      setStreams((old) => {
        let next = old;
        for (const { event: e, parts } of pending) {
          if (e.conversationId !== selectedRef.current || finishedMessages.current.has(e.messageId))
            continue;
          if (next === old) next = { ...old };
          next[e.runId] = {
            ...e,
            text:
              (next[e.runId]?.messageId === e.messageId ? next[e.runId].text : '') + parts.join(''),
          };
        }
        return next;
      });
    };
    const live = connectLive(
      '/api/events',
      {
        agent: (event) => {
          const e = JSON.parse((event as MessageEvent).data) as AgentEvent;
          if (e.type === 'conversation.title' && e.conversationId === selectedRef.current) {
            setDetail((d: any) =>
              d ? { ...d, conversation: { ...d.conversation, title: e.data.title } } : d,
            );
          }
          if (e.conversationId === selectedRef.current) {
            setDetail((d: any) =>
              d
                ? {
                    ...d,
                    events: d.events.some((x: AgentEvent) => x.id === e.id)
                      ? d.events
                      : [...d.events, e],
                  }
                : d,
            );
            if (e.type === 'assistant.message') {
              finishedMessages.current.add(e.data.messageId);
              setStreams((s) => {
                const copy = { ...s };
                delete copy[e.runId!];
                return copy;
              });
            }
            if (
              [
                'input.requested',
                'input.answered',
                'run.status',
                'attachment.added',
                'attachment.removed',
                'user.delivered',
              ].includes(e.type)
            )
              void load(e.conversationId).catch(() => {});
          }
          if (
            e.type === 'plan.updated' ||
            e.type === 'team.assigned' ||
            e.type === 'team.lifecycle' ||
            e.type === 'team.control' ||
            (e.type === 'tool.completed' &&
              [
                'create_plan',
                'extend_plan',
                'update_task',
                'record_verification',
                'handoff_task',
              ].includes(e.data.name))
          ) {
            const current = selectedRef.current;
            if (
              current &&
              (e.conversationId === current ||
                detailCache.current.get(current)?.teamMembers?.some((m) => m.runId === e.runId))
            )
              void load(current).catch(() => {});
          }
          if (
            [
              'input.requested',
              'input.answered',
              'run.status',
              'usage',
              'conversation.title',
              'child.started',
              'user.message',
            ].includes(e.type)
          )
            void refresh().catch(() => {});
        },
        delta: (event) => {
          const e = JSON.parse((event as MessageEvent).data);
          if (e.conversationId !== selectedRef.current || finishedMessages.current.has(e.messageId))
            return;
          const batch = chunks.get(e.messageId) || { event: e, parts: [] };
          batch.parts.push(e.text);
          chunks.set(e.messageId, batch);
          if (!flushTimer) flushTimer = setTimeout(flush, 80);
        },
        heartbeat: () => {
          void refresh().catch(() => {});
        },
        ready: () => {
          void refresh().catch((e) => notify(e.message));
          if (selectedRef.current) void load(selectedRef.current).catch((e) => notify(e.message));
        },
      },
      setConnection,
      async () => {
        await bootstrap();
        authenticated.current = true;
        await refresh();
      },
    );
    reconnect.current = live.retry;
    return () => {
      live.close();
      if (flushTimer) clearTimeout(flushTimer);
      chunks.clear();
    };
  }, [refresh, load, notify]);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [detail?.events.length, streams, selected]);
  async function action(fn: () => Promise<any>) {
    try {
      return await fn();
    } catch (e: any) {
      notify(e.message);
    }
  }
  async function newChat(projectId: string | null = null) {
    const c = await api('/conversations', { projectId });
    setSelected(c.id);
    setPage('chat');
    void refresh().catch((e) => notify(e.message));
    return c.id;
  }
  const conversation = detail?.conversation as Conversation | undefined;
  const currentRuns = state?.runs.filter((r: any) => r.conversationId === selected) || [],
    run = currentRuns.at(-1),
    running = run && !ended(run.status);
  const descendants =
    state && run
      ? state.runs.filter((candidate) => {
          let r: typeof candidate | undefined = candidate;
          while (r) {
            if (r.id === run.id) return true;
            r = r.parentRunId ? state.runs.find((p) => p.id === r!.parentRunId) : undefined;
          }
          return false;
        })
      : [];
  const totalUsage = run
    ? {
        ...run,
        usageComplete: !descendants.some((r) => r.usageComplete === false),
        inputTokens: descendants.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: descendants.reduce((n, r) => n + r.outputTokens, 0),
        cachedTokens: descendants.reduce((n, r) => n + r.cachedTokens, 0),
        modelCalls: descendants.reduce((n, r) => n + r.modelCalls, 0),
        estimatedUsd: descendants.some((r) => r.estimatedUsd === null)
          ? null
          : descendants.reduce((n, r) => n + (r.estimatedUsd || 0), 0),
      }
    : undefined;
  const project = state?.projects.find((p: any) => p.id === conversation?.projectId),
    profile = state?.settings.profiles.find((p: any) => p.id === conversation?.profileId);
  const update = async (data: any, targetId = selected) => {
    const key = targetId;
    if (!key) return;
    const pending = { ...patches.current.get(key), ...data };
    patches.current.set(key, pending);
    setDetail((old) =>
      old?.conversation.id === key
        ? { ...old, conversation: { ...old.conversation, ...pending } }
        : old,
    );
    const operation = updateQueue.current
      .catch(() => {})
      .then(() => api('/conversations/' + key, data, 'PATCH'));
    updateQueue.current = operation;
    try {
      const saved = await operation;
      // Invalidate snapshots requested before this write, so they cannot undo the UI.
      loadVersions.current.set(key, (loadVersions.current.get(key) || 0) + 1);
      loading.current.delete(key);
      if (patches.current.get(key) === pending) patches.current.delete(key);
      const current = { ...saved, ...patches.current.get(key) };
      setDetail((old) => (old?.conversation.id === key ? { ...old, conversation: current } : old));
      const cached = detailCache.current.get(key);
      if (cached) detailCache.current.set(key, { ...cached, conversation: current });
      setState((old) =>
        old
          ? { ...old, conversations: old.conversations.map((c) => (c.id === key ? current : c)) }
          : old,
      );
    } catch (error) {
      if (patches.current.get(key) === pending) {
        patches.current.delete(key);
        loading.current.delete(key);
        await load(key);
      }
      throw error;
    } finally {
      if (updateQueue.current === operation) updateQueue.current = Promise.resolve();
    }
  };
  async function send(text = draft) {
    if (sendingRef.current) return;
    if (!text.trim() && !detail?.attachments.some((a) => !a.messageEventId)) return;
    if (!text.trim())
      text = t('settings') === 'Settings' ? 'Please examine the attached files.' : '请查看附件。';
    sendingRef.current = true;
    setSending(true);
    const originalDraft = draft;
    let key = selected;
    setDraft('');
    localStorage.removeItem('agentdemo.draft.' + key);
    stick.current = true;
    let accepted = false;
    try {
      key = key || String(await newChat());
      await updateQueue.current;
      await api('/conversations/' + key + '/message', { text });
      accepted = true;
      // Acknowledgement ends submission; timeline refresh is independent work.
      void Promise.all([refresh(), load(key)]).catch((e) => notify(e.message));
    } catch (e: any) {
      if (!accepted) {
        if (selectedRef.current === key) setDraft((current) => current || originalDraft);
        else localStorage.setItem('agentdemo.draft.' + key, originalDraft);
      }
      notify(e.message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  async function removeAttachment(id: string) {
    const key = selected;
    await api('/attachments/' + id, undefined, 'DELETE');
    if (key) await load(key);
  }
  async function addFiles(files: FileList | File[]) {
    const pendingFiles = Array.from(files);
    const key = selected || (await newChat());
    const failures: string[] = [];
    for (const file of pendingFiles) {
      const form = new FormData();
      form.append('file', file);
      try {
        await api('/upload?conversationId=' + key, form);
      } catch (error) {
        failures.push(file.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    await load(key);
    notify(failures.length ? failures.join('\n') : t('attachments') + ' ✓');
  }
  async function copyConversation(id: string) {
    if (copying) return;
    setCopying(id);
    try {
      const value = (await api('/conversations/' + id)) as ConversationDetail;
      const text = conversationMarkdown(
        value,
        state?.settings.agentName || 'Amadeus',
        language === 'zh',
      );
      try {
        await navigator.clipboard.writeText(text);
        notify(language === 'zh' ? '已复制整个对话' : 'Entire conversation copied');
      } catch {
        setCopyFallback(text);
      }
      setMenu(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(null);
    }
  }
  function chatLink(c: any) {
    const active = state!.runs.some((r: any) => r.conversationId === c.id && !ended(r.status));
    return (
      <div
        key={c.id}
        className={'chat-link ' + (selected === c.id && page === 'chat' ? 'active' : '')}
        data-conversation-id={c.id}
      >
        <button
          className="chat-select"
          onClick={() => {
            setSelected(c.id);
            setPage('chat');
            setMenu(null);
          }}
        >
          {active ? (
            <span className="working-dot" />
          ) : c.parentId ? (
            <GitBranch size={14} />
          ) : (
            <MessageSquare size={14} />
          )}
          <span>{c.title}</span>
          {c.pinned && <Pin size={12} />}
        </button>
        <button
          className="chat-more"
          aria-label={'Chat actions ' + c.title}
          onClick={() => setMenu(menu === c.id ? null : c.id)}
        >
          <MoreHorizontal size={15} />
        </button>
        {menu === c.id && (
          <div className="context-menu">
            <button disabled={copying !== null} onClick={() => void copyConversation(c.id)}>
              {copying === c.id
                ? language === 'zh'
                  ? '正在复制…'
                  : 'Copying…'
                : language === 'zh'
                  ? '复制整个对话'
                  : 'Copy entire conversation'}
            </button>
            <button
              onClick={() => {
                setDeleteTarget(c);
                setDeleteTitle('');
                setMenu(null);
              }}
            >
              {language === 'zh' ? '彻底删除对话…' : 'Permanently delete…'}
            </button>
            {[
              [
                t('rename'),
                async () => {
                  const title = prompt(t('name'), c.title);
                  if (title) await api('/conversations/' + c.id, { title }, 'PATCH');
                },
              ],
              [t('pin'), () => api('/conversations/' + c.id, { pinned: !c.pinned }, 'PATCH')],
              [
                c.archived ? t('restore') : t('archive'),
                () => api('/conversations/' + c.id, { archived: !c.archived }, 'PATCH'),
              ],
            ].map(([label, fn]: any) => (
              <button
                key={label}
                onClick={() =>
                  void action(async () => {
                    await fn();
                    setMenu(null);
                    await refresh();
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  const filtered =
    state?.conversations.filter(
      (c: any) =>
        (state.projects.some((p) => p.id === c.projectId && p.removedAt)
          ? archived
          : c.archived === archived) &&
        (c.title.toLowerCase().includes(query.toLowerCase()) ||
          state.projects.some(
            (p) => p.id === c.projectId && p.name.toLowerCase().includes(query.toLowerCase()),
          )) &&
        (!!query ||
          c.id === selected ||
          !state?.runs.some(
            (r) =>
              r.conversationId === c.id &&
              r.parentRunId &&
              state.runs.some((p) => p.id === r.parentRunId),
          )),
    ) || [];
  function timeline() {
    const nodes: any[] = [];
    const shownChanges = new Set<string>();
    let activity: AgentEvent[] = [];
    const flush = () => {
      if (activity.length) {
        nodes.push(
          <Activity
            key={'steps-' + activity[0].id}
            events={activity}
            t={t}
            quiet={activity.every((e) => folded.has(e.id))}
          />,
        );
        activity = [];
      }
    };
    const all = detail?.events || [];
    const mediaAt = mediaTimeline(all);
    const lastByRun = new Map(all.filter((e) => e.runId).map((e) => [e.runId, e.id]));
    const starts = all.map((e, i) => (e.type === 'user.message' ? i : -1)).filter((i) => i >= 0);
    const offset = starts.length > visibleTurns ? starts[starts.length - visibleTurns] : 0;
    if (offset > 0 || detail?.hasOlderEvents)
      nodes.push(
        <button
          key="older"
          className="load-older"
          disabled={loadingOlder}
          onClick={async () => {
            if (!selected || !detail) return;
            stick.current = false;
            const container = scroll.current,
              height = container?.scrollHeight || 0,
              top = container?.scrollTop || 0;
            if (!offset && detail.hasOlderEvents) {
              setLoadingOlder(true);
              try {
                const earlier = await api<ConversationDetail>(
                  '/conversations/' + selected + '?limit=500&before=' + all[0].id,
                );
                const latest = detailCache.current.get(selected) || detail;
                const merged = {
                  ...latest,
                  hasOlderEvents: earlier.hasOlderEvents,
                  events: mergeConversationEvents(earlier.events, latest.events),
                };
                detailCache.current.set(selected, merged);
                if (selectedRef.current !== selected) return;
                setDetail(merged);
              } catch (e: any) {
                notify(e.message);
                return;
              } finally {
                setLoadingOlder(false);
              }
            }
            setVisibleTurns((n) => n + 6);
            requestAnimationFrame(() => {
              if (container) container.scrollTop = top + container.scrollHeight - height;
            });
          }}
        >
          {language === 'zh' ? '加载较早的对话' : 'Load earlier messages'} ·{' '}
          {loadingOlder ? '…' : Math.max(0, starts.length - visibleTurns) || '…'}
        </button>,
      );
    const folded = collapsibleProcess(all, currentRuns);
    const processes = new Map<
      string,
      { index: number; segments: { index: number; nodes: any[] }[]; events: AgentEvent[] }
    >();
    for (const e of all.slice(offset)) {
      if (folded.has(e.id)) flush();
      const start = nodes.length;
      if (e.type === 'user.message' || e.type === 'assistant.message') {
        flush();
        nodes.push(
          <Message
            key={e.id}
            event={e}
            onPreviewResult={(text) => {
              if (selectedRef.current !== selected) return false;
              if (draft.length + text.length + 2 > 100000) {
                notify(
                  language === 'zh'
                    ? '草稿过长，请分批发送结果。'
                    : 'Draft too long. Send results in smaller batches.',
                );
                return false;
              }
              setDraft((current) => current + (current ? '\n\n' : '') + text);
              draftRef.current?.focus();
              return true;
            }}
            t={t}
            notify={notify}
            onBranch={(eventId) =>
              void action(async () => {
                const fork = await api('/conversations/' + selected + '/fork', { eventId });
                setSelected(fork.id);
                await refresh();
                notify('Conversation branched. Project files are shared.');
              })
            }
          />,
        );
        if (e.type === 'user.message' && !e.data.steering) {
          const timing = currentRuns.find((r) => r.id === e.runId);
          if (timing)
            nodes.push(<Elapsed key={'elapsed-' + e.id} run={timing} zh={language === 'zh'} />);
        }
      } else if (['media.attached', 'file.attached'].includes(e.type) && e.data.attachment) {
        flush();
        nodes.push(
          <div key={e.id} className="message-attachments">
            <AttachmentPreview attachment={e.data.attachment} />
          </div>,
        );
      } else if (e.type === 'media.updated') {
        const job = mediaAt.get(e.id);
        if (job) {
          flush();
          nodes.push(
            <MediaGallery
              key={'media-' + job.id}
              conversationId={selected}
              jobs={[job]}
              zh={language === 'zh'}
              onText={(text: string) => setDraft((d) => d + (d ? '\n' : '') + text)}
            />,
          );
        }
      } else if (e.type === 'file.changes-limited' || e.type === 'file.changed') {
        const key = e.runId || 'legacy';
        if (!shownChanges.has(key)) {
          flush();
          shownChanges.add(key);
          const changes = (detail?.events || []).filter(
            (x: AgentEvent) =>
              (x.runId || 'legacy') === key &&
              ['file.changed', 'file.changes-limited'].includes(x.type),
          );
          nodes.push(<DiffGroup key={'changes-' + key} events={changes} zh={language === 'zh'} />);
        }
      } else if (e.type === 'input.requested') {
        flush();
        const input = detail?.inputs.find((q: any) => q.id === e.data.id) || e.data;
        nodes.push(
          <InputCard
            key={e.id}
            input={input}
            t={t}
            notify={notify}
            refresh={() => load(selected!)}
          />,
        );
      } else if (
        [
          'command.background',
          'command.progress',
          'command.yielded',
          'tool.started',
          'tool.completed',
          'model.started',
          'context.compacting',
          'context.compacted',
          'cognitive.intervention',
          'model.protocol-repair',
          'model.reconnecting',
          'child.started',
        ].includes(e.type)
      )
        activity.push(e);
      else if (e.type === 'run.status' && e.data.error) {
        flush();
        nodes.push(
          <div key={e.id} className="notice error">
            {e.data.error}
          </div>,
        );
      }
      if (folded.has(e.id)) flush();
      if (folded.has(e.id) && e.runId) {
        const rendered = nodes.splice(start);
        if (rendered.length) {
          let group = processes.get(e.runId);
          if (!group) {
            group = { index: nodes.length, segments: [], events: [] };
            processes.set(e.runId, group);
            nodes.push(null);
          }
          let segment = group.segments.at(-1);
          if (!segment || nodes.length !== segment.index + 1) {
            segment = { index: nodes.length, nodes: [] };
            group.segments.push(segment);
            nodes.push(null);
          }
          segment.nodes.push(...rendered);
          group.events.push(e);
        }
      }
      if (e.runId && lastByRun.get(e.runId) === e.id && detail) {
        flush();
        nodes.push(
          <TeamChat
            key={'team-' + e.runId}
            runId={e.runId}
            state={state!}
            detail={detail}
            zh={language === 'zh'}
            t={t}
            notify={notify}
          />,
        );
      }
    }
    flush();
    for (const [runId, group] of processes) {
      const messages = group.events.filter((e) => e.type === 'assistant.message').length;
      const tools = group.events.filter((e) => e.type === 'tool.started').length;
      const count = group.events.length;
      for (const segment of group.segments) {
        const contents: any[] = [];
        for (const node of segment.nodes) {
          const previous = contents.at(-1);
          if (node.type === Activity && previous?.type === Activity) {
            contents[contents.length - 1] = (
              <Activity
                key={previous.key}
                events={[...previous.props.events, ...node.props.events]}
                t={t}
                quiet
              />
            );
          } else contents.push(node);
        }
        nodes[segment.index] = (
          <div
            key={'segment-' + runId + '-' + segment.index}
            id={'segment-' + runId + '-' + segment.index}
            className="process-segment"
            hidden={!expandedProcesses[runId]}
          >
            {expandedProcesses[runId] ? contents : null}
          </div>
        );
      }
      nodes[group.index] = (
        <ProcessHistory
          key={'process-' + runId}
          open={!!expandedProcesses[runId]}
          onChange={(open) => setExpandedProcesses((previous) => ({ ...previous, [runId]: open }))}
          controls={group.segments
            .map((segment) => 'segment-' + runId + '-' + segment.index)
            .join(' ')}
          label={
            language === 'zh'
              ? `此前过程 · ${count} 条记录${messages ? ` · ${messages} 条模型回复` : ''}${tools ? ` · ${tools} 次工具调用` : ''}`
              : `${count} previous events${messages ? ` · ${messages} assistant messages` : ''}${tools ? ` · ${tools} tool calls` : ''}`
          }
        />
      );
    }
    return nodes;
  }
  if (!state)
    return (
      <div className="loading">
        <Sparkles size={30} />
        <p>Opening Amadeus…</p>
        {toast && <p>{toast}</p>}
      </div>
    );
  return (
    <div className={'app ' + (!sidebar ? 'no-sidebar' : '')}>
      <div className="live-toolbar">
        <DisplaySettings zh={language === 'zh'} />
        <span role="status">
          {language === 'zh'
            ? { Connected: '已连接', Connecting: '连接中' }[connection] || connection
            : connection}
        </span>
        {connection !== 'Connected' && (
          <button onClick={() => reconnect.current()}>
            {language === 'zh' ? '重新连接' : 'Reconnect'}
          </button>
        )}
        <Attention
          items={(state as any).pendingInputs || []}
          onSelect={jump}
          zh={language === 'zh'}
        />
      </div>
      {sidebar && (
        <Sidebar
          selected={selected || ''}
          editProject={(p) => {
            setEditingProject(p);
            setProjectName(p.name);
            setProjectFolders(p.folders.join('\n'));
            setProjectDialog(true);
          }}
          {...{
            t,
            state,
            setSidebar,
            action,
            newChat,
            query,
            setQuery,
            setProjectDialog: (value) => {
              setEditingProject(null);
              setProjectName('');
              setProjectFolders('');
              setProjectDialog(value);
            },
            archived,
            setArchived,
            filtered,
            chatLink,
            page,
            setPage,
            language,
            setLanguage,
            theme,
            setTheme,
          }}
        />
      )}
      <main className="main">
        <header className="topbar">
          <div className="row minzero">
            {!sidebar && (
              <button className="icon" onClick={() => setSidebar(true)}>
                <PanelLeft size={18} />
              </button>
            )}
            <span className="breadcrumb">
              {page === 'chat' ? project?.name || t('general') : t(page)}
            </span>
            <span className="slash">/</span>
            <strong className="truncate">
              {page === 'chat' ? conversation?.title || t('newChat') : agentName}
            </strong>
          </div>
          {page === 'chat' && (
            <div className="row">
              <select
                className="jump-select"
                aria-label="Jump to turn"
                defaultValue=""
                onChange={(e) => {
                  stick.current = false;
                  setVisibleTurns(Number.MAX_SAFE_INTEGER);
                  setAnchor('event-' + e.target.value);
                }}
              >
                <option value="">↳ Turns</option>
                {detail?.events
                  .filter((e: any) => e.type === 'user.message')
                  .map((e: any, i: number) => (
                    <option key={e.id} value={e.id}>
                      {i + 1} · {e.data.text.slice(0, 32)}
                    </option>
                  ))}
              </select>
              <button
                className={'icon ' + (inspector ? 'selected' : '')}
                title={t('details')}
                onClick={() => setInspector(!inspector)}
              >
                <SlidersHorizontal size={18} />
              </button>
            </div>
          )}
        </header>
        {project?.removedAt && (
          <div className="workspace-removed-notice" role="status">
            <span>
              {language === 'zh'
                ? '此工作区已移除，历史记录保留。恢复后才能继续任务。'
                : 'This workspace was removed. History is retained; restore it to continue tasks.'}
            </span>
            <button
              onClick={() => {
                setEditingProject(project);
                setProjectName(project.name);
                setProjectFolders(project.folders.join('\n'));
                setProjectDialog(true);
              }}
            >
              {language === 'zh' ? '恢复项目' : 'Restore project'}
            </button>
          </div>
        )}
        {page === 'chat' && conversation && (
          <ConversationStatus
            id={conversation.id}
            live={!!running}
            status={run?.status || 'ready'}
            project={project}
            isolated={!!conversation.isolationId}
            zh={language === 'zh'}
            open={(tab) => {
              setInspectorTab(tab);
              setInspector(true);
            }}
          />
        )}
        {page === 'background' ? (
          <div className="page-scroll">
            <Suspense
              fallback={<p role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</p>}
            >
              <BackgroundPage
                state={state}
                zh={language === 'zh'}
                notify={notify}
                openConversation={(id: string) => {
                  setSelected(id);
                  setPage('chat');
                  void refresh();
                }}
              />
            </Suspense>
          </div>
        ) : page === 'settings' ? (
          <div className="page-scroll">
            <Suspense
              fallback={<p role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</p>}
            >
              <SettingsPage settings={state.settings} t={t} refresh={refresh} notify={notify} />
            </Suspense>
          </div>
        ) : page !== 'chat' ? (
          <div className="page-scroll">
            <Suspense
              fallback={<p role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</p>}
            >
              <Library
                page={page}
                state={state}
                selected={selected}
                t={t}
                refresh={refresh}
                notify={notify}
              />
            </Suspense>
          </div>
        ) : (
          <WorkbenchProvider
            key={selected || 'none'}
            events={detail?.events || []}
            zh={language === 'zh'}
          >
            <div className="chat-layout">
              <div className="chat-main">
                <div
                  className="conversation-scroll"
                  ref={scroll}
                  onScroll={() => {
                    const el = scroll.current!;
                    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 130;
                  }}
                >
                  <div className="conversation-width">
                    {!detail?.events.length ? (
                      <section className="welcome">
                        <div className="welcome-icon">
                          <Sparkles size={32} />
                        </div>
                        <div className="eyebrow">{t('A LITTLE SPACE FOR BIG IDEAS')}</div>
                        <h1>{t('welcome')}</h1>
                        <p>{t('welcomeSub')}</p>
                        <div className="suggestions">
                          {[
                            [Folder, 'Explore a project', 'Understand code, plan a change'],
                            [BookOpen, 'Work with documents', 'Find answers grounded in sources'],
                            [Sparkles, 'Start with a question', 'Think through something together'],
                          ].map(([Icon, title, sub]: any) => (
                            <button
                              key={title}
                              onClick={() => {
                                setDraft(
                                  title === 'Explore a project'
                                    ? 'Help me understand this project.'
                                    : title === 'Work with documents'
                                      ? 'Help me analyze the documents I attach.'
                                      : 'Help me think through an idea.',
                                );
                                draftRef.current?.focus();
                              }}
                            >
                              <Icon size={19} />
                              <strong>{t(title)}</strong>
                              <span>{t(sub)}</span>
                            </button>
                          ))}
                        </div>
                        {!state.settings.profiles.length && (
                          <button className="primary" onClick={() => setPage('settings')}>
                            {t('noModel')}
                          </button>
                        )}
                      </section>
                    ) : (
                      timeline()
                    )}
                    {conversation && !conversation.parentId && !conversation.isolationId && (
                      <ConversationSchedules
                        key={conversation.id}
                        conversationId={conversation.id}
                        state={state}
                        zh={language === 'zh'}
                        notify={notify}
                        openConversation={(id: string) => {
                          setSelected(id);
                          void refresh();
                        }}
                      />
                    )}
                    {Object.entries(streams).map(
                      ([key, s]: any) =>
                        s.text && (
                          <article className="message assistant streaming" key={key}>
                            <div className="message-heading">
                              <span className="avatar">
                                <Sparkles size={15} />
                              </span>
                              <strong>{t('Amadeus')}</strong>
                              <span className="working-dot" />
                            </div>
                            <div className="message-body">
                              <Markdown
                                text={s.text}
                                live
                                interaction={{ zh: language === 'zh' }}
                              />
                            </div>
                          </article>
                        ),
                    )}
                    {detail?.teamSpace && (
                      <details className="team-panel">
                        <summary>
                          {language === 'zh' ? '团队运行状态' : 'Team lifecycle'} ·{' '}
                          {detail.teamSpace.mode} · {detail.teamSpace.status}
                        </summary>
                        {detail.teamSpace.selection && (
                          <p>
                            {language === 'zh' ? '组织方式选择：' : 'Organization choice: '}
                            {detail.teamSpace.selection.reason}
                          </p>
                        )}
                        {detail.teamSpace.status === 'active' && (
                          <button
                            onClick={() =>
                              void action(() =>
                                api('/runs/' + detail.teamSpace!.id + '/stop-team', {}),
                              )
                            }
                          >
                            {language === 'zh' ? '停止整个团队' : 'Stop entire team'}
                          </button>
                        )}
                        <TeamManagement
                          team={detail.teamSpace}
                          members={detail.teamMembers}
                          zh={language === 'zh'}
                          onTransfer={(role, targetRunId) =>
                            void action(() =>
                              api('/runs/' + detail.teamSpace!.id + '/team-role', {
                                role,
                                targetRunId,
                                revision: detail.teamSpace!.revision,
                              }),
                            )
                          }
                        />
                        {detail.teamScheduling?.enabled && (
                          <div className="notice">
                            Scheduling 路 max load {detail.teamScheduling.maxLoad}
                            {detail.teamScheduling.loads?.map((m) => (
                              <div key={m.runId}>
                                {m.runId.slice(0, 8)} 路 {m.load}/{detail.teamScheduling!.maxLoad}
                              </div>
                            ))}
                            {detail.teamScheduling.blocked?.map((b) => (
                              <div key={b.taskId}>
                                {b.taskId}: {b.reason}
                              </div>
                            ))}
                          </div>
                        )}
                        {detail.teamSpace.mode === 'creative' && (
                          <div>
                            {language === 'zh'
                              ? '每成员最多可发送的团队消息数（不是辩论轮次）：'
                              : 'Discussion message limit per member: '}
                            {detail.teamSpace.maxMessages}
                            <form
                              key={detail.teamSpace.id + ':' + detail.teamSpace.maxMessages}
                              onSubmit={(e) => {
                                e.preventDefault();
                                const data = new FormData(e.currentTarget);
                                void action(() =>
                                  api('/runs/' + detail.teamSpace!.id + '/team-discussion-limit', {
                                    maxMessages: Number(data.get('maxMessages')),
                                  }),
                                );
                              }}
                            >
                              <input
                                aria-label={
                                  language === 'zh' ? '每成员讨论消息预算' : 'Messages per member'
                                }
                                name="maxMessages"
                                type="number"
                                min="1"
                                max="1000"
                                defaultValue={detail.teamSpace.maxMessages}
                              />
                              <button type="submit">
                                {language === 'zh' ? '保存讨论额度' : 'Save discussion budget'}
                              </button>
                            </form>
                            {detail.teamSpace.discussionBudget && (
                              <span>
                                {language === 'zh'
                                  ? ' · 当前成员已用 / 剩余：'
                                  : ' · Current member used / remaining: '}
                                {detail.teamSpace.discussionBudget.used} /{' '}
                                {detail.teamSpace.discussionBudget.remaining}
                              </span>
                            )}
                            <br />
                            {detail.teamSpace.autoEnroll
                              ? language === 'zh'
                                ? '本团队自动纳入后续成员'
                                : 'This team automatically enrolls new members'
                              : language === 'zh'
                                ? '本团队使用固定成员名单'
                                : 'This team uses a fixed roster'}
                          </div>
                        )}
                        {detail.teamSpace.blockers.map((b) => (
                          <p key={b}>{b}</p>
                        ))}
                      </details>
                    )}
                    {!!detail?.taskBoard?.tasks?.length && (
                      <details className="team-panel">
                        <summary>
                          {language === 'zh'
                            ? '任务计划（执行者记录）'
                            : 'Task plan (author-reported)'}{' '}
                          · {detail.taskBoard.tasks.filter((t: any) => t.status === 'done').length}/
                          {detail.taskBoard.tasks.length}
                        </summary>
                        {detail.taskBoard.tasks.map((task: any) => (
                          <div
                            className="notice"
                            key={task.id}
                            id={'plan-task-' + task.id}
                            tabIndex={-1}
                          >
                            <strong>{task.title}</strong>{' '}
                            <span className="pill">{task.status}</span>
                            <p>{task.acceptance}</p>
                            <small>
                              {language === 'zh' ? '验证' : 'Verification'}:{' '}
                              {task.verification?.status === 'checked'
                                ? language === 'zh'
                                  ? '结果已记录并绑定版本（非独立验收）'
                                  : 'Observed result bound to version (not independent review)'
                                : task.verification?.status === 'stale'
                                  ? language === 'zh'
                                    ? '已过期，需要重新检查'
                                    : 'Stale; recheck required'
                                  : language === 'zh'
                                    ? '执行者声明，未绑定版本'
                                    : 'Author-reported; no version binding'}
                            </small>
                            <small>
                              {task.id} · {task.dependsOn.join(', ')} · {task.owner || '—'}
                            </small>
                            {task.note && <p>{task.note}</p>}
                            {!!task.evidence.length && (
                              <p>
                                {language === 'zh' ? '证据事件' : 'Evidence events'}:{' '}
                                {task.evidence.join(', ')}
                              </p>
                            )}
                          </div>
                        ))}
                      </details>
                    )}
                    {!!detail?.unknownEffects.length && (
                      <details className="notice recovery-card" key={selected}>
                        <summary>
                          {language === 'zh'
                            ? '待核对的中断操作'
                            : 'Interrupted operations to inspect'}{' '}
                          · {detail.unknownEffects.length}
                        </summary>
                        <p>
                          {t('settings') !== 'Settings'
                            ? '可以继续对话并进行只读检查；未知命令不会自动重跑。先自动核对，仍无法判断时再记录人工结论。'
                            : 'You can continue chatting and inspect safely. Unknown commands are never replayed. Try automatic checks before recording a manual conclusion.'}
                        </p>
                        <button
                          onClick={() =>
                            void action(async () => {
                              await api('/conversations/' + selected + '/recovery/check', {});
                              await load(selected!);
                            })
                          }
                        >
                          {t('settings') !== 'Settings'
                            ? '自动核对现有结果'
                            : 'Check existing results automatically'}
                        </button>
                        {detail?.unknownEffects.map((e: any) => (
                          <div className="notice" key={e.id}>
                            <strong>{t('inspect')}</strong>
                            <pre>{e.tool + ' ' + e.args}</pre>
                            <p className="muted">
                              {t('settings') !== 'Settings'
                                ? '上次结果仍未知。允许重新尝试可能重复产生副作用；此按钮不立即执行，后续仍遵守正常权限与审批。'
                                : 'The previous outcome remains unknown. Retrying may duplicate side effects. This button does not execute anything; normal permissions and approval still apply.'}
                            </p>
                            <button
                              disabled={running}
                              onClick={() =>
                                void action(async () => {
                                  await api('/effects/' + e.id + '/allow-retry', {});
                                  await load(selected!);
                                })
                              }
                            >
                              {t('settings') !== 'Settings'
                                ? '允许下次重新尝试'
                                : 'Allow another attempt'}
                            </button>

                            <button
                              onClick={() =>
                                void action(async () => {
                                  const note = prompt(
                                    'Describe the actual outcome after inspecting the files/processes.',
                                  );
                                  if (note) {
                                    await api('/effects/' + e.id + '/resolve', { note });
                                    await load(selected!);
                                  }
                                })
                              }
                            >
                              {t('Record inspected outcome')}
                            </button>
                          </div>
                        ))}
                      </details>
                    )}
                    {run && !running && (
                      <div className={'run-result ' + run.status}>
                        <span className="dot" />
                        {run.status}
                        <span>{totalUsage!.modelCalls} model calls 路 parent + children</span>
                        <span>
                          {(totalUsage!.inputTokens + totalUsage!.outputTokens).toLocaleString()}{' '}
                          tokens
                        </span>
                        <span>
                          {totalUsage!.estimatedUsd === null
                            ? t('unknownCost')
                            : '~$' + totalUsage!.estimatedUsd!.toFixed(5)}
                        </span>
                      </div>
                    )}
                    <div ref={bottom} />
                  </div>
                </div>
                <>
                  <Composer
                    onConfigureModels={() => setPage('settings')}
                    ensureConversation={async () => selected || (await newChat())}
                    {...{
                      run,
                      running,
                      detail,
                      send,
                      draft,
                      setDraft,
                      drag,
                      setDrag,
                      action,
                      addFiles,
                      removeAttachment,
                      draftRef,
                      upload,
                      profile,
                      state,
                      conversation,
                      update,
                      project,
                      t,
                      stick,
                      bottom,
                      sending,
                    }}
                  />
                </>
              </div>
              {inspector && (
                <Inspector
                  {...{
                    t,
                    setInspector,
                    tab: inspectorTab,
                    setTab: setInspectorTab,
                    conversation,
                    running,
                    state,
                    action,
                    update,
                    project,
                    run: totalUsage,
                  }}
                />
              )}
            </div>
          </WorkbenchProvider>
        )}
      </main>
      {deleteTarget && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-chat-title"
          >
            <h2 id="delete-chat-title">
              {language === 'zh' ? '彻底删除对话？' : 'Permanently delete conversation?'}
            </h2>
            <p>
              {language === 'zh'
                ? '将删除此对话及其子 Agent 的消息、运行记录和专属附件/产物，无法在应用内恢复。独立分支、已保存的长期记忆和项目磁盘文件保留。运行中的任务需先停止。'
                : 'Deletes this conversation, its agent children, messages, run records and exclusive attachments/artifacts. This cannot be undone in the app. Independent branches, saved memories and project files are retained. Stop running tasks first.'}
            </p>
            <label>
              {language === 'zh'
                ? '输入完整对话标题确认：'
                : 'Type the exact conversation title to confirm:'}
              <strong>{deleteTarget.title}</strong>
              <input
                autoFocus
                disabled={deleting}
                value={deleteTitle}
                onChange={(e) => setDeleteTitle(e.target.value)}
              />
            </label>
            <div className="row end">
              <button disabled={deleting} onClick={() => setDeleteTarget(null)}>
                {t('cancel')}
              </button>
              <button
                disabled={deleting || deleteTitle !== deleteTarget.title}
                onClick={() =>
                  void action(async () => {
                    setDeleting(true);
                    try {
                      const result = await api(
                        '/conversations/' + deleteTarget.id,
                        { confirmTitle: deleteTitle, permanent: true },
                        'DELETE',
                      );
                      for (const id of result.deleted) detailCache.current.delete(id);
                      if (selected && result.deleted.includes(selected)) {
                        setSelected(null);
                        setDetail(null);
                        localStorage.removeItem('agentdemo.chat');
                      }
                      setDeleteTarget(null);
                      await refresh();
                    } finally {
                      setDeleting(false);
                    }
                  })
                }
              >
                {deleting
                  ? language === 'zh'
                    ? '正在删除…'
                    : 'Deleting…'
                  : language === 'zh'
                    ? '确认彻底删除'
                    : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
      {projectDialog && (
        <ProjectDialog
          project={editingProject}
          onSaved={refresh}
          {...{
            t,
            setProjectDialog,
            projectName,
            setProjectName,
            projectFolders,
            setProjectFolders,
            language,
            action,
            newChat,
          }}
        />
      )}
      {copyFallback !== null && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={language === 'zh' ? '手动复制对话' : 'Copy conversation manually'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCopyFallback(null);
            }}
          >
            <h2>{language === 'zh' ? '浏览器未允许写入剪贴板' : 'Clipboard access unavailable'}</h2>
            <p>
              {language === 'zh'
                ? '内容已选中，按 Ctrl+C 复制完整对话。'
                : 'Text selected. Press Ctrl+C to copy the entire conversation.'}
            </p>
            <textarea
              aria-label={language === 'zh' ? '完整对话' : 'Entire conversation'}
              readOnly
              value={copyFallback}
              rows={12}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              style={{ width: '100%' }}
            />
            <button onClick={() => setCopyFallback(null)}>
              {language === 'zh' ? '关闭' : 'Close'}
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
