import { cacheStableTools } from './prompt-cache.js';
import { AppError as LimitError } from '../core/errors.js';
import { withToolImages } from './protocol.js';
import { assert } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelResult } from './protocol.js';
import {
  endpoint,
  parseArguments,
  reasoningFields,
  request,
  sse,
  standardUsage,
  validateCalls,
} from './protocol.js';
export function responsesPayload({ profile, messages, tools }: ModelRequest) {
  messages = withToolImages(messages);
  tools = cacheStableTools(profile, tools);
  const input: any[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.callId, output: m.content });
      continue;
    }
    if (m.role === 'assistant' && m.native) {
      input.push(...m.native);
      continue;
    }
    if (m.content || m.images?.length)
      input.push({
        role: m.role,
        content: m.images?.length
          ? [
              { type: 'input_text', text: m.content },
              ...m.images.map((image_url) => ({ type: 'input_image', image_url })),
            ]
          : m.content,
      });
    for (const c of m.calls || [])
      input.push({
        type: 'function_call',
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments),
      });
  }
  return {
    model: profile.model,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: profile.maxOutputTokens,
    instructions: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n'),
    input,
    ...reasoningFields(profile),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
          })),
        }
      : {}),
  };
}
export class ResponsesProvider implements ModelProvider {
  async complete(input: ModelRequest): Promise<ModelResult> {
    const response = await request(
      input.profile,
      endpoint(input.profile, '/responses'),
      responsesPayload(input),
      input.signal,
      {},
      input.retryTransientConnect,
    );
    let content = '',
      final: any;
    try {
      for await (const e of sse(response)) {
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type))
          final = e.response;
        assert(
          !['error', 'response.failed'].includes(e.type),
          'MODEL_INCOMPLETE',
          'Responses API did not complete; no tools executed.',
          502,
        );
        if (e.type === 'response.output_text.delta') {
          content += e.delta;
          input.onText(e.delta);
        }
        if (e.type.includes('reasoning')) input.onThinking?.();
        if (e.type === 'response.completed' || e.type === 'response.incomplete') final = e.response;
      }
      assert(
        final,
        'TRUNCATED_STREAM',
        'Responses stream disconnected before its final event.',
        502,
      );
      if (final?.incomplete_details?.reason === 'max_output_tokens')
        throw Object.assign(
          new LimitError(
            'MODEL_INCOMPLETE',
            'Model output reached its limit; incomplete tool calls were not executed.',
            502,
          ),
          { finishReason: 'length' },
        );
      assert(
        final?.status === 'completed',
        'MODEL_INCOMPLETE',
        'Responses API stream ended before completion.',
        502,
      );
      const native = final.output || [];
      assert(
        native.every((b: any) => ['reasoning', 'message', 'function_call'].includes(b.type)),
        'UNSUPPORTED_NATIVE_BLOCK',
        'Unsupported server tool output.',
        502,
      );
      const calls = validateCalls(
        native
          .filter((b: any) => b.type === 'function_call')
          .map((b: any) => ({
            id: b.call_id,
            name: b.name,
            arguments: parseArguments(b.arguments),
          })),
      );
      return {
        message: { role: 'assistant', content, native, ...(calls.length ? { calls } : {}) },
        usage: standardUsage(final.usage),
        responseId: final.id,
      };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { usage: standardUsage(final?.usage) });
      throw error;
    }
  }
}
