import { createHash } from 'node:crypto';
import type { Memory } from '../../shared/types.js';
import { memoryAccessible } from '../../shared/memory-scope.js';
import { memoryValid, MemoryLifecycle } from './memory-lifecycle.js';
import { documentAt } from './knowledge-versions.js';
import type { Store } from '../storage/store.js';

// Advisory only: never builds an index or infers quality from collection size.
export function indexAdvice(count: number, dimensions: number[], memoryBudgetMiB?: number) {
  const bytes = dimensions.length === 1 ? count * dimensions[0] * 4 : null;
  const budget = memoryBudgetMiB == null ? null : memoryBudgetMiB * 1024 * 1024;
  return {
    builtinSelection: count < 2000 ? 'exact' : 'hnsw',
    recommendation:
      dimensions.length > 1
        ? 'repair_mixed_dimensions'
        : count < 2000
          ? 'exact'
          : budget != null && bytes != null && bytes > budget
            ? 'evaluate_compression'
            : 'benchmark_hnsw',
    float32PayloadBytesEstimate: bytes,
    memoryBudgetMiB: memoryBudgetMiB ?? null,
    candidates: ['exact', 'hnsw', 'ivf-flat', 'ivf-pq'],
    constraints: [
      'HNSW adds graph memory; payload bytes are not total RAM or disk usage.',
      'IVF requires representative training data, nlist/nprobe tuning and recall benchmarks.',
      'PQ is lossy compression, commonly combined with IVF; validate dimension/subquantizer compatibility and recall loss.',
      'Backend support, latency, updates and measured recall matter; counts alone never authorize switching or rebuilding.',
    ],
    automaticMutation: false,
  };
}

function* knowledgeStatusSteps(
  store: Store,
  scopes: string[],
  fingerprint: string,
  enabled: boolean,
  at = Date.now(),
  memoryBudgetMiB?: number,
) {
  const allowed = [...new Set(scopes)];
  const docs = store.list<any>('document').filter((d) => allowed.includes(d.scope));
  const current = new Set(docs.filter((d) => documentAt(d, at)).map((d) => d.id));
  const dimensions = new Map<number, number>();
  let chunks = 0,
    textBytes = 0,
    stored = 0,
    compatible = 0,
    invalid = 0,
    stale = 0,
    vectorJsonBytes = 0;
  if (allowed.length) {
    // Iteration avoids copying the entire vector corpus into an additional JS array.
    const rows = store.db
      .prepare(
        'SELECT document_id,length(CAST(text AS BLOB)) bytes,vector FROM chunks WHERE scope IN (' +
          allowed.map(() => '?').join(',') +
          ')',
      )
      .iterate(...allowed);
    let visited = 0;
    for (const row of rows as Iterable<any>) {
      if (++visited % 64 === 0) yield;
      if (!current.has(row.document_id)) continue;
      chunks++;
      textBytes += Number(row.bytes);
      if (row.vector == null) continue;
      stored++;
      vectorJsonBytes += Buffer.byteLength(row.vector);
      try {
        const v = JSON.parse(row.vector);
        if (
          !Array.isArray(v?.values) ||
          !v.values.length ||
          !v.values.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
          !v.values.some((n: number) => n !== 0)
        ) {
          invalid++;
          continue;
        }
        if (!enabled || v.model !== fingerprint) {
          stale++;
          continue;
        }
        compatible++;
        dimensions.set(v.values.length, (dimensions.get(v.values.length) || 0) + 1);
      } catch {
        invalid++;
      }
    }
  }
  const watches = store.list<any>('knowledge-watch').filter((w) => allowed.includes(w.id));
  const sources = watches.map((w) => ({
    scope: w.id,
    status: w.status ?? 'unknown',
    issueCount: Array.isArray(w.issues) ? w.issues.length : 0,
    hasError: !!w.error,
    updatedAt: w.updatedAt ?? null,
    currentCycle: w.progress
      ? {
          startedAt: w.progress.startedAt ?? null,
          updatedAt: w.progress.updatedAt ?? null,
          phase: w.progress.phase ?? 'unknown',
          completed: w.progress.completed ?? 0,
          total: w.progress.total ?? null,
          imported: w.progress.imported ?? 0,
          unchangedSkipped: w.progress.reused ?? 0,
          failed: w.progress.failed ?? 0,
        }
      : null,
    lastCompletedScan: w.scan
      ? {
          files: w.scan.files ?? 0,
          newOrChanged: w.scan.updated ?? 0,
          unchanged: w.scan.unchanged ?? 0,
        }
      : null,
    note: 'Processing includes scanning unchanged files. Imported counts are document operations, not vector writes. Compare observations with matching scopes, asOf and timestamps; old traces do not prove current growth.',
  }));
  const failed = sources.some((w) => w.hasError || w.issueCount > 0);
  const state = !allowed.length
    ? 'disabled'
    : !current.size
      ? failed
        ? 'import_failed'
        : watches.length
          ? 'awaiting_import'
          : 'not_imported'
      : !chunks
        ? 'no_searchable_chunks'
        : !enabled
          ? 'lexical_only'
          : dimensions.size > 1
            ? 'incompatible_dimensions'
            : compatible < chunks
              ? 'index_incomplete'
              : 'ready';
  return {
    state,
    scopes: allowed,
    asOf: at,
    documents: {
      current: current.size,
      retainedVersions: docs.length,
      nonCurrentVersions: docs.length - current.size,
    },
    chunks: {
      current: chunks,
      textUtf8Bytes: textBytes,
      note: 'Chunk text includes overlap; this is not source-file size.',
    },
    vectors: {
      stored,
      compatible,
      missing: chunks - stored,
      staleModel: stale,
      invalid,
      pendingOrInvalid: chunks - compatible,
      dimensions: Object.fromEntries(dimensions),
      serializedBytes: vectorJsonBytes,
      coverage: chunks ? compatible / chunks : null,
    },
    embeddingEnabled: enabled,
    sources,
    storage: {
      physicalDiskBytes: null,
      externalCollectionCount: null,
      reason:
        'Shared database pages and remote collection totals cannot be attributed to this authorized scope from local records.',
    },
    indexAdvice: indexAdvice(compatible, [...dimensions.keys()], memoryBudgetMiB),
    notice:
      'Ready means indexed, not relevant or correct. Empty search results do not prove the source contains no answer.',
  };
}

