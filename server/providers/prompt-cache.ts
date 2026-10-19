import type { Profile, ToolSpec } from '../../shared/types.js';
// Cloud KV state belongs to the provider. No invented cache-control flags.
export function promptCacheMode(profile: Profile) {
  try {
    return new URL(profile.baseUrl).hostname === 'api.deepseek.com'
      ? 'deepseek-automatic-prefix'
      : 'provider-managed-or-unknown';
  } catch {
    return 'provider-managed-or-unknown';
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical); // enum/tuple order is semantic
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function cacheStableTools(_profile: Profile, tools: ToolSpec[]): ToolSpec[] {
  // Stable serialization is provider-independent; cache support remains observational.
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ ...t, parameters: canonical(t.parameters) as ToolSpec['parameters'] }));
}
