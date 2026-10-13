import { AppError } from '../core/errors.js';
export type FailurePhase = 'connect' | 'stream' | 'request';
const networkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const tlsCodes = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
// Keep only allowlisted codes. Error messages/URLs can contain credentials or prompts.
export function transportFailure(error: unknown): {
  code?: string;
  kind: 'network' | 'tls' | 'unknown';
} {
  if ((error as { name?: string })?.name === 'AbortError') return { kind: 'unknown' };
  const seen = new Set<unknown>();
  const queue = [error];
  let fetchFailure = false;
  while (queue.length && seen.size < 12) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const e = value as {
      code?: string;
      name?: string;
      message?: string;
      cause?: unknown;
      errors?: unknown[];
    };
    if (tlsCodes.has(e.code || '')) return { kind: 'tls', code: e.code };
    if (networkCodes.has(e.code || '')) return { kind: 'network', code: e.code };
    fetchFailure ||=
      e.name === 'TypeError' && ['fetch failed', 'terminated'].includes(e.message || '');
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, 6));
  }
  return { kind: fetchFailure ? 'network' : 'unknown' };
}
export function normalizeProviderFailure(error: unknown, phase: FailurePhase): unknown {
  if (error instanceof AppError) return error;
  const t = transportFailure(error);
  if (t.kind === 'unknown') return error;
  const normalized = new AppError(
    t.kind === 'tls' ? 'MODEL_TLS' : 'MODEL_NETWORK',
    t.kind === 'tls'
      ? 'Model TLS validation failed. Check the endpoint and certificate configuration.'
      : `Model transport failed during ${phase}${t.code ? ' (' + t.code + ')' : ''}. No tool calls from this incomplete response were executed.`,
    502,
  );
  return Object.assign(normalized, { transportCode: t.code, phase });
}
export function providerFailureDiagnostic(error: unknown, phase: FailurePhase = 'request') {
  const normalized = normalizeProviderFailure(error, phase);
  const e = normalized as {
    code?: string;
    phase?: FailurePhase;
    transportCode?: string;
    name?: string;
  };
  const code =
    e?.code && /^MODEL_[A-Z0-9_]+$/.test(e.code)
      ? e.code
      : e?.name === 'AbortError'
        ? 'CANCELLED'
        : 'UNCLASSIFIED_ERROR';
  const category =
    code === 'MODEL_NETWORK'
      ? 'network'
      : code === 'MODEL_TLS'
        ? 'tls'
        : code === 'MODEL_TIMEOUT' || code === 'MODEL_STREAM_IDLE'
          ? 'timeout'
          : code.startsWith('MODEL_HTTP_')
            ? 'http'
            : code === 'CANCELLED'
              ? 'cancelled'
              : 'protocol-or-internal';
  return {
    code,
    category,
    phase: e?.phase || phase,
    transportCode: e?.transportCode,
    retryable: ['network', 'timeout'].includes(category),
  };
}
