import { createHash } from 'node:crypto';
export interface ResearchProgress {
  hashes: string[];
  repeated: number;
  attempts?: number;
  unusable?: number;
  novel?: number;
}
export function researchProgress(previous: ResearchProgress | undefined, evidence: unknown) {
  const metrics = {
    attempts: (previous?.attempts || 0) + 1,
    unusable: previous?.unusable || 0,
    novel: previous?.novel || 0,
  };
  const page =
    evidence && typeof evidence === 'object' && 'status' in evidence
      ? (evidence as { status: number; text?: string })
      : undefined;
  const usable = page
    ? page.status >= 200 && page.status < 300 && Boolean(page.text?.trim())
    : Array.isArray(evidence)
      ? evidence.length > 0
      : Boolean(evidence);
  if (!usable)
    return {
      ...metrics,
      unusable: metrics.unusable + 1,
      hashes: previous?.hashes || [],
      repeated: (previous?.repeated || 0) + 1,
      usable: false,
      advice:
        'No usable evidence in this response. An HTTP error or empty result is not corroboration or proof of absence. Change source or method, or report the unresolved gap.',
    };
  // Identical page bodies on different URLs are not independent corroboration.
  const content = page ? page.text!.trim() : evidence;
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const repeated = previous?.hashes.includes(hash) ? previous.repeated + 1 : 0;
  return {
    ...metrics,
    usable: true,
    novel: metrics.novel + (previous?.hashes.includes(hash) ? 0 : 1),
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
