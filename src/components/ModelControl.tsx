import { useEffect, useState } from 'react';
import { Bot, Check, Search, Settings2 } from 'lucide-react';
import type { PublicProfile, SubagentModels } from '../../shared/types';
import { ControlPopover } from './ControlPopover';

export function ModelControl({
  profiles,
  profileId,
  policy,
  locked,
  zh,
  onSave,
  onConfigure,
  onBusy,
}: {
  profiles: PublicProfile[];
  profileId: string;
  policy?: SubagentModels | null;
  locked: boolean;
  zh: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onConfigure: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [tab, setTab] = useState<'main' | 'children'>('main');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<SubagentModels>(
    policy || { defaultProfileId: null, allowedProfileIds: [] },
  );
  const policySnapshot = JSON.stringify(
    policy || { defaultProfileId: null, allowedProfileIds: [] },
  );
  useEffect(() => {
    setDraft(JSON.parse(policySnapshot));
  }, [policySnapshot]);
  const selected = profiles.find((p) => p.id === profileId);
  const matches = profiles.filter((p) =>
    (p.name + ' ' + p.model + ' ' + p.transport).toLowerCase().includes(query.toLowerCase()),
  );
  const changed =
    JSON.stringify(draft) !==
    JSON.stringify(policy || { defaultProfileId: null, allowedProfileIds: [] });
  async function save(patch: Record<string, unknown>) {
    if (busy || locked) return;
    setBusy(true);
    onBusy(true);
    setError('');
    setSaved(false);
    try {
      await onSave(patch);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function details(p: PublicProfile) {
    let host = '';
    try {
      host = new URL(p.baseUrl).host;
    } catch {}
    return p.model + ' · ' + p.transport + (host ? ' · ' + host : '');
  }
  return (
    <ControlPopover
      label={selected?.name || selected?.model || (zh ? '选择模型' : 'Choose model')}
      icon={<Bot size={16} />}
      disabled={false}
    >
      <header className="control-heading">
        <strong>{zh ? '模型与 API 连接' : 'Models & API connections'}</strong>
        <button
          type="button"
          className="icon"
          title={zh ? '管理 API 连接' : 'Manage API connections'}
          aria-label={zh ? '管理 API 连接' : 'Manage API connections'}
          disabled={busy}
          onClick={onConfigure}
        >
          <Settings2 size={17} />
        </button>
      </header>
      <div
        className="collaboration-tabs"
        role="tablist"
        aria-label={zh ? '模型用途' : 'Model purpose'}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'main'}
          onClick={() => setTab('main')}
        >
          {zh ? '主对话' : 'Main chat'}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'children'}
          onClick={() => setTab('children')}
        >
          {zh ? '子 Agent' : 'Subagents'}
        </button>
      </div>
      {locked && (
        <p className="control-description">
          {zh
            ? '任务运行或发送中，暂不能修改模型配置。'
            : 'Model settings are locked while running or sending.'}
        </p>
      )}
      {!profiles.length && (
        <p>{zh ? '尚无 API 连接，请先添加。' : 'Add an API connection to get started.'}</p>
      )}
      {tab === 'main' ? (
        <>
          <label className="model-search">
            <Search size={15} />
            <input
              aria-label={zh ? '搜索模型' : 'Search models'}
              placeholder={zh ? '搜索连接名或模型' : 'Search connection or model'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div
            className="model-options"
            role="group"
            aria-label={zh ? '主对话模型' : 'Main chat model'}
          >
            {matches.map((p) => (
              <button
                type="button"
                key={p.id}
                className={'model-option' + (p.id === profileId ? ' selected' : '')}
                aria-pressed={p.id === profileId}
                disabled={locked || busy}
                onClick={() => void save({ profileId: p.id, reasoning: 'auto' })}
              >
                <span>
                  <strong>{p.name || p.model}</strong>
                  <small>{details(p)}</small>
                  {!p.hasKey && (
                    <small>
                      {zh
                        ? '未设置密钥；本地服务可能无需密钥'
                        : 'No key set; local endpoints may not require one'}
                    </small>
                  )}
                </span>
                {p.id === profileId && <Check size={17} />}
              </button>
            ))}
            {!matches.length && !!profiles.length && (
              <p>{zh ? '没有匹配的模型' : 'No matching models'}</p>
            )}
          </div>
          <p className="control-description">
            {zh
              ? '切换保留对话记录，思考档位恢复自动。历史上下文会发送到所选 API；不同模型的费用、上下文和图片能力可能不同。'
              : 'Switching keeps history and resets reasoning to Auto. Context is sent to the selected API; cost, context and vision capabilities may differ.'}
          </p>
        </>
      ) : (
        <div className="subagent-model-settings">
          <label>
            {zh ? '默认子 Agent 模型' : 'Default subagent model'}
            <select
              aria-label={zh ? '默认子 Agent 模型' : 'Default subagent model'}
              value={draft.defaultProfileId || ''}
              disabled={locked || busy}
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, defaultProfileId: e.target.value || null });
              }}
            >
              <option value="">{zh ? '跟随主对话' : 'Follow main chat'}</option>
              {draft.defaultProfileId && !profiles.some((p) => p.id === draft.defaultProfileId) && (
                <option value={draft.defaultProfileId}>
                  {zh ? '原连接已删除，请重新选择' : 'Connection removed; choose another'}
                </option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
          <p className="control-description">
            {zh
              ? '允许 Agent 按任务选择的其他连接（可不选）：'
              : 'Other connections the agent may choose for a task (optional):'}
          </p>
          <div className="model-options">
            {profiles
              .filter((p) => p.id !== profileId && p.id !== draft.defaultProfileId)
              .map((p) => (
                <label key={p.id} className="model-choice">
                  <input
                    type="checkbox"
                    disabled={locked || busy}
                    checked={draft.allowedProfileIds.includes(p.id)}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({
                        ...draft,
                        allowedProfileIds: e.target.checked
                          ? [...draft.allowedProfileIds, p.id]
                          : draft.allowedProfileIds.filter((id) => id !== p.id),
                      });
                    }}
                  />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{details(p)}</small>
                  </span>
                </label>
              ))}
          </div>
          <p className="control-description">
            {zh
              ? '默认不额外创建成员。主模型与默认子模型可用；勾选即允许将子任务上下文发送到这些 API。适用于后续新建和续跑成员，不改动运行中的成员。'
              : 'Does not create extra agents. Main and default subagent models are available; checked APIs may receive delegated context. Applies to future spawns and continuations, not running members.'}
          </p>
          <button
            type="button"
            className="primary"
            disabled={locked || busy || !changed}
            onClick={() =>
              void save({
                subagentModels: {
                  ...draft,
                  allowedProfileIds: draft.allowedProfileIds.filter((id) =>
                    profiles.some((p) => p.id === id),
                  ),
                },
              })
            }
          >
            {busy
              ? zh
                ? '保存中…'
                : 'Saving…'
              : zh
                ? '保存子 Agent 配置'
                : 'Save subagent settings'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="model-error">
          {error}
        </p>
      )}
      {saved && <p role="status">{zh ? '已保存' : 'Saved'}</p>}
    </ControlPopover>
  );
}
