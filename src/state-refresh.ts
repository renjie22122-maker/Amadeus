/** Preserve unchanged sections so heartbeat refreshes do not rerender the workspace. */
export function mergeState<T extends object>(old: T, incoming: Partial<T>): T {
  let next = old;
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (old[key] === incoming[key] || JSON.stringify(old[key]) === JSON.stringify(incoming[key]))
      continue;
    if (next === old) next = { ...old };
    next[key] = incoming[key] as T[keyof T];
  }
  return next;
}
