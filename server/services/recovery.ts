import { inspectReceipt } from './effect-recovery-protocols.js';
import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import type { FileScope } from './paths.js';
export async function inspectEffects(store: Store, files: FileScope, conversationId: string) {
  const resolved = store.reconcileKnownEffects(conversationId);
  for (const effect of store.unknownEffects(conversationId)) {
    const receipt = inspectReceipt(store, effect, conversationId);
    if (receipt) {
      store.transaction(() => {
        store.resolveEffect(effect.id, receipt.note + ' No replay performed.');
        store.event(conversationId, effect.run_id, 'effect.reconciled', {
          effectId: effect.id,
          ...receipt,
          replayed: false,
        });
      });
      resolved.push(effect.id);
      continue;
    }
    if (!['write_file', 'edit_file'].includes(effect.tool)) continue;
    const args = JSON.parse(effect.args);
    if (typeof args.path !== 'string') continue;
    let current: string;
    try {
      current = await files.read(args.path, 1000000);
    } catch {
      continue;
    } // Missing/inaccessible files remain unknown; storage errors below propagate.
    const expectation = store
      .events(conversationId)
      .find((e) => e.type === 'effect.expected' && e.data.effectId === effect.id)?.data;
    const matches =
      effect.tool === 'write_file'
        ? typeof args.content === 'string' && current === args.content
        : expectation?.path === args.path &&
          expectation?.sha256 === createHash('sha256').update(current).digest('hex');
    if (matches) {
      const pending = store.db
        .prepare("SELECT id FROM effects WHERE id=? AND state='started'")
        .get(effect.id);
      if (!pending) continue; // Another inspection may have completed while reading the file.
      store.resolveEffect(
        effect.id,
        'Automatic read-only check: current file exactly matches the host-recorded expected complete content. No replay performed.',
      );
      resolved.push(effect.id);
    }
  }
  return {
    resolved,
    unresolved: store.unknownEffects(conversationId).map((e) => ({
      id: e.id,
      tool: e.tool,
      args: JSON.parse(e.args),
      replayAllowed: false,
      recovery:
        store.maybe<any>('effect-reference', e.id)?.protocol ||
        (['write_file', 'edit_file'].includes(e.tool)
          ? 'exact-postimage'
          : 'external-inspection-required'),
    })),
  };
}
