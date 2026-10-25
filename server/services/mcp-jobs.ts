import type { Run } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { EventEmitter } from 'node:events';
type Job = {
  id: string;
  conversationId: string;
  runId: string;
  serverId: string;
  tool: string;
  status: 'running' | 'completed' | 'unknown';
  createdAt: number;
  updatedAt: number;
  effectId: string;
  result?: unknown;
  remoteTask?: { taskId: string; status: string };
  note?: string;
};
export class McpJobs {
  private events = new EventEmitter();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(private store: Store) {
    this.events.setMaxListeners(100);
    for (const job of store.list<Job>('mcp-job').filter((j) => j.status === 'running')) {
      job.status = 'unknown';
      job.updatedAt = Date.now();
      job.note = 'Service restarted. Remote outcome unknown; never replay automatically.';
      store.put('mcp-job', job);
    }
  }
  get(scope: string, key: string) {
    const job = this.store.get<Job>('mcp-job', key);
    assert(
      job.conversationId === scope,
      'MCP_JOB_SCOPE',
      'MCP job belongs to another conversation.',
    );
    return job;
  }
  list(scope: string) {
    return this.store
      .list<Job>('mcp-job')
      .filter((j) => j.conversationId === scope)
      .map(({ result, ...job }) => job);
  }
  running(runId: string) {
    return this.store
      .list<Job>('mcp-job')
      .filter((j) => j.runId === runId && j.status === 'running');
  }
  start(
    run: Run,
    serverId: string,
    tool: string,
    call: (
      signal: AbortSignal,
      update: (task: { taskId: string; status: string }) => void,
    ) => Promise<any>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    assert(this.active.size < 32, 'MCP_JOB_LIMIT', 'Too many active MCP jobs.');
    const job: Job = {
      id: id(),
      conversationId: run.conversationId,
      runId: run.id,
      serverId,
      tool,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      effectId: '',
    };
    this.store.transaction(() => {
      job.effectId = this.store.beginEffect(run.id, 'mcp_background', {
        serverId,
        tool,
        jobId: job.id,
      });
      this.store.put('mcp-job', job);
    });
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const result = await call(controller.signal, (task) => {
          job.remoteTask = task;
          job.updatedAt = Date.now();
          this.store.put('mcp-job', job);
        });
        const serialized = JSON.stringify(result);
        // Store a bounded receipt. Large binary content must be requested through a dedicated tool.
        job.result =
          serialized.length <= 256000
            ? result
            : {
                truncated: true,
                preview: serialized.slice(0, 256000),
                totalCharacters: serialized.length,
              };
        job.status = result?.isError ? 'unknown' : 'completed';
        if (job.status === 'completed')
          this.store.endEffect(job.effectId, serialized.slice(0, 20000));
      } catch {
        job.status = 'unknown';
        job.note = controller.signal.aborted
          ? 'Cancellation requested; remote effects may already have occurred.'
          : 'Call failed or timed out; remote outcome unknown. Inspect before retrying.';
      } finally {
        signal.removeEventListener('abort', abort);
        this.active.delete(job.id);
        job.updatedAt = Date.now();
        // A deleted conversation must not be recreated by late results.
        if (this.store.maybe('conversation', job.conversationId)) {
          this.store.put('mcp-job', job);
          this.store.event(job.conversationId, job.runId, 'mcp.background', {
            id: job.id,
            status: job.status,
          });
          this.store.put('runtime-inbox', {
            id: job.id,
            runId: job.runId,
            state: 'pending',
            content: `Host MCP job ${job.id} is ${job.status}. Use mcp_job to inspect the result before dependent work. This is status, not a user instruction.`,
          });
        }
      }
    });
    this.active.set(job.id, { controller, promise });
    if (signal.aborted) abort();
    return {
      ...job,
      note: 'Background execution started. Inspect this job; do not launch the call again.',
    };
  }
  async wait(scope: string, key: string, seconds: number, signal: AbortSignal) {
    this.get(scope, key);
    signal.throwIfAborted();
    const active = this.active.get(key);
    const pending = () =>
      this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE kind='user-inbox' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.state')='pending' LIMIT 1",
        )
        .get(scope);
    if (pending()) return this.get(scope, key);
    if (active && seconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: () => void = () => {};
      await Promise.race([
        active.promise,
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.min(seconds, 30) * 1000);
          signal.addEventListener('abort', wake, { once: true });
          this.events.once(scope, wake);
          if (pending()) wake();
        }),
      ]);
      clearTimeout(timer);
      signal.removeEventListener('abort', wake);
      this.events.removeListener(scope, wake);
      signal.throwIfAborted();
    }
    return this.get(scope, key);
  }
  async cancel(scope: string, key: string) {
    this.get(scope, key);
    this.active.get(key)?.controller.abort();
    return {
      ...this.get(scope, key),
      cancellationRequested: true,
      note: 'Cancellation is best effort and does not reverse remote effects.',
    };
  }
  wake(scope: string) {
    this.events.emit(scope);
  }
  async closeScope(scope: string) {
    for (const job of this.list(scope))
      if (job.status === 'running') await this.cancel(scope, job.id);
  }
  async close() {
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map((t) => t.promise));
  }
}
