import {
  SlidersHorizontal,
  RotateCcw,
  Users,
  Waypoints,
  ChevronDown,
  Check,
  History,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
export function TeamAutomationControls({
  id,
  policy,
  recovery,
  events,
  zh,
  action,
}: {
  id: string;
  policy: any;
  recovery: any[];
  events: any[];
  zh: boolean;
  action: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [draft, setDraft] = useState<any>(
    policy || {
      enabled: false,
      autoRecover: false,
      autoScale: false,
      autoElect: false,
      maxWorkers: 2,
      maxNewWorkers: 4,
      maxRecoveries: 1,
      idleSeconds: 60,
      costLimitUsd: null,
    },
  );
  useEffect(
    () =>
      setDraft(
        policy || {
          enabled: false,
          autoRecover: false,
          autoScale: false,
          autoElect: false,
          maxWorkers: 2,
          maxNewWorkers: 4,
          maxRecoveries: 1,
          idleSeconds: 60,
          costLimitUsd: null,
        },
      ),
    [id, JSON.stringify(policy)],
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<any>(policy);
  const [error, setError] = useState('');
  useEffect(() => {
    setSaved(policy);
    setError('');
  }, [id, JSON.stringify(policy)]);
  const defaults = {
    enabled: false,
    autoRecover: false,
    autoScale: false,
    autoElect: false,
    maxWorkers: 2,
    maxNewWorkers: 4,
    maxRecoveries: 1,
    idleSeconds: 60,
    costLimitUsd: null,
  };
  const dirty = Object.keys(defaults).some(
    (k) => draft[k] !== (saved?.[k] ?? (defaults as any)[k]),
  );
  const interrupted = recovery.filter((r) => ['interrupted', 'failed'].includes(r.status));
  const switches = [
    {
      key: 'autoRecover',
      icon: RotateCcw,
      label: zh ? '只读成员自动恢复' : 'Auto-recover read-only members',
      hint: zh ? '从已核对的结果继续' : 'Continue from verified outcomes',
    },
    {
      key: 'autoScale',
      icon: Users,
      label: zh ? '有上限的扩缩容' : 'Bounded autoscaling',
      hint: zh ? '按工作量增减只读成员' : 'Match read-only capacity to demand',
    },
    {
      key: 'autoElect',
      icon: Waypoints,
      label: zh ? '主持角色自动接管' : 'Automatic coordinator takeover',
      hint: zh ? '主持者退出后交接职责' : 'Transfer responsibility when a coordinator exits',
    },
  ];
  return (
    <details className="team-panel automation-panel">
      <summary>
        <SlidersHorizontal size={16} />
        <span>{zh ? '恢复与自动调度' : 'Recovery and automation'}</span>
        <span className={'team-status ' + (policy?.enabled ? 'is-on' : '')}>
          {policy?.enabled ? (zh ? '已启用' : 'On') : zh ? '手动' : 'Manual'}
        </span>
        {!!interrupted.length && <span className="team-count">{interrupted.length}</span>}
        <ChevronDown size={15} className="team-chevron" />
      </summary>
      <div className="automation-body">
        <label className="automation-master">
          <span>
            <strong>{zh ? '启用宿主自动化' : 'Enable host automation'}</strong>
            <small>
              {zh
                ? '本对话后续团队沿用；未建队时不执行'
                : 'Inherited by future teams in this conversation; inactive until a team exists'}
            </small>
          </span>
          <input
            className="team-switch"
            aria-label={zh ? '启用宿主自动化' : 'Enable host automation'}
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
        </label>
        <div className="automation-options">
          {switches.map(({ key, icon: Icon, label, hint }) => (
            <label className="automation-option" key={key}>
              <span className="automation-icon">
                <Icon size={17} />
              </span>
              <span className="automation-option-copy">
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
              <input
                className="team-switch"
                aria-label={label}
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
              />
            </label>
          ))}
        </div>
        <details className="automation-limits">
          <summary>
            <span>{zh ? '容量与费用' : 'Capacity and cost'}</span>
            <small>
              {draft.maxWorkers} {zh ? '位工作者上限' : 'workers max'}
            </small>
            <ChevronDown size={14} />
          </summary>
          <div className="automation-fields">
            {[
              ['maxWorkers', zh ? '活跃工作者上限' : 'Active worker limit', 1, 16],
              ['maxNewWorkers', zh ? '累计新增上限' : 'Total new workers', 0, 32],
              ['maxRecoveries', zh ? '每成员自动恢复次数' : 'Auto-recoveries per member', 0, 5],
              ['idleSeconds', zh ? '空闲收缩秒数' : 'Idle retirement seconds', 10, 3600],
            ].map(([key, label, min, max]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min={Number(min)}
                  max={Number(max)}
                  value={draft[String(key)]}
                  onChange={(e) => setDraft({ ...draft, [String(key)]: Number(e.target.value) })}
                />
              </label>
            ))}
            <label className="automation-cost">
              <span>
                {zh ? '新增费用门槛 USD（空白不限）' : 'Start cost threshold USD (blank = none)'}
              </span>
              <input
                type="number"
                placeholder={zh ? '不限' : 'No limit'}
                min="0.001"
                step="0.01"
                value={draft.costLimitUsd ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    costLimitUsd: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <p className="automation-footnote">
            {zh
              ? '费用门槛只阻止新增与恢复。全局并发、深度与原有权限仍然有效。'
              : 'The cost threshold limits new starts and recovery. Global concurrency, depth and permissions still apply.'}
          </p>
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="automation-save">
          <span>
            {dirty ? (
              zh ? (
                '有未保存的更改'
              ) : (
                'Unsaved changes'
              )
            ) : (
              <>
                <Check size={13} />
                {zh ? '已同步' : 'Up to date'}
              </>
            )}
          </span>
          <button
            className="team-primary"
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true);
              setError('');
              void action(async () => {
                try {
                  const result = await api('/runs/' + id + '/team-automation', draft);
                  setSaved(result);
                } catch (e: any) {
                  setError(e.message || String(e));
                  throw e;
                }
              }).finally(() => setSaving(false));
            }}
          >
            {saving
              ? zh
                ? '保存中…'
                : 'Saving…'
              : zh
                ? '保存自动化策略'
                : 'Save automation policy'}
          </button>
        </div>
        {!!interrupted.length && (
          <section className="team-recovery-list">
            <h4>
              {zh ? '需要留意' : 'Needs attention'}
              <span className="team-count">{interrupted.length}</span>
            </h4>
            {interrupted.map((r) => (
              <div className="team-recovery-item" key={r.runId}>
                <div className="team-recovery-heading">
                  <RotateCcw size={15} />
                  <span>{zh ? '中断的成员' : 'Interrupted member'}</span>
                  <code title={r.runId}>{r.runId.slice(0, 8)}</code>
                </div>
                <p>
                  {r.blockers.join('; ') ||
                    (zh
                      ? '可从已保存的结果继续，旧操作不会直接重放。'
                      : 'Continue from saved outcomes without replaying old calls.')}
                </p>
                <div className="team-actions">
                  <button
                    onClick={() =>
                      void action(() => api('/runs/' + r.runId + '/team-recovery-check', {}))
                    }
                  >
                    {zh ? '仅核对现有结果' : 'Inspect existing outcomes'}
                  </button>
                  <button
                    className="team-secondary"
                    disabled={!r.eligible}
                    onClick={() => void action(() => api('/runs/' + r.runId + '/team-recover', {}))}
                  >
                    {zh ? '核对并恢复此成员' : 'Inspect and resume member'}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
        {!!events.length && (
          <details className="team-history">
            <summary>
              <History size={14} />
              {zh ? '自动化记录' : 'Automation history'}
              <span className="team-count">{events.length}</span>
            </summary>
            {events.map((e) => (
              <details key={e.id}>
                <summary>{e.action}</summary>
                <pre>{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            ))}
          </details>
        )}
      </div>
    </details>
  );
}
