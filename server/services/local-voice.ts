import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MediaConnection } from '../../shared/media.js';
import type { Configuration } from './settings.js';
import { assert } from '../core/errors.js';

export function localVoiceConnections(root: string): MediaConnection[] {
  const path = join(root, 'voice-service/config.json');
  assert(existsSync(path), 'LOCAL_VOICE_SETUP', 'Run Setup-Local-Voice.cmd first.');
  const local = z
    .object({ token: z.string().min(32) })
    .parse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  return [
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
    baseUrl: 'http://127.0.0.1:8812/v1',
    apiKey: local.token,
    enabled: true,
    defaults:
      c.kind === 'speech' ? { voice: 'default', response_format: 'wav', read_aloud_units: 20 } : {},
    estimatedUsd: 0,
  })) as MediaConnection[];
}

export function configureLocalVoice(config: Configuration, root: string) {
  const connections = localVoiceConnections(root);
  const settings = config.get();
  const media = settings.media || { connections: [], transcriptionId: '', autoApproveMaxUsd: null };
  media.connections = [
    ...media.connections.filter((old) => !connections.some((c) => c.id === old.id)),
    ...connections,
  ];
  // Preserve an existing microphone choice. Adding local speech must not silently replace it.
  media.transcriptionId ||= connections[0].id;
  settings.media = media;
  config.save(settings);
  return config.public();
}
