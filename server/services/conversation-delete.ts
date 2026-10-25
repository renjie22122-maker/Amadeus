import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { Conversation } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { terminal } from '../core/lifecycle.js';

// Logical permanent deletion from application storage, not forensic disk erasure.
export function deleteConversation(store: Store, directory: string, key: string, title: string) {
  const target = store.get<Conversation>('conversation', key);
  assert(
    title === target.title,
    'CONFIRM_TITLE',
    'Type the exact conversation title to confirm deletion.',
  );
  assert(
    !target.parentId || target.forkEvent !== null,
    'CHILD_CONVERSATION',
    'Delete agent children together with their parent conversation.',
  );
  const chats = new Set([key]);
  const all = store.conversations();
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of all)
      if (c.parentId && chats.has(c.parentId) && c.forkEvent === null && !chats.has(c.id)) {
        chats.add(c.id);
        changed = true;
      }
  }
  const runs = store.runMetadata().filter((r) => chats.has(r.conversationId));
  assert(
    runs.every((r) => terminal(r.status)),
    'RUN_ACTIVE',
    'Stop this conversation and its agents before deleting.',
  );
  const runIds = new Set(runs.map((r) => r.id));
  const rows = (
    store.db.prepare('SELECT kind,id,data FROM records').all() as {
      kind: string;
      id: string;
      data: string;
    }[]
  ).map((r) => ({ ...r, value: JSON.parse(r.data) }));
  for (const r of rows)
    if (
      chats.has(r.value.conversationId) &&
      ['media-job', 'command-job', 'mcp-job'].includes(r.kind)
    )
      assert(
        !['submitting', 'queued', 'running', 'waiting_approval'].includes(r.value.status),
        'JOB_ACTIVE',
        'Stop pending background operations before deleting.',
      );
  const owned = new Set<string>([...chats, ...runIds]);
  const selected = new Map<string, (typeof rows)[number]>();
  const excluded = new Set([
    'project',
    'memory',
    'memory-vector',
    'memory-forgotten',
    'conversation',
  ]);
  const linked = (v: any) =>
    [
      'conversationId',
      'runId',
      'parentRunId',
      'root',
      'rootRunId',
      'teamId',
      'jobId',
      'sourceRunId',
    ].some((k) => typeof v[k] === 'string' && owned.has(v[k]));
  changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (excluded.has(r.kind) || selected.has(r.kind + ':' + r.id)) continue;
      if (
        owned.has(r.id) ||
        linked(r.value) ||
        [...chats].some((id) => r.value.scope === 'session:' + id)
      ) {
        selected.set(r.kind + ':' + r.id, r);
        owned.add(r.id);
        changed = true;
      }
    }
  }
  // Preserve assets still referenced by independent forks.
  const otherEvents = store.db.prepare('SELECT conversation_id,data FROM events').all() as {
    conversation_id: string;
    data: string;
  }[];
  const shared = (id: string) =>
    otherEvents.some((e) => !chats.has(e.conversation_id) && e.data.includes(id));
  const paths: string[] = [];
  for (const id of chats)
    for (const kind of ['chats', 'spills']) paths.push(join(directory, kind, id));
  for (const id of chats)
    paths.push(join(directory, 'browser-sessions', createHash('sha256').update(id).digest('hex')));
  for (const r of selected.values()) {
    if (r.kind === 'attachment' && !shared(r.id)) paths.push(join(directory, 'attachments', r.id));
    if (r.kind === 'media-job' && !shared(r.id)) paths.push(join(directory, 'media', r.id));
    if (r.kind === 'isolation' && !all.some((c) => !chats.has(c.id) && c.isolationId === r.id))
      paths.push(join(directory, 'isolated', r.id));
  }
  const root = realpathSync(directory);
  // Validate every path before any deletion; refuse junctions in the ownership chain.
  for (const path of paths) {
    const rel = relative(root, resolve(path));
    assert(
      rel && !rel.startsWith('..') && !isAbsolute(rel),
      'DELETE_SCOPE',
      'Invalid private-storage deletion path.',
    );
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if (existsSync(current))
        assert(
          !lstatSync(current).isSymbolicLink(),
          'DELETE_LINK',
          'Refusing linked storage path.',
        );
    }
  }
  // Synchronous filesystem work prevents task admission between the guard and commit.
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  store.transaction(() => {
    for (const c of all)
      if (!chats.has(c.id) && c.parentId && chats.has(c.parentId))
        store.put('conversation', { ...c, parentId: null });
    for (const id of chats) {
      store.db
        .prepare('DELETE FROM chunk_fts WHERE id IN (SELECT id FROM chunks WHERE scope=?)')
        .run('session:' + id);
      store.db.prepare('DELETE FROM chunks WHERE scope=?').run('session:' + id);
      store.db.prepare('DELETE FROM events WHERE conversation_id=?').run(id);
      store.remove('conversation', id);
    }
    for (const id of runIds) {
      store.db.prepare('DELETE FROM effects WHERE run_id=?').run(id);
      store.db.prepare('DELETE FROM ledger WHERE run_id=?').run(id);
      store.remove('run', id);
    }
    for (const id of chats)
      paths.push(
        join(directory, 'browser-sessions', createHash('sha256').update(id).digest('hex')),
      );
    for (const r of selected.values()) {
      if (
        (r.kind === 'attachment' || r.kind === 'media-job' || r.kind === 'media-file') &&
        shared(r.value.jobId || r.id)
      )
        continue;
      store.remove(r.kind, r.id);
    }
  });
  return { deleted: [...chats], retainedMemories: true };
}
