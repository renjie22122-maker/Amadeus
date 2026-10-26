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
  const days =
    Math.max(0, now - Math.max(m.observedAt ?? m.validFrom ?? m.createdAt, m.reinforcedAt || 0)) /
    86400000;
  // Independent confirmations slow forgetting with diminishing returns; never establish truth.
  const strength = Math.min(3, 1 + Math.log2(1 + Math.max(0, m.reinforcementCount || 0)) / 2);
  const time = days / (Math.max(1, m.halfLifeDays || 30) * strength);
  const turns = Math.max(0, laterUserTurns) / (Math.max(1, m.halfLifeTurns || 100) * strength);
  const exponent =
    policy === 'stable' ? 0 : policy === 'time' ? time : policy === 'turns' ? turns : time + turns;
  return { policy, factor: Math.max(0.05, Math.pow(0.5, exponent)), days, laterUserTurns };
}
