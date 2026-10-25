import type { Run } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { assert, AppError } from '../core/errors.js';
import { EventEmitter } from 'node:events';
export const MCP_SUSPEND = Symbol('mcp-suspend');
export type Recovery = { binding: string; sessionId?: string; protocol: string };
export type TaskUpdate = { taskId: string; status: string; recovery?: Recovery };
export type Job = {
  id: string;
  conversationId: string;
  runId: string;
  serverId: string;
  projectId?: string;
  tool: string;
  status: 'running' | 'completed' | 'unknown';
  createdAt: number;
  updatedAt: number;
  effectId: string;
  result?: unknown;
  remoteTask?: { taskId: string; status: string };
  note?: string;
  recovery?: Recovery;
  cancellationRequested?: boolean;
};
export class McpJobs {
  private closed = false;
  reopen() {
    this.closed = false;
  }
  private events = new EventEmitter();
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; job: Job }
  >();
  private resumeCall?: (
    job: Job,
    signal: AbortSignal,
    update: (task: TaskUpdate) => void,
  ) => Promise<any>;
  configureRecovery(call: NonNullable<McpJobs['resumeCall']>) {
    this.resumeCall = call;
  }
  private publicJob({ recovery, ...job }: Job) {
    return {
      ...job,
      resumable:
        !!recovery && !!job.remoteTask && job.status !== 'completed' && !job.cancellationRequested,
    };
  }
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
    return this.publicJob(job);
  }
  list(scope: string) {
    return this.store
      .list<Job>('mcp-job')
      .filter((j) => j.conversationId === scope)
      .map(({ result, ...job }) => this.publicJob(job));
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
    call: (signal: AbortSignal, update: (task: TaskUpdate) => void) => Promise<any>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    assert(!this.closed, 'MCP_CLOSING', 'MCP jobs are shutting down.');
    assert(this.active.size < 32, 'MCP_JOB_LIMIT', 'Too many active MCP jobs.');
    const job: Job = {
      id: id(),
      conversationId: run.conversationId,
      runId: run.id,
      serverId,
      projectId: this.store.get<any>('conversation', run.conversationId).projectId,
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
    this.execute(job, call, signal);
    return this.get(job.conversationId, job.id);
  }
  private execute(
    job: Job,
    call: (signal: AbortSignal, update: (task: TaskUpdate) => void) => Promise<any>,
    signal: AbortSignal,
  ) {
    const controller = new AbortController(),
      abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const result = await call(controller.signal, (task) => {
          const { recovery, ...remoteTask } = task;
          job.remoteTask = remoteTask;
          if (recovery) job.recovery = recovery;
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
        job.status =
          result?.isError || ['failed', 'cancelled'].includes(job.remoteTask?.status || '')
            ? 'unknown'
            : 'completed';
        if (job.status === 'completed') {
          delete job.note;
          this.store.transaction(() => {
            this.store.endEffect(job.effectId, serialized.slice(0, 20000));
            this.store.put('mcp-job', job);
          });
        }
      } catch (error) {
        job.status = 'unknown';
        if (controller.signal.aborted && controller.signal.reason !== MCP_SUSPEND)
          job.cancellationRequested = true;
        job.note =
          controller.signal.reason === MCP_SUSPEND
            ? 'Following suspended. Resume the existing remote task; never submit it again.'
            : controller.signal.aborted
              ? 'Cancellation requested; remote effects may already have occurred.'
              : error instanceof AppError && error.code === 'MCP_TASK_INPUT'
                ? 'Remote task requires input. Following paused; no input was fabricated.'
                : error instanceof AppError &&
                    ['MCP_RECOVERY_CHANGED', 'MCP_RECOVERY_DENIED'].includes(error.code)
                  ? 'Recovery blocked by changed configuration, credentials or permissions. Restore the original context before following.'
                  : (error as any)?.code === -32602
                    ? 'Server no longer recognizes this task; outcome unknown. Never submit it again automatically.'
                    : 'Following failed or timed out; remote outcome unknown. Resume following after checking the server; never replay the call.';
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
    this.active.set(job.id, { controller, promise, job });
    if (signal.aborted) abort();
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
    const job = this.store.get<Job>('mcp-job', key);
    job.cancellationRequested = true;
    this.store.put('mcp-job', job);
    const active = this.active.get(key);
    if (active) {
      active.job.cancellationRequested = true;
      active.controller.abort();
    } else if (job.recovery && job.remoteTask && this.resumeCall && job.status !== 'completed') {
      const controller = new AbortController();
      controller.abort();
      // Recovery adapter interprets this as an explicit remote cancellation, never a submission.
      await this.resumeCall(job, controller.signal, () => {}).catch(() => {});
    }
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
  async resume(scope: string, key: string) {
    assert(
      this.store.maybe('conversation', scope),
      'MCP_JOB_SCOPE',
      'Conversation no longer exists.',
    );
    assert(!this.closed, 'MCP_CLOSING', 'MCP jobs are shutting down.');
    this.get(scope, key);
    if (this.active.has(key)) return this.get(scope, key);
    const job = this.store.get<Job>('mcp-job', key);
    assert(
      job.recovery &&
        job.remoteTask &&
        !job.cancellationRequested &&
        job.status !== 'completed' &&
        this.resumeCall,
      'MCP_RESUME',
      'No resumable remote task. Never replay the original call.',
    );
    assert(this.active.size < 32, 'MCP_JOB_LIMIT', 'Too many active MCP jobs.');
    job.status = 'running';
    job.note = 'Following existing remote task; original call is never resubmitted.';
    this.store.put('mcp-job', job);
    this.execute(
      job,
      (signal, update) => this.resumeCall!(job, signal, update),
      new AbortController().signal,
    );
    return this.get(scope, key);
  }
  recover() {
    for (const job of this.store.list<Job>('mcp-job')) {
      if (
        job.recovery &&
        job.remoteTask &&
        job.status !== 'completed' &&
        !job.cancellationRequested &&
        this.store.maybe('conversation', job.conversationId)
      )
        void this.resume(job.conversationId, job.id).catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort(MCP_SUSPEND);
    await Promise.allSettled([...this.active.values()].map((t) => t.promise));
  }
}
