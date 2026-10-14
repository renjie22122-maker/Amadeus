import { useState, type ReactNode } from 'react';
import { GitFork, UserRound, Network, Check } from 'lucide-react';
import { ControlPopover } from './ControlPopover';
export function DelegationControl({
  value,
  disabled,
  onChange,
  zh = false,
  depth,
  total,
  parallel,
  mode = 'auto',
  onModeChange,
  management,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  zh?: boolean;
  depth: number;
  total: number;
  parallel: number;
  mode?: string;
  onModeChange?: (v: string) => void;
  management?: ReactNode;
}) {
  const [tab, setTab] = useState<'strategy' | 'manage'>('strategy');
  const options = [
    {
      id: 'off',
      icon: <UserRound size={18} />,
      name: zh ? '单 Agent' : 'Single agent',
      description: zh
        ? '由当前 Agent 完成，不创建子 Agent。'
        : 'The current agent handles the task without creating subagents.',
    },
    {
      id: 'auto',
      icon: <GitFork size={18} />,
      name: zh ? '自动协作' : 'Automatic',
      description: zh
        ? 'Agent 判断是否值得拆分，简单任务直接完成。'
        : 'Delegate when independent work is useful; keep simple tasks together.',
    },
    {
      id: 'prefer',
      icon: <Network size={18} />,
      name: zh ? '优先协作' : 'Prefer collaboration',
      description: zh
        ? '优先寻找可并行的独立工作，不强制拆分每个任务。'
        : 'Look for useful parallel work without forcing every task into a team.',
    },
  ];
  const selected = options.find((o) => o.id === value) || options[1];
  return (
    <ControlPopover
      label={(zh ? '协作' : 'Team') + ' · ' + selected.name}
      icon={<GitFork size={16} />}
      disabled={false}
    >
      <header className="control-heading">
        <strong>{zh ? '协作' : 'Collaboration'}</strong>
      </header>
      <div
        className="collaboration-tabs"
        role="tablist"
        aria-label={zh ? '协作设置' : 'Collaboration settings'}
      >
        <button role="tab" aria-selected={tab === 'strategy'} onClick={() => setTab('strategy')}>
          {zh ? '协作方式' : 'Team setup'}
        </button>
        <button role="tab" aria-selected={tab === 'manage'} onClick={() => setTab('manage')}>
          {zh ? '运行管理' : 'Runtime management'}
        </button>
      </div>
      {tab === 'manage' ? (
        <div className="collaboration-management">
          {management || (
            <p className="control-description">
              {zh
                ? '团队建立后，可在这里设置自动恢复、扩缩容和主持接管。'
                : 'Once a team is created, manage recovery, scaling and coordinator takeover here.'}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="control-description">
            {disabled
              ? zh
                ? '当前任务运行中，协作方式暂时锁定。运行管理仍可使用。'
                : 'Team setup is locked during a run. Runtime management remains available.'
              : zh
                ? '选择何时协作，以及团队如何组织。'
                : 'Choose when to collaborate and how to organize the team.'}
          </p>
          <div
            className="delegation-options"
            role="radiogroup"
            onKeyDown={(e) => {
              if (
                !disabled &&
                ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)
              ) {
                e.preventDefault();
                const current = options.findIndex((o) => o.id === value),
                  step = ['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1;
                const next = (current + step + options.length) % options.length;
                onChange(options[next].id);
                (e.currentTarget.querySelectorAll('button')[next] as HTMLElement)?.focus();
              }
            }}
            aria-label={zh ? '协作策略' : 'Team strategy'}
          >
            {options.map((o) => (
              <button
                type="button"
                role="radio"
                disabled={disabled}
                key={o.id}
                aria-checked={value === o.id}
                className={'delegation-option' + (value === o.id ? ' selected' : '')}
                onClick={() => onChange(o.id)}
              >
                <span className="delegation-icon">{o.icon}</span>
                <span className="delegation-copy">
                  <strong>
                    {o.name}
                    {o.id === 'auto' && <em>{zh ? '推荐' : 'Recommended'}</em>}
                  </strong>
                  <small>{o.description}</small>
                </span>
                <span className="delegation-check">{value === o.id && <Check size={16} />}</span>
              </button>
            ))}
          </div>
          <label className="collaboration-mode">
            {zh ? '团队模式' : 'Team mode'}
            <select
              disabled={disabled || value === 'off'}
              value={mode}
              onChange={(e) => onModeChange?.(e.target.value)}
            >
              <option value="auto">
                {zh ? '自动选择 · 按任务组织' : 'Automatic · task-based organization'}
              </option>
              <option value="hierarchy">{zh ? '主 Agent + 子 Agent' : 'Lead + workers'}</option>
              <option value="host">{zh ? '宿主调度 · 平级协作' : 'Host scheduling · peers'}</option>
              <option value="creative">
                {zh ? '创意讨论 · 自由协商' : 'Creative discussion · peers'}
              </option>
            </select>
          </label>
          <footer className="control-note">
            <div>
              {zh
                ? `最多委派 ${depth} 层 · 子任务累计 ${total === 0 ? '不限' : total} 个 · 本对话模型并发 ${parallel === 0 ? '不限' : parallel}`
                : `Depth ${depth} · ${total === 0 ? 'Unlimited' : total} children per run tree · ${parallel === 0 ? 'Unlimited' : parallel} model requests per conversation`}
            </div>
            <div>
              {zh
                ? '子 Agent 使用独立上下文，会增加用量；可写副本合并仍需你批准。'
                : 'Subagents have separate context and add usage. Merging writable copies still needs your approval.'}
            </div>
          </footer>
        </>
      )}
    </ControlPopover>
  );
}
