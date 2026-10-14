import type { ConversationDetail } from '../types';
import { groupManagementRoles, managementMemberLabel } from '../team-management';

export function TeamManagement({
  team,
  members = [],
  zh,
  onTransfer,
}: {
  team: NonNullable<ConversationDetail['teamSpace']>;
  members?: ConversationDetail['teamMembers'];
  zh: boolean;
  onTransfer: (role: string, target: string) => void;
}) {
  const roleName = (role: string) =>
    zh
      ? (
          { coordinator: '协调', planner: '规划', reviewer: '复核', summarizer: '汇总' } as Record<
            string,
            string
          >
        )[role] || role
      : role;
  const label = (id: string) =>
    managementMemberLabel(id, team.id, members.find((m) => m.runId === id)?.name, zh);
  return (
    <section
      className="team-management"
      aria-label={zh ? '团队管理职责' : 'Team management responsibilities'}
    >
      <strong>{zh ? '团队管理职责' : 'Team management responsibilities'}</strong>
      <p className="muted">
        {zh
          ? '这是管理分工，不是成员人数，也不是专业角色模板。实际成员及任务见本轮「协作关系与成员」。'
          : 'These are management responsibilities, not member counts or a professional role template. Actual members and tasks appear in this round’s collaboration view.'}
      </p>
      {groupManagementRoles(team.roles).map((group) => (
        <div className="team-management-owner" key={group.member}>
          <strong title={members.find((m) => m.runId === group.member)?.name || group.member}>
            {label(group.member)}
          </strong>
          <div className="team-management-badges">
            {group.roles.map((role) => (
              <span className="pill" key={role}>
                {roleName(role)}
              </span>
            ))}
          </div>
          {group.roles.length > 1 && (
            <small className="muted">{zh ? '同一成员兼任' : 'Held by the same member'}</small>
          )}
        </div>
      ))}
      <details className="team-management-transfer">
        <summary>{zh ? '调整管理分工（可选）' : 'Adjust responsibilities (optional)'}</summary>
        <p className="muted">
          {zh
            ? '移交给已有成员，不创建新 Agent，也不扩大权限。复核职责不等于已完成独立验证。'
            : 'Transfer to an existing member; no new agent or permissions. A reviewer role does not establish independent verification.'}
        </p>
        {Object.entries(team.roles).map(([role, owner]) => {
          const targets = members.filter(
            (m) =>
              m.runId !== owner &&
              !['completed', 'failed', 'interrupted'].includes(m.status) &&
              !team.closed[m.runId],
          );
          return (
            <label className="team-role-row" key={role}>
              <span>{roleName(role)}</span>
              <select
                aria-label={(zh ? '移交' : 'Transfer ') + roleName(role)}
                disabled={!targets.length}
                value=""
                onChange={(e) => {
                  if (e.target.value) onTransfer(role, e.target.value);
                }}
              >
                <option value="">
                  {!targets.length
                    ? zh
                      ? '暂无其他活跃成员'
                      : 'No other active member'
                    : zh
                      ? '选择接任成员…'
                      : 'Choose a member…'}
                </option>
                {targets.map((m) => (
                  <option key={m.runId} value={m.runId}>
                    {label(m.runId)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </details>
    </section>
  );
}
