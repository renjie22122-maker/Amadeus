import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelPool } from '../server/core/pool.js';
import { AnthropicProvider, anthropicPayload } from '../server/providers/anthropic.js';
import { GeminiProvider, geminiPayload } from '../server/providers/gemini.js';
import { ChatProvider, chatPayload } from '../server/providers/openai-chat.js';
import { ResponsesProvider, responsesPayload } from '../server/providers/responses.js';
import { profileSchema } from '../server/services/settings.js';
const profile = profileSchema.parse({
  id: 'test',
  name: 'test',
  transport: 'openai-chat',
  baseUrl: 'https://example.com',
  model: 'test',
});
const input = () => ({
  profile,
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
  signal: new AbortController().signal,
  onText: (_text: string) => {},
});
const response = (events: any[]) =>
  new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
test('Chat preserves DeepSeek reasoning across tool results', () => {
  const body = chatPayload({
    ...input(),
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning: 'signature-like reasoning',
        calls: [{ id: 'a', name: 'read', arguments: { path: 'x' } }],
      },
      { role: 'tool', callId: 'a', content: 'data' },
    ],
  });
  assert.equal(body.messages[0].reasoning_content, 'signature-like reasoning');
  assert.equal(body.messages[1].tool_call_id, 'a');
});
test('Chat refuses incomplete tool-call streams', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'x', function: { name: 'write_file', arguments: '{"path":"x"' } },
              ],
            },
            finish_reason: 'length',
          },
        ],
      },
    ]),
  );
  await assert.rejects(
    new ChatProvider().complete(input()),
    (e: any) => e.code === 'MODEL_INCOMPLETE',
  );
});
test('Anthropic keeps thinking signatures and native tool IDs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      {
        type: 'message_start',
        message: {
          id: 'msg',
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reason' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' },
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]),
  );
  const r = await new AnthropicProvider().complete(input());
  assert.equal((r.message.native![0] as any).signature, 'sig');
  assert.equal(r.message.calls![0].id, 'tool-1');
  assert.equal(r.usage.input, 15);
  const next = anthropicPayload({
    ...input(),
    messages: [r.message, { role: 'tool', callId: 'tool-1', content: 'x' }],
  });
  assert.equal(next.messages[0].content[0].signature, 'sig');
  assert.equal(next.messages[1].content[0].tool_use_id, 'tool-1');
});
test('Responses preserves encrypted reasoning without provider-side storage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      { type: 'response.output_text.delta', delta: 'Done' },
      {
        type: 'response.completed',
        response: {
          id: 'r',
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'rs', encrypted_content: 'encrypted' },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done' }],
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      },
    ]),
  );
  const r = await new ResponsesProvider().complete(input());
  assert.equal(r.message.content, 'Done');
  const next = responsesPayload({ ...input(), messages: [r.message] });
  assert.equal(next.store, false);
  assert.equal(next.input[0].encrypted_content, 'encrypted');
});
test('Gemini preserves thought signatures and matches function response names', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'read_file', args: { path: 'x' } },
                  thoughtSignature: 'sig',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
      },
    ]),
  );
  const r = await new GeminiProvider().complete(input());
  assert.equal(r.usage.output, 12);
  const next = geminiPayload({
    ...input(),
    messages: [r.message, { role: 'tool', callId: r.message.calls![0].id, content: 'data' }],
  });
  assert.equal(next.contents[0].parts[0].thoughtSignature, 'sig');
  assert.equal(next.contents[1].parts[0].functionResponse.name, 'read_file');
});
test('HTTP authentication failures are explicit and never simulated', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private gateway details', { status: 401 }),
  );
  await assert.rejects(
    new ChatProvider().complete(input()),
    (e) => String(e).includes('401') && !String(e).includes('private gateway details'),
  );
});
test('ModelPool enforces actual model concurrency across resumed tasks', async () => {
  const pool = new ModelPool(() => 2);
  let active = 0,
    max = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      pool.run(new AbortController().signal, async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(max, 2);
});
test('ModelPool removes cancelled queued work', async () => {
  const pool = new ModelPool(() => 1);
  let release: () => void = () => {};
  const first = pool.run(
    new AbortController().signal,
    () => new Promise<void>((r) => (release = r)),
  );
  await new Promise((r) => setTimeout(r, 1));
  const controller = new AbortController();
  const second = pool.run(controller.signal, async () => {
    throw new Error('must not execute');
  });
  controller.abort();
  await assert.rejects(second, (e: any) => e.code === 'CANCELLED');
  release();
  await first;
});

test('truncated Chat response carries measured usage to the runtime', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      {
        choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 123, completion_tokens: 456 },
      },
    ]),
  );
  await assert.rejects(
    new ChatProvider().complete(input()),
    (error: any) =>
      error.code === 'MODEL_INCOMPLETE' && error.usage.input === 123 && error.usage.output === 456,
  );
});

test('all native adapters expose output-limit reason without executing partial calls', async (t) => {
  const cases: [any, any[]][] = [
    [
      new AnthropicProvider(),
      [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }],
    ],
    [
      new GeminiProvider(),
      [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }],
    ],
    [
      new ResponsesProvider(),
      [
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          },
        },
      ],
    ],
  ];
  for (const [provider, events] of cases) {
    t.mock.method(globalThis, 'fetch', async () => response(events));
    await assert.rejects(provider.complete(input()), (e: any) => e.finishReason === 'length');
    t.mock.restoreAll();
  }
});
test('HTTP retry is bounded to rejected requests, and errors redact credentials', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls < 3
      ? new Response('', { status: 503 })
      : response([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  });
  await new ChatProvider().complete(input());
  assert.equal(calls, 3);
  t.mock.restoreAll();
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: { message: 'bad token fixture-secret' } }), {
        status: 400,
      }),
  );
  await assert.rejects(
    new ChatProvider().complete({ ...input(), profile: { ...profile, apiKey: 'fixture-secret' } }),
    (e: any) => !e.message.includes('fixture-secret') && e.message.includes('[redacted]'),
  );
});

test('usage receipts merge split counters without accepting empty or invalid receipts', async () => {
  const { standardUsage } = await import('../server/providers/protocol.js');
  assert.equal(standardUsage({}).measured, false);
  assert.equal(standardUsage({ prompt_tokens: -1, completion_tokens: '8' }).measured, false);
  const partial = standardUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80 });
  assert.equal(partial.measured, false);
  const complete = standardUsage({ completion_tokens: 12 }, partial);
  assert.equal(complete.measured, true);
  assert.equal(complete.input, 100);
  assert.equal(complete.cached, 80);
  assert.deepEqual(standardUsage({}, complete), complete);
  assert.equal(standardUsage({ prompt_tokens: 0, completion_tokens: 0 }).measured, true);
});

test('chat retains split terminal usage after finish and empty trailing receipts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response([
      { id: 'receipt', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80 } },
      { choices: [], usage: { completion_tokens: 12 } },
      { choices: [], usage: {} },
    ]),
  );
  const result = await new ChatProvider().complete(input());
  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 12);
  assert.equal(result.usage.cached, 80);
  assert.equal(result.usage.measured, true);
});