export function memoryStatus(
  store: Store,
  scopes: string[],
  conversationId: string,
  fingerprint: string,
  enabled: boolean,
  at = Date.now(),
) {
  const records = store
    .list<Memory>('memory')
    .filter((m) => scopes.includes(m.scope) && memoryAccessible(m, conversationId));
  const lifecycle = new MemoryLifecycle(store);
  const states: Record<string, number> = {};
  let eligible = 0,
    expired = 0,
    stored = 0,
    compatible = 0,
    bytes = 0;
  for (const m of records) {
    const state = m.status || (m.active ? 'active' : 'candidate');
    states[state] = (states[state] || 0) + 1;
    if ((m.expiresAt != null && m.expiresAt <= at) || (m.validUntil != null && m.validUntil <= at))
      expired++;
    bytes += Buffer.byteLength(m.content);
    const v = store.maybe<any>('memory-vector', m.id);
    if (v) stored++;
    if (!memoryValid(m, at) || !lifecycle.evidenceValid(m)) continue;
    eligible++;
    const hash = createHash('sha256')
      .update(JSON.stringify([m.content, m.revision, m.scope]))
      .digest('hex');
    if (
      enabled &&
      v?.hash === hash &&
      v.model === fingerprint &&
      Array.isArray(v.values) &&
      v.values.length &&
      v.values.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
      v.values.some((n: number) => n !== 0)
    )
      compatible++;
  }
  return {
    scopes,
    visibleRecords: records.length,
    states,
    expired,
    recallEligible: eligible,
    contentUtf8Bytes: bytes,
    vectors: { stored, eligibleCompatible: compatible, eligibleUnindexed: eligible - compatible },
    note: 'State counts overlap expiration. Recall eligibility is not a promise of a query match; conversation-local memories from other chats are excluded.',
  };
}

export function knowledgeStatus(...args: Parameters<typeof knowledgeStatusSteps>) {
  const steps = knowledgeStatusSteps(...args);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
export async function knowledgeStatusAsync(...args: Parameters<typeof knowledgeStatusSteps>) {
  const steps = knowledgeStatusSteps(...args);
  try {
    let next = steps.next();
    while (!next.done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      next = steps.next();
    }
    return next.value;
  } finally {
    steps.return(undefined as never);
  }
}
