let csrf = '';
const stateResponses = new Map<string, { etag: string; value: unknown }>();
export function streamReadAloud(
  conversationId: string,
  serviceId: string,
  text: string,
  signal: AbortSignal,
) {
  return fetch('/api/conversations/' + encodeURIComponent(conversationId) + '/read-aloud', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ serviceId, text }),
    signal,
  });
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const stateKey =
    body === undefined && (!method || method === 'GET') && /^\/state\?view=(shell|full)$/.test(path)
      ? path
      : undefined;
  const cached = stateKey ? stateResponses.get(stateKey) : undefined;
  const headers = { ...(cached ? { 'If-None-Match': cached.etag } : {}), ...extraHeaders };
  const response = await fetch('/api' + path, {
    signal:
      body instanceof FormData && path.startsWith('/upload?')
        ? signal
        : AbortSignal.any([
            AbortSignal.timeout(
              path === '/media/local-voice/preview' ? 170000 : body === undefined ? 20000 : 120000,
            ),
            ...(signal ? [signal] : []),
          ]),
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers:
      body === undefined || body instanceof FormData
        ? { 'X-CSRF-Token': csrf, ...headers }
        : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (response.status === 304 && cached) return cached.value as T;
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  const etag = response.headers.get('etag');
  if (stateKey && etag) stateResponses.set(stateKey, { etag, value });
  return value;
}
let bootstrapping: Promise<any> | undefined;
export function bootstrap() {
  if (!bootstrapping) {
    bootstrapping = api('/bootstrap')
      .then((value) => {
        if (csrf !== value.csrf) stateResponses.clear();
        csrf = value.csrf;
        return value;
      })
      .finally(() => {
        bootstrapping = undefined;
      });
  }
  return bootstrapping;
}
