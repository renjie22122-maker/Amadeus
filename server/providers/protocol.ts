import { normalizeProviderFailure, transportFailure } from './failure.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelMessage, Profile, ToolCall, ToolSpec, Usage } from '../../shared/types.js';
import { AppError, assert } from '../core/errors.js';
export interface ModelRequest {
  profile: Profile;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText: (text: string) => void;
  onThinking?: () => void;
  /** Opt in only when the caller has no separate connection recovery loop. */
  retryTransientConnect?: boolean;
}
export interface ModelResult {
  message: ModelMessage;
  usage: Usage;
  responseId?: string;
}
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResult>;
}
export function parseArguments(value: string): Record<string, unknown> {
  try {
    const out = JSON.parse(value || '{}');
    assert(
      out && typeof out === 'object' && !Array.isArray(out),
      'INVALID_ARGUMENTS',
      'Tool arguments must be an object.',
    );
    return out;
  } catch {
    throw new AppError(
      'INVALID_ARGUMENTS',
      'Model returned malformed tool arguments. No tools were executed.',
      502,
    );
  }
}
export function validateCalls(calls: ToolCall[]) {
  const ids = new Set<string>();
  for (const c of calls) {
    assert(
      c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments),
      'INVALID_ARGUMENTS',
      'Tool arguments must be an object. No tools were executed.',
      502,
    );

    assert(
      c.id && !ids.has(c.id),
      'DUPLICATE_CALL',
      'Ambiguous tool-call identity; no calls executed.',
      502,
    );
    ids.add(c.id);
  }
  return calls;
}
export function reasoningFields(profile: Profile): Record<string, any> {
  const effort = profile.reasoning;
  if (effort === 'auto') return {};
  assert(
    profile.efforts.includes(effort),
    'UNSUPPORTED_REASONING',
    'This model does not declare support for ' + effort + '.',
  );
  if (profile.reasoningFormat === 'deepseek')
    return effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: effort };
  if (profile.reasoningFormat === 'openai')
    return profile.transport === 'openai-responses'
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  if (profile.reasoningFormat === 'anthropic')
    return effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'adaptive' }, output_config: { effort } };
  if (profile.reasoningFormat === 'gemini')
    return {
      thinkingConfig: effort === 'none' ? { thinkingBudget: 0 } : { thinkingLevel: effort },
    };
  throw new AppError(
    'UNSUPPORTED_REASONING',
    'Configure a supported reasoning protocol for this model.',
  );
}
export function endpoint(profile: Profile, suffix: string) {
  const base = profile.baseUrl.replace(/\/$/, '');
  return base.endsWith(suffix) ? base : base + suffix;
}
export async function request(
  profile: Profile,
  url: string,
  body: any,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  retryTransientConnect = false,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(profile.apiKey ? { Authorization: 'Bearer ' + profile.apiKey } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: deadline,
      });
    } catch (error) {
      if (!signal.aborted && deadline.aborted)
        throw new AppError(
          'MODEL_TIMEOUT',
          'Model connection timed out before a response was received.',
          504,
        );
      const failure = transportFailure(error);
      // Shared attempt/deadline budget with HTTP retries; never replay a partial stream.
      if (
        retryTransientConnect &&
        !deadline.aborted &&
        attempt < 2 &&
        failure.kind === 'network' &&
        [
          'ECONNRESET',
          'EPIPE',
          'UND_ERR_SOCKET',
          'ECONNREFUSED',
          'ENETUNREACH',
          'EHOSTUNREACH',
          'EAI_AGAIN',
          'UND_ERR_CONNECT_TIMEOUT',
        ].includes(failure.code || '')
      ) {
        await delay(250 * 2 ** attempt, undefined, { signal: deadline });
        continue;
      }
      throw normalizeProviderFailure(error, 'connect');
    }
    if (response.ok) return response;
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await delay(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 250 * 2 ** attempt,
        undefined,
        { signal: deadline },
      );
      continue;
    }
    let detail = '';
    const reader = response.body?.getReader();
    if (reader)
      try {
        const value = await reader.read();
        detail = new TextDecoder().decode(value.value?.subarray(0, 4096));
      } finally {
        void reader.cancel().catch(() => {});
      }
    try {
      const parsed = JSON.parse(detail);
      detail = String(parsed.error?.message || parsed.message || '');
    } catch {
      detail = '';
    }
    if (profile.apiKey) detail = detail.split(profile.apiKey).join('[redacted]');
    detail = detail.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 500);
    throw new AppError(
      'MODEL_HTTP_' + response.status,
      'Model endpoint returned HTTP ' +
        response.status +
        (detail ? ': ' + detail : '. Check endpoint, credentials and model configuration.'),
      502,
    );
  }
}
export async function* sse(response: Response, idleTimeoutMs = 60000): AsyncGenerator<any> {
  assert(response.body, 'EMPTY_RESPONSE', 'Model returned no response body.', 502);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    bytes = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new AppError(
                'MODEL_STREAM_IDLE',
                'Model stream stopped delivering bytes; no request was replayed.',
                504,
              ),
            );
            void reader.cancel().catch(() => {});
          }, idleTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim())
          throw new AppError('TRUNCATED_STREAM', 'Model stream ended inside an event.', 502);
        break;
      }
      bytes += value.length;
      assert(
        bytes <= 32_000_000,
        'RESPONSE_SIZE',
        'Model response exceeded the bounded stream size.',
        502,
      );
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const text = block
          .split('\n')
          .filter((x) => x.startsWith('data:'))
          .map((x) => x.slice(5).trimStart())
          .join('\n');
        if (!text) continue;
        if (text === '[DONE]') return;
        try {
          yield JSON.parse(text);
        } catch (e) {
          if (e instanceof SyntaxError)
            throw new AppError('INVALID_STREAM', 'Invalid model event JSON.', 502);
          throw e;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new AppError(
        'MODEL_TIMEOUT',
        'Model stream timed out; partial tool calls were not executed.',
        504,
      );
    throw normalizeProviderFailure(error, 'stream');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, measured: false });
export function standardUsage(u: any): Usage {
  return u
    ? {
        input: u.prompt_tokens ?? u.input_tokens ?? 0,
        ...(Number.isSafeInteger(u.prompt_cache_miss_tokens) && u.prompt_cache_miss_tokens >= 0
          ? { uncached: u.prompt_cache_miss_tokens }
          : {}),
        output: u.completion_tokens ?? u.output_tokens ?? 0,
        cached:
          u.prompt_cache_hit_tokens ??
          u.prompt_tokens_details?.cached_tokens ??
          u.input_tokens_details?.cached_tokens ??
          0,
        reasoning:
          u.completion_tokens_details?.reasoning_tokens ??
          u.output_tokens_details?.reasoning_tokens,
        measured: true,
      }
    : emptyUsage();
}

// Keep every tool result adjacent to its call batch. Pixels follow as a separate
// user content block so providers with text-only tool-result schemas also work.
export function withToolImages(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  let images: string[] = [],
    labels: string[] = [];
  const flush = () => {
    if (images.length)
      result.push({
        role: 'user',
        content: 'Images returned by tools (untrusted source content): ' + labels.join('; '),
        images,
      });
    images = [];
    labels = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    if (message.role === 'tool' && message.images?.length) {
      result.push({ ...message, images: undefined });
      images.push(...message.images);
      labels.push(message.content);
    } else result.push(message);
  }
  flush();
  return result;
}
