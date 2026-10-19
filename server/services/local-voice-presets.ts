import { localVoiceConfig } from './local-voice.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assert } from '../core/errors.js';
import type { Configuration } from './settings.js';
const execute = promisify(execFile);
// CosyVoice frontend._extract_speech_token explicitly rejects references >30s.
// Recommended duration and upload bytes are application guidance/safeguards, not model limits.
export const localVoiceCapabilities = Object.freeze({
  model: 'cosyvoice',
  maxReferenceSeconds: 30,
  minReferenceSeconds: 0,
  recommendedReferenceSeconds: 3,
  maxUploadBytes: 25 * 1024 * 1024,
  limitSource: 'cosyvoice/cli/frontend.py::_extract_speech_token',
  previewLanguages: ['zh', 'en', 'ja'],
});
const referenceLanguage = z.enum(['auto', 'zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'ru']);
export function inspectReferencePcm(bytes: Buffer) {
  const duration = bytes.length / 48000;
  assert(
    bytes.length % 2 === 0 &&
      duration > localVoiceCapabilities.minReferenceSeconds &&
      duration <= localVoiceCapabilities.maxReferenceSeconds,
    'VOICE_DURATION',
    'CosyVoice accepts non-empty audio up to 30 seconds. Select a matching excerpt and transcript; audio is not silently truncated.',
  );
  let squared = 0,
    clipped = 0,
    peak = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const value = Math.abs(bytes.readInt16LE(i)) / 32768;
    squared += value * value;
    peak = Math.max(peak, value);
    if (value >= 0.999) clipped++;
  }
  assert(peak > 0, 'VOICE_SILENT', 'Reference recording is silent. Choose audible speech.');
  const rmsDb = 10 * Math.log10(squared / (bytes.length / 2));
  const clippingRatio = clipped / (bytes.length / 2);
  const warnings: string[] = [];
  if (duration < localVoiceCapabilities.recommendedReferenceSeconds) warnings.push('short');
  if (rmsDb < -40) warnings.push('quiet');
  if (clippingRatio > 0.01) warnings.push('clipping');
  return { duration, rmsDb, clippingRatio, warnings };
}
const fields = z.object({
  name: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(1500),
  consent: z.literal('true'),
  language: referenceLanguage.default('auto'),
});
function local(root: string) {
  const path = join(root, 'voice-service/config.json');
  assert(existsSync(path), 'VOICE_SETUP', 'Run Setup-Local-Voice.cmd first.');
  return { path, data: JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) };
}
export function listLocalVoices(root: string) {
  return Object.entries(local(root).data.voices || {}).map(([id, raw]) => {
    const voice = raw as any;
    return {
      id,
      name: voice.name || (id === 'default' ? 'Default / 默认' : id),
      text: voice.text || '',
      language: voice.language || 'auto',
      quality: voice.quality || null,
    };
  });
}
export async function normalizeVoice(input: string, output: string) {
  // Bounded decode, no shell and no client-supplied paths or executable.
  await execute(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'wav,mp3,ogg,flac,mov,matroska,webm,aac,aiff',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-t',
      String(localVoiceCapabilities.maxReferenceSeconds + 1),
      '-f',
      's16le',
      output,
    ],
    { timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true },
  );
}
export async function saveLocalVoice(
  root: string,
  raw: unknown,
  audio: Buffer,
  normalize = normalizeVoice,
) {
  const input = fields.parse(raw);
  assert(
    audio.length > 0 && audio.length <= localVoiceCapabilities.maxUploadBytes,
    'VOICE_SIZE',
    'Reference recording must be 1 byte–25 MiB.',
  );
  local(root); // Require existing setup before writing anything.
  const voices = join(root, 'voice-service/voices');
  mkdirSync(voices, { recursive: true });
  const temporary = await mkdtemp(join(voices, '.upload-'));
  try {
    const source = join(temporary, 'input.audio'),
      pcm = join(temporary, 'output.pcm');
    await writeFile(source, audio);
    await normalize(source, pcm);
    const bytes = await readFile(pcm);
    const quality = inspectReferencePcm(bytes);
    const { duration } = quality;
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + bytes.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(bytes.length, 40);
    const id = randomUUID(),
      target = join(voices, id + '.wav');
    await writeFile(target, Buffer.concat([header, bytes]), { flag: 'wx' });
    // Read after decoding; preserve concurrent unrelated config changes.
    const { path, data } = local(root);
    data.voices = {
      ...data.voices,
      [id]: {
        name: input.name,
        audio: target,
        text: input.text,
        language: input.language,
        quality,
        source: 'user-upload',
      },
    };
    const pending = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(pending, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(pending, path);
    } catch (error) {
      await rm(target, { force: true });
      await rm(pending, { force: true });
      throw error;
    }
    return { id, name: input.name, text: input.text, language: input.language, duration, quality };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function useLocalVoice(config: Configuration, root: string, id: string) {
  assert(
    listLocalVoices(root).some((voice) => voice.id === id),
    'VOICE_NOT_FOUND',
    'Choose a configured voice.',
  );
  const settings = config.get();
  const connection = settings.media?.connections.find(
    (item) => item.id === 'amadeus-local-cosyvoice',
  );
  assert(connection, 'VOICE_CONNECTION', 'Add local voice connections first.');
  connection.defaults = { ...connection.defaults, voice: id };
  config.save(settings);
  return { id };
}
export async function previewLocalVoice(root: string, raw: unknown) {
  const { id, language } = z
    .object({ id: z.string().min(1), language: z.enum(['zh', 'en', 'ja']) })
    .parse(raw);
  assert(
    listLocalVoices(root).some((voice) => voice.id === id),
    'VOICE_NOT_FOUND',
    'Choose a configured voice.',
  );
  const data = localVoiceConfig(root);
  const response = await fetch(data.baseUrl + '/audio/speech', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(155000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.token },
    body: JSON.stringify({
      model: 'cosyvoice',
      input:
        language === 'zh'
          ? '你好，这是本地音色试听。'
          : language === 'ja'
            ? 'こんにちは。これは音声のテストです。'
            : 'Hello. This is a local voice preview.',
      voice: id,
      response_format: 'wav',
    }),
  });
  assert(
    response.ok,
    'VOICE_PREVIEW',
    `Local voice preview failed (${response.status}); check that the service is running and idle.`,
    503,
  );
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 4 * 1024 * 1024, 'VOICE_SIZE', 'Preview exceeds audio limit.');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { audio: Buffer.concat(parts).toString('base64'), mime: 'audio/wav' };
}
