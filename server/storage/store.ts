import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Conversation, PendingInput, Run } from '../../shared/types.js';
import { AppError, assert } from '../core/errors.js';
import { checkTransition, terminal } from '../core/lifecycle.js';
function parseStored(data: string, kind: string, key: string) {
  try {
    return JSON.parse(data);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new AppError(
        'RECORD_CORRUPT',
        'Stored ' + kind + ' record cannot be decoded (id: ' + key + ').',
        500,
      );
    throw error;
  }
}
export const id = () => randomUUID();
export class Store {
  readonly db: DatabaseSync;
  private runRevisions = new Map<string, number>();
  runRevision(id: string) {
    return this.runRevisions.get(id) || 0;
  }
  private transactionDepth = 0;
  private pendingEvents: AgentEvent[] = [];
  onEvent: (event: AgentEvent) => void = () => {};
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,run_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,id);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
      CREATE INDEX IF NOT EXISTS events_tool_result ON events(run_id,json_extract(data,'$.callId')) WHERE type='tool.completed';
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,scope TEXT NOT NULL,document_id TEXT NOT NULL,name TEXT NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL,vector TEXT,source_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_scope ON chunks(scope);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(id UNINDEXED,terms);
      CREATE TABLE IF NOT EXISTS ledger(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,tool TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_runs_conversation ON records(json_extract(data,'$.conversationId'),json_extract(data,'$.createdAt')) WHERE kind='run';
      INSERT OR IGNORE INTO schema_migrations VALUES(1,unixepoch()*1000);
      CREATE TABLE IF NOT EXISTS run_metadata(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_metadata_conversation ON run_metadata(conversation_id,created_at);
      INSERT OR IGNORE INTO run_metadata SELECT id,COALESCE(json_extract(data,'$.conversationId'),''),COALESCE(json_extract(data,'$.createdAt'),0),json_remove(data,'$.checkpoints') FROM records WHERE kind='run';
      CREATE INDEX IF NOT EXISTS records_conversation_scope ON records(kind,CASE WHEN json_valid(data) THEN json_extract(data,'$.conversationId') END);
      CREATE INDEX IF NOT EXISTS effects_unfinished ON effects(run_id) WHERE state='started';
      CREATE TABLE IF NOT EXISTS run_checkpoints(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      INSERT OR IGNORE INTO run_checkpoints SELECT id,COALESCE(json_extract(data,'$.checkpoints'),'[]') FROM records WHERE kind='run';
    `);
  }
  // Metadata projections never contain model checkpoints. Keep them transactionally
  // alongside records so UI reads do not deserialize every historical prompt.
  runMetadata(conversationId?: string): Run[] {
    const rows = conversationId
      ? this.db
          .prepare('SELECT data FROM run_metadata WHERE conversation_id=? ORDER BY created_at')
          .all(conversationId)
      : this.db.prepare('SELECT data FROM run_metadata ORDER BY created_at').all();
    return (rows as { data: string }[]).map((r) => ({ ...JSON.parse(r.data), checkpoints: [] }));
  }
  runHeader(key: string): Run {
    const row = this.db.prepare('SELECT data FROM run_metadata WHERE id=?').get(key) as
      { data: string } | undefined;
    assert(row, 'NOT_FOUND', 'run not found', 404);
    return { ...JSON.parse(row.data), checkpoints: [] };
  }
  close() {
    this.db.close();
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    if (kind === 'run')
      return this.transaction(() => {
        this.runRevisions.set(value.id, this.runRevision(value.id) + 1);
        const { checkpoints, ...metadata } = value as unknown as Run;
        this.db
          .prepare(
            'INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
          )
          .run(kind, value.id, JSON.stringify(metadata));
        this.db
          .prepare(
            'INSERT INTO run_checkpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data<>excluded.data',
          )
          .run(value.id, JSON.stringify(checkpoints || []));
        this.db
          .prepare(
            'INSERT INTO run_metadata VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,created_at=excluded.created_at,data=excluded.data',
          )
          .run(
            value.id,
            metadata.conversationId || '',
            metadata.createdAt || 0,
            JSON.stringify(metadata),
          );
        return value;
      });
    this.db
      .prepare(
        'INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  get<T>(kind: string, key: string): T {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key) as
      { data: string } | undefined;
    assert(row, 'NOT_FOUND', kind + ' not found', 404);
    const value = parseStored(row.data, kind, key);
    if (kind === 'run') {
      const payload = this.db.prepare('SELECT data FROM run_checkpoints WHERE id=?').get(key) as
        { data: string } | undefined;
      value.checkpoints = payload
        ? parseStored(payload.data, 'run-checkpoints', key)
        : value.checkpoints || [];
    }
    return value as T;
  }
  maybe<T>(kind: string, key: string): T | undefined {
    try {
      return this.get<T>(kind, key);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }
  list<T>(kind: string): T[] {
    return (
      this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  /** Filter in SQLite before decoding unrelated conversations' payloads. */
  forConversation<T>(kind: string, conversationId: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT id,data FROM records WHERE kind=? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.conversationId') END=?",
        )
        .all(kind, conversationId) as { id: string; data: string }[]
    ).map((row) => parseStored(row.data, kind, row.id));
  }
  latestRun(conversationId: string): Run | undefined {
    const row = this.db
      .prepare(
        'SELECT id FROM run_metadata WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(conversationId) as { id: string } | undefined;
    return row ? this.get<Run>('run', row.id) : undefined;
  }
  remove(kind: string, key: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key);
      if (kind === 'run') {
        this.db.prepare('DELETE FROM run_metadata WHERE id=?').run(key);
        this.db.prepare('DELETE FROM run_checkpoints WHERE id=?').run(key);
      }
    });
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth,
      mark = this.pendingEvents.length;
    const savepoint = 'nested_' + depth;
    this.db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    let value: T;
    try {
      value = fn();
      if (value && typeof (value as any).then === 'function')
        throw new Error('SQLite transactions must be synchronous.');
      this.db.exec(depth ? 'RELEASE ' + savepoint : 'COMMIT');
    } catch (error) {
      this.pendingEvents.length = mark;
      this.db.exec(depth ? 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint : 'ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
    if (!depth) {
      const events = this.pendingEvents.splice(0);
      for (const event of events) this.onEvent(event);
    }
    return value;
  }
  event(
    conversationId: string,
    runId: string | null,
    type: string,
    data: Record<string, any>,
  ): AgentEvent {
    const now = Date.now();
    const row = this.db
      .prepare('INSERT INTO events(conversation_id,run_id,type,data,created_at) VALUES(?,?,?,?,?)')
      .run(conversationId, runId, type, JSON.stringify(data), now);
    const event = {
      id: Number(row.lastInsertRowid),
      conversationId,
      runId,
      type,
      data,
      createdAt: now,
    };
    if (this.transactionDepth) this.pendingEvents.push(event);
    else this.onEvent(event);
    return event;
  }
  events(conversationId: string, after = 0, type?: string): AgentEvent[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM events WHERE conversation_id=? AND id>? AND (? IS NULL OR type=?) ORDER BY id',
        )
        .all(conversationId, after, type ?? null, type ?? null) as any[]
    ).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      runId: r.run_id,
      type: r.type,
      data: JSON.parse(r.data),
      createdAt: r.created_at,
    }));
  }
  eventsForRun(runId: string, types?: string[]): AgentEvent[] {
    const filter = types?.length ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    return (
      this.db
        .prepare('SELECT * FROM events WHERE run_id=?' + filter + ' ORDER BY id')
        .all(runId, ...(types || [])) as any[]
    ).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      runId: r.run_id,
      type: r.type,
      data: JSON.parse(r.data),
      createdAt: r.created_at,
    }));
  }
  eventPage(conversationId: string, limit: number, before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(conversationId, before, limit + 1) as any[];
    const hasOlderEvents = rows.length > limit;
    return {
      hasOlderEvents,
      events: rows
        .slice(0, limit)
        .reverse()
        .map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          runId: r.run_id,
          type: r.type,
          data: JSON.parse(r.data),
          createdAt: r.created_at,
        })) as AgentEvent[],
    };
  }
  conversations() {
    return this.list<Conversation>('conversation').sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
  }
  runs(conversationId?: string) {
    const rows = conversationId
      ? this.db
          .prepare(
            "SELECT data FROM records WHERE kind='run' AND json_extract(data,'$.conversationId')=? ORDER BY json_extract(data,'$.createdAt')",
          )
          .all(conversationId)
      : this.db
          .prepare(
            "SELECT data FROM records WHERE kind='run' ORDER BY json_extract(data,'$.createdAt')",
          )
          .all();
    return (rows as { data: string }[]).map((r) => this.get<Run>('run', JSON.parse(r.data).id));
  }
  transition(runId: string, status: Run['status'], error: string | null = null) {
    const run = this.get<Run>('run', runId);
    checkTransition(run.status, status);
    const next = this.put('run', { ...run, status, error, updatedAt: Date.now() });
    this.event(run.conversationId, run.id, 'run.status', { status, error });
    return next;
  }
  recover() {
    // Status and approval cancellation commit together. Unknown effects remain untouched.
    this.transaction(() => {
      for (const run of this.runs().filter((r) => !terminal(r.status))) {
        this.transition(
          run.id,
          'interrupted',
          run.status === 'waiting_approval'
            ? 'The service restarted while awaiting approval. Waiting itself has no timeout. Resume to reassess the unapproved action; it was not authorized by waiting.'
            : 'The service restarted. Inspect unfinished operations before continuing.',
        );
      }
      // Also repair approvals orphaned by older non-atomic recovery implementations.
      for (const q of this.list<PendingInput>('input').filter((q) => q.status === 'pending')) {
        const run = this.maybe<Run>('run', q.runId);
        if (!run || terminal(run.status))
          this.put('input', {
            ...q,
            status: 'cancelled',
            payload: { ...q.payload, interruptionReason: 'service_restart' },
          });
      }
    });
  }
  beginEffect(runId: string, tool: string, args: Record<string, unknown>) {
    const key = id();
    this.db
      .prepare('INSERT INTO effects(id,run_id,tool,args,state) VALUES(?,?,?,?,?)')
      .run(key, runId, tool, JSON.stringify(args), 'started');
    return key;
  }
  endEffect(key: string, result: string, state = 'completed') {
    this.db.prepare('UPDATE effects SET state=?,result=? WHERE id=?').run(state, result, key);
  }
  unknownEffects(conversationId: string) {
    return this.db
      .prepare(
        "SELECT e.* FROM effects e JOIN run_metadata r ON r.id=e.run_id WHERE e.state='started' AND r.conversation_id=?",
      )
      .all(conversationId) as any[];
  }
  reconcileKnownEffects(conversationId: string): string[] {
    const unresolved = this.unknownEffects(conversationId),
      events = this.events(conversationId),
      resolved: string[] = [];
    for (const e of unresolved) {
      const failure = events.find((v) => v.type === 'effect.unknown' && v.data.effectId === e.id)
        ?.data.reason;
      let reason = '';
      if (
        e.tool === 'run_command' &&
        [
          'Tool error: spawn docker ENOENT',
          'Tool error: Windows native isolation requires an absolute Python interpreter path in Settings. No host fallback.',
        ].includes(failure)
      )
        reason = 'Logged launch precondition failed before the requested command started.';
      if (
        e.tool === 'edit_file' &&
        failure === 'Tool error: Expected exactly one match. Read the current file and retry.'
      )
        reason = 'Logged exact-match validation failed before writing.';
      if (
        e.tool === 'run_command' &&
        unresolved.filter((x) => x.run_id === e.run_id).length === 1
      ) {
        const q = this.list<PendingInput>('input')
          .filter((q) => q.runId === e.run_id && q.kind === 'approval')
          .at(-1);
        const run = this.get<Run>('run', e.run_id);
        if (
          q?.status === 'cancelled' &&
          q.answer === null &&
          terminal(run.status) &&
          q.payload.command === JSON.parse(e.args).command &&
          !events.some((v) => v.type === 'input.answered' && v.data.id === q.id)
        )
          reason = 'Interrupted while awaiting approval; no approval was granted.';
      }
      if (reason) {
        this.resolveEffect(e.id, 'Automatic reconciliation: ' + reason + ' No replay performed.');
        resolved.push(e.id);
      }
    }
    return resolved;
  }
  resolveEffect(key: string, note: string) {
    assert(note.trim(), 'NOTE_REQUIRED', 'Record what was inspected.');
    const result = this.db
      .prepare("UPDATE effects SET state='inspected',result=? WHERE id=? AND state='started'")
      .run(note, key);
    assert(
      result.changes === 1,
      'EFFECT_NOT_PENDING',
      'Operation is no longer awaiting reconciliation.',
      409,
    );
  }
}
