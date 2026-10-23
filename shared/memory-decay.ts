import type { Memory } from './types.js';
export type DecayPolicy = 'auto' | 'stable' | 'time' | 'turns' | 'time-and-turns';
export function memoryDecayPolicy(m: Memory): Exclude<DecayPolicy, 'auto'> {
  if (m.decayPolicy && m.decayPolicy !== 'auto') return m.decayPolicy;
  if (m.stability === 'stable') return 'stable';
  if (m.stability === 'evolving') return 'time';
  if (m.stability === 'temporary') return 'time-and-turns';
  if (m.kind === 'fact' || m.kind === 'goal') return 'time';
  return m.kind === 'episode' || (m.kind === 'decision' && m.scope === 'user')
    ? 'time-and-turns'
    : 'stable';
}
export function memoryDecay(m: Memory, now = Date.now(), laterUserTurns = 0) {
  const policy = memoryDecayPolicy(m);
  const days = Math.max(0, now - (m.observedAt ?? m.validFrom ?? m.createdAt)) / 86400000;
  const time = days / Math.max(1, m.halfLifeDays || 30);
  const turns = Math.max(0, laterUserTurns) / Math.max(1, m.halfLifeTurns || 100);
  const exponent =
    policy === 'stable' ? 0 : policy === 'time' ? time : policy === 'turns' ? turns : time + turns;
  return { policy, factor: Math.max(0.05, Math.pow(0.5, exponent)), days, laterUserTurns };
}
