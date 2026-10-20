import { randomUUID } from 'node:crypto';
/** Correlate local sidecar deadlines without logging prompts, URLs or credentials. */
export async function ragFetch(
  url: string,
  init: RequestInit,
  caller?: AbortSignal,
  budgetMs = 60000,
) {
  caller?.throwIfAborted();
  const requestId = randomUUID();
  const started = performance.now();
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  const headers = new Headers(init.headers);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  if (local) {
    headers.set('X-Amadeus-Request-Id', requestId);
    headers.set('X-Amadeus-Timeout-Ms', String(budgetMs));
  }
  try {
    return await fetch(url, { ...init, headers, signal });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'retrieval.request.failed',
        requestId,
        elapsedMs: Math.round(performance.now() - started),
        budgetMs,
        cause: caller?.aborted
          ? 'caller_cancelled'
          : deadline.aborted
            ? 'client_deadline'
            : 'transport_failure',
        local,
      }),
    );
    if (!caller?.aborted && deadline.aborted)
      throw new Error(
        `[RETRIEVAL_TIMEOUT] Retrieval service did not return headers within ${budgetMs / 1000}s (request ${requestId}). Inspect local request stages; no automatic retry was started.`,
      );
    throw error;
  }
}
