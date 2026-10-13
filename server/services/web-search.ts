import { filterSearch, type SourcePolicy } from './source-policy.js';
import type { Settings, Profile, Usage } from '../../shared/types.js';
import { assert } from '../core/errors.js';
export function searchProfile(settings: Settings): Profile | undefined {
  const id = settings.web?.searchProfileId;
  return id
    ? settings.profiles.find((p) => p.id === id)
    : settings.profiles.find((p) => new URL(p.baseUrl).hostname === 'api.deepseek.com');
}
export function parseSearch(payload: any, limit: number) {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const results = blocks.filter((b: any) => b.type === 'web_search_tool_result');
  assert(
    results.length,
    'SEARCH_NOT_EXECUTED',
    'Provider did not return native search evidence. No generated links are substituted.',
  );
  const sources: { url: string; title: string; snippet: string }[] = [];
  for (const block of results) {
    assert(
      Array.isArray(block.content),
      'SEARCH_PROVIDER_ERROR',
      'Search provider reported an error or unsupported result.',
    );
    for (const item of block.content) {
      if (item.type !== 'web_search_result' || typeof item.url !== 'string') continue;
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        continue;
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        sources.some((x) => x.url === url.href)
      )
        continue;
      const citation = blocks
        .flatMap((b: any) => (Array.isArray(b.citations) ? b.citations : []))
        .find((c: any) => c.url === item.url);
      sources.push({
        url: url.href,
        title: String(item.title || '').slice(0, 500),
        snippet: String(citation?.cited_text || '').slice(0, 1500),
      });
    }
  }
  return {
    summary: blocks
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('\n')
      .slice(0, 12000),
    sources: sources.slice(0, limit),
    truncated: sources.length > limit,
  };
}
export async function searchWeb(
  query: string,
  limit: number,
  settings: Settings,
  signal: AbortSignal,
  account: (usage: Usage, profile: Profile) => void,
  sourcePolicy?: SourcePolicy,
) {
  assert(settings.web?.enabled !== false, 'WEB_DISABLED', 'Web tools are disabled in Settings.');
  const profile = searchProfile(settings);
  assert(
    profile?.apiKey,
    'SEARCH_NOT_CONFIGURED',
    'Select a DeepSeek search connection in Settings > Web access.',
  );
  const base = settings.web?.searchBaseUrl || 'https://api.deepseek.com/anthropic/v1';
  const url = new URL(base);
  assert(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'SEARCH_ENDPOINT',
    'Search endpoint must be HTTPS without credentials, query or fragment.',
  );
  // Never silently send an existing provider key to an unrelated host.
  assert(
    url.origin === new URL(profile.baseUrl).origin,
    'SEARCH_CREDENTIAL_SCOPE',
    'Search endpoint must share the selected connection origin. Add a connection for this endpoint instead.',
  );
  const model = settings.web?.searchModel || profile.model;
  const billed = {
    ...profile,
    model,
    prices: model === profile.model ? profile.prices : { input: null, output: null, cached: null },
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(settings.web?.timeoutMs || 60000)]);
  let dispatched = false;
  let usage: Usage = { input: 0, output: 0, cached: 0, measured: false };
  try {
    deadline.throwIfAborted();
    dispatched = true;
    const response = await fetch(base.replace(/\/$/, '') + '/messages', {
      method: 'POST',
      redirect: 'error',
      signal: deadline,
      headers: {
        'content-type': 'application/json',
        'x-api-key': profile.apiKey,
        authorization: 'Bearer ' + profile.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Search the web for: ' + query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });
    assert(
      response.ok,
      'SEARCH_HTTP',
      'Search provider returned HTTP ' +
        response.status +
        '. Check the search endpoint, credentials and supported model; no automatic retry.',
    );
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2000000) {
        await reader.cancel();
        throw new Error('Search response exceeds 2 MB');
      }
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')),
      u = payload.usage;
    if (u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens))
      usage = {
        input:
          u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens,
        cached: u.cache_read_input_tokens || 0,
        measured: true,
      };
    const filtered = filterSearch(parseSearch(payload, sourcePolicy ? 10000 : limit), sourcePolicy);
    return {
      ...filtered,
      sources: filtered.sources.slice(0, limit),
      truncated: filtered.truncated || filtered.sources.length > limit,
      provider: 'deepseek-messages',
      model,
      usage,
      retrievedAt: new Date().toISOString(),
    };
  } finally {
    if (dispatched) account(usage, billed);
  }
}
