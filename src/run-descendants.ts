/** Traverse parent links once, without loading checkpoints or scanning the array per parent. */
export function runDescendants<T extends { id: string; parentRunId?: string | null }>(
  runs: T[],
  root: string,
): T[] {
  const children = new Map<string, string[]>();
  for (const run of runs) {
    if (run.parentRunId) {
      const list = children.get(run.parentRunId) || [];
      list.push(run.id);
      children.set(run.parentRunId, list);
    }
  }
  const found = new Set<string>();
  const pending = [root];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    if (found.has(id)) continue;
    found.add(id);
    pending.push(...(children.get(id) || []));
  }
  return runs.filter((run) => found.has(run.id));
}
