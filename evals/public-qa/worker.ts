import { prepareExecutionLayout } from '../../server/services/execution-layout.js';
import { providerFailureDiagnostic } from '../../server/providers/failure.js';
import { extractIsolated } from '../../server/services/document-parser.js';
import { sourceAllowed, checkSourceText } from '../../server/services/source-policy.js';
import { execute } from '../../server/services/process.js';
import { pythonCommand } from '../../server/tools/work-chains.js';
import {
  checkResponse,
  responseContractSchema,
  type ResponseContract,
} from '../../server/core/response-contract.js';
import { sharedCatalog, sharedSpecs } from './shared-catalog.js';
import { evaluationSources } from './evidence-policy.js';
import {
  researchProgress,
  type ResearchProgress,
} from '../../server/services/research-progress.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { extract } from '../../server/services/documents.js';
import { normalizeImage } from '../../server/services/images.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { Configuration } from '../../server/services/settings.js';
import { Store } from '../../server/storage/store.js';
import { Runtime } from '../../server/core/runtime.js';
import { terminal } from '../../server/core/lifecycle.js';
import { providerFor } from '../../server/providers/registry.js';
import { searchWeb } from '../../server/services/web-search.js';
import { fetchPublic } from '../../server/services/network.js';
import type { Run } from '../../shared/types.js';
const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const original = new Configuration(job.settings);
const profile = {
  ...original.profile(job.profileId),
  maxOutputTokens: Number(job.maxOutputTokens) || 4096,
  timeoutMs: 120000,
};
if (
  job.expectedModel &&
  (profile.model !== job.expectedModel || profile.baseUrl !== job.expectedEndpoint)
)
  throw Error('EVAL_PROFILE_CHANGED');

const settings = {
  ...new Configuration(join(job.directory, 'config.json'), { persistSecrets: false }).get(),
  profiles: [profile],
  defaultProfileId: profile.id,
  web: original.get().web,
  ...(job.protocol === 'native-evidence-v1'
    ? { commandBackend: 'docker' as const, dockerImage: job.analysisImage, dockerUser: '1000:1000' }
    : {}),
  maxAgentDepth: 0,
  maxChildren: 1,
  maxParallelRuns: 1,
};
const dir = resolve(job.directory);
await mkdir(dir, { recursive: true });
const started = Date.now(),
  controller = new AbortController();
const maxSteps = Number(job.maxSteps) || (job.kind === 'swe' ? 30 : 8);
let deadlineExpired = false;
const timer = setTimeout(
  () => {
    deadlineExpired = true;
    controller.abort();
  },
  job.kind === 'swe' ? 1200000 : 600000,
);
const requests: any[] = [],
  tools: any[] = [],
  auxiliary: any[] = [];
let answer = '',
  error: string | undefined;
const clean = job.protocol === 'shared-evidence-v2';
const native = job.protocol === 'native-evidence-v1';
const prepared = clean || native;
let contract: ResponseContract = {
  format: 'single-line',
  prefix: '',
  userRequirement: 'Return only the requested value on one line.',
};
let progress: ResearchProgress | undefined;
const { workspace, state: runtimeState, files } = await prepareExecutionLayout(dir);
if (prepared) {
  if (!job.analysisImage) throw Error('ANALYSIS_IMAGE_REQUIRED');
  await mkdir(workspace, { recursive: true });
  for (const a of job.attachments || []) {
    if (a.name !== a.name.split(/[\\/]/).at(-1)) throw Error('ATTACHMENT_NAME');
    const data = await readFile(a.path);
    if (createHash('sha256').update(data).digest('hex') !== a.sha256)
      throw Error('ATTACHMENT_CHANGED');
    await writeFile(join(workspace, a.name), data, { flag: 'wx' });
    await files.resolve(a.name); // Exercise the same private-storage boundary before model calls.
  }
}

