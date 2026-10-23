import { useEffect, useState } from 'react';
import { api } from '../api';
export function MemoryDefaults({ scope, state, zh, notify }: any) {
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false);
  const chat = scope.startsWith('chat:')
    ? state.conversations.find((c: any) => c.id === scope.slice(5))
    : undefined;
  const profile = state.settings.profiles.find(
    (p: any) => p.id === (chat?.profileId || state.settings.defaultProfileId),
  );
  useEffect(() => {
    let live = true;
    api('/memory-policy?scope=' + encodeURIComponent(scope))
      .then((x: any) => {
        if (live) setEnabled(x.enabled);
      })
      .catch((e: any) => notify(e.message));
    return () => {
      live = false;
    };
  }, [scope]);
  return (
    <section className="panel">
      <h3>
        {chat
          ? zh
            ? '本接入聊天自动记忆'
            : 'Automatic memory for this external chat'
          : zh
            ? '本范围的新对话默认设置'
            : 'New-chat defaults for this scope'}
      </h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !profile}
          onChange={async (e) => {
            const previous = enabled,
              next = e.target.checked;
            setEnabled(next);
            setBusy(true);
            try {
              await api('/memory-policy', { scope, enabled: next, profileId: profile.id });
              setEnabled(next);
            } catch (e: any) {
              setEnabled(previous);
              notify(e.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {chat
          ? zh
            ? '仅在这个接入聊天内自动学习与召回，不扩大范围'
            : 'Learn and recall only within this external chat'
          : zh
            ? '新对话自动管理记忆，现有继承设置的对话同步更新'
            : 'Automatic memory for new chats and existing inheriting chats'}
      </label>
      <p className="muted">
        {zh
          ? '旧候选也会按原文复审：每批最多 8 条，每条原文最多 12,000 字符，发送到原对话已授权模型，会消耗额度；停用、历史、过期和冲突不会自动恢复。原对话需未归档且开启自动管理。'
          : 'Old candidates are also reviewed: up to 8 per batch with 12,000 characters per human source, using the original authorized model at model cost. Disabled, historical, expired and disputed entries are not revived. The original chat must be unarchived and opted in.'}
      </p>
      <p className="muted">
        {zh
          ? '仅授权此模型地址处理本范围记忆；对话级例外不覆盖：'
          : 'Only this model destination is authorized; per-chat overrides remain: '}
        {profile?.baseUrl || '—'}
      </p>
    </section>
  );
}
