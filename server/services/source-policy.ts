import { createHash } from 'node:crypto';
/** Optional caller-owned evidence boundary. Not a claim to detect all contamination. */
export interface SourcePolicy {
  id: string;
  blockedHosts: string[];
  blockedPatterns: string[];
  contentPatterns: string[];
  discardSynthesis: boolean;
}
export function sourceAllowed(input: string, policy?: SourcePolicy): boolean {
  if (!policy) return true;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  let decoded = url.href;
  for (let i = 0; i < 3; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  return (
    !policy.blockedHosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h)) &&
    !policy.blockedPatterns.some((p) => new RegExp(p, 'i').test(decoded))
  );
}
export function checkSource(url: string, policy?: SourcePolicy) {
  if (!sourceAllowed(url, policy))
    throw Object.assign(new Error('Source excluded by active evidence policy.'), {
      code: 'SOURCE_EXCLUDED',
    });
}
export function checkSourceText(text: string, policy?: SourcePolicy) {
  if (policy?.contentPatterns.some((p) => new RegExp(p, 'i').test(text)))
    throw Object.assign(new Error('Content withheld by active evidence policy.'), {
      code: 'SOURCE_CONTENT_EXCLUDED',
    });
}
export function filterSearch<
  T extends { summary: string; sources: { url: string; title: string; snippet: string }[] },
>(result: T, policy?: SourcePolicy) {
  if (!policy) return result;
  const sources = result.sources.filter((s) => sourceAllowed(s.url, policy));
  // No generated title/snippet can smuggle a rejected source's answer into strict search.
  return {
    ...result,
    summary: policy.discardSynthesis ? '' : result.summary,
    sources: policy.discardSynthesis
      ? sources.map((s) => ({ url: s.url, title: '', snippet: '' }))
      : sources,
    evidencePolicy: policy.id,
    excludedCount: result.sources.length - sources.length,
    synthesisWithheld: policy.discardSynthesis,
    sourceDigest: createHash('sha256')
      .update(JSON.stringify(sources.map((s) => s.url)))
      .digest('hex'),
    notice:
      'URLs are discovery leads, not verified answers. Fetch originals. Filtering cannot rule out unknown mirrors or training contamination.',
  };
}
