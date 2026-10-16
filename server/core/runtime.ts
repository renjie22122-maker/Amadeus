import { ConversationTitles, shortTitle } from '../services/conversation-titles.js';
import { taskSkills } from '../services/skill-discovery.js';
import { providerFailureDiagnostic } from '../providers/failure.js';
import { completeModel, accountModelUsage } from './model-session.js';
import { createRuntimeServices } from './runtime-services.js';
import { setTimeout as recoveryDelay } from 'node:timers/promises';
import { transientModelFailure, modelReconnectDelay } from './model-recovery.js';
import { toolHooks } from '../services/tool-hooks.js';
import { prepareResume } from './resume-preparation.js';
import { runtimeMessages } from './context-reuse.js';
import { RunPump } from './run-pump.js';
import { RunEnvironment } from './run-environment.js';
import { BackgroundCommands } from '../services/background-commands.js';
import { checkResponse, type ResponseContract } from './response-contract.js';
import { finalizeRun } from './finalization.js';
import { TeamCoordinator } from './team-coordinator.js';
import { MediaService } from '../services/media.js';
import { normalizeImage } from '../services/images.js';
import { TeamAutomation } from '../services/team-automation.js';
import { Teams } from '../services/team-space.js';
import { DelegationManager } from './delegation-manager.js';
import { termination } from './termination.js';
import { profileKey } from './context-budget.js';
import { ContextManager } from './context-manager.js';
import { ToolExecutor } from './tool-executor.js';
import { CognitiveController } from './cognitive-controller.js';
import { MemoryIndex } from '../services/memory-index.js';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import type {
  Attachment,
  Conversation,
  ModelMessage,
  Profile,
  Project,
  Run,
  Usage,
} from '../../shared/types.js';
import type { ModelProvider, ModelRequest, ModelResult } from '../providers/protocol.js';
import { providerFor } from '../providers/registry.js';
import { Inputs } from '../services/approvals.js';
import { Knowledge } from '../services/knowledge.js';
import { McpHub } from '../services/mcp.js';
import { FileScope } from '../services/paths.js';
import { Configuration } from '../services/settings.js';
import { Store, id } from '../storage/store.js';
import { tools, type TeamPort, type ToolContext } from '../tools/registry.js';
import { abortError, assert, errorMessage, AppError } from './errors.js';
import { terminal } from './lifecycle.js';
import { ModelPool } from './pool.js';
export class Runtime implements TeamPort {
  readonly teamAutomation: TeamAutomation;
  private titles: ConversationTitles;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintenanceTask: Promise<void> | null = null;
  readonly mcp: McpHub;
  readonly bus = new EventEmitter();
  readonly media: MediaService;
  readonly background: BackgroundCommands;
  readonly inputs: Inputs;
  readonly knowledge: Knowledge;
  readonly memories: MemoryIndex;
  readonly registry = tools();
  private modelPool: ModelPool;
  private contextManager: ContextManager;
  private toolExecutor: ToolExecutor;
  private delegation: DelegationManager;
  private teamCoordinator: TeamCoordinator;
  private environment: RunEnvironment;
  private execution: RunPump;
  private steering = new Map<string, { content: string; attachmentIds: string[] }[]>();
  private scheduling = false;
  private schedulingTask: Promise<void> = Promise.resolve();
  private reschedule = false;
  private shuttingDown = false;
  readonly streams = new Map<string, { conversationId: string; messageId: string; text: string }>();
  constructor(
    readonly store: Store,
    readonly config: Configuration,
    readonly directory: string,
    private resolveProvider: (p: Profile) => ModelProvider = providerFor,
  ) {
    this.titles = new ConversationTitles(store, (key) => config.profile(key), this.resolveProvider);
    this.execution = new RunPump({
      scope: (key) => this.executionScope(store.get<Run>('run', key)),
      status: (key) => store.get<Run>('run', key).status,
      limit: () => config.get().maxParallelRuns,
      execute: (key, signal) => this.execute(key, signal),
      finished: (key) => {
        this.steering.delete(key);
        this.streams.delete(key);
        this.bus.emit('finished', key);
        if (!this.shuttingDown) this.titles.finish(key);
      },
    });
    this.teamCoordinator = new TeamCoordinator(store, {
      events: this.bus,
      filesForConversation: (c) => this.filesForConversation(c),
      steer: (id, text) => this.steer(id, text),
      pump: () => this.pump(),
    });
    this.modelPool = new ModelPool(() => config.get().maxParallelRuns);
    this.contextManager = new ContextManager(
      store,
      () => config.get().compactionRatio,
      this.modelPool,
      (run, req) => this.complete(run, req),
      (run) => this.executionScope(run),
      (run) => new CognitiveController(store).snapshot(run),
      (stage, run) =>
        toolHooks(
          {
            store,
            config,
            run,
            conversation: store.get<Conversation>('conversation', run.conversationId),
          },
          stage,
          'context',
        ),
    );
    this.toolExecutor = new ToolExecutor(store, this.registry, directory);
    this.delegation = new DelegationManager(store, config, directory, this.bus, {
      context: (run) => this.context(run),
      start: (...args) => this.start(...args),
      signal: (key) => this.execution.signal(key),
      pump: () => this.pump(),
      steer: (...args) => this.steer(...args),
    });
    this.teamAutomation = new TeamAutomation(store, {
      resume: (old, newId, prompt) =>
        this.start(old.conversationId, prompt, old.maxSteps, {
          parentRunId: old.parentRunId || old.id,
          depth: old.depth || 1,
          fresh: true,
          runId: newId,
          recoveredFrom: old.id,
        }),
      spawn: (source, prompt, ticket) =>
        this.delegation.spawn(
          source,
          prompt,
          'Complete assigned work with actual evidence.',
          'read-only',
          ticket,
        ),
      notify: (key, text) => {
        const r = this.store.get<Run>('run', key);
        if (!terminal(r.status)) this.steer(r.conversationId, text);
      },
      stop: (key) => this.stop(key, false),
    });
    const services = createRuntimeServices(store, config, directory, this.resolveProvider, (c) =>
      this.filesForConversation(c),
    );
    this.mcp = services.mcp;
    this.background = services.background;
    this.media = services.media;
    this.inputs = services.inputs;
    this.knowledge = services.knowledge;
    this.memories = services.memories;
    this.environment = new RunEnvironment(store, config, directory, this.memories);
    store.onEvent = (e) => {
      this.bus.emit('event', e);
      if (['tool.completed', 'team.lifecycle'].includes(e.type)) this.scheduleTeams();
    };
    this.bus.on('finished', () => this.scheduleTeams());
    this.bus.setMaxListeners(200);
  }
  active(conversationId: string) {
    return this.store.runMetadata(conversationId).find((r) => !terminal(r.status));
  }
  start(
    conversationId: string,
    message: string,
    maxSteps = 0,
    options: {
      parentRunId?: string;
      depth?: number;
      fresh?: boolean;
      runId?: string;
      recoveredFrom?: string;
      controlTicket?: string;
    } = {},
  ): Run {
    const c = this.store.get<Conversation>('conversation', conversationId);
    assert(
      !c.projectId || !this.store.get<Project>('project', c.projectId).removedAt,
      'PROJECT_REMOVED',
      'Restore this project before starting a task.',
    );
    assert(
      !this.active(conversationId),
      'RUN_ACTIVE',
      'This conversation is already running.',
      409,
    );
    this.store.reconcileKnownEffects(conversationId);
    const recoveryOnly = this.store.unknownEffects(conversationId).length > 0;
    const profile = this.config.profile(c.profileId);
    assert(
      profile.efforts.includes(c.reasoning),
      'REASONING_UNAVAILABLE',
      'Choose a supported reasoning level.',
    );
    const previous = this.store.latestRun(conversationId);
    const now = Date.now(),
      run: Run = {
        id: options.runId || id(),
        recoveredFrom: options.recoveredFrom,
        controlTicket: options.controlTicket,
        recoveryOnly,
        conversationId,
        status: 'queued',
        parentRunId: options.parentRunId || null,
        depth: options.depth || 0,
        createdAt: now,
        updatedAt: now,
        error: null,
        contextSample: options.fresh ? undefined : previous?.contextSample,
        checkpoints: options.fresh ? [] : structuredClone(previous?.checkpoints || []),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelCalls: 0,
        estimatedUsd: null,
        maxSteps,
        profileId: profile.id,
        providerFingerprint: JSON.stringify([profile.transport, profile.baseUrl, profile.model]),
        reasoning: c.reasoning,
      };
    // A different protocol cannot safely replay provider-specific thinking/signature blocks.
    if (
      previous &&
      (previous.profileId !== run.profileId ||
        (previous.providerFingerprint && previous.providerFingerprint !== run.providerFingerprint))
    )
      run.checkpoints = this.history(conversationId);
    if (run.contextSample?.fingerprint !== profileKey({ ...profile, reasoning: c.reasoning }))
      run.contextSample = undefined;
    this.store.put('conversation', {
      ...c,
      title: c.title === 'New chat' && !c.titleGeneration ? shortTitle(message) : c.title,
      ...(!previous &&
      !c.parentId &&
      !options.parentRunId &&
      c.title === 'New chat' &&
      !c.titleGeneration
        ? { titleGeneration: { runId: run.id, state: 'pending' as const } }
        : {}),
      updatedAt: now,
    });
    this.store.put('run', run);
    const queued = this.recordUserMessage(conversationId, run.id, message);
    this.steering.set(run.id, [queued]);
    this.execution.enqueue(run.id);
    this.pump();
    return this.store.get('run', run.id);
  }
  steer(conversationId: string, message: string) {
    const run = this.active(conversationId);
    assert(run, 'NO_ACTIVE_RUN', 'No running task.', 409);
    const queued = this.recordUserMessage(conversationId, run.id, message, true);
    this.background.wake(conversationId);
    this.steering.set(run.id, [...(this.steering.get(run.id) || []), queued]);
  }
  private recordUserMessage(
    conversationId: string,
    runId: string,
    content: string,
    steering = false,
  ) {
    return this.store.transaction(() => {
      const attachments = this.store
        .forConversation<Attachment>('attachment', conversationId)
        .filter((a) => !a.messageEventId);
      const event = this.store.event(conversationId, runId, 'user.message', {
        text: content,
        steering,
        attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      });
      for (const a of attachments) this.store.put('attachment', { ...a, messageEventId: event.id });
      const queued = { content, attachmentIds: attachments.map((a) => a.id) };
      this.store.put('user-inbox', {
        id: String(event.id),
        conversationId,
        runId,
        state: 'pending',
        steering,
        ...queued,
      });
      return queued;
    });
  }
  startTeamMaintenance() {
    if (this.maintenanceTimer || this.shuttingDown) return;
    this.maintenanceTimer = setInterval(() => this.maintainTeams(), 1000);
    this.maintenanceTimer.unref();
  }
  private maintainTeams() {
    if (this.shuttingDown || this.maintenanceTask) return;
    this.maintenanceTask = this.teamAutomation
      .tick()
      .then(() => this.scheduleTeams())
      .catch((error) => {
        this.store.put('team-control-error', {
          id: 'latest',
          error: errorMessage(error),
          at: Date.now(),
        });
      })
      .finally(() => {
        this.maintenanceTask = null;
      });
  }
  stopTeam(key: string) {
    const team = new Teams(this.store).get(this.store.get<Run>('run', key));
    assert(team, 'TEAM_MISSING', 'No peer team.');
    const policy = this.store.maybe<any>('team-automation', team.id);
    if (policy) this.store.put('team-automation', { ...policy, enabled: false });
    for (const member of team.members) this.stop(member);
  }
  stop(key: string, cascade = true, manual = true) {
    const run = this.store.get<Run>('run', key);
    if (terminal(run.status)) return;
    if (manual && cascade) {
      const t = new Teams(this.store).get(run);
      if (t) {
        const p = this.store.maybe<any>('team-automation', t.id);
        if (p) this.store.put('team-automation', { ...p, enabled: false });
      }
    }
    if (manual)
      this.store.put('team-member-held', {
        id: key,
        reason: 'Explicit stop; automatic recovery suppressed.',
      });
    if (cascade)
      for (const child of this.store
        .runMetadata()
        .filter((c) => c.parentRunId === key && !terminal(c.status)))
        this.stop(child.id, true, manual);
    if (!this.execution.cancel(key)) {
      this.store.transition(key, 'interrupted', 'Stopped by user.');
      this.bus.emit('finished', key);
    }
  }

