import { SkillPicker } from './SkillPicker';
import { ContextPanel, FilesPanel } from './InspectorPanels';
import { X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { Conversation, Project } from '../../shared/types';
import type { Action, RunView, UiState } from '../types';

interface InspectorProps {
  tab: 'settings' | 'context' | 'files';
  setTab: (tab: 'settings' | 'context' | 'files') => void;
  t: (key: string) => string;
  setInspector: Dispatch<SetStateAction<boolean>>;
  conversation: Conversation | undefined;
  running: boolean | undefined;
  state: UiState;
  action: Action;
  update: (data: Record<string, unknown>) => Promise<void>;
  project: Project | undefined;
  run: RunView | undefined;
}
export function Inspector({
  t,
  tab,
  setTab,
  setInspector,
  conversation,
  running,
  state,
  action,
  update,
  project,
  run,
}: InspectorProps) {
  return (
    <aside className="inspector">
      <div className="section-title">
        <h3>{t('details')}</h3>
        <button aria-label={t('Close details')} onClick={() => setInspector(false)}>
          <X size={16} />
        </button>
      </div>
      <nav className="inspector-tabs">
        {(['settings', 'context', 'files'] as const).map((k) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {t(k === 'context' ? 'Context' : k === 'files' ? 'Files' : 'Settings & usage')}
          </button>
        ))}
      </nav>
      {conversation && tab === 'context' && (
        <ContextPanel
          key={conversation.id}
          id={conversation.id}
          zh={t('settings') !== 'Settings'}
          live={!!running}
        />
      )}
      {conversation && tab === 'files' && (
        <FilesPanel
          key={conversation.id}
          id={conversation.id}
          zh={t('settings') !== 'Settings'}
          live={!!running}
        />
      )}
      {tab === 'settings' &&
        (conversation ? (
          <>
            <label>
              {t('model')}
              <select
                disabled={running}
                value={conversation.profileId}
                onChange={(e) =>
                  void action(() => update({ profileId: e.target.value, reasoning: 'auto' }))
                }
              >
                {state.settings.profiles.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {project
                ? project.folders.map((f: string, i: number) => (
                    <span className="folder-path" key={f}>
                      @{i} {f}
                    </span>
                  ))
                : t('noProject')}
            </p>
            <h4>{t('selectedSkills')}</h4>
            <p className="muted">
              {t('settings') === 'Settings'
                ? 'Checked skills are preferred. The agent may discover other enabled library skills when relevant; disable a skill in the library to exclude it.'
                : '勾选的技能优先使用；Agent 也可按需发现技能库中其他已启用技能。如需排除，请在技能库禁用。'}
            </p>
            <SkillPicker
              skills={state.skills}
              selected={conversation.skillIds}
              disabled={!!running}
              zh={t('settings') !== 'Settings'}
              onChange={(skillIds) => void action(() => update({ skillIds }))}
            />
            {['knowledge'].map((k) => (
              <label className="checkbox" key={k}>
                <input
                  disabled={running}
                  type="checkbox"
                  checked={(conversation as any)[k]}
                  onChange={(e) => void action(() => update({ [k]: e.target.checked }))}
                />
                {k === 'memory'
                  ? t('settings') === 'Settings'
                    ? 'Use existing memories'
                    : '使用已有记忆'
                  : t(k)}
              </label>
            ))}
            <p className="muted">
              {t('settings') === 'Settings'
                ? project
                  ? 'Project memories only by default.'
                  : 'General chat recalls confirmed user preferences; no project memory.'
                : project
                  ? '默认只召回本项目记忆。'
                  : '普通对话召回已确认的用户偏好，不读取项目记忆。'}
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                disabled={!!running}
                checked={
                  conversation.automaticMemory === true &&
                  conversation.memoryGenerationTarget ===
                    conversation.profileId +
                      '|' +
                      state.settings.profiles.find((p: any) => p.id === conversation.profileId)
                        ?.baseUrl
                }
                onChange={(e) => void action(() => update({ automaticMemory: e.target.checked }))}
              />
              {t('settings') === 'Settings' ? 'Automatic memory management' : '自动管理记忆'}
            </label>
            <p className="muted">
              {t('settings') === 'Settings'
                ? 'Automatic management uses this chat’s authorized model to review eligible messages and relevant same-scope memories; some verified tool outcomes can serve as evidence. This uses model quota. To stop using existing memories, turn off “Use existing memories” as well.'
                : '自动管理使用本对话已授权的模型复审符合条件的消息及同范围的相关记忆；经验证的工具结果也可以作为依据。这会消耗模型额度。若还要停止召回已有记忆，请同时关闭“使用已有记忆”。'}
              <br />
              {state.settings.profiles.find((p: any) => p.id === conversation.profileId)?.baseUrl}
            </p>
            <button
              disabled={!!running}
              onClick={() => void action(() => update({ memoryPolicy: 'inherit' }))}
            >
              {t('settings') === 'Settings'
                ? 'Use scope memory defaults'
                : '恢复继承本范围记忆设置'}
            </button>
            {project && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={!!running || !conversation.memory}
                  checked={conversation.includeUserMemory === true}
                  onChange={(e) =>
                    void action(() => update({ includeUserMemory: e.target.checked }))
                  }
                />
                {t('settings') === 'Settings' ? 'Also use user preferences' : '同时使用用户偏好'}
              </label>
            )}
            {run && (
              <>
                <h4>{t('usage')}</h4>
                {run.usageComplete === false && (
                  <p className="muted">
                    Some failed requests did not return usage. Totals are incomplete.
                  </p>
                )}
                <dl>
                  <dt>{t('Input')}</dt>
                  <dd>{run.inputTokens.toLocaleString()}</dd>
                  <dt>{t('Output')}</dt>
                  <dd>{run.outputTokens.toLocaleString()}</dd>
                  <dt>{t('Cache hits')}</dt>
                  <dd>{run.cachedTokens.toLocaleString()}</dd>
                  <dt>{t('Cost estimate')}</dt>
                  <dd>
                    {run.estimatedUsd === null ? 'Unknown' : '$' + run.estimatedUsd.toFixed(5)}
                  </dd>
                </dl>
              </>
            )}
          </>
        ) : (
          <p className="muted">{t('Create a chat to configure its tools.')}</p>
        ))}
    </aside>
  );
}
