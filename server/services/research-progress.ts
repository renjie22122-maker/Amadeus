import { createHash } from 'node:crypto';
export interface ResearchProgress {
  hashes: string[];
  repeated: number;
}
export function researchProgress(previous: ResearchProgress | undefined, evidence: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const repeated = previous?.hashes.includes(hash) ? previous.repeated + 1 : 0;
  return {
    hashes: [...(previous?.hashes || []).filter((h) => h !== hash), hash].slice(-32),
    repeated,
    ...(repeated >= 2
      ? {
          advice:
            'Repeated evidence adds no corroboration. Change source or method, use available computation/visual tools, or report the unresolved gap. Do not infer absence from failed retrieval.',
        }
      : {}),
  };
}
