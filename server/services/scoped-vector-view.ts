import type { Store } from '../storage/store.js';
import { documentEligibilitySQL } from './knowledge-versions.js';
/** Take a scoped snapshot of vector membership, not of the document bodies. */
export function scopedVectorView(
  store: Store,
  scopes: string[],
  documentIds: string[],
  asOf: number,
) {
  const slots = (values: string[]) => values.map(() => '?').join(',');
  const revisionQuery = store.db.prepare(
    `SELECT scope,version FROM vector_scope_revision WHERE scope IN (${slots(scopes)}) ORDER BY scope`,
  );
  const revision = () => JSON.stringify(revisionQuery.all(...scopes));
  const before = revision();
  const scopeEligibility =
    documentEligibilitySQL +
    ` AND json_extract(data,'$.scope') IN (${slots(scopes)})` +
    (documentIds.length ? ` AND id IN (${slots(documentIds)})` : '');
  const docQuery = store.db.prepare(scopeEligibility + ' ORDER BY id');
  const eligibleIds = () =>
    docQuery.all(asOf, asOf, ...scopes, ...documentIds).map((r) => String(r.id));
  const eligible = eligibleIds();
  const beforeDocs = JSON.stringify(eligible);
  const eligibleSet = new Set(eligible);
  const changed = () => revision() !== before || JSON.stringify(eligibleIds()) !== beforeDocs;
  return { before, eligible, eligibleSet, scopeEligibility, changed };
}