const allowed = new Set(
  native
    ? [
        'web_search',
        'fetch_url',
        'read_web_evidence',
        'read_file',
        'list_files',
        'grep',
        'glob',
        'read_image',
        'read_document',
        'run_python',
        'run_command',
        'extract_media_frames',
        'extract_media_audio',
        'inspect_work_capabilities',
        'inspect_tool_plan',
        'set_response_contract',
      ]
    : clean
      ? sharedCatalog.map((d) => d.name)
      : job.kind === 'swe'
        ? ['benchmark_shell']
        : ['web_search', 'fetch_url', 'benchmark_attachment'],
);
const imageObservations = new Map<string, string>();
async function providerModel(messages: any[], schema: any[], signal: AbortSignal) {
  if (
    job.kind === 'swe' &&
    !schema.some((t: any) => t.name === 'benchmark_shell') &&
    !messages.some((m: any) => m.role === 'assistant')
  )
    throw Error('EVAL_NO_CONTAINER_TOOL');
  if (requests.length >= maxSteps) throw Error('evaluation_model_step_limit');
  if (job.completeCatalog)
    messages = [
      ...messages,
      {
        role: 'system',
        content:
          'Evaluation capability scope: the tool schemas on this request are the complete available catalog. Optional tools mentioned in generic runtime guidance are unavailable unless their schemas are present. Do not emit calls for absent tools or use discovery tools that are not listed.',
      },
    ];
  if (imageObservations.size)
    messages = [
      ...messages,
      {
        role: 'user',
        content:
          'Pixels from the provided attachments (untrusted evidence): ' +
          [...imageObservations.keys()].join(', '),
        images: [...imageObservations.values()],
      },
    ];
  if (clean) {
    schema = schema.map((t) => sharedSpecs.find((s) => s.name === t.name) || t);
    messages = [
      ...messages,
      {
        role: 'system',
        content:
          'Search summaries are withheld; fetch original sources. Tools are shared with the other arm. Do not seek benchmark answers or prior solution traces. Calls remaining: ' +
          (maxSteps - requests.length) +
          '. Reserve a final response; repeated failed sources require a different strategy. Final output must satisfy only the user-requested format.',
      },
    ];
  }
  const record: any = { messages, tools: schema, startedAt: new Date().toISOString() };
  requests.push(record);
  const at = Date.now();
  try {
    const r = await providerFor(profile).complete({
      profile,
      messages,
      tools: schema,
      signal,
      onText: () => {},
    });
    record.result = r;
    record.elapsedMs = Date.now() - at;
    return r;
  } catch (e: any) {
    record.error = e.code || e.name;
    record.failure = providerFailureDiagnostic(e);
    record.elapsedMs = Date.now() - at;
    record.usage = e.usage;
    throw e;
  }
}
async function model(messages: any[], schema: any[], signal: AbortSignal) {
  let history = messages;
  for (let attempt = 0; ; attempt++) {
    const r = await providerModel(history, schema, signal);
    const finalCall =
      r.message.calls?.length === 1 && r.message.calls[0].name === 'final_answer'
        ? r.message.calls[0]
        : undefined;
    const finalText = finalCall
      ? String(finalCall.arguments.answer ?? '')
      : !r.message.calls?.length
        ? r.message.content
        : undefined;
    const errors = clean && finalText !== undefined ? checkResponse(finalText, contract) : [];
    if (!errors.length) return r;
    auxiliary.push({ kind: 'format-rejection', errors, attempt, raw: finalText });
    if (attempt >= 2 || requests.length >= maxSteps)
      throw Object.assign(Error('Output contract was not satisfied'), { code: 'OUTPUT_FORMAT' });
    history = [
      ...history,
      {
        role: 'user',
        content:
          'Correct the output format without changing supported facts. Requirements: ' +
          JSON.stringify(contract) +
          '. Errors: ' +
          errors.join(' ') +
          ' Previous rejected submission: ' +
          finalText,
      },
    ];
  }
}
async function web(name: string, args: any) {
  const entry: any = { name, args };
  tools.push(entry);
  try {
    if (!allowed.has(name)) throw Error('EVAL_TOOL_NOT_ALLOWED');
    if (clean) {
      const def = sharedCatalog.find((d) => d.name === name)!;
      args = def.schema.strict().parse(args);
      if (name === 'declare_output_contract') {
        contract = responseContractSchema.parse(args);
        entry.result = { contract, semanticVerification: false };
        return JSON.stringify(entry.result);
      }
      if (name === 'calculate') {
        entry.result = await execute(
          pythonCommand(args.code),
          workspace,
          controller.signal,
          30000,
          {
            ...settings,
            commandBackend: 'docker',
            dockerImage: job.analysisImage,
            dockerUser: '1000:1000',
          },
        );
        return JSON.stringify(entry.result);
      }
      if (name === 'inspect_remote_document') {
        const r = await fetchPublic(
          args.url,
          controller.signal,
          0,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          'document',
          evaluationSources,
        );
        if (r.status !== 200 || !r.imageBytes || r.truncated) throw Error('DOCUMENT_UNAVAILABLE');
        const filename =
          'download-' + createHash('sha256').update(r.imageBytes).digest('hex') + '.pdf';
        const staging = join(dir, filename);
        await writeFile(staging, r.imageBytes);
        const text = await extractIsolated(staging, 30000, controller.signal);
        checkSourceText(text, evaluationSources);
        await files.writeBytes(filename, r.imageBytes);
        const offset = args.offset || 0;
        entry.result = {
          url: r.url,
          name: filename,
          text: text.slice(offset, offset + 24000),
          offset,
          totalCharacters: text.length,
          nextOffset: offset + 24000 < text.length ? offset + 24000 : null,
        };
        return JSON.stringify(entry.result);
      }
      if (name === 'inspect_remote_image') {
        const r = await fetchPublic(
          args.url,
          controller.signal,
          0,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          true,
          evaluationSources,
        );
        if (r.status !== 200 || !r.imageBytes || r.truncated) throw Error('IMAGE_UNAVAILABLE');
        const image = await normalizeImage(r.imageBytes);
        imageObservations.set(r.url, image.url);
        entry.result = { url: r.url, pixelsProvided: true, metadata: image.metadata };
        return JSON.stringify(entry.result);
      }
      name =
        (
          {
            research_search: 'web_search',
            research_fetch: 'fetch_url',
            inspect_attachment: 'benchmark_attachment',
          } as Record<string, string>
        )[name] || name;
    }
    if (name === 'benchmark_attachment') {
      const attachment = (job.attachments || []).find((a: any) => a.name === args.name);
      if (!attachment && !clean) throw Error('Attachment not provided to this task');
      const attachmentPath = clean ? await files.resolve(args.name) : attachment.path;
      const attachmentName = attachment?.name || args.name;
      const data = clean
        ? await files.readBytes(args.name, 25 * 1024 * 1024)
        : await readFile(attachmentPath);
      if (attachment && createHash('sha256').update(data).digest('hex') !== attachment.sha256)
        throw Error('Attachment changed');
      const ext = extname(attachmentName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        const normalized = await normalizeImage(
          data,
          clean && args.width !== undefined
            ? {
                left: args.left || 0,
                top: args.top || 0,
                width: args.width,
                height: args.height || args.width,
              }
            : undefined,
        );
        imageObservations.set(attachmentName, normalized.url);
        entry.result = {
          name: attachmentName,
          pixelsProvided: true,
          metadata: normalized.metadata,
        };
        return JSON.stringify(entry.result);
      }
      let text: string;
      if (['.zip', '.pptx'].includes(ext) || (ext === '.xlsx' && args.member)) {
        const parsed = await promisify(execFile)(
          job.python,
          [
            '-X',
            'utf8',
            'evals/full-suite/read-archive.py',
            attachmentPath,
            String(args.member || ''),
          ],
          { timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
        );
        text = parsed.stdout;
      } else if (['.jsonld', '.pdb'].includes(ext)) text = data.toString('utf8');
      else if (['.mp3', '.wav', '.mp4'].includes(ext)) {
        entry.result = {
          unavailable:
            'Audio/video decoder or transcription service not configured in this shared evaluation adapter',
          name: attachmentName,
        };
        return JSON.stringify(entry.result);
      } else
        text = clean
          ? await extractIsolated(attachmentPath, 30000, controller.signal)
          : await extract(attachmentPath);
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      entry.result = {
        name: attachmentName,
        offset,
        totalCharacters: text.length,
        text: text.slice(offset, offset + 24000),
        nextOffset: offset + 24000 < text.length ? offset + 24000 : null,
      };
      return JSON.stringify(entry.result);
    }
    if (name === 'benchmark_shell') {
      if (!/^amadeus-eval-[a-z0-9-]+$/.test(job.container))
        throw Error('Invalid evaluation container');
      try {
        const r = await promisify(execFile)(
          'docker',
          [
            'exec',
            job.container,
            'bash',
            '-lc',
            'source /opt/miniconda3/bin/activate testbed && cd /testbed && ' + String(args.command),
          ],
          { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        );
        entry.result = { code: 0, output: r.stdout + r.stderr };
      } catch (e: any) {
        entry.result = { code: e.code, output: String(e.stdout || '') + String(e.stderr || '') };
        if (e.killed) {
          await promisify(execFile)('docker', ['stop', '-t', '1', job.container], {
            timeout: 15000,
            windowsHide: true,
          });
          throw Error('Command timeout; isolated container stopped');
        }
      }
      return JSON.stringify(entry.result).slice(0, 20000);
    }
    const r =
      name === 'web_search'
        ? await searchWeb(
            String(args.query),
            Math.min(12, Math.max(1, Number(args.limit) || 6)),
            settings,
            controller.signal,
            (usage, p) => auxiliary.push({ usage, model: p.model }),
            clean ? evaluationSources : undefined,
          )
        : await fetchPublic(
            String(args.url),
            controller.signal,
            0,
            AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
            false,
            clean ? evaluationSources : undefined,
          );
    if (clean) {
      progress = researchProgress(
        progress,
        'sources' in r ? r.sources : { url: r.url, text: r.text, status: r.status },
      );
      entry.result = { ...r, researchProgress: progress };
    } else entry.result = r;
    return JSON.stringify(entry.result);
  } catch (e: any) {
    entry.error = e.code || e.name;
    return JSON.stringify({
      ok: false,
      error: entry.error,
      message: String(e.message).slice(0, 300),
      next: 'Change method or report the missing evidence. An error is not a source observation.',
    });
  }
}
try {
  if (job.arm === 'smolagents' || job.arm === 'smolagents-code') {
    await new Promise<void>((done) => {
      const container =
        'amadeus-native-' + createHash('sha256').update(dir).digest('hex').slice(0, 20);
      const child = native
        ? spawn(
            'docker',
            [
              'run',
              '--rm',
              '--pull=never',
              '--name',
              container,
              '--network=none',
              '--user',
              '1000:1000',
              '--cap-drop=ALL',
              '--security-opt=no-new-privileges',
              '--pids-limit=128',
              '--memory=1g',
              '--cpus=2',
              '--read-only',
              '--tmpfs',
              '/tmp:rw,noexec,nosuid,size=128m',
              '--env',
              'HOME=/tmp',
              '--mount',
              'type=bind,source=' + workspace + ',target=/workspace',
              '--mount',
              'type=bind,source=' +
                resolve('evals/public-qa/native-smol.py') +
                ',target=/runner.py,readonly',
              '--workdir',
              '/workspace',
              '-i',
              job.analysisImage,
              'python3',
              '-u',
              '/runner.py',
            ],
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
          )
        : spawn(job.python, ['evals/public-qa/smol-loop.py'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      child.stdin.write(
        JSON.stringify({
          prompt: job.prompt,
          arm: job.arm,
          kind: job.kind,
          maxSteps,
          catalog: clean ? sharedSpecs : undefined,
        }) + '\n',
      );
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 2000)));
      const abort = () => {
        if (native) {
          const stop = spawn('docker', ['rm', '-f', container], {
            stdio: 'ignore',
            windowsHide: true,
          });
          stop.unref();
        }
        child.kill();
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      createInterface({ input: child.stdout }).on('line', async (line) => {
        let item: any;
        try {
          item = JSON.parse(line);
        } catch {
          return;
        }
        try {
          if (item.kind === 'final') {
            answer = item.answer;
            return;
          }
          if (item.kind === 'failed') {
            error = item.error;
            auxiliary.push({ kind: 'native-failure', exceptionTypes: item.exceptionTypes });
            return;
          }
          let result: any;
          if (native && item.kind === 'native_search') {
            if (typeof item.query !== 'string' || item.query.length > 2000)
              throw Error('SEARCH_QUERY');
            const entries = await new Promise<any[]>((resolve, reject) => {
              const worker = spawn(job.python, ['evals/public-qa/native-search.py'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
              });
              let out = '';
              const timer = setTimeout(() => {
                worker.kill();
                reject(Error('Native search timeout'));
              }, 30000);
              worker.stdout.on('data', (b) => {
                out += b;
                if (out.length > 2_000_000) {
                  worker.kill();
                  reject(Error('Native search output limit'));
                }
              });
              worker.stderr.on('data', () => {});
              worker.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
              });
              worker.on('close', (code) => {
                clearTimeout(timer);
                try {
                  if (code) throw Error('Native search failed');
                  resolve(JSON.parse(out));
                } catch (e) {
                  reject(e);
                }
              });
              worker.stdin.end(JSON.stringify({ query: item.query, limit: 6 }));
            });
            result = entries
              .filter((e) => sourceAllowed(e.href, evaluationSources))
              .map((e) => ({ href: e.href, title: '', body: '' }));
            tools.push({
              name: 'native_search',
              query: item.query,
              result,
              excludedCount: entries.length - result.length,
              sourcePolicy: evaluationSources.id,
            });
          } else if (native && item.kind === 'native_fetch') {
            const page = await fetchPublic(
              item.url,
              controller.signal,
              0,
              AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
              false,
              evaluationSources,
              true,
            );
            result = { text: page.rawText, status: page.status };
            tools.push({
              name: 'native_fetch',
              url: page.url,
              result,
              sourcePolicy: evaluationSources.id,
            });
          } else if (native && item.kind === 'native_image') {
            if (typeof item.data !== 'string' || item.data.length > 36_000_000)
              throw Error('IMAGE_LIMIT');
            const image = await normalizeImage(Buffer.from(item.data, 'base64'));
            imageObservations.set(item.name, image.url);
            result = { pixelsProvided: true, metadata: image.metadata };
            tools.push({ name: 'native_image', nameInWorkspace: item.name, result });
          } else if (item.kind === 'model') {
            const messages = item.request.messages.map((m: any) => ({
              role: m.role,
              content:
                typeof m.content === 'string'
                  ? m.content
                  : (m.content || []).map((x: any) => x.text || '').join('\n'),
              ...(m.tool_calls
                ? {
                    calls: m.tool_calls.map((t: any) => ({
                      id: t.id,
                      name: t.function.name,
                      arguments:
                        typeof t.function.arguments === 'string'
                          ? JSON.parse(t.function.arguments)
                          : t.function.arguments,
                    })),
                  }
                : {}),
              ...(m.tool_call_id ? { callId: m.tool_call_id } : {}),
            }));
            const native = (item.request.tools || []).map((t: any) => ({
              ...t.function,
              effect: allowed.has(t.function.name) ? 'network' : 'read',
            }));
            const r = await model(messages, native, controller.signal);
            result = {
              role: 'assistant',
              content: r.message.content,
              tool_calls: r.message.calls?.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            };
          } else result = await web(item.name, item.args);
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ result }) + '\n');
        } catch (e: any) {
          if (!child.stdin.destroyed)
            child.stdin.write(JSON.stringify({ error: e.code || e.message || e.name }) + '\n');
        }
      });
      child.on('error', (e) => {
        error = e.message;
        done();
      });
      child.on('close', () => {
        controller.signal.removeEventListener('abort', abort);
        if (!answer && !error)
          error = controller.signal.aborted ? 'CANCELLED' : 'smolagents_no_final';
        if (error) auxiliary.push({ kind: 'native-stderr', text: stderr.slice(-2000) });
        done();
      });
    });
  } else {
    const config = new Configuration(join(dir, 'config.json'), { persistSecrets: false });
    config.save(settings);
    const store = new Store(join(runtimeState, 'runtime.sqlite'));
    const runtime = new Runtime(store, config, runtimeState, () => ({
      complete: async (req) =>
        model(
          req.messages,
          req.tools.filter((t) => allowed.has(t.name)),
          req.signal,
        ),
    }));
    if (native) {
      const invoke = runtime.registry.invoke.bind(runtime.registry);
      runtime.registry.invoke = (name, args, context) =>
        invoke(name, args, {
          ...context,
          sourcePolicy: evaluationSources,
          accountWeb: (usage, profile) => {
            auxiliary.push({ kind: 'web-usage', usage, model: profile.model });
            context.accountWeb?.(usage, profile);
          },
        });
    }
    if (clean)
      for (const def of sharedCatalog)
        runtime.registry.add({
          ...def,
          effect: sharedSpecs.find((s) => s.name === def.name)!.effect,
          run: async (a: any) => ({ content: await web(def.name, a) }),
        });
    if (!prepared && job.kind !== 'swe')
      runtime.registry.add({
        name: 'benchmark_attachment',
        description:
          'Read a task-provided attachment by exact name. Images supply pixels, documents supply paginated text. ZIP lists entries; member reads one entry. Audio/video transcription is unavailable.',
        effect: 'read',
        schema: z.object({
          name: z.string(),
          offset: z.number().int().nonnegative().optional(),
          member: z.string().optional(),
        }),
        run: async (a) => ({ content: await web('benchmark_attachment', a) }),
      });
    if (job.kind === 'swe')
      runtime.registry.add({
        name: 'benchmark_shell',
        description:
          'Run a bash command inside the isolated benchmark container at /testbed. No host filesystem or network access. Use this for reading, editing and testing the repository.',
        effect: 'execute',
        schema: z.object({ command: z.string() }),
        run: async (a) => ({ content: await web('benchmark_shell', a) }),
      });
    const nativeSpecs = runtime.registry.specs.bind(runtime.registry);
    runtime.registry.specs = (ctx) => nativeSpecs(ctx).filter((t) => allowed.has(t.name));
    const now = Date.now();
    if (job.kind === 'swe' || prepared) {
      await mkdir(join(dir, 'workspace'), { recursive: true });
      store.put('project', {
        id: 'benchmark',
        name: 'Isolated container benchmark',
        folders: [join(dir, 'workspace')],
        createdAt: now,
      });
    }
    store.put('conversation', {
      id: 'chat',
      title: job.id,
      projectId: job.kind === 'swe' || prepared ? 'benchmark' : null,
      profileId: profile.id,
      reasoning: profile.reasoning,
      permission: job.kind === 'swe' || prepared ? 'trusted' : 'ask',
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
    const run = runtime.start('chat', job.prompt, maxSteps);
    const abort = () => runtime.stop(run.id);
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      while (!terminal(store.get<Run>('run', run.id).status))
        await new Promise((r) => setTimeout(r, 100));
      await runtime.shutdown();
      const events = store.events('chat');
      await writeFile(join(dir, 'events.json'), JSON.stringify(events, null, 2));
      tools.push(...events.filter((e) => e.type === 'tool.completed').map((e) => e.data));
      const final = store.get<Run>('run', run.id);
      answer =
        requests
          .map((r) => r.result?.message)
          .filter((m) => m && !m.calls?.length)
          .at(-1)?.content || '';
      if (final.status !== 'completed') error = final.termination?.code || final.status;
    } finally {
      controller.signal.removeEventListener('abort', abort);
      store.close();
    }
  }
} catch (e: any) {
  error = e.code || e.name;
} finally {
  clearTimeout(timer);
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        answer,
        error: deadlineExpired ? 'EVAL_DEADLINE' : error,
        providerFailure: error ? requests.at(-1)?.failure : undefined,
        deadlineExpired,
        protocol: job.protocol || 'legacy',
        analysisImage: job.analysisImage,
        sourcePolicy: prepared ? evaluationSources.id : null,
        elapsedMs: Date.now() - started,
        requests,
        tools,
        auxiliary,
      },
      null,
      2,
    ),
  );
}
