import { providerFailureDiagnostic } from '../../server/providers/failure.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Configuration } from '../../server/services/settings.js';
import { Store } from '../../server/storage/store.js';
import { Runtime } from '../../server/core/runtime.js';
import { terminal } from '../../server/core/lifecycle.js';
import { providerFor } from '../../server/providers/registry.js';
import type { ModelProvider } from '../../server/providers/protocol.js';
import type { ModelMessage, Run } from '../../shared/types.js';
const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const profile = {
  ...new Configuration(job.settings).profile(job.profileId),
  maxOutputTokens: Number(job.maxOutputTokens) || 4096,
  timeoutMs: Number(job.timeoutMs) || 180000,
};
if (
  job.expectedModel &&
  (profile.model !== job.expectedModel || profile.baseUrl !== job.expectedEndpoint)
)
  throw Error('EVAL_PROFILE_CHANGED');

const dir = resolve(job.directory);
await mkdir(dir, { recursive: true });
const started = Date.now();
let captured: any;
const save = (name: string, value: any) =>
  writeFile(join(dir, name), JSON.stringify(value, null, 2));
async function complete(messages: ModelMessage[], tools: any[], signal: AbortSignal) {
  await save('request.json', { messages, tools });
  const at = Date.now();
  try {
    const r = await providerFor(profile).complete({
      profile,
      messages,
      tools,
      signal,
      onText: () => {},
    });
    captured = { ...r, elapsedMs: Date.now() - started, modelMs: Date.now() - at };
  } catch (e: any) {
    captured = {
      error: e.code || e.name || 'provider_error',
      failure: providerFailureDiagnostic(e),
      usage: e.usage,
      finishReason: e.finishReason,
      elapsedMs: Date.now() - started,
    };
  }
  await save('result.json', captured);
}
if (job.arm === 'smolagents') {
  await save('case.json', job.case);
  const p = spawnSync(
    job.python,
    ['evals/bfcl/smol-request.py', join(dir, 'case.json'), join(dir, 'native-request.json')],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (p.status !== 0) throw Error(p.stderr || 'smolagents prompt construction failed');
  const req = JSON.parse(await readFile(join(dir, 'native-request.json'), 'utf8'));
  const messages = req.messages.map((m: any) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((x: any) => x.text || '').join('\n'),
  }));
  const final = req.nativeTools.find((t: any) => t.function.name === 'final_answer').function;
  await complete(
    messages,
    [...job.case.tools, { ...final, effect: 'read' }],
    AbortSignal.timeout(profile.timeoutMs + 5000),
  );
} else {
  const config = new Configuration(join(dir, 'config.json'), { persistSecrets: false });
  config.save({
    ...config.get(),
    profiles: [profile],
    defaultProfileId: profile.id,
    maxAgentDepth: 0,
    maxChildren: 1,
    maxParallelRuns: 1,
  });
  const store = new Store(join(dir, 'runtime.sqlite'));
  let run: Run;
  const wrapper: ModelProvider = {
    complete: async (req) => {
      if (captured) throw Error('Only one decision is permitted');
      await complete(req.messages, job.case.tools, req.signal);
      runtime.stop(run.id);
      // Captured calls are graded but never dispatched. This is a first-decision probe.
      return {
        message: { role: 'assistant', content: 'Evaluation capture complete.' },
        usage: captured.usage || { input: 0, output: 0, cached: 0, measured: false },
      };
    },
  };
  const runtime = new Runtime(store, config, dir, () => wrapper);
  runtime.registry.specs = () => job.case.tools;
  runtime.registry.modelSpecs = () => job.case.tools;
  const now = Date.now();
  store.put('conversation', {
    id: 'chat',
    title: job.case.id,
    projectId: null,
    profileId: profile.id,
    reasoning: profile.reasoning,
    permission: 'ask',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    parentId: null,
    forkEvent: null,
    skillIds: [],
    knowledge: false,
    memory: false,
    generateMemory: false,
    automaticMemory: false,
    teamStrategy: 'off',
  });
  run = runtime.start('chat', job.case.question[0].map((m: any) => m.content).join('\n'), 2);
  const timer = setTimeout(() => runtime.stop(run.id), profile.timeoutMs + 30000);
  try {
    while (!terminal(store.get<Run>('run', run.id).status))
      await new Promise((r) => setTimeout(r, 100));
    await runtime.shutdown();
    if (!captured)
      await save('result.json', {
        error: 'runtime_no_model_response',
        elapsedMs: Date.now() - started,
      });
  } finally {
    clearTimeout(timer);
    store.close();
  }
}
