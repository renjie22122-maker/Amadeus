import { ChatNotebook } from '../components/ChatNotebook';
import { BrowserVoiceChat } from '../components/BrowserVoiceChat';
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
  peerType: 'private',
  accessMode: 'chat',
  allowedSenders: [],
  allGroupMembers: false,
  groupPrefix: '/amadeus',
  sharedKnowledge: true,
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
  const [mediaServices, setMediaServices] = useState<any[]>([]);
  const [voiceChat, setVoiceChat] = useState<ChatConnection | null>(null);
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const refresh = async () => {
    const r = await api('/chat-connections');
    setItems(r.connections);
    setMediaServices(r.mediaServices || []);
  };
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api('/chat-connections')
        .then((r) => {
          if (!disposed) {
            setItems(r.connections);
            setMediaServices(r.mediaServices || []);
          }
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
              '连接私聊或群聊，区分普通聊天与授权远程工作。',
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
          '为指定私聊或群聊选择普通聊天或远程工作。普通聊天新建隔离会话，支持联网、多媒体与授权知识库；远程工作使用所选会话的权限和历史。群聊输出对全群可见。',
          'Choose ordinary chat or remote work for a private contact or group. Ordinary chat creates isolated history with web, media and authorized knowledge; work inherits the chosen conversation permissions and history. Group replies are visible to all members.',
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
      {voiceChat && (
        <BrowserVoiceChat
          key={voiceChat.id}
          connection={voiceChat}
          zh={zh}
          close={() => setVoiceChat(null)}
          openConversation={openConversation}
        />
      )}
      <div className="chat-connection-grid">
        {items.map((c) => (
          <article className="chat-connection-card" key={c.id}>
            <div className="chat-connections-heading">
              <strong>{c.name}</strong>
              <span className="pill">
                {c.status.status === 'reauthorize'
                  ? tr('待重新授权', 'Reauthorization required')
                  : !c.enabled
                    ? tr('已手动停用', 'Manually disabled')
                    : c.status.status === 'connected'
                      ? tr('已连接', 'Connected')
                      : c.status.status === 'disconnected'
                        ? tr('连接断开', 'Disconnected')
                        : c.status.status}
              </span>
            </div>
            <p>
              {chatPlatforms.find((p) => p.transport === c.transport)?.name} · {c.senderId}
            </p>
            <p className="muted">
              {(c.status.status === 'reauthorize'
                ? tr(
                    '会话权限、模型或资料范围已变化。核对后重新启用并保存；不会自动恢复授权。',
                    'Conversation permissions, model or scope changed. Review, enable and save again; authorization is not restored automatically.',
                  )
                : !c.enabled
                  ? tr(
                      '此入口已停用，不接收新任务。',
                      'This connection is disabled and accepts no new tasks.',
                    )
                  : c.status.error) ||
                tr(
                  '等待平台消息；保存配置不代表已经连通。',
                  'Waiting for messages; saving configuration does not prove connectivity.',
                )}
            </p>
            <p>
              {c.peerType === 'group' ? tr('群聊', 'Group') : tr('私聊', 'Private')} ·{' '}
              {c.accessMode === 'chat'
                ? tr('普通聊天', 'Ordinary chat')
                : tr('远程工作', 'Remote work')}{' '}
              · {tr('排队', 'Queued')}: {c.queued} ·{' '}
              {c.remoteApprovals
                ? tr('允许单次远程审批', 'One-time remote approvals enabled')
                : tr('本机审批', 'Local approvals')}
            </p>
            <div className="chat-connection-actions">
              <button disabled={!c.enabled} onClick={() => setVoiceChat(c)}>
                {tr('网页语音', 'Browser voice')}
              </button>
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
                  setForm({
                    peerType: 'private',
                    accessMode: 'work',
                    allowedSenders: [],
                    allGroupMembers: false,
                    groupPrefix: '/amadeus',
                    sharedKnowledge: true,
                    ...rest,
                    token: '',
                    appSecret: '',
                    verifyToken: '',
                  });
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
            <ChatNotebook id={c.id} zh={zh} notify={notify} />
            {c.deliveries.some((d: any) => ['uncertain', 'failed'].includes(d.state)) && (
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
                {tr('核对失败／未确认的发送', 'Review failed / uncertain deliveries')}
              </button>
            )}
          </article>
        ))}
      </div>
      {deliveries && (
        <div className="chat-connection-card">
          <h2>{tr('发送失败或结果不确定', 'Failed or uncertain deliveries')}</h2>
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
              body.allowedSenders = (body.allowedSenders || [])
                .map((x) => x.trim())
                .filter(Boolean);
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
            {tr('权限类别', 'Access level')}
            <select
              disabled={!!form.id}
              value={form.accessMode || 'work'}
              onChange={(e) =>
                setForm((f) =>
                  f
                    ? {
                        ...f,
                        accessMode: e.target.value as 'chat' | 'work',
                        groupContext: false,
                        groupReplyMode: 'mentions',
                        remoteApprovals: false,
                        reviewFriendRequests: false,
                        allGroupMembers: false,
                        groupMediaEnabled: false,
                        groupMediaServiceIds: [],
                      }
                    : f,
                )
              }
            >
              <option value="chat">
                {tr('普通聊天：联网、媒体、知识库', 'Ordinary chat: web, media and knowledge')}
              </option>
              <option value="work">
                {tr('远程工作：沿用工作会话权限', 'Remote work: selected workspace permissions')}
              </option>
            </select>
          </label>
          <label>
            {tr('接收范围', 'Destination type')}
            <select
              disabled={!!form.id}
              value={form.peerType || 'private'}
              onChange={(e) =>
                setForm((f) =>
                  f
                    ? {
                        ...f,
                        peerType: e.target.value as 'private' | 'group',
                        autoInviteGroups: false,
                        reviewFriendRequests: false,
                        groupContext: false,
                        groupReplyMode: 'mentions',
                        peerId: e.target.value === 'private' ? f.senderId : '',
                        allGroupMembers: false,
                        groupMediaEnabled: false,
                        groupMediaServiceIds: [],
                      }
                    : f,
                )
              }
            >
              <option value="private">{tr('指定私聊用户', 'Private contact')}</option>
              <option value="group" disabled={form.transport === 'whatsapp'}>
                {tr('指定群聊', 'Group')}
              </option>
            </select>
          </label>
          <p>
            {form.accessMode === 'chat'
              ? tr(
                  '保存时新建独立普通会话，只沿用下方会话的模型。不会复制历史或接入本机项目。',
                  'Saving creates isolated ordinary-chat history using only the selected model; no existing history or project is copied.',
                )
              : tr(
                  '工作权限和历史来自所选会话。请使用专用会话；群成员能看到回传结果。',
                  'Work inherits the selected conversation permissions and history. Use a dedicated conversation; group members can see delivered results.',
                )}
          </p>
          {form.accessMode === 'chat' && (
            <label className="check">
              <input
                type="checkbox"
                checked={form.sharedKnowledge !== false}
                onChange={(e) => field('sharedKnowledge', e.target.checked)}
              />
              {tr(
                '开放普通对话共享知识库（群成员可看到引用）',
                'Allow general shared knowledge (citations are visible to group members)',
              )}
            </label>
          )}
          {form.transport === 'onebot11' && form.peerType !== 'group' && (
            <label className="check">
              <input
                type="checkbox"
                checked={!!form.autoInviteGroups}
                onChange={(e) => field('autoInviteGroups', e.target.checked)}
              />
              {tr(
                '指定控制人邀请入群后自动开放基本聊天（需平台邀请事件；不继承工作权限）',
                'Enable basic group chat after verified controller invitations (never inherits work permissions)',
              )}
            </label>
          )}
          {form.transport === 'onebot11' &&
            form.peerType !== 'group' &&
            form.accessMode === 'work' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.reviewFriendRequests}
                  onChange={(e) => field('reviewFriendRequests', e.target.checked)}
                />
                {tr(
                  '将好友申请发给此控制人审批；通过后开放独立普通聊天（无电脑操作和审批权限）',
                  'Send friend requests to this controller; accepted friends get isolated basic chat, never work or approval access',
                )}
              </label>
            )}
          {form.peerType === 'group' && (
            <>
              <label>
                {tr('群 ID / group_openid / chatid', 'Group ID / group_openid / chatid')}
                <input
                  required
                  disabled={!!form.id}
                  value={form.peerId}
                  onChange={(e) => field('peerId', e.target.value)}
                />
              </label>
              <label>
                {tr(
                  '允许发送任务的成员 ID（每行一个；控制人默认允许）',
                  'Allowed member IDs (one per line; controller always allowed)',
                )}
                <textarea
                  value={(form.allowedSenders || []).join('\n')}
                  onChange={(e) => field('allowedSenders', e.target.value.split(/[\n,，]/))}
                />
              </label>
              {form.accessMode === 'chat' && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!form.allGroupMembers}
                    onChange={(e) => field('allGroupMembers', e.target.checked)}
                  />
                  {tr(
                    '允许该群全部成员普通聊天',
                    'Allow ordinary chat for every member of this group',
                  )}
                </label>
              )}
              {form.accessMode === 'chat' && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!!form.groupContext}
                      onChange={(e) => {
                        field('groupContext', e.target.checked);
                        if (!e.target.checked) field('groupReplyMode', 'mentions');
                      }}
                    />
                    {tr(
                      '保留允许成员的近期群消息上下文（可能发送给模型；不跨群）',
                      'Keep recent authorized group context (may be sent to the model; isolated by group)',
                    )}
                  </label>
                  <label>
                    {tr('回复方式', 'Reply mode')}
                    <select
                      value={form.groupReplyMode || 'mentions'}
                      onChange={(e) => field('groupReplyMode', e.target.value)}
                    >
                      <option value="mentions">{tr('@或前缀触发', 'Mentions or prefix')}</option>
                      <option value="participate" disabled={!form.groupContext}>
                        {tr(
                          '适度参与：可保持沉默，每小时最多3次主动判断',
                          'Selective participation: may stay silent, at most 3 unsolicited decisions/hour',
                        )}
                      </option>
                    </select>
                  </label>
                </>
              )}
              <label>
                {tr('群内触发前缀', 'Group message prefix')}
                <input
                  required
                  value={form.groupPrefix || '/amadeus'}
                  onChange={(e) => field('groupPrefix', e.target.value)}
                />
              </label>
              <p>
                {tr(
                  '例如 /amadeus 你好。QQ 官方还需要 @机器人；只有下方控制人能使用审批、/stop 和 /status。',
                  'Example: /amadeus hello. Official QQ additionally needs @bot. Only the controller below may approve or use /stop and /status.',
                )}
              </p>
            </>
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
            {tr('参考模型会话 / 工作目标会话', 'Model template / work conversation')}
            <select
              required
              disabled={!!form.id}
              value={form.conversationId}
              onChange={(e) => field('conversationId', e.target.value)}
            >
              <option value="">{tr('选择专用会话', 'Choose a dedicated chat')}</option>
              {form.conversationId && !conversations.some((c) => c.id === form.conversationId) && (
                <option value={form.conversationId}>
                  {tr('此连接的独立会话', 'Isolated conversation for this connection')}
                </option>
              )}
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
            {tr(
              '私聊用户 / 群控制人 ID（不是昵称）',
              'Private contact / group controller ID (not display name)',
            )}
            <input
              required
              disabled={!!form.id}
              value={form.senderId}
              onChange={(e) => {
                field('senderId', e.target.value);
                if (form.peerType !== 'group') field('peerId', e.target.value);
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
          {form.accessMode === 'chat' && form.peerType === 'group' && (
            <fieldset>
              <legend>{tr('群媒体授权', 'Group media authorization')}</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!form.groupMediaEnabled}
                  onChange={(e) => field('groupMediaEnabled', e.target.checked)}
                />
                {tr(
                  '本机授权一次，允许本群成员使用以下服务，无需逐次审批',
                  'Authorize this group once to use selected services without per-request approval',
                )}
              </label>
              {form.groupMediaEnabled && (
                <>
                  {mediaServices.map((s) => (
                    <label className="check" key={s.id}>
                      <input
                        type="checkbox"
                        checked={(form.groupMediaServiceIds || []).includes(s.id)}
                        onChange={(e) =>
                          field(
                            'groupMediaServiceIds',
                            e.target.checked
                              ? [...(form.groupMediaServiceIds || []), s.id]
                              : (form.groupMediaServiceIds || []).filter((id) => id !== s.id),
                          )
                        }
                      />
                      {s.name} · {s.kind} ·{' '}
                      {s.estimatedUsd == null
                        ? tr('费用未知，不能预授权', 'Unknown cost; cannot preauthorize')
                        : '$' + s.estimatedUsd}
                    </label>
                  ))}
                  <label>
                    {tr(
                      '每次估算费用上限 USD（0 只允许估算免费服务）',
                      'Maximum estimated USD per request (0 allows estimated free services only)',
                    )}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.groupMediaMaxUsd ?? 0}
                      onChange={(e) => field('groupMediaMaxUsd', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {tr(
                      '全群每小时最多请求数（失败也计数）',
                      'Maximum requests per hour across the group (failures count)',
                    )}
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={form.groupMediaHourlyLimit ?? 12}
                      onChange={(e) => field('groupMediaHourlyLimit', Number(e.target.value))}
                    />
                  </label>
                </>
              )}
              <p className="muted">
                {tr(
                  '仅限媒体服务和本群附件，不开放电脑操作。费用是配置估算而非账单上限；服务配置变化需本机重新保存授权。关闭即撤销未来请求，已提交任务不会自动取消。',
                  'Media services and same-group attachments only; no computer control. Costs are configured estimates, not billing caps. Service changes require local reauthorization. Disabling blocks future requests, not already submitted jobs.',
                )}
              </p>
            </fieldset>
          )}
          <label className="check">
            <input
              type="checkbox"
              disabled={form.accessMode === 'chat'}
              checked={form.remoteApprovals}
              onChange={(e) => field('remoteApprovals', e.target.checked)}
            />
            {tr(
              '允许绑定账号进行单次审批：操作详情会发到聊天平台，有效期按平台限制设置；敏感或过长内容仍在本机核对。',
              'Allow one-time approvals by the bound account: operation details are sent to the platform, validity follows platform limits. Sensitive/large payloads require local review.',
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
