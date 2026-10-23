import { AppError as LimitError } from '../core/errors.js';
import { withToolImages } from './protocol.js';
import { randomUUID } from 'node:crypto';
import { assert } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelResult } from './protocol.js';
import { emptyUsage, reasoningFields, request, sse, validateCalls } from './protocol.js';
export function geminiPayload({ profile, messages, tools }: ModelRequest) {
  messages = withToolImages(messages);
  const names = new Map(
      messages.flatMap((m) => (m.calls || []).map((c) => [c.id, c.name] as const)),
    ),
    contents: any[] = [];
  for (const m of messages.filter((m) => m.role !== 'system')) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts: any[];
    if (m.role === 'tool')
      parts = [
        {
          functionResponse: {
            id: m.callId,
            name: names.get(m.callId!),
            response: { output: m.content },
          },
        },
      ];
    else if (m.native) parts = m.native;
    else {
      parts = m.content ? [{ text: m.content }] : [];
      for (const image of m.images || []) {
        const [header, data] = image.split(',');
        parts.push({ inlineData: { mimeType: header.slice(5).split(';')[0], data } });
      }
      for (const c of m.calls || [])
        parts.push({ functionCall: { id: c.id, name: c.name, args: c.arguments } });
    }
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  return {
    systemInstruction: {
      parts: [
        {
          text: messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n'),
        },
      ],
    },
    contents,
    generationConfig: { maxOutputTokens: profile.maxOutputTokens, ...reasoningFields(profile) },
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        }
      : {}),
  };
}
export class GeminiProvider implements ModelProvider {
  async complete(input: ModelRequest): Promise<ModelResult> {
    const p = input.profile;
    const url =
      p.baseUrl.replace(/\/$/, '') +
      '/models/' +
      encodeURIComponent(p.model) +
      ':streamGenerateContent?alt=sse';
    const response = await request(
      p,
      url,
      geminiPayload(input),
      input.signal,
      {
        'x-goog-api-key': p.apiKey,
      },
      input.retryTransientConnect,
    );
    let content = '',
      finish = '',
      usage = emptyUsage();
    const native: any[] = [];
    try {
      for await (const e of sse(response)) {
        assert(!e.error, 'MODEL_ERROR', 'Gemini reported an error.', 502);
        const c = e.candidates?.[0];
        if (c?.finishReason) finish = c.finishReason;
        for (const part of c?.content?.parts || []) {
          native.push(part);
          if (part.text && !part.thought) {
            content += part.text;
            input.onText(part.text);
          } else if (part.thought) input.onThinking?.();
        }
        if (e.usageMetadata) {
          const u = e.usageMetadata;
          usage = {
            input: u.promptTokenCount || 0,
            output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
            cached: u.cachedContentTokenCount || 0,
            reasoning: u.thoughtsTokenCount,
            measured: true,
          };
        }
      }
      assert(finish, 'TRUNCATED_STREAM', 'Gemini stream disconnected before its final event.', 502);
      if (finish === 'MAX_TOKENS')
        throw Object.assign(
          new LimitError(
            'MODEL_INCOMPLETE',
            'Model output reached its limit; incomplete tool calls were not executed.',
            502,
          ),
          { finishReason: 'length' },
        );
      assert(
        finish === 'STOP',
        'MODEL_INCOMPLETE',
        'Gemini response ended with ' + (finish || 'no finish reason') + '.',
        502,
      );
      const calls = validateCalls(
        native
          .filter((b) => b.functionCall)
          .map((b) => ({
            id: b.functionCall.id || randomUUID(),
            name: b.functionCall.name,
            arguments: b.functionCall.args || {},
          })),
      );
      let i = 0;
      for (const b of native) if (b.functionCall) b.functionCall.id = calls[i++].id;
      return {
        message: { role: 'assistant', content, native, ...(calls.length ? { calls } : {}) },
        usage,
      };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { usage });
      throw error;
    }
  }
}
