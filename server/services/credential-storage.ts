import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Settings } from '../../shared/types.js';
export interface SecretCodec {
  seal(value: string): string;
  open(value: string): string;
}
const transform = (value: string, decrypt: boolean) => {
  const script = `Add-Type -AssemblyName System.Security
 $inputText=[Console]::In.ReadToEnd()
 $data=${decrypt ? '[Convert]::FromBase64String($inputText)' : '[Text.Encoding]::UTF8.GetBytes($inputText)'}
 $result=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::Out.Write(${decrypt ? '[Text.Encoding]::UTF8.GetString($result)' : '[Convert]::ToBase64String($result)'})`;
  try {
    return execFileSync(
      join(
        process.env.SystemRoot || 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: value,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    throw Error(
      'Windows credential protection failed. Settings were not saved; no plaintext fallback. Use the original Windows account to open protected settings.',
    );
  }
};
export const windowsSecrets: SecretCodec = {
  seal: (v) => transform(v, false),
  open: (v) => transform(v, true),
};
export function protectSettings(value: Settings, codec: SecretCodec) {
  const output = structuredClone(value);
  const secret = {
    profiles: output.profiles.map((p) => ({ id: p.id, key: p.apiKey })),
    embedding: output.embedding.apiKey,
    retrieval: Object.fromEntries(
      ['vectors', 'rerank', 'lightRag'].map((k) => [
        k,
        (output.retrieval as any)?.[k]?.apiKey || '',
      ]),
    ),
    media: (output.media?.connections || []).map((p) => ({ id: p.id, key: p.apiKey })),
  };
  if (
    !secret.profiles.some((p) => p.key) &&
    !secret.embedding &&
    !Object.values(secret.retrieval).some(Boolean) &&
    !secret.media.some((p) => p.key)
  )
    return output;
  const credentialEnvelope = {
    version: 1,
    provider: 'windows-dpapi',
    ciphertext: codec.seal(JSON.stringify(secret)),
  };
  for (const p of output.profiles) p.apiKey = '';
  output.embedding.apiKey = '';
  for (const k of ['vectors', 'rerank', 'lightRag'])
    if ((output.retrieval as any)?.[k]) (output.retrieval as any)[k].apiKey = '';
  for (const p of output.media?.connections || []) p.apiKey = '';
  return { ...output, credentialEnvelope };
}
export function restoreSettings(raw: any, codec?: SecretCodec) {
  if (!raw.credentialEnvelope) return raw;
  if (
    raw.credentialEnvelope.version !== 1 ||
    raw.credentialEnvelope.provider !== 'windows-dpapi' ||
    !codec
  )
    throw Error('Protected credentials require the original Windows user account.');
  const secret = JSON.parse(codec.open(raw.credentialEnvelope.ciphertext));
  const result = structuredClone(raw);
  delete result.credentialEnvelope;
  for (const p of result.profiles || [])
    p.apiKey = secret.profiles.find((s: any) => s.id === p.id)?.key || '';
  result.embedding.apiKey = secret.embedding || '';
  for (const k of ['vectors', 'rerank', 'lightRag'])
    if (result.retrieval?.[k]) result.retrieval[k].apiKey = secret.retrieval?.[k] || '';
  for (const p of result.media?.connections || [])
    p.apiKey = secret.media.find((s: any) => s.id === p.id)?.key || '';
  return result;
}
