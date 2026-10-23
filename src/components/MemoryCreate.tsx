import { useState } from 'react';
import type { Conversation, Memory } from '../../shared/types';
import { conversationMemoryScope, memoryReach } from '../../shared/memory-scope';
import { api } from '../api';

export function MemoryCreate({
  scope,
  conversations,
  currentConversationId,
  zh,
  go,
}: {
  scope: string;
  conversations: Conversation[];
  currentConversationId?: string;
  zh: boolean;
  go: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const chats = conversations.filter((c) => conversationMemoryScope(c) === scope);
  const [source, setSource] = useState(
    chats.some((c) => c.id === currentConversationId) ? currentConversationId! : '',
  );
  const [search, setSearch] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<Memory['kind']>('preference');
  const [reach, setReach] = useState<Memory['recallScope']>('auto');
  const [busy, setBusy] = useState(false);
  const local = memoryReach({ scope, kind, recallScope: reach } as Memory) === 'conversation';
  const label = (en: string, cn: string) => (zh ? cn : en);
  return (
    <details className="memory-create">
      <summary>{label('Add a memory manually (optional)', '手动添加记忆（可选）')}</summary>
      <p className="muted">
        {label(
          'Automatic management can extract memories from chats. Manual entry is optional; the current original chat is preselected.',
          '开启自动管理后可从聊天提取记忆，无需逐条录入。手动创建会带入当前原对话。',
        )}
      </p>
      <textarea
        aria-label={label('Memory content', '记忆内容')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="memory-scope-fields">
        <label>
          {label('Memory kind', '记忆类型')}
          <select
            aria-label={label('Memory kind', '记忆类型')}
            value={kind}
            onChange={(e) => setKind(e.target.value as Memory['kind'])}
          >
            <option value="preference">{label('Preference', '偏好')}</option>
            <option value="fact">{label('Reported fact', '事实／背景')}</option>
            <option value="goal">{label('Ongoing goal', '持续目标')}</option>
            <option value="decision">{label('Decision', '决定')}</option>
            <option value="episode">{label('Event / temporary state', '事件／临时状态')}</option>
          </select>
        </label>
        <label>
          {label('Recall scope', '召回范围')}
          <select
            aria-label={label('Recall scope', '召回范围')}
            value={reach}
            onChange={(e) => setReach(e.target.value as Memory['recallScope'])}
          >
            <option value="auto">{label('Automatic assessment', '自动：按内容评估')}</option>
            <option value="conversation">{label('Original conversation only', '仅原对话')}</option>
            <option value="scope" disabled={scope.startsWith('chat:')}>
              {label('Shared in this storage scope', '本存储范围共享')}
            </option>
          </select>
        </label>
        <label>
          {label('Find original conversation', '查找原对话')}
          <input
            aria-label={label('Find original conversation', '查找原对话')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={label('Search titles', '搜索对话标题')}
          />
        </label>
        <label>
          {label('Original conversation', '原对话')}
          <select
            aria-label={label('Original conversation', '原对话')}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">{label('No original conversation', '不关联原对话')}</option>
            {chats
              .filter(
                (c) => c.id === source || c.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || label('Untitled conversation', '未命名对话')}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="muted">
        {local
          ? label('Effective scope: original conversation only.', '当前生效范围：仅原对话。')
          : label(
              'Effective scope: shared within the selected storage scope.',
              '当前生效范围：所选存储范围内共享。',
            )}
        {local &&
          !source &&
          label(' Choose its original conversation before creating.', ' 请先选择原对话。')}
      </p>
      <button
        className="primary"
        disabled={busy || !content.trim() || (local && !source)}
        onClick={async () => {
          setBusy(true);
          try {
            await go(async () => {
              await api('/memories', {
                scope,
                content,
                kind,
                recallScope: reach,
                ...(source ? { sourceConversationId: source } : {}),
              });
              setContent('');
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        {label('Create memory', '创建记忆')}
      </button>
    </details>
  );
}
