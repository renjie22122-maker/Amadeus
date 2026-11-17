import { lazy, Suspense, useEffect, useState } from 'react';
const BrowserVoiceChat = lazy(() =>
  import('./BrowserVoiceChat').then((m) => ({ default: m.BrowserVoiceChat })),
);
import { api, bootstrap } from '../api';
export function PersonalDot() {
  const [snapshot, setSnapshot] = useState<any>(),
    [error, setError] = useState('');
  const [voice, setVoice] = useState(false);
  const [screen, setScreen] = useState<string | null>(null),
    [capturing, setCapturing] = useState(false);
  const [text, setText] = useState(''),
    [sending, setSending] = useState(false);
  useEffect(() => {
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
        const value = await api('/personal/dot', undefined, 'GET', {}, controller.signal);
        if (!controller.signal.aborted) {
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
  }, []);
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
  if (voice && snapshot?.identity)
    return (
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
    <div className="personal-dot">
      <strong>{snapshot?.identity?.name || 'Amadeus'}</strong>
      <span role="status">
        {error ||
          (snapshot?.active
            ? '正在处理'
            : snapshot?.identity
              ? '随时可以聊'
              : '请先选择常驻助手会话')}
      </span>
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
          <img src={screen} alt="待发送的屏幕截图" style={{ maxWidth: '100%', maxHeight: 120 }} />
          <button onClick={() => setScreen(null)}>移除截图</button>
        </div>
      )}
      <button disabled={!snapshot?.identity || capturing || sending} onClick={() => void capture()}>
        {capturing ? '选择中…' : '选择屏幕或窗口截图'}
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          aria-label="发送消息"
          value={text}
          maxLength={10000}
          disabled={!snapshot?.identity || sending}
          onChange={(e) => setText(e.target.value)}
          placeholder="说点什么…"
        />
        <button disabled={sending || !text.trim() || !snapshot?.identity}>
          {sending ? '发送中' : '发送'}
        </button>
      </form>
      <button disabled={!snapshot?.identity} onClick={() => setVoice(true)}>
        语音对话
      </button>
      <button onClick={open}>打开助手与后台任务</button>
    </div>
  );
}
