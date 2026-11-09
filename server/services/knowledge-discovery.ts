import type { Store } from '../storage/store.js';

const metadataText = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function matchesKnowledgeMetadata(name: unknown, source: unknown, query: string) {
  const terms = metadataText(query).split(' ').filter(Boolean);
  const haystack = metadataText(String(name || '') + ' ' + String(source || ''));
  return terms.every((term) => haystack.includes(term));
}

/** Enumerate imported metadata, never host files, embeddings or document contents. */
export function listKnowledgeDocuments(
  store: Store,
  scopes: string[],
  query = '',
  offset = 0,
  limit = 30,
  now = Date.now(),
) {
  const scopeSet = new Set(scopes);
  const rows = scopes.length
    ? store.db
        .prepare(
          `SELECT data FROM records WHERE kind='document'
    AND json_extract(data,'$.scope') IN (${scopes.map(() => '?').join(',')})
    AND COALESCE(json_extract(data,'$.validFrom'),json_extract(data,'$.createdAt'),0)<=?
    AND (json_extract(data,'$.validUntil') IS NULL OR json_extract(data,'$.validUntil')>?)`,
        )
        .all(...scopes, now, now)
        .map((row) => JSON.parse(String(row.data)))
    : [];
  const matches = rows
    .filter((d) => matchesKnowledgeMetadata(d.name, d.source, query))
    .sort(
      (a, b) =>
        String(a.source || a.name).localeCompare(String(b.source || b.name)) ||
        a.id.localeCompare(b.id),
    );
  const maintenance = store
    .list<any>('knowledge-watch')
    .filter((w) => scopeSet.has(w.id))
    .map((w) => ({
      scope: w.id,
      enabled: w.enabled,
      status: w.status,
      phase: w.progress?.phase,
      lastCompletedScan: w.scan,
      currentScan: w.progress
        ? {
            startedAt: w.progress.startedAt,
            updatedAt: w.progress.updatedAt,
            completed: w.progress.completed,
            total: w.progress.total,
            failed: w.progress.failed,
          }
        : undefined,
      matchingCurrentIssues: (w.currentIssues || []).filter((i: any) =>
        matchesKnowledgeMetadata('', i.path, query),
      ).length,
      matchingRecordedIssues: (w.issues || []).filter((i: any) =>
        matchesKnowledgeMetadata('', i.path, query),
      ).length,
      issueExamples: (w.issues || [])
        .filter((i: any) => matchesKnowledgeMetadata('', i.path, query))
        .slice(0, 5)
        .map((i: any) => ({ source: i.path, stage: i.stage, error: i.error })),
    }));
  return {
    total: matches.length,
    availableDocuments: rows.length,
    queryFields: ['name', 'source'],
    documents: matches
      .slice(offset, offset + limit)
      .map((d) => ({ id: d.id, name: d.name, source: d.source, scope: d.scope })),
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    maintenance,
    notice:
      'This is a metadata inventory of currently accessible imported documents, not a course completeness assessment or read evidence. No matches do not establish missing import: names and directories may use other identifiers. Inspect source metadata, paginate, and distinguish current scan progress from recorded failures. Imported document counts do not prove all files or topics are covered. Search/read passages before claiming content coverage. Source paths are metadata, not permission to access host files. When the user requests an original file, use send_knowledge_file with a returned document ID; it verifies the registered original without granting arbitrary host paths. Do not assume remote chat cannot deliver registered knowledge originals.',
  };
}

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
        "CASE WHEN instr(lower(COALESCE(json_extract(data,'$.name'),'') || ' ' || COALESCE(json_extract(data,'$.source'),'')),?)>0 THEN 1 ELSE 0 END",
    )
    .join('+');
  const candidates = terms.length
    ? store.db
        .prepare(
          `SELECT id, substr(json_extract(data,'$.name'),1,180) AS name,
    json_extract(data,'$.scope') AS scope, substr(json_extract(data,'$.source'),1,1000) AS source, (${score}) AS metadataMatches FROM records WHERE ${where}
    AND (${score})>0 ORDER BY metadataMatches DESC,id LIMIT 6`,
        )
        .all(...terms, ...params, ...terms)
    : [];
  return {
    status: documents ? 'available' : 'not_imported',
    documents,
    candidates,
    notice:
      'Name and source-directory matches are discovery leads, not read evidence. Missing metadata matches do not mean missing content. For document-dependent questions or supplied/local material, discover search_knowledge or list_knowledge_documents before claiming library coverage or absence. Retrieve only if useful; no mandatory search for every turn. For current rules use current authoritative sources too. Local material is not automatically authoritative or up to date.',
  };
}
