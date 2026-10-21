import type { MediaConnection } from './media.js';

export const mediaReferenceBudget = {
  count: 64,
  bytes: 100 * 1024 * 1024,
  perFileBytes: 25 * 1024 * 1024,
};
export function mediaCapabilityTarget(
  c: Pick<MediaConnection, 'baseUrl' | 'model' | 'protocol' | 'kind'>,
) {
  return JSON.stringify([c.baseUrl.replace(/\/$/, ''), c.model, c.protocol, c.kind]);
}
export function supportsReadAloud(c: MediaConnection) {
  return (
    c.kind === 'speech' &&
    c.protocol === 'openai-speech' &&
    c.capabilities?.readAloud?.protocol === 'wav-ndjson-v1' &&
    c.capabilities.readAloud.target === mediaCapabilityTarget(c)
  );
}
export function speechStreamEndpoints(c: MediaConnection) {
  if (!supportsReadAloud(c))
    throw Error('Native streaming capability is missing or its target changed.');
  const base = new URL(c.baseUrl);
  if (
    !(
      base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))
    ) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error(
      'Speech streaming requires HTTPS or literal loopback HTTP with no credentials, query or fragment.',
    );
  const root = base.href.replace(/\/$/, '');
  return { speech: root + '/audio/speech', health: root.replace(/\/v1$/, '') + '/health' };
}
// Compatibility migration only: never infer a custom service's stream protocol from its name.
export function migrateLegacyVoice(c: MediaConnection) {
  if (
    !c.capabilities &&
    c.id === 'amadeus-local-cosyvoice' &&
    c.model === 'cosyvoice' &&
    c.protocol === 'openai-speech' &&
    c.kind === 'speech' &&
    c.baseUrl.replace(/\/$/, '') === 'http://127.0.0.1:8812/v1'
  )
    c.capabilities = { readAloud: { protocol: 'wav-ndjson-v1', target: mediaCapabilityTarget(c) } };
}

export function supportsTranscriptionPreview(c: MediaConnection) {
  return (
    c.kind === 'transcription' &&
    c.protocol === 'openai-transcription' &&
    c.capabilities?.transcriptionPreview?.protocol === 'audio-snapshot-v1' &&
    c.capabilities.transcriptionPreview.target === mediaCapabilityTarget(c)
  );
}
