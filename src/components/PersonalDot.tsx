import { RunReceipt } from './RunReceipt';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
const BrowserVoiceChat = lazy(() =>
  import('./BrowserVoiceChat').then((m) => ({ default: m.BrowserVoiceChat })),
);
import { DotWritingPanel } from './DotWritingPanel';
import { writingTools, type WritingMode } from '../../shared/dot-writing';
import { api, bootstrap } from '../api';
export function PersonalDot() {
  const [snapshot, setSnapshot] = useState<any>(),
    [error, setError] = useState('');
  const [compact, setCompact] = useState(true);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [mode, setMode] = useState('聊天');
  async function fold(value: boolean) {
    const bridge = (
      window as Window & { amadeusDesktop?: { setDotCollapsed: (v: boolean) => Promise<boolean> } }
    ).amadeusDesktop;
    if (await bridge?.setDotCollapsed?.(value)) setCompact(value);
  }
  const generation = useRef(0);
  const [choices, setChoices] = useState<{ id: string; title: string }[] | null>(null);
  const [binding, setBinding] = useState(false);
  async function choose(id?: string) {
    setBinding(true);
    generation.current++;
    try {
      if (id === undefined) {
        const [chats, spaces] = await Promise.all([
          api('/personal/dot/conversations'),
          api('/personal/dot/projects'),
        ]);
        setChoices(chats);
        setProjects(spaces);
        return;
      }
      const target =
        id ||
        (await api('/conversations', { projectId: projectId || null, title: 'Dot · 新对话' })).id;
      await api('/personal/dot/binding', { conversationId: target });
      const next = await api('/personal/dot');
      generation.current++;
      setSnapshot(next);
      setAssist('off');
      setChoices(null);
      setScreen(null);
      setText('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '切换失败');
    } finally {
      setBinding(false);
    }
  }
  const [voice, setVoice] = useState(false);
  const [screen, setScreen] = useState<string | null>(null),
    [capturing, setCapturing] = useState(false);
  const [text, setText] = useState(''),
    [sending, setSending] = useState(false);
  const [assist, setAssist] = useState('off');
  const [composing, setComposing] = useState(false);
  const [suggestion, setSuggestion] = useState<{ draft: string; value: string } | null>(null);
  const [assistError, setAssistError] = useState('');
  const dismissed = useRef('');
  const conversationId = snapshot?.identity?.conversationId;
  useEffect(() => {
    setSuggestion(null);
    setAssistError('');
    if (
      mode !== '聊天' ||
      assist === 'off' ||
      compact ||
      voice ||
      sending ||
      composing ||
      binding ||
      choices ||
      !conversationId ||
      text.trim().length < 4 ||
      dismissed.current === text
    )
      return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const draft = text.slice(-2000);
        const { suggestion: value } = await api(
          '/personal/dot/draft-suggestion',
          { conversationId, draft, mode: assist },
          'POST',
          {},
          controller.signal,
        );
        if (!controller.signal.aborted && value && (assist !== 'grammar' || value !== draft))
          setSuggestion({ draft: text, value });
      } catch {
        if (!controller.signal.aborted) setAssistError('本次建议未能生成，可继续输入');
      }
    }, 1100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, assist, compact, voice, sending, composing, binding, choices, conversationId, text]);
  useEffect(() => {
    if (compact) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let authenticated = false;
    async function poll() {
      try {
        if (!authenticated) {
          await bootstrap();
          authenticated = true;
        }
        if (controller.signal.aborted) return;
        const current = generation.current;
        const value = await api('/personal/dot', undefined, 'GET', {}, controller.signal);
        if (!controller.signal.aborted && current === generation.current) {
          setSnapshot(value);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) setError('连接中断，请检查主服务');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden ? 30000 : 5000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [compact]);
  const open = () =>
    (
      window as Window & { amadeusDesktop?: { openAgent?: () => void } }
    ).amadeusDesktop?.openAgent?.();
  async function capture() {
    setCapturing(true);
    try {
      const desktop = (
        window as Window & { amadeusDesktop?: { captureContext?: () => Promise<string | null> } }
      ).amadeusDesktop;
      setScreen((await desktop?.captureContext?.()) || null);
    } catch {
      setError('截图失败，可重试或直接打开助手');
    } finally {
      setCapturing(false);
    }
  }
  async function send() {
    if (!text.trim() || sending || !snapshot?.identity) return;
    setSending(true);
    setError('');
    try {
      if (screen) {
        const blob = await (await fetch(screen)).blob();
        const form = new FormData();
        form.append('file', blob, 'screen-context.png');
        await api(
          '/upload?conversationId=' + encodeURIComponent(snapshot.identity.conversationId),
          form,
        );
        setScreen(null);
      }
      await api(
        '/conversations/' + encodeURIComponent(snapshot.identity.conversationId) + '/message',
        { text },
      );
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  }
  const tab = (
    <button className="dot-tab" aria-label="展开 Amadeus Dot" onClick={() => void fold(false)}>
      <span aria-hidden="true">•••</span>
    </button>
  );
  const voicePanel = (
    <div className="personal-dot personal-dot-voice">
      {' '}
      {voice && snapshot?.identity && (
        <Suspense fallback={<span>加载语音…</span>}>
          <BrowserVoiceChat
            connection={{
              id: 'personal',
              name: snapshot.identity.name,
              conversationId: snapshot.identity.conversationId,
            }}
            voiceBase="/personal/voice-turn"
            zh={true}
            close={() => setVoice(false)}
            openConversation={open}
          />
        </Suspense>
      )}
      <button onClick={() => setVoice(false)}>返回聊天</button>
    </div>
  );
  return (
    <>
      {compact && tab}
      {!compact && voice && snapshot?.identity && voicePanel}
      <div className="personal-dot" hidden={compact || !!(voice && snapshot?.identity)}>
        <header className="dot-heading">
          <span className="personal-dot-orb" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>{snapshot?.identity?.name || 'Amadeus'}</strong>
            <small>{snapshot?.title || '尚未绑定会话'}</small>
          </div>
          <button
            title="收起到屏幕边缘"
            aria-label="收起到屏幕边缘"
            onClick={() => void fold(true)}
          >
            ›
          </button>
          <button
            disabled={sending || binding || capturing || !!text || !!screen}
            onClick={() => (choices ? setChoices(null) : void choose())}
          >
            {choices ? '收起' : '会话'}
          </button>
        </header>
        {choices && (
          <div className="dot-choices">
            <select
              aria-label="切换会话"
              value={snapshot?.identity?.conversationId || ''}
              disabled={binding}
              onChange={(e) => void choose(e.target.value)}
            >
              <option value="" disabled>
                选择会话
              </option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <select
              aria-label="新会话所属项目"
              value={projectId}
              disabled={binding}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">普通对话</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button disabled={binding} onClick={() => void choose('')}>
              新建会话
            </button>
          </div>
        )}
        <div className="dot-body">
          <nav className="dot-tools" aria-label="写作工具">
            {(window as Window & { amadeusDesktop?: { platform?: string } }).amadeusDesktop
              ?.platform === 'win32' &&
              (window as Window & { amadeusDesktop?: { openWritingApps?: () => Promise<void> } })
                .amadeusDesktop?.openWritingApps && (
                <button
                  onClick={() => {
                    void (window as any).amadeusDesktop
                      .openWritingApps()
                      .catch(() => setError('无法启动应用写作辅助'));
                  }}
                >
                  应用辅助
                </button>
              )}
            {['聊天', ...Object.keys(writingTools)].map((name) => (
              <button key={name} aria-pressed={mode === name} onClick={() => setMode(name)}>
                {name}
              </button>
            ))}
          </nav>
          <div hidden={mode === '聊天'} className="dot-workspace">
            <DotWritingPanel
              key={conversationId || 'unbound'}
              conversationId={conversationId}
              mode={(mode === '聊天' ? '改写' : mode) as WritingMode}
            />
          </div>
          <section hidden={mode !== '聊天'} className="dot-content">
            <span role="status">
              {error ||
                (snapshot?.active
                  ? '正在处理'
                  : snapshot?.identity
                    ? '随时可以聊'
                    : '请先选择常驻助手会话')}
            </span>
            {snapshot?.latestRunId && conversationId && (
              <RunReceipt
                key={conversationId + ':' + snapshot.latestRunId}
                runId={snapshot.latestRunId}
                conversationId={conversationId}
                zh
                dot
              />
            )}
            <div className="personal-dot-messages" aria-label="最近消息">
              {snapshot?.events.map((e: any) => (
                <p key={e.id}>
                  <b>{e.type === 'user.message' ? '你' : '助手'}：</b>
                  {e.text}
                </p>
              ))}
            </div>
            {screen && (
              <div>
                <img
                  src={screen}
                  alt="待发送的屏幕截图"
                  style={{ maxWidth: '100%', maxHeight: 120 }}
                />
                <button onClick={() => setScreen(null)}>移除截图</button>
              </div>
            )}
            <button
              disabled={!snapshot?.identity || capturing || sending || binding || !!choices}
              onClick={() => void capture()}
            >
              {capturing ? '选择中…' : '选择屏幕或窗口截图'}
            </button>
            <label>
              输入辅助{' '}
              <select
                value={assist}
                onChange={(e) => {
                  dismissed.current = '';
                  setAssist(e.target.value);
                }}
              >
                <option value="off">关闭</option>
                <option value="grammar">语法建议</option>
                <option value="sentence">补完当前句</option>
                <option value="paragraph">续写下一段</option>
              </select>
            </label>
            {assist !== 'off' && (
              <small>停顿后将最近 2,000 个字符发送给当前会话模型，可能产生费用。</small>
            )}
            {assistError && <small role="status">{assistError}</small>}
            {suggestion?.draft === text && suggestion && (
              <aside className="dot-suggestion">
                {suggestion.value}
                <small>Tab 采纳 · Esc 忽略</small>
              </aside>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                rows={3}
                aria-label="发送消息"
                value={text}
                maxLength={10000}
                disabled={!snapshot?.identity || sending || binding || !!choices}
                onChange={(e) => setText(e.target.value)}
                spellCheck
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || composing) return;
                  if (
                    suggestion &&
                    suggestion.draft === text &&
                    (e.key === 'Escape' ||
                      (e.key === 'Tab' &&
                        !e.shiftKey &&
                        e.currentTarget.selectionStart === text.length &&
                        e.currentTarget.selectionEnd === text.length))
                  ) {
                    e.preventDefault();
                    const next =
                      e.key === 'Escape'
                        ? text
                        : assist === 'grammar'
                          ? text.slice(0, Math.max(0, text.length - 2000)) + suggestion.value
                          : text + (assist === 'paragraph' ? '\n\n' : '') + suggestion.value;
                    dismissed.current = next;
                    setText(next);
                    setSuggestion(null);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={mode === '聊天' ? '说点什么…' : '粘贴材料或输入要求…'}
              />
              <button disabled={sending || !text.trim() || !snapshot?.identity}>
                {sending ? '发送中' : '发送'}
              </button>
            </form>
            <button
              disabled={!snapshot?.identity || binding || !!choices}
              onClick={() => setVoice(true)}
            >
              语音对话
            </button>
            <button onClick={open}>打开助手与后台任务</button>
          </section>
        </div>
      </div>
    </>
  );
}
