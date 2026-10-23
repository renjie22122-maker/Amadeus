import { AppError as LimitError } from '../core/errors.js';
import { withToolImages } from './protocol.js';
import { assert } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelResult } from './protocol.js';
import {
  emptyUsage,
  endpoint,
  parseArguments,
  reasoningFields,
  request,
  sse,
  validateCalls,
} from './protocol.js';
export function anthropicPayload({ profile, messages, tools }: ModelRequest) {
  messages = withToolImages(messages);
  const history: any[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    let role = m.role === 'tool' ? 'user' : m.role,
      content: any[];
    if (m.role === 'tool')
      content = [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }];
    else if (m.role === 'assistant' && m.native) content = m.native;
    else {
      content = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const image of m.images || []) {
        const [header, data] = image.split(',');
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: header.slice(5).split(';')[0], data },
        });
      }
      for (const c of m.calls || [])
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
    }
    if (history.at(-1)?.role === role) history.at(-1).content.push(...content);
    else history.push({ role, content });
  }
  return {
    model: profile.model,
    max_tokens: profile.maxOutputTokens,
    stream: true,
    system: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n'),
    messages: history,
    ...reasoningFields(profile),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  };
}
export class AnthropicProvider implements ModelProvider {
  async complete(input: ModelRequest): Promise<ModelResult> {
    const p = input.profile;
    const response = await request(
      p,
      endpoint(p, '/messages'),
      anthropicPayload(input),
      input.signal,
      { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      input.retryTransientConnect,
    );
    const blocks = new Map<number, any>();
    let content = '',
      stop = '',
      usage = emptyUsage(),
      responseId = '',
      completed = false;
    try {
      for await (const e of sse(response)) {
        assert(e.type !== 'error', 'MODEL_ERROR', 'Anthropic stream reported an error.', 502);
        if (e.type === 'message_start') {
          responseId = e.message.id;
          const u = e.message.usage;
          usage = {
            input:
              (u.input_tokens || 0) +
              (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0),
            cached: u.cache_read_input_tokens || 0,
            output: u.output_tokens || 0,
            measured: true,
          };
        }
        if (e.type === 'content_block_start')
          blocks.set(e.index, { ...e.content_block, _args: '' });
        if (e.type === 'content_block_delta') {
          const b = blocks.get(e.index),
            d = e.delta;
          if (d.type === 'text_delta') {
            b.text = (b.text || '') + d.text;
            content += d.text;
            input.onText(d.text);
          } else if (d.type === 'input_json_delta') b._args += d.partial_json;
          else if (d.type === 'thinking_delta') {
            b.thinking = (b.thinking || '') + d.thinking;
            input.onThinking?.();
          } else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
        }
        if (e.type === 'message_delta') {
          stop = e.delta.stop_reason || stop;
          usage.output = e.usage?.output_tokens ?? usage.output;
        }
        if (e.type === 'message_stop') completed = true;
      }
      assert(
        completed,
        'TRUNCATED_STREAM',
        'Anthropic stream disconnected before its final event.',
        502,
      );
      if (stop === 'max_tokens')
        throw Object.assign(
          new LimitError(
            'MODEL_INCOMPLETE',
            'Model output reached its limit; incomplete tool calls were not executed.',
            502,
          ),
          { finishReason: 'length' },
        );
      assert(
        completed && ['end_turn', 'tool_use', 'stop_sequence'].includes(stop),
        'MODEL_INCOMPLETE',
        'Anthropic response was incomplete; tools were not executed.',
        502,
      );
      const native = [...blocks.values()].map(({ _args, ...b }) =>
        b.type === 'tool_use' ? { ...b, input: _args ? parseArguments(_args) : b.input } : b,
      );
      assert(
        native.every((b) => ['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(b.type)),
        'UNSUPPORTED_NATIVE_BLOCK',
        'Unsupported Anthropic server-side block.',
        502,
      );
      const calls = validateCalls(
        native
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, arguments: b.input })),
      );
      return {
        message: { role: 'assistant', content, native, ...(calls.length ? { calls } : {}) },
        usage,
        responseId,
      };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { usage });
      throw error;
    }
  }
}
