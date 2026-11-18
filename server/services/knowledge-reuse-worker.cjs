const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const query = db.prepare(
    'SELECT vector FROM chunks WHERE text=? AND scope=(SELECT scope FROM chunks WHERE id=?) AND vector IS NOT NULL LIMIT 100',
  );
  parentPort.postMessage({ rows: workerData.rows.map((row) => query.all(row.text, row.id)) });
} catch {
  parentPort.postMessage({ error: 'Vector reuse lookup failed.' });
} finally {
  if (db) db.close();
}
