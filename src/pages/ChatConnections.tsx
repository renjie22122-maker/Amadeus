import '../chat-connections.css';
import { useEffect, useState } from 'react';
import { MessageCircle, Pause, Plus, Trash2, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { chatPlatforms, type ChatConnection } from '../../shared/chat-connections';
import type { Conversation } from '../../shared/types';
type Form = Omit<ChatConnection, 'id' | 'authorizedTarget' | 'activatedAt' | 'revision'> & {
  id?: string;
  token: string;
  appSecret: string;
  verifyToken: string;
};
const blank: Form = {
  name: '',
  transport: 'telegram',
  conversationId: '',
  senderId: '',
  peerId: '',
  enabled: false,
  endpoint: '',
  accountId: '',
  apiVersion: '',
  webhookPort: 8788,
  remoteApprovals: false,
  token: '',
  appSecret: '',
  verifyToken: '',
};
export function ChatConnectionsPage({
  conversations,
  zh,
  notify,
  openConversation,
}: {
  conversations: Conversation[];
  zh: boolean;
  notify: (s: string) => void;
  openConversation: (id: string) => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [form, setForm] = useState<Form | null>(null),
    [busy, setBusy] = useState(false),
    [deliveries, setDeliveries] = useState<{ id: string; rows: any[] } | null>(null);
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const refresh = async () => {
    const r = await api('/chat-connections');
    setItems(r.connections);
  };
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api('/chat-connections')
        .then((r) => {
          if (!disposed) setItems(r.connections);
        })
        .catch((e) => {
          if (!disposed) notify(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof Form, value: unknown) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const platform = chatPlatforms.find((p) => p.transport === form?.transport);
  return (
    <section className="chat-connections-page">
      <header className="chat-connections-heading">
        <div>
          <h1>
            <MessageCircle size={24} /> {tr('接入聊天', 'Chat connections')}
          </h1>
          <p>
            {tr(
              '从可信的私聊发送任务，并把结果和审批带回手机。',
              'Send tasks from a trusted private chat and receive results and approvals on your phone.',
            )}
          </p>
        </div>
        <button onClick={() => setForm({ ...blank })}>
          <Plus size={16} />
          {tr('添加接入', 'Add connection')}
        </button>
      </header>
      <p className="muted">
        {tr(
          '接收绑定账号的私聊文字、图片、语音、视频和文档，不接收群聊或转发。会话历史、文件范围和权限沿用所选会话；建议创建专用会话。接入端能看到任务结果及你允许发送的审批内容。',
          'Bound private text and supported media/documents are accepted; groups and forwards are excluded. The selected conversation retains its history, file scope and permissions. A dedicated conversation is recommended. The platform receives results and enabled approval payloads.',
        )}
      </p>
      {!items.length && (
        <div className="chat-connection-card">
          {tr(
            '尚未配置。选择平台后填写账号凭据、可信联系人和目标会话。',
            'No connections yet. Choose a platform, credentials, trusted contact and target conversation.',
          )}
        </div>
      )}
      <div className="chat-connection-grid">
        {items.map((c) => (
          <article className="chat-connection-card" key={c.id}>
            <div className="chat-connections-heading">
              <strong>{c.name}</strong>
              <span className="pill">{c.enabled ? c.status.status : tr('已暂停', 'Paused')}</span>
            </div>
            <p>
              {chatPlatforms.find((p) => p.transport === c.transport)?.name} · {c.senderId}
            </p>
            <p className="muted">
              {c.status.error ||
                tr(
                  '等待平台消息；保存配置不代表已经连通。',
                  'Waiting for messages; saving configuration does not prove connectivity.',
                )}
            </p>
            <p>
              {tr('排队', 'Queued')}: {c.queued} ·{' '}
              {c.remoteApprovals
                ? tr('允许单次远程审批', 'One-time remote approvals enabled')
                : tr('本机审批', 'Local approvals')}
            </p>
            <div className="chat-connection-actions">
              <button onClick={() => openConversation(c.conversationId)}>
                {tr('打开会话', 'Open chat')}
              </button>
              <button
                onClick={() => {
                  const {
                    authorizedTarget: _,
                    activatedAt: __,
                    revision: ___,
                    status: ____,
                    deliveries: _____,
                    queued: ______,
                    ...rest
                  } = c;
                  setForm({ ...rest, token: '', appSecret: '', verifyToken: '' });
                }}
              >
                {tr('配置', 'Configure')}
              </button>
              {c.enabled && (
                <button
                  disabled={busy}
                  onClick={() => void act(() => api('/chat-connections/' + c.id + '/pause', {}))}
                >
                  <Pause size={14} />
                  {tr('暂停接入', 'Pause')}
                </button>
              )}
              <button
                disabled={busy || c.enabled}
                onClick={() => {
                  if (
                    confirm(
                      tr(
                        '删除接入？本地会话和执行记录保留。',
                        'Remove connection? Local chat and execution history remain.',
                      ),
                    )
                  )
                    void act(() => api('/chat-connections/' + c.id, {}, 'DELETE'));
                }}
              >
                <Trash2 size={14} />
                {tr('删除', 'Remove')}
              </button>
            </div>
            {c.deliveries.some((d: any) => d.state === 'uncertain') && (
              <button
                onClick={() =>
                  void act(async () =>
                    setDeliveries({
                      id: c.id,
                      rows: await api('/chat-connections/' + c.id + '/deliveries'),
                    }),
                  )
                }
              >
                {tr('核对未确认的发送', 'Review uncertain deliveries')}
              </button>
            )}
          </article>
        ))}
      </div>
      {deliveries && (
        <div className="chat-connection-card">
          <h2>{tr('发送结果不确定', 'Uncertain deliveries')}</h2>
          <p>
            {tr(
              '请先检查手机，重发可能产生重复消息。',
              'Check your phone first; retrying may duplicate a message.',
            )}
          </p>
          {deliveries.rows.map((d) => (
            <div key={d.id}>
              <pre>{d.text}</pre>
              <button
                onClick={() =>
                  void act(async () => {
                    await api('/chat-connections/' + deliveries.id + '/delivery', {
                      id: d.id,
                      decision: 'dismiss',
                    });
                    setDeliveries(null);
                  })
                }
              >
                {tr('已收到／不再发送', 'Received / dismiss')}
              </button>
              <button
                onClick={() => {
                  if (confirm(tr('确认重发？可能重复。', 'Retry? This may duplicate the message.')))
                    void act(async () => {
                      await api('/chat-connections/' + deliveries.id + '/delivery', {
                        id: d.id,
                        decision: 'retry',
                      });
                      setDeliveries(null);
                    });
                }}
              >
                {tr('重发', 'Retry')}
              </button>
            </div>
          ))}
          <button onClick={() => setDeliveries(null)}>{tr('关闭', 'Close')}</button>
        </div>
      )}
      {form && (
        <form
          className="chat-connection-card chat-connection-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const { id, ...body } = form;
              await api('/chat-connections' + (id ? '/' + id : ''), body, id ? 'PUT' : 'POST');
              setForm(null);
            });
          }}
        >
          <h2>{tr('接入设置', 'Connection settings')}</h2>
          <label>
            {tr('平台 / 协议', 'Platform / protocol')}
            <select
              disabled={!!form.id}
              value={form.transport}
              onChange={(e) => {
                const transport = e.target.value as Form['transport'];
                setForm({
                  ...blank,
                  transport,
                  name: chatPlatforms.find((p) => p.transport === transport)?.name || '',
                  conversationId: form.conversationId,
                });
              }}
            >
              {chatPlatforms.map((p) => (
                <option key={p.id} value={p.transport}>
                  {p.name}
                  {p.official ? '' : ' · ' + tr('第三方桥接', 'third-party bridge')}
                </option>
              ))}
            </select>
          </label>
          <a href={platform?.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {tr('官方 / 上游接入说明', 'Official / upstream setup')}
          </a>
          {form.transport.startsWith('onebot') && (
            <p role="note">
              {tr(
                '需要另行安装、登录可信 OneBot 桥接器；不是扫码即用的官方机器人。微信桥接有严格客户端版本要求，未经真机验证，不自动降级或安装旧版微信。',
                'Requires a separately installed, signed-in trusted OneBot bridge. This is not an official QR-login bot. WeChat bridges have client-version constraints; no automatic downgrade or installation.',
              )}
            </p>
          )}
          <label>
            {tr('名称', 'Name')}
            <input
              required
              maxLength={80}
              value={form.name}
              onChange={(e) => field('name', e.target.value)}
            />
          </label>
          <label>
            {tr('目标会话（包含已有历史）', 'Target conversation (including history)')}
            <select
              required
              disabled={!!form.id}
              value={form.conversationId}
              onChange={(e) => field('conversationId', e.target.value)}
            >
              <option value="">{tr('选择专用会话', 'Choose a dedicated chat')}</option>
              {conversations
                .filter((c) => !c.archived && !c.parentId && !c.isolationId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} · {c.permission}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {tr('可信私聊用户 ID（不是昵称）', 'Trusted private user ID (not display name)')}
            <input
              required
              disabled={!!form.id}
              value={form.senderId}
              onChange={(e) => {
                field('senderId', e.target.value);
                field('peerId', e.target.value);
              }}
            />
          </label>
          <label>
            {tr('服务令牌（编辑时留空保留）', 'Service token (blank keeps saved token)')}
            <input
              type="password"
              autoComplete="new-password"
              required={!form.id}
              value={form.token}
              onChange={(e) => field('token', e.target.value)}
            />
          </label>
          {form.transport !== 'telegram' && (
            <label>
              {tr(
                '机器人账号 / VK 社群 ID / WhatsApp Phone Number ID',
                'Bot account / VK community ID / WhatsApp Phone Number ID',
              )}
              <input
                required
                disabled={!!form.id}
                value={form.accountId}
                onChange={(e) => field('accountId', e.target.value)}
              />
            </label>
          )}
          {form.transport.startsWith('onebot') && (
            <label>
              {tr('本机 OneBot WebSocket 地址', 'Local OneBot WebSocket address')}
              <input
                required
                placeholder="ws://127.0.0.1:3001"
                disabled={!!form.id}
                value={form.endpoint}
                onChange={(e) => field('endpoint', e.target.value)}
              />
            </label>
          )}
          {['vk', 'whatsapp'].includes(form.transport) && (
            <label>
              {tr(
                '平台 API 版本（取自开发者后台）',
                'Platform API version (from developer dashboard)',
              )}
              <input
                required
                value={form.apiVersion}
                onChange={(e) => field('apiVersion', e.target.value)}
              />
            </label>
          )}
          {['whatsapp', 'qq'].includes(form.transport) && (
            <>
              {form.transport === 'whatsapp' && (
                <>
                  <label>
                    Meta App Secret
                    <input
                      type="password"
                      autoComplete="new-password"
                      required={!form.id}
                      value={form.appSecret}
                      onChange={(e) => field('appSecret', e.target.value)}
                    />
                  </label>
                  <label>
                    Webhook Verify Token
                    <input
                      type="password"
                      autoComplete="new-password"
                      required={!form.id}
                      value={form.verifyToken}
                      onChange={(e) => field('verifyToken', e.target.value)}
                    />
                  </label>
                </>
              )}
              <label>
                {tr('独立 Webhook 本机端口', 'Dedicated local webhook port')}
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={form.webhookPort}
                  onChange={(e) => field('webhookPort', Number(e.target.value))}
                />
              </label>
              <p>
                {tr(
                  '需要 HTTPS 反向代理，仅代理独立 Webhook 端口，不要暴露 Amadeus 管理端口。回调路径保存后显示；遵守平台回复时间和次数限制。QQ 官方用 AppSecret 填入服务令牌，可信联系人填写 openid 而非 QQ 号。',
                  'Requires an HTTPS reverse proxy to the dedicated webhook port only. Never expose the Amadeus admin port. The callback path appears after saving; Platform reply windows/quotas apply. For official QQ use AppSecret as the token and the contact openid (not QQ number).',
                )}
              </p>
              {form.id && (
                <code>
                  {'http://127.0.0.1:' + form.webhookPort + '/' + form.transport + '/' + form.id}
                </code>
              )}
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={form.remoteApprovals}
              onChange={(e) => field('remoteApprovals', e.target.checked)}
            />
            {tr(
              '允许绑定账号进行单次审批：操作详情会发到聊天平台，15 分钟有效；敏感或过长内容仍在本机核对。',
              'Allow one-time approvals by the bound account: operation details are sent to the platform, valid for 15 minutes. Sensitive/large payloads require local review.',
            )}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => field('enabled', e.target.checked)}
            />
            {tr(
              '启用，并授权此账号向所选会话发送任务及接收结果（可能产生模型费用）。',
              'Enable and authorize this account to send tasks to the selected chat and receive results (model charges may apply).',
            )}
          </label>
          <p className="muted">
            {tr(
              '远程传输最多 50 MiB/文件、10 个附件/消息；Telegram 官方下载最多 20 MiB，文档解析最多 25 MiB。平台格式限制另外生效；语音转写和生成沿用本地媒体服务与审批。/status 查看运行状态；/stop 停止当前任务并取消待处理远程消息。普通消息按序处理，不会发送本机输入框草稿。审批使用精确的一次性指令，不能修改永久权限。',
              'Remote transfer budget: 50 MiB/file, 10 attachments/message; Telegram download: 20 MiB; document parsing: 25 MiB. Provider format limits also apply. Transcription/generation uses configured media services and approvals. /status checks progress; /stop stops the active task and cancels queued remote messages. Messages are processed in order; the local composer draft is never submitted. Approval commands cannot change permanent permissions.',
            )}
          </p>
          <div className="chat-connection-actions">
            <button type="submit" className="primary" disabled={busy}>
              {tr('保存', 'Save')}
            </button>
            <button type="button" onClick={() => setForm(null)}>
              {tr('取消', 'Cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
