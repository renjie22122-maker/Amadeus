import { chatMemorySources } from './chat-memory-source.js';
import type { Memory } from '../../shared/types.js';
import { memoryConversation } from '../../shared/memory-scope.js';
import { Store } from '../storage/store.js';
// User turns only; tool chatter, token volume and retrievals never age or refresh a memory.
export function memoryActivity(store: Store, memories: Memory[], at = Date.now()) {
  const cache = new Map<string, { id: number; createdAt: number }[]>();
  const ages = new Map<string, number>();
  for (const m of memories) {
    const chat = memoryConversation(m);
    if (!chat || m.sourceEventId == null) continue;
    let events = cache.get(chat);
    if (!events) {
      events = m.scope.startsWith('chat:')
        ? chatMemorySources(store, chat)
            .map((s) => ({ id: s.id, createdAt: s.at }))
            .filter((e) => e.createdAt <= at)
        : store
            .events(chat, 0, 'user.message')
            .filter((e) => !e.data.scheduledTrigger)
            .filter((e) => e.createdAt <= at);
      cache.set(chat, events);
    }
    // Unknown source means unavailable activity evidence, not arbitrarily old.
    const anchor = m.reinforcedEventId || m.sourceEventId;
    if (events.some((e) => e.id === anchor))
      ages.set(m.id, events.filter((e) => e.id > anchor).length);
  }
  return ages;
}
