import type { Run, Profile, Usage } from '../../shared/types.js';
import type { ModelRequest, ModelProvider } from '../providers/protocol.js';
import { Store, id } from '../storage/store.js';
import { AppError } from './errors.js';
import { COMPACT } from './prompts.js';
import { sampleContext } from './context-budget.js';
import {
  prefixObservation,
  comparePrefix,
  contextComponents,
  type PrefixObservation,
} from './cache-observation.js';
export async function completeModel(
  store: Store,
  resolveProvider: (p: Profile) => ModelProvider,
  run: Run,
  input: ModelRequest,
) {
  try {
    const result = await resolveProvider(input.profile).complete(input);
    // Validate delivery before treating an otherwise successful transport as a result.
    // Keep measured usage on rejection so a repair does not hide the first call's cost.
    if (!result.message.content.trim() && !result.message.calls?.length)
      throw Object.assign(
        new AppError('EMPTY_RESPONSE', 'Model returned neither an answer nor tool calls.', 502),
        { usage: result.usage },
      );
    if (input.messages[0]?.content !== COMPACT && result.usage.measured) {
      run.contextSample = sampleContext(
        input.messages,
        input.tools,
        input.profile,
        result.usage.input,
      );
      run.lastContextInputTokens = result.usage.input;
      run.lastContextMeasuredAt = Date.now();
    }
    if (input.messages[0]?.content !== COMPACT) {
      const current = prefixObservation(input.messages, input.tools, input.profile);
      const previous = store.maybe<PrefixObservation>('prompt-prefix', run.conversationId);
      store.put('prompt-prefix', { ...current, id: run.conversationId });
      const diagnostics = {
        ...comparePrefix(previous || undefined, current, result.usage),
        ...contextComponents(input.messages, input.tools),
      };
      store.put('context-diagnostics', { id: run.id, ...diagnostics });
      store.event(run.conversationId, run.id, 'context.cache_observed', diagnostics);
    }
    accountModelUsage(store, run, result.usage, input.profile, id());
    return result;
  } catch (error) {
    const usage = (error as { usage?: Usage })?.usage || {
      input: 0,
      output: 0,
      cached: 0,
      measured: false,
    };
    accountModelUsage(store, run, usage, input.profile, id());
    if (error instanceof AppError && error.code === 'MODEL_INCOMPLETE') {
      const info = error as AppError & {
        finishReason?: string;
        answerCharacters?: number;
        reasoningCharacters?: number;
        pendingToolCalls?: number;
      };
      store.event(run.conversationId, run.id, 'model.incomplete', {
        finishReason: info.finishReason,
        outputLimit: input.profile.maxOutputTokens,
        reasoning: input.profile.reasoning,
        outputTokens: usage.output,
        answerCharacters: info.answerCharacters,
        reasoningCharacters: info.reasoningCharacters,
        pendingToolCalls: info.pendingToolCalls,
        toolsExecuted: false,
      });
    }
    throw error;
  }
}
export function accountModelUsage(
  store: Store,
  run: Run,
  usage: Usage,
  profile: Profile,
  requestId: string,
) {
  store.db
    .prepare('INSERT INTO ledger(request_id,run_id,data) VALUES(?,?,?)')
    .run(requestId, run.id, JSON.stringify({ usage, model: profile.model, at: Date.now() }));
  run.inputTokens += usage.input;
  run.outputTokens += usage.output;
  run.cachedTokens += usage.cached;
  run.modelCalls++;
  if (!usage.measured) run.usageComplete = false;
  const p = profile.prices;
  if (
    usage.measured &&
    p.input !== null &&
    p.output !== null &&
    p.cached !== null &&
    (run.modelCalls === 1 || run.estimatedUsd !== null)
  ) {
    run.estimatedUsd =
      (run.estimatedUsd || 0) +
      (Math.max(0, usage.input - usage.cached) * p.input +
        usage.cached * p.cached +
        usage.output * p.output) /
        1000000;
  } else run.estimatedUsd = null;
  store.put('run', run);
  store.event(run.conversationId, run.id, 'usage', {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cachedTokens: run.cachedTokens,
    modelCalls: run.modelCalls,
    estimatedUsd: run.estimatedUsd,
    measured: usage.measured,
  });
}
