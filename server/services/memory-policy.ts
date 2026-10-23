import type { Conversation } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { Configuration } from './settings.js';
import { conversationMemoryScope } from '../../shared/memory-scope.js';
export const chatMemoryScope = conversationMemoryScope;
export function inheritedMemory(
  store: Store,
  config: Configuration,
  c: Pick<Conversation, 'projectId' | 'profileId'> & Partial<Conversation>,
) {
  const policy = store.maybe<any>('memory-policy', chatMemoryScope(c));
  const profile = config.get().profiles.find((p) => p.id === c.profileId);
  const target = profile ? profile.id + '|' + profile.baseUrl : '';
  const isolated = !!(c.remoteChatOnly || c.remoteMemoryOnly);
  const enabled = isolated
    ? c.automaticMemory !== false
    : !!(policy?.enabled && policy.targets?.includes(target));
  return {
    memoryPolicy: 'inherit' as const,
    automaticMemory: enabled,
    generateMemory: enabled,
    memory: enabled,
    includeUserMemory: false,
    memoryGenerationTarget: enabled ? target : undefined,
  };
}
