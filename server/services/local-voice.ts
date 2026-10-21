import { mediaCapabilityTarget } from '../../shared/media-capabilities.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MediaConnection } from '../../shared/media.js';
import type { Configuration } from './settings.js';
import { assert } from '../core/errors.js';

export function localVoiceConfig(root: string) {
  const path = join(root, 'voice-service/config.json');
  assert(existsSync(path), 'LOCAL_VOICE_SETUP', 'Run Setup-Local-Voice.cmd first.');
  const local = z
    .object({
      token: z.string().min(32),
      listenPort: z.number().int().min(1).max(65535).default(8812),
    })
    .parse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  return { ...local, baseUrl: `http://127.0.0.1:${local.listenPort}/v1` };
}
export function localVoiceConnections(root: string): MediaConnection[] {
  const local = localVoiceConfig(root);
  const connections = [
    {
      id: 'amadeus-local-sensevoice',
      name: 'Local SenseVoice · 中英转写',
      protocol: 'openai-transcription',
      kind: 'transcription',
      model: 'sensevoice',
    },
    {
      id: 'amadeus-local-whisper',
      name: 'Local Whisper · 时间戳转写',
      protocol: 'openai-transcription',
      kind: 'transcription',
      model: 'whisper',
    },
    {
      id: 'amadeus-local-cosyvoice',
      name: 'Local CosyVoice · 中英语音',
      protocol: 'openai-speech',
      kind: 'speech',
      model: 'cosyvoice',
    },
  ].map((c) => ({
    ...c,
    baseUrl: local.baseUrl,
    apiKey: local.token,
    enabled: true,
    defaults:
      c.kind === 'speech' ? { voice: 'default', response_format: 'wav', read_aloud_units: 20 } : {},
    estimatedUsd: 0,
  })) as MediaConnection[];
  for (const c of connections)
    if (c.kind === 'speech')
      c.capabilities = {
        readAloud: { protocol: 'wav-ndjson-v1', target: mediaCapabilityTarget(c) },
      };
    else if (c.model === 'whisper')
      c.capabilities = {
        transcriptionPreview: { protocol: 'audio-snapshot-v1', target: mediaCapabilityTarget(c) },
      };
  return connections;
}

export function configureLocalVoice(config: Configuration, root: string) {
  const connections = localVoiceConnections(root);
  const settings = config.get();
  const media = settings.media || { connections: [], transcriptionId: '', autoApproveMaxUsd: null };
  media.connections = [
    ...media.connections.filter((old) => !connections.some((c) => c.id === old.id)),
    ...connections.map((c) => {
      const old = media.connections.find((existing) => existing.id === c.id);
      return old ? { ...c, enabled: old.enabled, defaults: { ...c.defaults, ...old.defaults } } : c;
    }),
  ];
  // Preserve an existing microphone choice. Adding local speech must not silently replace it.
  media.transcriptionId ||= connections[0].id;
  settings.media = media;
  config.save(settings);
  return config.public();
}

// Expose only runtime telemetry, never local paths, voice text or service credentials.
export async function localVoiceStatus(root: string) {
  try {
    const local = localVoiceConfig(root);
    const response = await fetch(new URL('/health', local.baseUrl), {
      headers: { Authorization: `Bearer ${local.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Unavailable');
    const data = z
      .object({
        state: z.object({
          busy: z.boolean(),
          device: z.enum(['cuda', 'cpu']).nullable(),
          reason: z.string().nullable(),
        }),
        devicePolicy: z.enum(['auto', 'cuda', 'cpu']),
      })
      .parse(await response.json());
    return {
      available: true,
      busy: data.state.busy,
      device: data.state.busy ? data.state.device : null,
      reason: data.state.busy ? (data.state.reason?.slice(0, 300) ?? null) : null,
      policy: data.devicePolicy,
    };
  } catch {
    return { available: false, busy: false, device: null, reason: null, policy: null };
  }
}