  private executionScope(run: Run): string {
    const seen = new Set<string>();
    while (run.parentRunId) {
      assert(!seen.has(run.id), 'RUN_ANCESTRY', 'Cyclic run ancestry.');
      seen.add(run.id);
      run = this.store.get<Run>('run', run.parentRunId);
    }
    return run.conversationId;
  }
  private pump() {
    this.execution.pump();
  }
  private history(conversationId: string): ModelMessage[] {
    return this.store
      .selectedEvents(conversationId, ['user.message', 'assistant.message'])
      .map((e) => ({
        role: e.type === 'user.message' ? 'user' : 'assistant',
        content: e.data.text,
      }));
  }
  filesForConversation(c: Conversation): Promise<FileScope> {
    return this.environment.filesForConversation(c);
  }
  async context(run: Run): Promise<ToolContext> {
    const c = this.store.get<Conversation>('conversation', run.conversationId);
    const files = await this.filesForConversation(c);
    const scopes = c.knowledge
      ? ['session:' + c.id, ...(c.projectId ? ['project:' + c.projectId] : ['general'])]
      : [];
    if (c.knowledge && run.parentRunId) {
      let parent = this.store.get<Run>('run', run.parentRunId);
      scopes.push('session:' + parent.conversationId);
      while (parent.parentRunId) {
        parent = this.store.get<Run>('run', parent.parentRunId);
        scopes.push('session:' + parent.conversationId);
      }
    }
    return {
      run,
      conversation: c,
      files,
      store: this.store,
      inputs: this.inputs,
      media: this.media,
      background: this.background,
      config: this.config,
      knowledge: this.knowledge,
      team: this,
      mcp: this.mcp,
      signal: this.execution.signal(run.id) || new AbortController().signal,
      scopes,
      auxiliary: (fn) =>
        this.modelPool.run(
          this.execution.signal(run.id) || new AbortController().signal,
          fn,
          this.executionScope(run),
        ),
      accountWeb: (usage, profile) => this.account(run, usage, profile, id()),
    };
  }
  private system(run: Run, ctx: ToolContext, profile: Profile) {
    return this.environment.system(
      run,
      ctx,
      profile,
      (this.steering.get(run.id) || []).map((m) => m.content),
    );
  }
  private complete(run: Run, input: ModelRequest) {
    return completeModel(this.store, this.resolveProvider, run, input);
  }
  private account(run: Run, usage: Usage, profile: Profile, requestId: string) {
    return accountModelUsage(this.store, run, usage, profile, requestId);
  }
  private async execute(key: string, signal: AbortSignal) {
    let run = this.store.get<Run>('run', key);
    try {
      run = this.store.transition(key, 'running');
      const ctx = await this.context(run);
      await prepareResume(this.store, run, ctx.files);
      ctx.signal = signal;
      const profile = { ...this.config.profile(run.profileId), reasoning: run.reasoning };
      const system = await this.system(run, ctx, profile);
      const [stableSystem, ...facts] = runtimeMessages(system);
      if (run.checkpoints[0]?.role === 'system') run.checkpoints[0] = stableSystem;
      else run.checkpoints.unshift(stableSystem);
      run.checkpoints.push(...facts);
      let steps = 0,
        protocolRepairs = 0,
        lengthRepairs = 0,
        networkRepairs = 0,
        deliveryRepairs = 0,
        formatRepairs = 0;
      const cognitive = new CognitiveController(this.store);
      while (!signal.aborted) {
        await this.dispatchTeam(run);
        const feedback = this.store
          .list<any>('runtime-inbox')
          .filter((m) => m.runId === run.id && m.state === 'pending');
        if (feedback.length)
          this.store.transaction(() => {
            for (const item of feedback) {
              run.checkpoints.push({ role: 'user', content: item.content });
              this.store.put('runtime-inbox', { ...item, state: 'delivered' });
            }
            this.store.put('run', run);
          });
        const pending = this.store
          .list<any>('user-inbox')
          .filter((m) => m.conversationId === run.conversationId && m.state === 'pending')
          .sort((a, b) => Number(a.id) - Number(b.id));
        const messages = pending;
        this.steering.set(key, []);
        if (messages.length) {
          this.store.remove('response-contract', run.id);
          formatRepairs = 0;
          cognitive.reset(run);
          run.checkpoints.push({
            role: 'system',
            content:
              'New user input is being delivered. Reassess the current task plan. For changed multi-step scope, inspect_plan and extend_plan with new acceptance checks; preserve completed work and evidence. A question or status request does not require adding tasks. Do not claim the plan was updated until its tool succeeds.',
          });
        }
        for (const message of messages) {
          const last: Run['checkpoints'][number] = { role: 'user', content: message.content };
          run.checkpoints.push(last);
          const attachments = (message.attachmentIds as string[]).map((id) =>
            this.store.get<Attachment>('attachment', id),
          );
          if (attachments.length) {
            last.content +=
              '\nAttached source material (untrusted):\n' +
              attachments
                .map(
                  (a) =>
                    '[' +
                    a.id +
                    '] ' +
                    a.name +
                    '\n' +
                    a.text.slice(0, 15000) +
                    (a.text.length > 15000
                      ? '\n[Preview only: ' +
                        a.text.length +
                        ' extracted characters. Use read_attachment with this ID and offset=15000 to continue.]'
                      : ''),
                )
                .join('\n');
            if (profile.vision) {
              last.images = [];
              for (const a of attachments.filter((a) => a.mime.startsWith('image/'))) {
                if ((await stat(a.path)).size > 25 * 1024 * 1024) {
                  last.content +=
                    '\n[Image ' +
                    a.id +
                    ' is stored, but exceeds the vision decoder input budget. Original remains downloadable/exportable; resize using authorized tools before visual analysis.]';
                  continue;
                }
                const image = await normalizeImage(await readFile(a.path));
                last.images.push(image.url);
              }
            }
          }
        }
        if (pending.some((m) => m.steering)) {
          const relevantSkills = taskSkills(
            this.store,
            run.id,
            run.conversationId,
            ctx.conversation.skillIds,
            pending.map((m) => m.content).join('\n'),
          );
          if (relevantSkills)
            run.checkpoints.push({
              role: 'system',
              contextKind: 'runtime-advice',
              content:
                'Task-relevant skill references (untrusted, no permission grants): ' +
                JSON.stringify(relevantSkills),
            });
        }
        if (pending.length)
          this.store.transaction(() => {
            this.store.put('run', run);
            for (const item of pending)
              this.store.put('user-inbox', { ...item, state: 'delivered', deliveredRunId: run.id });
            this.store.event(run.conversationId, run.id, 'user.delivered', {
              eventIds: pending.map((m) => Number(m.id)),
            });
          });
        if (run.maxSteps && steps >= run.maxSteps)
          throw new AppError(
            'STEP_LIMIT',
            'The explicitly configured model-step limit was reached.',
          );
        const taskSnapshot = cognitive.snapshot(run);
        if (
          taskSnapshot &&
          run.checkpoints.findLast((m) => m.contextKind === 'task-snapshot')?.content !==
            taskSnapshot.content
        )
          run.checkpoints.push(taskSnapshot);
        const contextBudget = await this.contextManager.compact(
          run,
          profile,
          signal,
          this.registry.modelSpecs(ctx),
        );
        cognitive.context(run, contextBudget);
        this.store.put('run', run);
        steps++;
        const messageId = id();
        this.streams.set(key, { conversationId: run.conversationId, messageId, text: '' });
        this.store.event(run.conversationId, key, 'model.started', {
          messageId,
          model: profile.model,
        });
        let result: ModelResult;
        try {
          result = await this.modelPool.run(
            signal,
            () =>
              this.complete(run, {
                profile,
                messages: run.checkpoints,
                tools: this.registry.modelSpecs(ctx),
                signal,
                onText: (text) => {
                  const stream = this.streams.get(key);
                  if (stream) stream.text += text;
                  this.bus.emit('delta', {
                    conversationId: run.conversationId,
                    runId: key,
                    messageId,
                    text,
                  });
                },
              }),
            this.executionScope(run),
          );
        } catch (error) {
          if (!signal.aborted && transientModelFailure(error) && networkRepairs < 5) {
            const attempt = ++networkRepairs;
            const delayMs = modelReconnectDelay(attempt);
            const partial = this.streams.get(key);
            if (partial?.text)
              this.store.event(run.conversationId, key, 'assistant.message', {
                messageId,
                text: partial.text,
                final: false,
                incomplete: true,
              });
            this.streams.delete(key);
            this.store.event(run.conversationId, key, 'model.reconnecting', {
              failure: providerFailureDiagnostic(error),
              attempt,
              maxAttempts: 5,
              delayMs,
              toolsExecuted: false,
            });
            await recoveryDelay(delayMs, undefined, { signal });
            continue;
          }
          if (
            !signal.aborted &&
            error instanceof AppError &&
            error.code === 'MODEL_INCOMPLETE' &&
            (error as AppError & { finishReason?: string }).finishReason === 'length' &&
            lengthRepairs++ < 2
          ) {
            const partial = this.streams.get(key);
            if (partial?.text)
              this.store.event(run.conversationId, key, 'assistant.message', {
                messageId,
                text: partial.text,
                final: false,
                incomplete: true,
              });
            this.streams.delete(key);
            this.store.event(run.conversationId, key, 'model.protocol-repair', {
              code: 'OUTPUT_LIMIT',
              attempt: lengthRepairs,
              maxAttempts: 2,
              toolsExecuted: false,
              outputLimit: profile.maxOutputTokens,
              message:
                'Output was truncated. Retrying with a smaller response (at most two repairs); completed operations will not be replayed.',
            });
            run.checkpoints.push({
              role: 'user',
              content:
                (lengthRepairs === 2
                  ? 'This is the last output-length repair for this step. Reduce the next response to the smallest useful complete action; avoid repeating analysis or bundling changes. '
                  : '') +
                'Runtime feedback: your last response hit the output token limit before completion. None of its tool calls executed. Produce one smaller complete next step or a concise complete answer, with less deliberation. Split large tool arguments across steps. Do not repeat any earlier completed operations. The configured output allowance and reasoning level are unchanged.',
            });
            continue;
          }
          if (
            !signal.aborted &&
            error instanceof AppError &&
            ['INVALID_ARGUMENTS', 'DUPLICATE_CALL', 'EMPTY_RESPONSE', 'EMPTY_ANSWER'].includes(
              error.code,
            ) &&
            protocolRepairs++ < 2
          ) {
            const partial = this.streams.get(key);
            if (partial?.text)
              this.store.event(run.conversationId, key, 'assistant.message', {
                messageId,
                text: partial.text,
                final: false,
                incomplete: true,
              });
            this.streams.delete(key);
            this.store.event(run.conversationId, key, 'model.protocol-repair', {
              code: error.code,
              attempt: protocolRepairs,
              toolsExecuted: false,
            });
            run.checkpoints.push({
              role: 'user',
              content:
                'Runtime protocol feedback: the previous response was empty or invalid and none of its tools executed. Deliver a nonempty answer if no tool is needed. Otherwise use only the attached tool schemas, valid JSON objects and unique call IDs; emit one small complete tool call. Do not replay earlier completed operations.',
            });
            continue;
          }
          throw error;
        }
        protocolRepairs = 0;
        lengthRepairs = 0;
        networkRepairs = 0;
        if (signal.aborted) throw abortError();
        if (!result.message.calls?.length) {
          const contract = this.store.maybe<ResponseContract>('response-contract', run.id);
          const issues = contract ? checkResponse(result.message.content, contract) : [];
          if (issues.length) {
            this.streams.delete(key);
            this.store.event(run.conversationId, key, 'assistant.message', {
              messageId,
              text: result.message.content,
              final: false,
              incomplete: true,
            });
            this.store.event(run.conversationId, key, 'delivery.format-rejected', {
              issues,
              attempt: formatRepairs + 1,
            });
            assert(
              formatRepairs++ < 2,
              'OUTPUT_FORMAT',
              'Final answer does not satisfy its declared output contract: ' + issues.join(' '),
            );
            run.checkpoints.push(result.message, {
              role: 'user',
              contextKind: 'runtime-advice',
              content:
                'Host output-format check: ' +
                issues.join(' ') +
                ' Preserve the answer meaning and evidence. Correct only the final representation; do not repeat completed tools. Contract: ' +
                JSON.stringify(contract),
            });
            this.store.put('run', run);
            continue;
          }
        }
        run.checkpoints.push(result.message);
        this.store.put('run', run);
        this.streams.delete(key);
        if (result.message.content)
          this.store.event(run.conversationId, key, 'assistant.message', {
            messageId,
            text: result.message.content,
            final: !result.message.calls?.length,
          });
        if (!result.message.calls?.length) {
          await this.dispatchTeam(run);
          assert(
            result.message.content.trim(),
            'EMPTY_ANSWER',
            'Model returned neither an answer nor tool calls.',
          );
          if (
            (this.steering.get(key) || []).length ||
            this.store
              .list<any>('runtime-inbox')
              .some((m) => m.runId === key && m.state === 'pending')
          )
            continue;
          // Finish children before reporting the task terminal; never abandon live descendants.
          const children = this.store
            .runMetadata()
            .filter(
              (r) =>
                r.parentRunId === key && !terminal(r.status) && !new Teams(this.store).get(run),
            );
          if (children.length) {
            const reports = await this.wait(
              run,
              children.map((c) => c.id),
              signal,
            );
            run.status = 'running';
            run.checkpoints.push({
              role: 'user',
              content:
                'Delegated work has finished. Incorporate relevant results before your final answer:\n' +
                JSON.stringify(reports),
            });
            continue;
          }
          const jobs = this.background.running(run.id);
          if (jobs.length) {
            while (
              this.background.running(run.id).length &&
              !(this.steering.get(key) || []).length
            ) {
              await Promise.all(
                this.background
                  .running(run.id)
                  .map((job) => this.background.wait(run.conversationId, job.id, signal, 60)),
              );
              signal.throwIfAborted();
            }
            continue;
          }
          await toolHooks(ctx, 'beforeTaskComplete', 'task');
          try {
            await finalizeRun(this.store, run, ctx.files);
          } catch (error) {
            if (
              error instanceof AppError &&
              [
                'PLAN_INCOMPLETE',
                'CHALLENGE_OPEN',
                'MEMORY_CHECK_PENDING',
                'TEAM_REVIEW_PENDING',
              ].includes(error.code) &&
              deliveryRepairs++ < 2
            ) {
              const message =
                'Host delivery check: ' +
                error.message +
                ' Continue the unfinished checks or explain a concrete blocker. Do not replay completed operations or drop requirements.';
              run.checkpoints.push({
                role: 'user',
                contextKind: 'runtime-advice',
                content: message,
              });
              this.store.event(run.conversationId, run.id, 'cognitive.intervention', {
                action: 'verify',
                reason: error.code,
                message,
              });
              continue;
            }
            throw error;
          }
          if (this.store.get<Run>('run', run.id).status === 'completed')
            await toolHooks(ctx, 'afterTaskComplete', 'task');
          return;
        }
        const outputs = await this.toolExecutor.batch(run, result.message.calls, ctx);
        const decision = cognitive.observe(
          run,
          result.message.calls.map((c) => [c.name, c.arguments]),
          outputs,
          this.toolExecutor.takeOutcomes(run.id),
        );
        if (decision.action === 'stop') throw new AppError('STAGNATION', decision.reason);
        if (decision.message) {
          run.checkpoints.push({
            role: 'user',
            contextKind: 'runtime-advice',
            content: '[Runtime observation; not a new user request] ' + decision.message,
          });
          this.store.put('run', run);
        }
      }
      throw abortError();
    } catch (error) {
      const partial = this.streams.get(key);
      if (partial?.text)
        this.store.event(run.conversationId, key, 'assistant.message', {
          messageId: partial.messageId,
          text: partial.text,
          final: false,
          incomplete: true,
        });
      await this.background.stopRun(key);
      const current = this.store.get<Run>('run', key);
      if (!terminal(current.status)) {
        const reason = termination(error, signal.aborted);
        this.store.put('run', { ...current, termination: reason });
        this.store.transition(
          key,
          reason.recoverable ? 'interrupted' : 'failed',
          errorMessage(error),
        );
        this.store.event(run.conversationId, key, 'run.termination', reason);
      }
      if (!new Teams(this.store).get(current))
        for (const child of this.store
          .runMetadata()
          .filter((c) => c.parentRunId === key && !terminal(c.status)))
          this.stop(child.id);
    }
  }
  private scheduleTeams() {
    if (this.shuttingDown) return;
    this.reschedule = true;
    if (this.scheduling) return;
    this.scheduling = true;
    this.schedulingTask = Promise.resolve().then(async () => {
      try {
        while (this.reschedule && !this.shuttingDown) {
          this.reschedule = false;
          for (const t of this.store.list<any>('team-space').filter((t) => t.mode === 'host')) {
            const run = this.store.get<Run>('run', t.id);
            try {
              await this.dispatchTeam(run);
            } catch (error) {
              this.store.event(run.conversationId, run.id, 'team.scheduler-error', {
                error: errorMessage(error),
              });
            }
          }
        }
      } finally {
        this.scheduling = false;
      }
    });
  }
  private dispatchTeam(run: Run) {
    return this.teamCoordinator.dispatch(run);
  }
  awaitDiscussion(run: Run, signal: AbortSignal, afterId?: string, seconds = 60) {
    return this.teamCoordinator.awaitDiscussion(run, signal, afterId, seconds);
  }
  awaitAssignment(run: Run, signal: AbortSignal) {
    return this.teamCoordinator.awaitAssignment(run, signal);
  }
  members: NonNullable<TeamPort['members']> = (...args) => this.delegation.members(...args);
  continueMember: NonNullable<TeamPort['continueMember']> = (...args) =>
    this.delegation.continueMember(...args);
  closeMember: NonNullable<TeamPort['closeMember']> = (...args) =>
    this.delegation.closeMember(...args);
  spawn: TeamPort['spawn'] = (...args) => this.delegation.spawn(...args);
  inspectChanges = (parent: Run, key: string) => this.delegation.inspectChanges(parent, key);
  mergeChanges = (parent: Run, key: string, version: string) =>
    this.delegation.mergeChanges(parent, key, version);
  wait: TeamPort['wait'] = (...args) => this.delegation.wait(...args);
  message: TeamPort['message'] = (...args) => this.delegation.message(...args);
  async shutdown() {
    this.shuttingDown = true;
    this.execution.stopAccepting();
    clearInterval(this.maintenanceTimer);
    await this.maintenanceTask;
    for (const key of this.execution.keys()) this.stop(key, true, false);
    await this.execution.drained();
    await this.schedulingTask;
    await this.titles.close();
    await this.background.shutdown();
    this.knowledge.close();
    await this.mcp.close();
  }
}
