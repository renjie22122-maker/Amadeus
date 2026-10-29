import './VideoAccountSettings.css';
import { useEffect, useState } from 'react';
import { api } from '../api';
export function VideoAccountSettings({
  zh,
  notify,
}: {
  zh: boolean;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  async function load() {
    try {
      setData(await api('/settings/video-accounts'));
    } catch (e: any) {
      notify(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function change(platform: string, patch: any) {
    setData((d: any) => ({
      ...d,
      accounts: d.accounts.map((a: any) => (a.platform === platform ? { ...a, ...patch } : a)),
    }));
  }
  return (
    <section className="panel video-account-settings">
      <h2>{zh ? '视频读取 · 登录账号使用范围' : 'Video reading · account access'}</h2>
      <p className="muted">
        {zh
          ? '仅控制哪些会话可以借用本机已配置的登录账号读取视频、字幕和评论。群聊默认不授权；不显示 Cookie 内容。保存此处立即生效，无需重启。'
          : 'Controls which conversations may use configured local accounts for videos, subtitles and comments. Groups are denied by default. Cookie contents are never displayed. Saves apply without restart.'}
      </p>
      <button disabled={busy} onClick={load}>
        {zh ? '刷新账号范围' : 'Refresh account access'}
      </button>
      {!data ? (
        <p>{zh ? '加载中…' : 'Loading…'}</p>
      ) : !data.accounts.length ? (
        <p>
          {zh
            ? '尚未配置本机视频账号。请在本机 video-reader.json 中配置 Cookies 文件路径。'
            : 'No account configured. Set a Cookies file path in local video-reader.json.'}
        </p>
      ) : (
        data.accounts.map((a: any) => (
          <details key={a.platform} open>
            <summary>{a.platform === 'bilibili' ? 'B站 / Bilibili' : 'YouTube'}</summary>
            <label>
              <input
                type="checkbox"
                checked={a.allowLocalConversations}
                onChange={(e) => change(a.platform, { allowLocalConversations: e.target.checked })}
              />
              {zh ? '允许本地普通对话和项目对话' : 'Allow local and project conversations'}
            </label>
            <label>
              <input
                type="checkbox"
                checked={['qq', 'onebot11'].every((t) => a.privateChatTransports.includes(t))}
                onChange={(e) =>
                  change(a.platform, {
                    privateChatTransports: [
                      ...a.privateChatTransports.filter(
                        (t: string) => !['qq', 'onebot11'].includes(t),
                      ),
                      ...(e.target.checked ? ['qq', 'onebot11'] : []),
                    ],
                  })
                }
              />
              {zh
                ? '允许 QQ 私聊（当前及以后接入的私聊）'
                : 'Allow QQ private chats (existing and future)'}
            </label>
            <p>
              {zh
                ? '额外授权指定会话（包括逐群授权）'
                : 'Additionally allow selected conversations, including individual groups'}
            </p>
            <input
              aria-label={zh ? '筛选会话' : 'Filter conversations'}
              placeholder={zh ? '搜索会话名称或 ID' : 'Search title or ID'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {data.conversations
                .filter((c: any) => (c.title + c.id).toLowerCase().includes(query.toLowerCase()))
                .map((c: any) => {
                  const connections = data.connections.filter(
                    (v: any) => v.conversationId === c.id,
                  );
                  return (
                    <label key={c.id} style={{ display: 'flex', gap: 8, padding: 6 }}>
                      <input
                        type="checkbox"
                        checked={a.conversationIds.includes(c.id)}
                        onChange={(e) =>
                          change(a.platform, {
                            conversationIds: e.target.checked
                              ? [...a.conversationIds, c.id]
                              : a.conversationIds.filter((id: string) => id !== c.id),
                          })
                        }
                      />
                      <span>
                        {c.title || c.id}
                        <small className="muted" style={{ display: 'block' }}>
                          {connections
                            .map((v: any) =>
                              [v.transport, v.peerType, v.peerId].filter(Boolean).join(' · '),
                            )
                            .join(', ') || (zh ? '本地 / 项目' : 'Local / project')}
                        </small>
                      </span>
                    </label>
                  );
                })}
            </div>
            {a.conversationIds
              .filter((id: string) => !data.conversations.some((c: any) => c.id === id))
              .map((id: string) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      change(a.platform, {
                        conversationIds: a.conversationIds.filter((v: string) => v !== id),
                      })
                    }
                  />
                  {zh ? '会话已不可用：' : 'Unavailable conversation: '}
                  {id}
                </label>
              ))}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const saved = await api(
                    '/settings/video-accounts',
                    {
                      revision: data.revision,
                      platform: a.platform,
                      scope: {
                        allowLocalConversations: a.allowLocalConversations,
                        privateChatTransports: a.privateChatTransports,
                        conversationIds: a.conversationIds,
                      },
                    },
                    'PUT',
                  );
                  setData({ ...data, ...saved });
                  notify(zh ? '账号范围已保存' : 'Account access saved');
                } catch (e: any) {
                  notify(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {zh ? '保存此账号范围' : 'Save account access'}
            </button>
          </details>
        ))
      )}
    </section>
  );
}
