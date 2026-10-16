import { EventEmitter } from 'node:events';
import type { Run, Settings } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { execute, type CommandResult } from './process.js';
import { assert, abortError, errorMessage, NotStartedError } from '../core/errors.js';
export interface CommandJob {
  id: string;
  runId: string;
  conversationId: string;
  command: string;
  cwd: string;
  status:
    'waiting_approval' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'unknown';
  createdAt: number;
  updatedAt: number;
  timeoutSeconds: number;
  effectId: string;
  approvalId?: string;
  stdout: string;
  stderr: string;
  result?: CommandResult;
  error?: string;
  errorCode?: string;
  notStarted?: boolean;
  readyText?: string;
  readyObserved: boolean;
}
export class BackgroundCommands {
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private events = new EventEmitter();
  constructor(
    private store: Store,
    private notify: (job: CommandJob) => void = () => {},
  ) {
    this.events.setMaxListeners(200);
    for (const job of store
      .list<CommandJob>('command-job')
      .filter((j) => ['running', 'waiting_approval'].includes(j.status))) {
      const notStarted = job.status === 'waiting_approval';
      job.status = notStarted ? 'cancelled' : 'unknown';
      job.error = notStarted
        ? 'Service restarted before execution; request fresh approval.'
        : 'Service restarted during execution. Original process outcome is unknown; inspect, do not replay.';
      job.updatedAt = Date.now();
      store.put('command-job', job);
      store.event(job.conversationId, job.runId, 'command.background', this.view(job));
    }
  }
  view(job: CommandJob) {
    return {
      ...job,
      stdout: job.stdout.slice(-12000),
      stderr: job.stderr.slice(-4000),
      result: job.result
        ? {
            ...job.result,
            stdout: job.result.stdout.slice(-12000),
            stderr: job.result.stderr.slice(-4000),
          }
        : undefined,
      note: 'Log readiness is only a marker, not a health check. Unknown outcomes must not be replayed.',
    };
  }
  get(conversationId: string, key: string) {
    const job = this.store.get<CommandJob>('command-job', key);
    assert(
      job.conversationId === conversationId,
      'COMMAND_SCOPE',
      'Background command belongs to another conversation.',
    );
    return job;
  }
  running(runId: string) {
    return this.store
      .list<CommandJob>('command-job')
      .filter((j) => j.runId === runId && ['running', 'waiting_approval'].includes(j.status));
  }
  list(conversationId: string) {
    return this.store
      .list<CommandJob>('command-job')
      .filter((j) => j.conversationId === conversationId)
      .map((j) => this.view(j));
  }
  start(
    run: Run,
    command: string,
    cwd: string,
    seconds: number,
    settings: Settings,
    signal: AbortSignal,
    readyText?: string,
    approval?: { id: string; authorize: (signal: AbortSignal) => Promise<void> },
    delivery?: { detached: boolean },
  ) {
    signal.throwIfAborted();
    const job = this.store.transaction(() => {
      const effectId = '';
      const job: CommandJob = {
        id: id(),
        runId: run.id,
        conversationId: run.conversationId,
        command,
        cwd,
        status: approval ? 'waiting_approval' : 'running',
        approvalId: approval?.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        timeoutSeconds: seconds,
        effectId,
        stdout: '',
        stderr: '',
        readyText,
        readyObserved: false,
      };
      this.store.put('command-job', job);
      this.store.event(run.conversationId, run.id, 'command.background', this.view(job));
      return job;
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let lastSaved = 0;
    const save = () => {
      job.updatedAt = Date.now();
      this.store.put('command-job', job);
      this.events.emit(job.id);
    };
    const heartbeat = setInterval(() => {
      save();
      this.store.event(job.conversationId, job.runId, 'command.background', this.view(job));
    }, 5000);
    const task = (async () => {
      try {
        if (approval) await approval.authorize(controller.signal);
        controller.signal.throwIfAborted();
        this.store.transaction(() => {
          job.effectId = this.store.beginEffect(run.id, 'background_command', {
            command,
            cwd,
            timeoutSeconds: seconds,
          });
          this.store.put('effect-reference', {
            id: job.effectId,
            runId: run.id,
            protocol: 'command-job',
            jobId: job.id,
          });
          job.status = 'running';
          save();
        });
        this.store.event(job.conversationId, job.runId, 'command.background', this.view(job));
        const result = await execute(
          command,
          cwd,
          controller.signal,
          seconds * 1000,
          settings,
          (stream, chunk) => {
            const field = stream === 'stdout' ? 'stdout' : 'stderr';
            job[field] = (job[field] + chunk).slice(-64000);
            if (readyText && job.stdout.includes(readyText)) job.readyObserved = true;
            if (Date.now() - lastSaved > 500) {
              lastSaved = Date.now();
              save();
            }
          },
        );
        job.result = result;
        job.stdout = result.stdout.slice(-64000);
        job.stderr = result.stderr.slice(-64000);
        job.readyObserved ||= !!readyText && result.stdout.includes(readyText);
        job.status = controller.signal.aborted
          ? 'cancelled'
          : result.code === 0 && !result.timedOut
            ? 'completed'
            : 'failed';
        this.store.transaction(() => {
          save();
          this.store.endEffect(job.effectId, JSON.stringify(result).slice(0, 20000));
        });
      } catch (error) {
        job.error = errorMessage(error);
        job.notStarted = error instanceof NotStartedError;
        job.errorCode = error instanceof NotStartedError ? error.code : undefined;
        job.status = !job.effectId
          ? controller.signal.aborted
            ? 'cancelled'
            : error instanceof NotStartedError && error.code === 'APPROVAL_DENIED'
              ? 'denied'
              : 'failed'
          : error instanceof NotStartedError
            ? 'failed'
            : 'unknown';
        if (job.effectId && error instanceof NotStartedError)
          this.store.endEffect(job.effectId, job.error, 'not_started');
      } finally {
        clearInterval(heartbeat);
        signal.removeEventListener('abort', cancel);
        save();
        this.active.delete(job.id);
        this.store.event(job.conversationId, job.runId, 'command.background', this.view(job));
        if (delivery?.detached !== false) this.notify(job);
      }
    })();
    this.active.set(job.id, { controller, task });
    if (signal.aborted) cancel();
    return this.view(job);
  }
  wake(conversationId: string) {
    this.events.emit('steering:' + conversationId);
  }
  async wait(
    conversationId: string,
    key: string,
    signal: AbortSignal,
    seconds = 0,
    untilReady = false,
  ) {
    const job = this.get(conversationId, key);
    const done = () =>
      !['running', 'waiting_approval'].includes(job.status) || (untilReady && job.readyObserved);
    if (done()) return this.view(job);
    const pending = () =>
      !!this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE kind='user-inbox' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.state')='pending' LIMIT 1",
        )
        .get(conversationId);
    if (pending()) return { ...this.view(job), waitReason: 'user-input' };
    let steered = false;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.events.removeListener(key, changed);
        this.events.removeListener('steering:' + conversationId, wake);
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const changed = () => {
        const latest = this.get(conversationId, key);
        Object.assign(job, latest);
        if (done()) finish();
      };
      const abort = () => finish(abortError());
      const wake = () => {
        steered = true;
        finish();
      };
      const timer = seconds > 0 ? setTimeout(() => finish(), seconds * 1000) : undefined;
      this.events.on(key, changed);
      this.events.once('steering:' + conversationId, wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (pending()) wake();
      else changed();
    });
    return {
      ...this.view(this.get(conversationId, key)),
      waitReason: steered ? 'user-input' : 'status-or-timeout',
    };
  }
  async cancel(conversationId: string, key: string) {
    const job = this.get(conversationId, key),
      active = this.active.get(key);
    if (active) {
      active.controller.abort();
      await active.task;
    }
    return this.view(this.get(conversationId, job.id));
  }
  async stopRun(runId: string) {
    await Promise.all(this.running(runId).map((j) => this.cancel(j.conversationId, j.id)));
  }
  async shutdown() {
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.active.values()].map((i) => i.task));
  }
}
