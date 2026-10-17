import type { Store } from '../storage/store.js';

/** Bounded metadata discovery, not evidence retrieval or a relevance verdict. */
export function knowledgeDiscovery(
  store: Store,
  scopes: string[],
  query: string,
  now = Date.now(),
) {
  if (!scopes.length) return { status: 'disabled', documents: 0, candidates: [] };
  const where = `kind='document' AND json_extract(data,'$.scope') IN (${scopes.map(() => '?').join(',')})
    AND COALESCE(json_extract(data,'$.validFrom'),json_extract(data,'$.createdAt'),0)<=?
    AND (json_extract(data,'$.validUntil') IS NULL OR json_extract(data,'$.validUntil')>?)`;
  const params = [...scopes, now, now];
  const documents = (
    store.db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;
  const segments = [
    ...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query.slice(-4000)),
  ]
    .filter((s) => s.isWordLike && s.segment.length >= 2)
    .map((s) => s.segment.toLowerCase());
  const terms = [...new Set(segments)].slice(-16);
  const score = terms
    .map(
      () =>
        "CASE WHEN instr(lower(COALESCE(json_extract(data,'$.name'),'')),?)>0 THEN 1 ELSE 0 END",
    )
    .join('+');
  const candidates = terms.length
    ? store.db
        .prepare(
          `SELECT id, substr(json_extract(data,'$.name'),1,180) AS name,
    json_extract(data,'$.scope') AS scope, (${score}) AS titleMatches FROM records WHERE ${where}
    AND (${score})>0 ORDER BY titleMatches DESC,id LIMIT 6`,
        )
        .all(...terms, ...params, ...terms)
    : [];
  return {
    status: documents ? 'available' : 'not_imported',
    documents,
    candidates,
    notice:
      'Title matches are discovery leads, not read evidence. Missing title matches do not mean missing content. For document-dependent questions or supplied/local material, discover search_knowledge or list_knowledge_documents before claiming library coverage or absence. Retrieve only if useful; no mandatory search for every turn. For current rules use current authoritative sources too. Local material is not automatically authoritative or up to date.',
  };
}
