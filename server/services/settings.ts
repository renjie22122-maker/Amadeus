import { migrateLegacyVoice } from '../../shared/media-capabilities.js';
import {
  protectSettings,
  restoreSettings,
  windowsSecrets,
  type SecretCodec,
} from './credential-storage.js';
import { mediaProtocols } from '../../shared/media.js';
import { writePrivate } from './private-file.js';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Profile, Settings } from '../../shared/types.js';
import { assert } from '../core/errors.js';
const reasoning = z.enum(['auto', 'none', 'low', 'medium', 'high', 'max']);
const price = z.number().nonnegative().nullable();
export const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  transport: z.enum(['openai-chat', 'anthropic', 'openai-responses', 'gemini']),
  baseUrl: z.url(),
  apiKey: z.string().default(''),
  model: z.string().min(1),
  reasoning: reasoning.default('auto'),
  reasoningFormat: z.enum(['none', 'openai', 'deepseek', 'anthropic', 'gemini']).default('none'),
  efforts: z.array(reasoning).default(['auto']),
  contextWindow: z.number().int().min(4096).max(10_000_000).default(65536),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).default(8192),
  timeoutMs: z.number().int().min(1000).max(1800000).default(120000),
  vision: z.boolean().default(false),
  prices: z
    .object({ input: price, output: price, cached: price })
    .default({ input: null, output: null, cached: null }),
});
const schema = z.object({
  specialists: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(80),
        instructions: z.string().max(6000),
        skillIds: z.array(z.string()).max(100),
        allowedTools: z.array(z.string().min(1).max(100)).min(1).max(200),
      }),
    )
    .max(30)
    .default([]),
  actionRules: z
    .array(
      z.object({
        id: z.string().min(1),
        enabled: z.boolean(),
        tool: z.string().min(1).max(100),
        decision: z.enum(['deny', 'ask']),
        projectId: z.string().optional(),
        pathGlob: z.string().max(300).optional(),
        commandEquals: z.string().max(20000).optional(),
        backend: z.enum(['approval-host', 'docker', 'native-windows']).optional(),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(100)
    .default([]),
  hooks: z
    .array(
      z
        .object({
          id: z.string(),
          enabled: z.boolean(),
          stage: z.enum([
            'beforeTool',
            'afterTool',
            'beforeCommand',
            'afterCommand',
            'beforeCompaction',
            'afterCompaction',
            'beforeTaskComplete',
            'afterTaskComplete',
            'beforeMemoryWrite',
            'afterMemoryWrite',
          ]),
          tool: z.string().min(1).max(100),
          action: z.enum(['deny', 'notify', 'command']),
          command: z.string().min(1).max(8000).optional(),
          timeoutSeconds: z.number().int().min(1).max(300).optional(),
          message: z.string().min(1).max(2000),
          projectId: z.string().optional(),
        })
        .refine(
          (h) => h.action !== 'deny' || h.stage.startsWith('before'),
          'Deny hooks must run before the tool.',
        )
        .refine(
          (h) =>
            h.action !== 'command' ||
            (!!h.command &&
              ['beforeTool', 'afterTool', 'beforeCommand', 'afterCommand'].includes(h.stage)),
          'Command hooks require a command and a tool/command lifecycle stage.',
        ),
    )
    .max(64)
    .default([]),

  agentName: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\u0000-\u001f\u007f]+$/)
    .default('Amadeus'),
  autoReview: z
    .object({
      profileId: z.string().default(''),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000),
    })
    .default({ profileId: '', timeoutMs: 30000 }),
  media: z
    .object({
      connections: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1).max(100),
            protocol: z.enum(mediaProtocols.map((p) => p.id) as [any, ...any[]]),
            kind: z.enum(['image', 'video', 'music', 'speech', 'transcription', 'model3d']),
            baseUrl: z.url(),
            apiKey: z.string().default(''),
            model: z.string().min(1),
            enabled: z.boolean().default(false),
            defaults: z.record(z.string(), z.unknown()).default({}),
            estimatedUsd: z.number().nonnegative().nullable().default(null),
            capabilities: z
              .object({
                readAloud: z
                  .object({ protocol: z.literal('wav-ndjson-v1'), target: z.string().max(4000) })
                  .optional(),
                references: z
                  .object({
                    target: z.string().max(4000),
                    maxPerField: z.number().int().min(1).max(64).optional(),
                    maxTotal: z.number().int().min(1).max(64).optional(),
                    arrayFields: z
                      .array(z.string().regex(/^[a-zA-Z][\w]*$/))
                      .max(64)
                      .optional(),
                  })
                  .optional(),
              })
              .optional(),
          }),
        )
        .default([]),
      transcriptionId: z.string().default(''),
      autoApproveMaxUsd: z.number().nonnegative().nullable().default(null),
    })
    .default({ connections: [], transcriptionId: '', autoApproveMaxUsd: null }),

  web: z
    .object({
      enabled: z.boolean().default(true),
      searchProfileId: z.string().default(''),
      searchBaseUrl: z.url().default('https://api.deepseek.com/anthropic/v1'),
      searchModel: z.string().default(''),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    })
    .default({
      enabled: true,
      searchProfileId: '',
      searchBaseUrl: 'https://api.deepseek.com/anthropic/v1',
      searchModel: '',
      timeoutMs: 60000,
    }),

  profiles: z.array(profileSchema),
  defaultProfileId: z.string(),
  maxParallelRuns: z.number().int().min(0).max(12).default(3),
  maxAgentDepth: z.number().int().min(0).max(5).default(2),
  maxChildren: z.number().int().min(0).max(32).default(8),
  compactionRatio: z.number().min(0.3).max(0.9).default(0.75),
  dockerImage: z.string().default('node:24-bookworm-slim'),
  commandBackend: z
    .enum(['approval-host', 'docker', 'native-windows'])
    .default(process.platform === 'win32' ? 'native-windows' : 'docker'),
  dockerUser: z
    .string()
    .regex(/^\d+(?::\d+)?$/)
    .default('1000:1000'),
  approveFileWrites: z.boolean().default(false),
  nativePython: z.string().default(''),
  nativeNetwork: z.enum(['deny', 'host']).default('deny'),
  retrieval: z
    .object({
      graph: z.boolean().default(true),
      vectors: z
        .object({
          enabled: z.boolean().default(false),
          baseUrl: z.string().default(''),
          apiKey: z.string().default(''),
          authorizedTarget: z.string().optional(),
          backend: z.enum(['faiss', 'milvus', 'qdrant']),
          index: z.enum(['flat', 'hnsw', 'ivf-flat', 'ivf-pq']),
        })
        .optional(),
      rerank: z
        .object({
          enabled: z.boolean().default(false),
          baseUrl: z.string().default(''),
          apiKey: z.string().default(''),
          authorizedTarget: z.string().optional(),
          model: z.string().min(1),
          candidates: z.number().int().min(1).max(60).default(40),
          minScore: z.number().finite().optional(),
        })
        .optional(),
      lightRag: z
        .object({
          enabled: z.boolean().default(false),
          baseUrl: z.string().default(''),
          apiKey: z.string().default(''),
          authorizedTarget: z.string().optional(),
          scope: z.string().min(1),
          embeddingModel: z.string().optional(),
          mode: z.enum(['local', 'global', 'hybrid', 'mix']).default('mix'),
        })
        .optional(),
    })
    .optional(),
  embedding: z
    .object({
      baseUrl: z.string(),
      apiKey: z.string(),
      model: z.string(),
      backend: z.enum(['remote', 'local']).optional(),
    })
    .default({ baseUrl: '', apiKey: '', model: '' }),
  mcp: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        command: z.string(),
        capability: z.enum(['general', 'browser', 'computer']).optional(),
        builtin: z.enum(['browser', 'computer']).optional(),
        browser: z
          .object({
            allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).max(100),
            persistSession: z.boolean(),
          })
          .optional(),
        args: z.array(z.string()),
        enabled: z.boolean(),
      }),
    )
    .default([]),
});
export class Configuration {
  private value: Settings;
  constructor(
    private path: string,
    private options: { persistSecrets?: boolean; secretCodec?: SecretCodec } = {},
  ) {
    this.value = existsSync(path)
      ? schema.parse({
          commandBackend: 'approval-host',
          ...restoreSettings(JSON.parse(readFileSync(path, 'utf8')), this.codec()),
        })
      : schema.parse({ profiles: [], defaultProfileId: '' });
    for (const c of this.value.media?.connections || []) migrateLegacyVoice(c);
    // Upgrade only the former default brand; retain user-selected identities.
    if (this.value.agentName === 'AgentDemo') this.value.agentName = 'Amadeus';
  }
  private codec() {
    return this.options.secretCodec || (process.platform === 'win32' ? windowsSecrets : undefined);
  }
  get(): Settings {
    return structuredClone(this.value);
  }
  profile(key?: string): Profile {
    const p = this.value.profiles.find((p) => p.id === (key || this.value.defaultProfileId));
    assert(
      p,
      'MODEL_NOT_CONFIGURED',
      'Add a model connection in Settings before starting a task.',
      409,
    );
    return structuredClone(p);
  }
  public() {
    return {
      ...this.get(),
      media: {
        ...this.value.media,
        connections: (this.value.media?.connections || []).map(({ apiKey, ...p }) => ({
          ...p,
          hasKey: !!apiKey,
        })),
      },
      profiles: this.value.profiles.map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey })),
      retrieval: this.value.retrieval && {
        ...this.value.retrieval,
        ...Object.fromEntries(
          ['vectors', 'rerank', 'lightRag'].map((k) => {
            const c = (this.value.retrieval as any)[k];
            return [k, c && { ...c, apiKey: undefined, hasKey: !!c.apiKey }];
          }),
        ),
      },
      embedding: {
        ...this.value.embedding,
        apiKey: undefined,
        hasKey: !!this.value.embedding.apiKey,
      },
    };
  }
  save(input: unknown) {
    const raw = input as any;
    for (const k of ['vectors', 'rerank', 'lightRag']) {
      const c = raw.retrieval?.[k],
        old = (this.value.retrieval as any)?.[k];
      if (c && c.apiKey === undefined)
        c.apiKey = old?.baseUrl === c.baseUrl ? old.apiKey || '' : '';
    }
    for (const p of raw.profiles || [])
      if (p.apiKey === undefined) {
        const old = this.value.profiles.find((x) => x.id === p.id);
        p.apiKey =
          old && new URL(old.baseUrl).origin === new URL(p.baseUrl).origin ? old.apiKey : '';
      }
    if (raw.embedding && raw.embedding.apiKey === undefined)
      raw.embedding.apiKey =
        raw.embedding.baseUrl === this.value.embedding.baseUrl ? this.value.embedding.apiKey : '';
    for (const p of raw.media?.connections || [])
      if (p.apiKey === undefined) {
        const old = this.value.media?.connections.find((x) => x.id === p.id);
        p.apiKey =
          old &&
          old.protocol === p.protocol &&
          new URL(old.baseUrl).origin === new URL(p.baseUrl).origin
            ? old.apiKey
            : '';
      }
    const next = schema.parse(raw);
    assert(
      new Set(next.media.connections.map((p) => p.id)).size === next.media.connections.length,
      'DUPLICATE_MEDIA',
      'Media connection IDs must be unique.',
    );
    for (const p of next.media.connections) {
      const u = new URL(p.baseUrl);
      assert(
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash,
        'MEDIA_ENDPOINT',
        'Media services require HTTPS or literal loopback HTTP, without credentials, query or fragment.',
      );
      const preset = mediaProtocols.find((x) => x.id === p.protocol)!;
      assert(
        ['fal', 'replicate'].includes(p.protocol) || preset.kind === p.kind,
        'MEDIA_KIND',
        'Protocol does not support this media type.',
      );
    }
    assert(
      next.commandBackend !== 'native-windows' ||
        !next.nativePython ||
        (isAbsolute(next.nativePython || '') && existsSync(next.nativePython!)),
      'NATIVE_CONFIGURATION',
      'AppContainer requires an existing absolute Python interpreter path. Configure Native Python interpreter before saving.',
    );

    assert(
      new Set(next.profiles.map((p) => p.id)).size === next.profiles.length,
      'DUPLICATE_PROFILE',
      'Connection IDs must be unique.',
    );
    for (const p of next.profiles) {
      const u = new URL(p.baseUrl);
      assert(
        !u.username && !u.password && !u.search && !u.hash,
        'INVALID_ENDPOINT',
        'Model endpoint must not contain credentials, query or fragment.',
      );
      assert(
        u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)),
        'INVALID_ENDPOINT',
        'Use HTTPS, or a local HTTP model endpoint.',
      );
      assert(
        p.efforts.includes(p.reasoning),
        'UNSUPPORTED_REASONING',
        'Default reasoning must be in the supported effort list.',
      );
    }
    assert(
      !next.profiles.length || next.profiles.some((p) => p.id === next.defaultProfileId),
      'DEFAULT_MODEL',
      'Select an existing default connection.',
    );
    mkdirSync(dirname(this.path), { recursive: true });
    const persisted = structuredClone(next);
    if (
      this.options.persistSecrets === false ||
      this.path.replaceAll('\\', '/').split('/').includes('.diagnostics')
    ) {
      for (const p of persisted.profiles) p.apiKey = '';
      persisted.embedding.apiKey = '';
      for (const k of ['vectors', 'rerank', 'lightRag'])
        if ((persisted.retrieval as any)?.[k]) (persisted.retrieval as any)[k].apiKey = '';
      for (const p of persisted.media?.connections || []) p.apiKey = '';
    }
    const codec = this.codec();
    const protectedValue = codec ? protectSettings(persisted, codec) : persisted;
    writePrivate(this.path + '.tmp', JSON.stringify(protectedValue, null, 2));
    renameSync(this.path + '.tmp', this.path);
    this.value = next;
    return this.public();
  }
}
