export function groupManagementRoles(roles: Record<string, string>) {
  const groups = new Map<string, string[]>();
  for (const [role, member] of Object.entries(roles))
    groups.set(member, [...(groups.get(member) || []), role]);
  return [...groups].map(([member, roles]) => ({ member, roles }));
}
export function managementMemberLabel(
  id: string,
  root: string,
  name: string | undefined,
  zh: boolean,
) {
  if (id === root) return zh ? '主 Agent' : 'Lead agent';
  const title = name?.trim() || (zh ? '成员' : 'Member');
  return (title.length > 32 ? title.slice(0, 32) + '…' : title) + ' · ' + id.slice(0, 6);
}
