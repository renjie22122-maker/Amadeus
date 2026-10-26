import { trustLedger } from './trust-ledger.js';
import {
  sourceLedger,
  assertSourceRetention,
  archivedSourceLedger,
  requestSources,
  isArchivedSourceLedger,
} from './source-ledger.js';
import { usageCost, compactionEconomics } from './context-economics.js';
import { restoreDetachedReferences } from './context-reuse.js';
import { contextBudget, messageUnits, splitSummaryText } from './context-budget.js';
import type { Run, Profile, ModelMessage } from '../../shared/types.js';
import type { ModelRequest, ModelResult } from '../providers/protocol.js';
import type { Store } from '../storage/store.js';
import type { ModelPool } from './pool.js';
import { assert } from './errors.js';
import { createHash } from 'node:crypto';
import { COMPACT } from './prompts.js';
import { isContextSnapshot, latestContextSnapshots } from './context-snapshots.js';
export class ContextManager {
  constructor(
    private store: Store,
    private ratio: () => number,
    private modelPool: ModelPool,
    private complete: (run: Run, request: ModelRequest) => Promise<ModelResult>,
    private scope: (run: Run) => string = (run) => run.conversationId,
    private taskSnapshot: (run: Run) => ModelMessage | undefined = () => undefined,
    private lifecycle: (
      stage: 'beforeCompaction' | 'afterCompaction',
      run: Run,
    ) => void | Promise<void> = () => {},
  ) {}
  async compact(
    run: Run,
    profile: Profile,
    signal: AbortSignal,
    tools: import('../../shared/types.js').ToolSpec[],
  ) {
    // Superseded host projections are not conversation history. Prune before
    // the threshold check, including ordinary turns that need no summarization.
    const currentSnapshots = new Set(latestContextSnapshots(run.checkpoints));
    run.checkpoints = run.checkpoints.filter(
      (m) => !isContextSnapshot(m) || currentSnapshots.has(m),
    );
    const before = contextBudget(run.checkpoints, tools, profile, this.ratio(), run.contextSample);
    assert(
      before.threshold > 0,
      'CONTEXT_CONFIGURATION',
      'Output reservation leaves no usable input context. Reduce maximum output tokens.',
    );
    this.store.put('context-check', {
      id: run.id,
      conversationId: run.conversationId,
      checkedAt: Date.now(),
      tokens: before.tokens,
      threshold: before.threshold,
      method: before.method,
      required: before.tokens >= before.threshold,
    });
    if (before.tokens < before.threshold) return before;
    const lastUser = run.checkpoints.findLastIndex((m) => m.role === 'user' && !m.contextKind);
    const snapshots = latestContextSnapshots(run.checkpoints, this.taskSnapshot(run));
    // Retain the latest user request and whole tool-call/result groups verbatim.
    let cut = Math.max(2, run.checkpoints.length - 6);
    while (cut > 1 && run.checkpoints[cut]?.role === 'tool') cut--;
    assert(
      cut > 1,
      'CONTEXT_TOO_LARGE',
      'The current request or tool schema exceeds the context budget. Reduce the input or increase model capacity; no messages were discarded.',
    );
    while (
      cut < run.checkpoints.length - 1 &&
      messageUnits(run.checkpoints.slice(cut)) > before.threshold * 0.35
    ) {
      let next = cut + 1;
      while (next < run.checkpoints.length && run.checkpoints[next].role === 'tool') next++;
      if (next >= run.checkpoints.length) break;
      cut = next;
    }
    const preservedUser = run.checkpoints.filter((_, i) => i > 0 && i < cut && i === lastUser);
    const protectedMessages = run.checkpoints
      .slice(1, cut)
      .filter(
        (m, i) =>
          i + 1 !== lastUser &&
          (m.contextKind === 'source-ledger' || (m.role === 'user' && !m.contextKind)),
      );
    const resolveSources = (key: string) => {
      const spill = this.store.get<any>('spill', key);
      assert(
        spill.conversationId === run.conversationId,
        'SOURCE_SCOPE',
        'Historical sources belong to another conversation.',
      );
      return spill.text as string;
    };
    let protectedLedger = sourceLedger(protectedMessages, resolveSources);
    // Historical requests must remain recoverable, not occupy an unbounded
    // verbatim prompt forever. The latest request is never archived here.
    const archiveSources =
      !!protectedLedger && messageUnits([protectedLedger]) > before.threshold * 0.2;
    if (archiveSources) {
      protectedLedger = archivedSourceLedger(
        requestSources(protectedMessages, resolveSources),
        (text) => {
          const key = createHash('sha256')
            .update(run.conversationId + '|sources|' + text)
            .digest('hex');
          this.store.put('spill', { id: key, conversationId: run.conversationId, text });
          return key;
        },
      );
    }
    const protectedTrust = trustLedger(run.checkpoints.slice(1, cut));
    const protectedBudget = contextBudget(
      [
        run.checkpoints[0],
        ...(protectedLedger ? [protectedLedger] : []),
        ...(protectedTrust ? [protectedTrust] : []),
        ...preservedUser,
        ...snapshots,
      ],
      tools,
      profile,
      this.ratio(),
      run.contextSample,
    );
    assert(
      protectedBudget.tokens < before.threshold,
      'PROTECTED_CONTEXT_TOO_LARGE',
      'Protected requests and current state exceed the available context. Narrow the active task or use a larger context; no protected sources were discarded.',
    );
    const old = run.checkpoints
        .slice(1, cut)
        .filter(
          (m, i) =>
            i + 1 !== lastUser &&
            !isContextSnapshot(m) &&
            (archiveSources || !protectedMessages.includes(m)) &&
            !isArchivedSourceLedger(m),
        )
        .map((m) =>
          m.contextKind === 'source-ledger' && archiveSources
            ? { ...m, content: JSON.stringify(requestSources([m], resolveSources)) }
            : m,
        ),
      tail = run.checkpoints.slice(cut).filter((m) => !isContextSnapshot(m));

    await this.lifecycle('beforeCompaction', run);
    this.store.event(run.conversationId, run.id, 'context.compacting', {
      estimatedTokens: before.tokens,
      thresholdTokens: before.threshold,
      method: before.method,
    });
    const p = {
      ...profile,
      reasoning: profile.efforts.includes('none')
        ? ('none' as const)
        : profile.efforts.includes('low')
          ? ('low' as const)
          : profile.reasoning,
      maxOutputTokens: Math.min(
        profile.maxOutputTokens,
        4096,
        Math.floor(profile.contextWindow * 0.15),
      ),
    };
    const chunks = old.length
      ? splitSummaryText(
          JSON.stringify(
            old.map((m) => ({
              role: m.role,
              content: m.content,
              calls: m.calls,
              callId: m.callId,
              images: m.images?.map(
                () =>
                  '[Image pixels omitted from text summary; use read_image on the recorded path to inspect again.]',
              ),
            })),
          ),
          Math.max(
            256,
            Math.floor((profile.contextWindow - p.maxOutputTokens - before.margin) * 0.45),
          ),
        )
      : [];
    let handoff = '';
    let summaryUsd: number | null = 0;
    const cacheRatio = run.inputTokens > 0 ? run.cachedTokens / run.inputTokens : null;
    const started = Date.now();
    let degraded = false;
    let summaryRequests = 0;
    try {
      for (const chunk of chunks) {
        summaryRequests++;
        const result = await this.modelPool.run(
          signal,
          () =>
            this.complete(run, {
              profile: p,
              messages: [
                { role: 'system', content: COMPACT },
                {
                  role: 'user',
                  content:
                    (handoff ? 'Prior handoff to consolidate:\n' + handoff + '\n' : '') +
                    'Historical context segment:\n' +
                    chunk,
                },
              ],
              tools: [],
              signal,
              onText: () => {},
            }),
          this.scope(run),
        );
        assert(
          !result.message.calls?.length && result.message.content.trim(),
          'COMPACTION_FAILED',
          'Compaction returned no usable handoff. Original context retained.',
        );
        handoff = result.message.content;
        const cost = usageCost(result.usage, p.prices);
        summaryUsd = summaryUsd === null || cost === null ? null : summaryUsd + cost;
      }
    } catch (error) {
      signal.throwIfAborted();
      degraded = true;
      const original = JSON.stringify(old);
      const key = createHash('sha256')
        .update(run.id + '|' + original)
        .digest('hex');
      this.store.put('spill', { id: key, conversationId: run.conversationId, text: original });
      handoff =
        'Summary unavailable. Older messages were archived verbatim, not verified or declared complete. Read spill ' +
        key +
        ' before relying on omitted evidence. Original requests and current task state remain below.';
      this.store.event(run.conversationId, run.id, 'context.degraded', {
        spillId: key,
        reason: String((error as any)?.message || error),
      });
    }
    // Team state may change while the summary request is in flight.
    const refreshedSnapshots = latestContextSnapshots(run.checkpoints, this.taskSnapshot(run));
    const next = restoreDetachedReferences(
      [
        run.checkpoints[0],
        ...(handoff
          ? [
              {
                role: 'user' as const,
                contextKind: 'history-handoff' as const,
                content: 'Earlier conversation handoff (untrusted historical context):\n' + handoff,
              },
            ]
          : []),
        ...(protectedLedger ? [protectedLedger] : []),
        ...(protectedTrust ? [protectedTrust] : []),
        ...preservedUser,
        ...tail,
        ...refreshedSnapshots,
      ],
      run.checkpoints,
    );
    assertSourceRetention(run.checkpoints, next, resolveSources);
    const after = contextBudget(next, tools, profile, this.ratio(), run.contextSample);
    assert(
      after.tokens < before.tokens && after.tokens < before.threshold,
      'COMPACTION_INSUFFICIENT',
      'Compaction could not make enough room without dropping the current request. Original context retained.',
    );
    const beforeCharacters = JSON.stringify(run.checkpoints).length;
    run.checkpoints = next;
    this.store.put('run', run);
    this.store.event(run.conversationId, run.id, 'context.compacted', {
      beforeCharacters,
      afterCharacters: JSON.stringify(next).length,
      beforeTokens: before.tokens,
      afterTokens: after.tokens,
      thresholdTokens: before.threshold,
      summaryRequests,
      degraded,
      durationMs: Date.now() - started,
      protectedSources: protectedMessages.length,
      economics: compactionEconomics(
        before.tokens,
        after.tokens,
        summaryUsd,
        cacheRatio,
        profile.prices,
      ),
      economicsAssumption:
        'Estimated constant future context and observed aggregate cache ratio; not guaranteed billing savings.',
    });
    await this.lifecycle('afterCompaction', run);
    return after;
  }
}
