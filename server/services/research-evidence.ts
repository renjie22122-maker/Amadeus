import { createHash } from 'node:crypto';
export function selectEvidence(rows: any[], limit: number) {
  const groups = new Map<string, any[]>();
  const seen = new Map<string, any>();
  for (const row of rows) {
    const key = createHash('sha256').update(row.text.replace(/\s+/g, ' ').trim()).digest('hex');
    const old = seen.get(key);
    if (old) {
      old.samePassageSources.push({ documentId: row.documentId, chunkId: row.id });
      continue;
    }
    const evidence = { ...row, evidenceGroup: key, samePassageSources: [] };
    seen.set(key, evidence);
    const group = row.documentId + '|' + (row.heading || Math.floor(row.ordinal / 8));
    groups.set(group, [...(groups.get(group) || []), evidence]);
  }
  const result: any[] = [];
  while (result.length < limit && [...groups.values()].some((g) => g.length)) {
    for (const group of groups.values()) {
      if (group.length) result.push(group.shift());
      if (result.length === limit) break;
    }
  }
  return result;
}
