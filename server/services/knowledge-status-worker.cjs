// Read-only derived status: keep vector decoding and SQLite I/O off the HTTP thread.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  const { path, scope, fingerprint, documentIds } = workerData;
  db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=2000');
  const current = new Set(documentIds),
    statuses = {};
  for (const id of current)
    statuses[id] = { completed: 0, total: 0, invalid: 0, status: 'pending' };
  for (const row of db
    .prepare('SELECT document_id,vector FROM chunks WHERE scope=?')
    .iterate(scope)) {
    if (!current.has(row.document_id)) continue;
    const item = statuses[row.document_id];
    item.total++;
    let vector;
    try {
      const value = JSON.parse(row.vector);
      if (
        value &&
        typeof value.model === 'string' &&
        Array.isArray(value.values) &&
        value.values.length
      ) {
        let norm = 0,
          valid = true;
        for (const n of value.values) {
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            valid = false;
            break;
          }
          norm += n * n;
        }
        if (valid && Number.isFinite(norm) && norm > 0) vector = value;
      }
    } catch {}
    if (row.vector != null && !vector) item.invalid++;
    if (vector && vector.model === fingerprint) item.completed++;
    item.status =
      item.completed === item.total ? 'indexed' : item.completed ? 'partial' : 'pending';
  }
  parentPort.postMessage({ statuses });
} catch {
  parentPort.postMessage({ error: 'Index status inspection failed in read-only worker.' });
} finally {
  db?.close();
}
