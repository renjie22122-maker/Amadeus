import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { rootRun } from './task-board.js';
const canonical = (x: any): any =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
const hash = (x: any) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
export function groupObservations(
  rows: { eventId: number; runId: string; source: any; result: any }[],
) {
  const groups = new Map<
    string,
    { sourceHash: string; eventIds: number[]; executors: string[]; resultHashes: string[] }
  >();
  for (const row of rows) {
    const key = hash(row.source),
      g = groups.get(key) || { sourceHash: key, eventIds: [], executors: [], resultHashes: [] };
    if (!g.eventIds.includes(row.eventId)) g.eventIds.push(row.eventId);
    if (!g.executors.includes(row.runId)) g.executors.push(row.runId);
    const result = hash(row.result);
    if (!g.resultHashes.includes(result)) g.resultHashes.push(result);
    groups.set(key, g);
  }
  return {
    references: rows.length,
    uniqueEvents: new Set(rows.map((r) => r.eventId)).size,
    sourceGroups: groups.size,
    groups: [...groups.values()].map((g) => ({
      ...g,
      observationsDiffer: g.resultHashes.length > 1,
    })),
    independentSources: 'not-established',
    notice:
      'Different executors are not independent sources. Repeated checks are replication, not votes. Different outputs require examination, not automatic contradiction. Unknown lineage must not be counted as independent support.',
  };
}
export function evidenceDiversity(store: Store, boardId: string, eventIds: number[]) {
  const rows = [];
  for (const eventId of eventIds.slice(0, 200)) {
    const event = store.db
      .prepare('SELECT run_id,type,data FROM events WHERE id=?')
      .get(eventId) as any;
    if (event?.type !== 'tool.completed' || !event.run_id) continue;
    const run = store.maybe<any>('run', event.run_id);
    if (!run || rootRun(store, run) !== boardId) continue;
    const data = JSON.parse(event.data);
    if (['search_knowledge', 'investigate_knowledge'].includes(data.name)) {
      try {
        const parsed = typeof data.output === 'string' ? JSON.parse(data.output) : data.output;
        const hits = Array.isArray(parsed) ? parsed : parsed?.results;
        if (Array.isArray(hits) && hits.length) {
          for (const hit of hits) {
            if (typeof hit.text !== 'string' || !hit.documentId || !hit.id) continue;
            rows.push({
              eventId,
              runId: event.run_id,
              source: {
                kind: 'retrieved-passage',
                contentHash: hash(hit.text.replace(/\s+/g, ' ').trim()),
              },
              result: hit.text.replace(/\s+/g, ' ').trim(),
            });
          }
          continue;
        }
      } catch {
        /* Unknown provenance stays explicitly unknown below. */
      }
    }
    const start = store.db
      .prepare(
        "SELECT data FROM events WHERE run_id=? AND type='tool.started' AND json_extract(data,'$.callId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(event.run_id, data.callId) as any;
    const args = start ? JSON.parse(start.data) : null;
    rows.push({
      eventId,
      runId: event.run_id,
      source: args
        ? { tool: data.name, args: args.arguments || args.args, artifact: data.verification?.after }
        : { unknownEvent: eventId },
      result: data.output ?? data.outcome ?? null,
    });
  }
  return { ...groupObservations(rows), truncated: eventIds.length > 200 };
}
