import { cacheStableTools } from './prompt-cache.js';
import { withToolImages } from './protocol.js';
import { AppError, assert } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelResult } from './protocol.js';
import {
  emptyUsage,
  endpoint,
  parseArguments,
  reasoningFields,
  request,
  sse,
  standardUsage,
  validateCalls,
} from './protocol.js';
export function chatPayload({ profile, messages, tools }: ModelRequest) {
  messages = withToolImages(messages);
  tools = cacheStableTools(profile, tools);
  return {
    model: profile.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: profile.maxOutputTokens,
    ...reasoningFields(profile),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            { type: 'text', text: m.content },
            ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ]
        : m.content,
      ...(m.calls?.length
        ? {
            tool_calls: m.calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          }
        : {}),
      ...(m.callId ? { tool_call_id: m.callId } : {}),
      ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
    })),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  };
}
export class ChatProvider implements ModelProvider {
  async complete(input: ModelRequest): Promise<ModelResult> {
    const response = await request(
      input.profile,
      endpoint(input.profile, '/chat/completions'),
      chatPayload(input),
      input.signal,
      {},
      input.retryTransientConnect,
    );
    let content = '',
      reasoning = '',
      finish = '',
      usage = emptyUsage(),
      responseId = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    try {
      for await (const event of sse(response)) {
        assert(!event.error, 'MODEL_ERROR', 'The model reported a stream error.', 502);
        responseId = event.id || responseId;
        if (event.usage) usage = standardUsage(event.usage);
        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) {
          content += delta.content;
          input.onText(delta.content);
        }
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          input.onThinking?.();
        }
        for (const c of delta.tool_calls || []) {
          assert(
            Number.isInteger(c.index),
            'INVALID_STREAM',
            'Tool delta is missing a numeric index; no partial calls executed.',
            502,
          );
          let row = calls.get(c.index);
          if (!row) {
            row = { id: '', name: '', args: '' };
            calls.set(c.index, row);
          }
          if (c.id) row.id = c.id;
          if (c.function?.name && c.function.name !== row.name) row.name += c.function.name;
          if (c.function?.arguments) row.args += c.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (!['stop', 'tool_calls'].includes(finish)) {
        throw Object.assign(
          new AppError(
            'MODEL_INCOMPLETE',
            finish === 'length'
              ? 'Model output reached its limit (' +
                  input.profile.maxOutputTokens +
                  ' tokens; reasoning and answer share this allowance). Increase Maximum output tokens in Settings or use a lower reasoning level. No calls from this response were executed.'
              : 'Model output ended without a complete response (' +
                  (finish || 'missing finish') +
                  '). No partial tool calls were executed.',
            502,
          ),
          {
            finishReason: finish,
            outputLimit: input.profile.maxOutputTokens,
            outputTokens: usage.output,
            answerCharacters: content.length,
            reasoningCharacters: reasoning.length,
            pendingToolCalls: calls.size,
          },
        );
      }
      const parsed = validateCalls(
        [...calls.values()].map((c) => ({
          id: c.id,
          name: c.name,
          arguments: parseArguments(c.args),
        })),
      );
      assert(
        content.trim() || parsed.length,
        'EMPTY_RESPONSE',
        'Model returned no answer or tool calls.',
        502,
      );
      return {
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(parsed.length ? { calls: parsed } : {}),
        },
        usage,
        responseId,
      };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { usage });
      throw error;
    }
  }
}
