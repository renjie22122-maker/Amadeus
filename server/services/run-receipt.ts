import type { Store } from '../storage/store.js';
import { assert } from '../core/errors.js';
// Local owner API. Select only operational metadata, never message bodies, prompts, tool arguments or checkpoints.
export function runReceipt(store: Store, conversationId: string, runId: string) {
  const run = store.maybeRunHeader(runId);
  assert(
    run && run.conversationId === conversationId,
    'NOT_FOUND',
    'Run not found in this conversation.',
    404,
  );
  const rows = store.db
    .prepare(
      `SELECT request_id AS requestId,json_extract(data,'$.timing.outcome') AS outcome,json_extract(data,'$.timing.elapsedMs') AS elapsedMs,json_extract(data,'$.timing.firstTextMs') AS firstTextMs,json_extract(data,'$.timing.firstThinkingMs') AS firstThinkingMs,json_extract(data,'$.usage.measured') AS measured FROM ledger WHERE run_id=? ORDER BY rowid DESC LIMIT 20`,
    )
    .all(runId);
  const recall =
    store.db
      .prepare(
        `SELECT json_array_length(data,'$.ids') AS count,json_extract(data,'$.method') AS method,json_extract(data,'$.elapsedMs') AS elapsedMs FROM events WHERE run_id=? AND conversation_id=? AND type='memory.recalled' ORDER BY id DESC LIMIT 1`,
      )
      .get(runId, conversationId) ?? null;
  const settledTools = store.db
    .prepare(
      `SELECT json_extract(data,'$.name') AS name,json_extract(data,'$.elapsedMs') AS elapsedMs,json_extract(data,'$.outcome.status') AS status FROM events WHERE run_id=? AND conversation_id=? AND type='tool.progress' AND json_extract(data,'$.phase')='settled' ORDER BY id DESC LIMIT 20`,
    )
    .all(runId, conversationId);
  const deliveryAvailable = !!store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='chat_outbox_run'")
    .get();
  const delivery = deliveryAvailable
    ? store.db
        .prepare(
          `SELECT o.state,count(*) AS count,count(d.id) AS platformReceipts,max(CASE WHEN d.sent_at>=o.created_at THEN d.sent_at-o.created_at END) AS maxAckMs FROM chat_outbox o LEFT JOIN chat_delivery d ON d.id=o.id AND d.connection_id=o.connection_id WHERE o.run_id=? GROUP BY o.state ORDER BY o.state`,
        )
        .all(runId)
    : [];
  return {
    schemaVersion: 1,
    runId,
    conversationId,
    status: run.status,
    localModelCalls: run.modelCalls,
    modelRequests: rows,
    requestLimit: 20,
    settledTools,
    recall,
    deliveryAvailable,
    delivery,
  };
}
