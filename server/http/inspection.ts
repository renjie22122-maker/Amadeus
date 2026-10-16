import { contextBudget } from '../core/context-budget.js';
import { readFile, lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Conversation, Run } from '../../shared/types.js';
import type { Runtime } from '../core/runtime.js';
import { assert } from '../core/errors.js';

export function inspectionRoutes(app: FastifyInstance, runtime: Runtime) {
  const { store, config } = runtime;
  const snapshots = new Map<string, Promise<any>>();
  let previousConfig = JSON.stringify(config.public());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/context', async (req) => {
    const c = store.get<Conversation>('conversation', req.params.id);
    const q = z
      .object({
        runId: z.string().optional(),
        offset: z.coerce.number().int().min(0).default(0),
        summary: z.literal('1').optional(),
      })
      .parse(req.query);
    const runs = store.runMetadata(c.id).sort((a, b) => b.createdAt - a.createdAt);
    const run = q.runId ? store.runHeader(q.runId) : runs[0];
    assert(
      !run || run.conversationId === c.id,
      'CONTEXT_SCOPE',
      'Run belongs to another conversation.',
      403,
    );
    const configured = config.get().profiles.find((p) => p.id === (run?.profileId || c.profileId));
    // Match the effective per-run reasoning used by Runtime.execute and sampleContext.
    const profile = configured
      ? { ...configured, reasoning: run?.reasoning ?? c.reasoning }
      : undefined;
    const currentConfig = JSON.stringify(config.public());
    if (previousConfig !== currentConfig) {
      snapshots.clear();
      previousConfig = currentConfig;
    }
    const key = JSON.stringify([c, run?.id, run ? store.runRevision(run.id) : 0]);
    let pending = snapshots.get(key);
    if (!pending) {
      pending = (async () => {
        const full = run ? store.get<Run>('run', run.id) : undefined;
        const messages = full?.checkpoints || [];
        const tools = full ? runtime.registry.modelSpecs(await runtime.context(full)) : [];
        const budget = profile
          ? contextBudget(
              messages,
              tools,
              profile,
              config.get().compactionRatio,
              full?.contextSample,
            )
          : null;
        return { messages, budget, characters: JSON.stringify(messages).length };
      })();
      snapshots.set(key, pending);
      while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value!);
      pending.catch(() => snapshots.delete(key));
    }
    const { messages, budget, characters } = await pending;
    if (characters > 6_000_000) snapshots.delete(key);
    const compactionEvents = store.events(c.id, 0, 'context.compacted');
    return {
      compactionCount: compactionEvents.length,
      budget,
      lastCompactionCheck: run ? store.maybe('context-check', run.id) : null,
      runId: run?.id || null,
      runs: runs.map((r) => ({ id: r.id, createdAt: r.createdAt, status: r.status })),
      model: profile?.model || '',
      capacity: profile?.contextWindow || null,
      total: messages.length,
      cache: run ? store.maybe<any>('context-diagnostics', run.id) : null,
      cognitive: run
        ? (() => {
            const state = store.maybe<any>('cognitive-state', run.id);
            return state
              ? { step: state.step, signals: state.signals, adviceOutcome: state.lastAdviceOutcome }
              : null;
          })()
        : null,
      measuredInput: run?.lastContextInputTokens ?? null,
      measuredAt: run?.lastContextMeasuredAt ?? null,
      compressionThresholdTokens: budget?.threshold ?? null,
      characters,
      offset: q.offset,
      compactions: compactionEvents
        .filter((e) => e.type === 'context.compacted' && (!run || e.runId === run.id))
        .map((e) => ({ at: e.createdAt, ...e.data })),
      messages: (q.summary ? [] : messages.slice(q.offset, q.offset + 10)).map(
        (m: any, i: number) => {
          const text =
            m.content +
            (m.calls?.length ? '\n\nTool calls:\n' + JSON.stringify(m.calls, null, 2) : '');
          return {
            index: q.offset + i,
            role: m.role,
            callId: m.callId,
            characters: text.length,
            text: text.slice(0, 16000),
            truncated: text.length > 16000,
          };
        },
      ),
    };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/files', async (req) => {
    const c = store.get<Conversation>('conversation', req.params.id);
    const q = z
      .object({
        path: z.string().max(2048).default('@0/.'),
        view: z.enum(['list', 'text', 'asset']).default('list'),
      })
      .parse(req.query);
    const scope = await runtime.filesForConversation(c);
    if (q.view === 'asset') {
      const file = await scope.resolve(q.path),
        mime: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
        };
      const type = mime[extname(file).toLowerCase()];
      const stat = await lstat(file);
      assert(
        type && stat.isFile() && stat.size <= 1000000,
        'PREVIEW_ASSET',
        'Use a PNG/JPEG/GIF/WebP/ICO image under 1 MB.',
      );
      return { data: 'data:' + type + ';base64,' + (await readFile(file)).toString('base64') };
    }
    if (q.view === 'text') {
      const text = await scope.read(q.path, 200000);
      assert(!text.includes('\0'), 'BINARY_FILE', 'Binary file preview is not available.');
      return { path: q.path, text };
    }
    const entries = await scope.list(q.path);
    return {
      roots: scope.roots,
      path: q.path,
      kind: c.isolationId ? 'isolated' : c.projectId ? 'project' : 'artifacts',
      entries: entries.slice(0, 500),
      truncated: entries.length > 500,
    };
  });
}
