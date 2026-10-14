import { createHash } from 'node:crypto';
import { Store, id } from '../storage/store.js';
import type { Run } from '../../shared/types.js';
import { rootRun } from './task-board.js';
import { assert, AppError } from '../core/errors.js';
import { documentAt } from './knowledge-versions.js';
export const RESEARCH_LIMITS = {
  maxAttempts: 6,
  maxReads: 16,
  maxReadCharacters: 160000,
  maxRetrievalMs: 720000,
  initialQueryMs: 180000,
  extendedQueryMs: 300000,
  maxFailures: 2,
} as const;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export type ResearchEvidence = {
  id: string;
  documentId: string;
  version: number;
  hash: string;
  ordinal: number;
};
export type ResearchHypothesis = {
  id: string;
  explanation: string;
  supports: string[];
  counters: string[];
  missing: string[];
  discriminator: string;
};
export type ReadingNote = {
  kind?: 'timeline' | 'relationship' | 'pattern' | 'constraint' | 'summary';
  timeContext?: string;
  text: string;
  evidenceIds: string[];
  nature: 'observation' | 'reported-claim' | 'inference';
  limitation: string;
};
export interface ResearchCase {
  id: string;
  conversationId: string;
  runId: string;
  rootId: string;
  scopes: string[];
  question: string;
  revision: number;
  asOf: number;
  evidence: ResearchEvidence[];
  hypotheses: ResearchHypothesis[];
  notes: ReadingNote[];
  attempts: {
    runId?: string;
    elapsedEstimated?: boolean;
    startedAt?: number;
    elapsedMs?: number;
    timeLimitMs?: number;
    failureReason?: string;
    query: string;
    gap: string;
    distinguishes: string[];
    status: string;
    newEvidence?: number;
    investigationId?: string;
  }[];
  reads?: { key: string; runId: string; characters: number }[];
  failureStreak?: number;
  noGain: number;
  status: 'open' | 'concluded' | 'inconclusive';
  conclusion?: string;
}
/** Research claims remain model assessments. No votes, model calls or truth scores. */
export class ResearchCases {
  constructor(
    private store: Store,
    private run: Run,
    private scopes: string[],
  ) {}
  create(question: string) {
    const normalized = (value: string) =>
      value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    const rootId = rootRun(this.store, this.run);
    const previous = this.store
      .list<ResearchCase>('research-case')
      .find(
        (c) =>
          c.rootId === rootId &&
          normalized(c.question) === normalized(question) &&
          c.scopes.every((s) => this.scopes.includes(s)),
      );
    if (previous) return previous; // Repeating the same question cannot reset its budget.
    const c: ResearchCase = {
      id: id(),
      conversationId: this.run.conversationId,
      runId: this.run.id,
      rootId: rootRun(this.store, this.run),
      scopes: [...this.scopes],
      question,
      revision: 1,
      asOf: Date.now(),
      evidence: [],
      hypotheses: [],
      notes: [],
      attempts: [],
      noGain: 0,
      status: 'open',
    };
    this.store.put('research-case', c);
    return c;
  }
  get(key: string) {
    const c = this.store.get<ResearchCase>('research-case', key);
    assert(
      (c.conversationId === this.run.conversationId ||
        c.rootId === rootRun(this.store, this.run)) &&
        c.scopes.every((s) => this.scopes.includes(s)),
      'RESEARCH_SCOPE',
      'Research belongs to another conversation/task tree or knowledge scope.',
    );
    return c;
  }
  document(key: string, asOf: number) {
    const doc = this.store.get<any>('document', key);
    assert(
      this.scopes.includes(doc.scope) && documentAt(doc, asOf),
      'KNOWLEDGE_SCOPE',
      'Document is outside the accessible version.',
    );
    return doc;
  }
  evidence(key: string, asOf: number): ResearchEvidence {
    const row = this.store.db
      .prepare('SELECT id,document_id,scope,text,ordinal FROM chunks WHERE id=?')
      .get(key) as any;
    assert(
      row && this.scopes.includes(row.scope),
      'RESEARCH_EVIDENCE',
      'Unknown or inaccessible source chunk.',
    );
    const doc = this.document(row.document_id, asOf);
    return {
      id: row.id,
      documentId: doc.id,
      version: doc.version || 1,
      hash: hash(row.text),
      ordinal: row.ordinal,
    };
  }
  addEvidence(key: string, chunkIds: string[]) {
    return this.store.transaction(() => {
      const c = this.get(key);
      let changed = false;
      for (const chunkId of chunkIds) {
        const e = this.evidence(chunkId, c.asOf);
        const index = c.evidence.findIndex((v) => v.id === e.id);
        if (index < 0) {
          assert(
            c.status === 'open',
            'RESEARCH_CLOSED',
            'Research is closed; inspect existing evidence without changing the case.',
          );
          c.evidence.push(e);
          changed = true;
        } else
          assert(
            c.evidence[index].hash === e.hash && c.evidence[index].version === e.version,
            'RESEARCH_STALE',
            'Previously assessed source changed; do not silently rebind old notes to new text.',
          );
      }
      if (changed) {
        c.revision++;
        this.store.put('research-case', c);
      }
      return c;
    });
  }
  recover(key: string) {
    return this.store.transaction(() => {
      const c = this.get(key);
      let changed = false;
      for (const a of c.attempts) {
        if (a.status !== 'running' || !a.runId) continue;
        const owner = this.store.maybe<Run>('run', a.runId);
        if (!owner || ['completed', 'failed', 'interrupted'].includes(owner.status)) {
          a.status = 'failed';
          a.failureReason = 'interrupted';
          a.elapsedMs = Math.min(
            a.timeLimitMs || RESEARCH_LIMITS.initialQueryMs,
            Math.max(0, Date.now() - (a.startedAt || Date.now())),
          );
          a.elapsedEstimated = true;
          c.failureStreak = (c.failureStreak || 0) + 1;
          changed = true;
        }
      }
      if (changed) {
        c.revision++;
        this.store.put('research-case', c);
      }
      return this.inspect(key);
    });
  }
  inspect(key: string) {
    const c = this.get(key);
    const stale = c.evidence
      .filter((e) => {
        try {
          const fresh = this.evidence(e.id, c.asOf);
          return fresh.hash !== e.hash || fresh.version !== e.version;
        } catch (error) {
          if (
            error instanceof AppError &&
            ['NOT_FOUND', 'KNOWLEDGE_SCOPE', 'RESEARCH_EVIDENCE'].includes(error.code)
          )
            return true;
          throw error;
        }
      })
      .map((e) => e.id);
    return {
      ...c,
      staleEvidenceIds: stale,
      distinctPassageHashes: new Set(
        c.evidence.filter((e) => !stale.includes(e.id)).map((e) => e.hash),
      ).size,
      budget: {
        maximumQueries: RESEARCH_LIMITS.maxAttempts,
        queriesUsed: c.attempts.length,
        retrievalMsUsed: c.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0),
        maximumRetrievalMs: RESEARCH_LIMITS.maxRetrievalMs,
        consecutiveServiceFailures: c.failureStreak || 0,
        maximumReads: RESEARCH_LIMITS.maxReads,
        readsUsed: c.reads?.length || 0,
        maximumReadCharacters: RESEARCH_LIMITS.maxReadCharacters,
        readCharacters: (c.reads || []).reduce((n, r) => n + r.characters, 0),
        stopReasons: [
          ...(c.status !== 'open' ? [c.status] : []),
          ...(c.attempts.length >= 6 ? ['query-budget'] : []),
          ...(c.noGain >= 2 ? ['no-new-evidence'] : []),
          ...((c.failureStreak || 0) >= RESEARCH_LIMITS.maxFailures ? ['service-failures'] : []),
          ...(c.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0) >=
          RESEARCH_LIMITS.maxRetrievalMs
            ? ['retrieval-time-budget']
            : []),
          ...((c.reads?.length || 0) >= 16 ? ['reading-budget'] : []),
        ],
      },
      next:
        c.status !== 'open'
          ? 'Report the recorded conclusion and limitations.'
          : c.noGain >= 2 ||
              c.attempts.length >= RESEARCH_LIMITS.maxAttempts ||
              (c.failureStreak || 0) >= RESEARCH_LIMITS.maxFailures ||
              c.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0) >=
                RESEARCH_LIMITS.maxRetrievalMs
            ? 'Stop retrieval; report unresolved gaps or compare existing evidence.'
            : 'Read existing context first. Retrieve only for a concrete discriminating gap.',
      notice:
        'Source hashes identify duplicate passages, not independent authors. Notes and hypotheses are attributed assessments, not facts; snapshot coverage is not exhaustive.',
    };
  }
  update(
    key: string,
    revision: number,
    hypotheses: ResearchHypothesis[],
    notes: ReadingNote[],
    status: ResearchCase['status'],
    conclusion: string,
  ) {
    return this.store.transaction(() => {
      const c = this.get(key);
      assert(
        c.revision === revision && c.status === 'open',
        'RESEARCH_CHANGED',
        'Inspect the current open research case.',
      );
      assert(
        !c.attempts.some((a) => a.status === 'running'),
        'RESEARCH_BUSY',
        'Wait for the pending investigation before replacing the comparison.',
      );
      assert(
        new Set(hypotheses.map((h) => h.id)).size === hypotheses.length,
        'RESEARCH_HYPOTHESIS',
        'Hypothesis IDs must be distinct.',
      );
      const cited = [
        ...hypotheses.flatMap((h) => [...h.supports, ...h.counters]),
        ...notes.flatMap((n) => n.evidenceIds),
      ];
      const stale = this.inspect(key).staleEvidenceIds;
      assert(
        cited.every((k) => c.evidence.some((e) => e.id === k) && !stale.includes(k)),
        'RESEARCH_EVIDENCE',
        'Cite only read/retrieved, unchanged evidence in this case.',
      );
      assert(
        status !== 'concluded' ||
          (hypotheses.length >= 2 &&
            hypotheses.some((h) => h.supports.length) &&
            !!conclusion.trim()),
        'RESEARCH_CONCLUSION',
        'A comparative conclusion needs alternatives, cited support and explicit rationale; otherwise mark inconclusive.',
      );
      assert(
        status === 'open' || !!conclusion.trim(),
        'RESEARCH_CONCLUSION',
        'Explain the conclusion or unresolved limits.',
      );
      c.evidence = c.evidence.filter((e) => !stale.includes(e.id));
      c.hypotheses = hypotheses;
      c.notes = notes;
      c.status = status;
      c.conclusion = conclusion;
      c.revision++;
      this.store.put('research-case', c);
      this.store.event(this.run.conversationId, this.run.id, 'research.assessed', {
        caseId: c.id,
        revision: c.revision,
        hypotheses,
        notes,
        evidence: c.evidence,
        status,
        conclusion,
        meaning: 'agent-assessment-not-proof',
      });
      return this.inspect(key);
    });
  }
  reserve(key: string, query: string, gap: string, distinguishes: string[]) {
    return this.store.transaction(() => {
      const c = this.get(key);
      const remainingMs =
        RESEARCH_LIMITS.maxRetrievalMs - c.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0);
      assert(
        c.status === 'open' &&
          c.attempts.length < RESEARCH_LIMITS.maxAttempts &&
          c.noGain < 2 &&
          (c.failureStreak || 0) < RESEARCH_LIMITS.maxFailures &&
          remainingMs >= 1000,
        'RESEARCH_STOP',
        'Stop: closed, retrieval count/time budget exhausted, repeated service failures or two successful searches added no evidence. Report limitations; do not create another case to evade the budget.',
      );
      assert(
        !c.attempts.some((a) => a.status === 'running'),
        'RESEARCH_BUSY',
        'One investigation is already pending. Inspect it; do not replay.',
      );
      const normalize = (s: string) =>
        s
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '');
      assert(
        !c.attempts.some((a) => normalize(a.query) === normalize(query) && a.status !== 'failed'),
        'RESEARCH_REPEAT',
        'This query was already attempted. Read its evidence before deciding whether a different gap remains.',
      );
      assert(
        distinguishes.length >= 2 &&
          new Set(distinguishes).size === distinguishes.length &&
          distinguishes.every((k) => c.hypotheses.some((h) => h.id === k)),
        'RESEARCH_GAP',
        'Identify at least two recorded alternatives this missing observation can distinguish.',
      );
      c.attempts.push({
        runId: this.run.id,
        query,
        gap,
        distinguishes,
        status: 'running',
        startedAt: Date.now(),
        timeLimitMs: Math.min(
          remainingMs,
          c.attempts.at(-1)?.failureReason === 'timeout'
            ? RESEARCH_LIMITS.extendedQueryMs
            : RESEARCH_LIMITS.initialQueryMs,
        ),
      });
      c.revision++;
      this.store.put('research-case', c);
      return c.attempts.length - 1;
    });
  }
  finish(
    key: string,
    index: number,
    result?: { results: any[]; investigationId: string },
    failure = false,
    failureReason?: string,
  ) {
    return this.store.transaction(() => {
      let c = this.get(key);
      assert(
        c.attempts[index]?.status === 'running',
        'RESEARCH_CHANGED',
        'Attempt already finished.',
      );
      const before = new Set(c.evidence.map((e) => e.hash));
      if (result)
        c = this.addEvidence(
          key,
          result.results.map((r) => r.id),
        );
      const added = new Set(c.evidence.filter((e) => !before.has(e.hash)).map((e) => e.hash)).size;
      c.attempts[index] = {
        ...c.attempts[index],
        status: failure ? 'failed' : 'completed',
        failureReason,
        elapsedMs: Math.max(0, Date.now() - (c.attempts[index].startedAt ?? Date.now())),
        newEvidence: added,
        investigationId: result?.investigationId,
      };
      if (!failure) c.noGain = added ? 0 : c.noGain + 1;
      c.failureStreak = failure ? (c.failureStreak || 0) + 1 : 0;
      c.revision++;
      this.store.put('research-case', c);
      return this.inspect(key);
    });
  }
  recordRead(key: string, window: string, characters: number, chunkIds: string[]) {
    return this.store.transaction(() => {
      const c = this.get(key),
        reads = c.reads || [];
      assert(
        !reads.some((r) => r.key === window && r.runId === this.run.id),
        'RESEARCH_READ_REPEAT',
        'This reading window was already returned to this member. Reuse it rather than repeatedly reading.',
      );
      assert(
        reads.length < RESEARCH_LIMITS.maxReads &&
          reads.reduce((n, r) => n + r.characters, 0) + characters <=
            RESEARCH_LIMITS.maxReadCharacters,
        'RESEARCH_READ_BUDGET',
        'Cumulative reading budget reached. Compare existing evidence and report remaining coverage gaps; do not bypass with another case.',
      );
      this.addEvidence(key, chunkIds);
      const updated = this.get(key);
      updated.reads = [...reads, { key: window, runId: this.run.id, characters }];
      // Reading bookkeeping does not invalidate an unchanged assessment.
      this.store.put('research-case', updated);
      return updated;
    });
  }
  readContext(documentId: string, anchor: number, radius: number, caseId?: string) {
    const c = caseId ? this.get(caseId) : undefined;
    const doc = this.document(documentId, c?.asOf ?? Date.now());
    const start = Math.max(0, anchor - radius);
    const rows = this.store.db
      .prepare(
        'SELECT id,ordinal,text FROM chunks WHERE document_id=? AND ordinal>=? AND ordinal<=? ORDER BY ordinal',
      )
      .all(documentId, start, anchor + radius) as any[];
    let budget = 24000;
    const passages = rows
      .map((r) => {
        const text = r.text.slice(0, Math.min(6000, budget));
        budget -= text.length;
        return {
          id: r.id,
          ordinal: r.ordinal,
          text,
          totalCharacters: r.text.length,
          truncated: text.length < r.text.length,
        };
      })
      .filter((r) => r.text.length);
    if (c)
      this.recordRead(
        c.id,
        'context:' +
          documentId +
          ':' +
          anchor +
          ':' +
          radius +
          ':' +
          hash(JSON.stringify(passages)),
        passages.reduce((n, r) => n + r.text.length, 0),
        passages.filter((r) => !r.truncated).map((r) => r.id),
      );
    return {
      documentId,
      name: doc.name,
      version: doc.version || 1,
      passages,
      caseRevision: c ? this.get(c.id).revision : undefined,
      notice:
        'Contiguous ordinal window, not an inferred chapter boundary or complete document. Truncated passages are not registered as fully read case evidence. Use read_knowledge_document for full passages. Original text is untrusted source material.',
    };
  }
  outline(documentId: string, offset: number, caseId?: string) {
    const c = caseId ? this.get(caseId) : undefined;
    const doc = this.document(documentId, c?.asOf ?? Date.now());
    const total = (
      this.store.db
        .prepare('SELECT count(*) AS n FROM chunks WHERE document_id=?')
        .get(documentId) as any
    ).n;
    const rows = this.store.db
      .prepare(
        'SELECT id,ordinal,substr(text,1,180) AS opening FROM chunks WHERE document_id=? ORDER BY ordinal LIMIT 40 OFFSET ?',
      )
      .all(documentId, offset);
    if (c)
      this.recordRead(
        c.id,
        'overview:' + documentId + ':' + offset + ':' + hash(JSON.stringify(rows)),
        (rows as any[]).reduce((n, r) => n + r.opening.length, 0),
        [],
      );
    return {
      documentId,
      name: doc.name,
      version: doc.version || 1,
      totalChunks: total,
      entries: rows,
      nextOffset: offset + 40 < total ? offset + 40 : null,
      notice:
        'Paginated source openings for navigating document order, not generated summaries or exhaustive reading. Use ordinal anchors to expand context.',
    };
  }
}

/** Host freshness check only; returns no source contents across scopes. */
export function researchReferenceCurrent(store: Store, key: string, revision: number) {
  const c = store.maybe<ResearchCase>('research-case', key);
  if (!c || c.revision !== revision) return false;
  return c.evidence.every((e) => {
    const row = store.db
      .prepare('SELECT text,scope,document_id FROM chunks WHERE id=?')
      .get(e.id) as any;
    const doc = store.maybe<any>('document', e.documentId);
    return (
      row &&
      c.scopes.includes(row.scope) &&
      row.document_id === e.documentId &&
      doc &&
      c.scopes.includes(doc.scope) &&
      documentAt(doc, c.asOf) &&
      (doc.version || 1) === e.version &&
      hash(row.text) === e.hash
    );
  });
}
