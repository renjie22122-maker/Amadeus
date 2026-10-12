import type { Conversation, Project } from '../shared/types';
export function recentChats(chats: Conversation[]) {
  return [...chats].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
}
export function recentProjects(projects: Project[], chats: Conversation[]) {
  const activity = new Map<string, number>();
  for (const c of chats)
    if (c.projectId && !c.archived)
      activity.set(c.projectId, Math.max(activity.get(c.projectId) || 0, c.updatedAt));
  return [...projects].sort(
    (a, b) =>
      Math.max(b.createdAt, activity.get(b.id) || 0) -
        Math.max(a.createdAt, activity.get(a.id) || 0) || a.id.localeCompare(b.id),
  );
}
export function visibleEntries<T extends { id: string; pinned?: boolean }>(
  items: T[],
  limit: number,
  selected?: string,
) {
  return items.filter((item, index) => index < limit || item.id === selected || item.pinned);
}
