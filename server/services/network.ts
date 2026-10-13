import { checkSource, checkSourceText, sourceAllowed, type SourcePolicy } from './source-policy.js';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { assert } from '../core/errors.js';
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Conservative IPv6 policy: public global unicast only; rejects mapped IPv4, loopback and ULA.
  return (
    isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip) && !ip.toLowerCase().startsWith('2001:db8:')
  );
}
export async function fetchPublic(
  input: string,
  signal: AbortSignal,
  redirects = 0,
  deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  binaryImage: boolean | 'media' | 'document' = false,
  sourcePolicy?: SourcePolicy,
  rawBody = false,
): Promise<{
  url: string;
  text: string;
  status: number;
  truncated: boolean;
  contentType: string;
  links: { url: string; text: string }[];
  imageBytes?: Buffer;
  rawText?: string;
}> {
  signal = deadline;
  signal.throwIfAborted();
  assert(redirects < 5, 'REDIRECT_LIMIT', 'Too many redirects');
  checkSource(input, sourcePolicy);
  const url = new URL(input);
  assert(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'URL_DENIED',
    'Only public HTTP(S) URLs are allowed.',
  );
  assert(
    !url.port || ['80', '443'].includes(url.port),
    'URL_DENIED',
    'Nonstandard network ports are not enabled.',
  );
  const addresses = (await new Promise<Awaited<ReturnType<typeof lookup>> | any[]>(
    (resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancel));
    },
  )) as { address: string; family: number }[];
  assert(
    addresses.length > 0 && addresses.every((a) => publicAddress(a.address)),
    'URL_DENIED',
    'Private, loopback and link-local networks are not accessible through web tools.',
  );
  const chosen = addresses[0];
  const result = await new Promise<{
    status: number;
    location?: string;
    text: string;
    contentType: string;
    truncated: boolean;
    imageBytes?: Buffer;
  }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        signal,
        timeout: 30000,
        headers: {
          'User-Agent': 'Amadeus/0.1',
          Accept: binaryImage
            ? 'image/png,image/jpeg,image/webp,image/gif'
            : 'text/html,text/plain,application/json',
        },
        lookup: (_host, options, cb: any) =>
          options?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({
            status,
            location: response.headers.location,
            text: '',
            contentType: '',
            truncated: false,
          });
          return;
        }
        const contentType = String(response.headers['content-type'] || 'text/plain');
        if (
          !(binaryImage
            ? binaryImage === 'document'
              ? /^application\/pdf(;|$)/i.test(contentType)
              : binaryImage === 'media'
                ? /^(image\/(png|jpeg|webp|gif)|audio\/|video\/|model\/|application\/(octet-stream|zip)|text\/plain)/i.test(
                    contentType,
                  )
                : /^image\/(png|jpeg|webp|gif)(;|$)/i.test(contentType)
            : /text\/|json|xml|javascript/i.test(contentType))
        ) {
          response.destroy();
          reject(
            new Error(
              'Unsupported page type: ' +
                contentType +
                '. Use read_image for PNG/JPEG/WebP/GIF, or import other binary documents.',
            ),
          );
          return;
        }
        let size = 0;
        let finished = false;
        const finish = (truncated: boolean) => {
          if (finished) return;
          finished = true;
          const charset = contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
          let text: string;
          try {
            text = binaryImage ? '' : new TextDecoder(charset).decode(Buffer.concat(chunks));
          } catch {
            text = Buffer.concat(chunks).toString('utf8');
          }
          resolve({
            status,
            text,
            contentType,
            truncated,
            ...(binaryImage ? { imageBytes: Buffer.concat(chunks) } : {}),
          });
        };
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          const maxBytes =
            binaryImage === 'media' ? 150 * 1024 * 1024 : binaryImage ? 25 * 1024 * 1024 : 2000000;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
            finish(true);
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(false));
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Network request timed out')));
    request.on('error', reject);
  });
  if (result.location)
    return fetchPublic(
      new URL(result.location, url).href,
      signal,
      redirects + 1,
      deadline,
      binaryImage,
      sourcePolicy,
      rawBody,
    );
  checkSourceText(result.text, sourcePolicy);
  const html = /html/i.test(result.contentType),
    links: { url: string; text: string }[] = [];
  if (html)
    for (const match of result.text.matchAll(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      try {
        const target = new URL(match[1], url);
        if (
          ['http:', 'https:'].includes(target.protocol) &&
          !target.username &&
          !target.password &&
          sourceAllowed(target.href, sourcePolicy) &&
          !links.some((l) => l.url === target.href)
        )
          links.push({
            url: target.href,
            text: match[2]
              .replace(/<[^>]+>/g, ' ')
              .trim()
              .slice(0, 200),
          });
      } catch {}
      if (links.length >= 100) break;
    }
  const text = html
    ? result.text
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
    : result.text;
  return {
    url: url.href,
    ...(rawBody ? { rawText: result.text } : {}),
    status: result.status,
    contentType: result.contentType,
    text: text.slice(0, 120000),
    truncated: result.truncated || text.length > 120000,
    links,
    ...(binaryImage ? { imageBytes: result.imageBytes } : {}),
  };
}

export async function fetchPublicImage(
  url: string,
  signal: AbortSignal,
  sourcePolicy?: SourcePolicy,
) {
  const result = await fetchPublic(
    url,
    signal,
    0,
    AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    true,
    sourcePolicy,
  );
  assert(
    result.status >= 200 && result.status < 300,
    'IMAGE_HTTP',
    'Image endpoint returned HTTP ' + result.status,
  );
  assert(
    !result.truncated && result.imageBytes,
    'IMAGE_SIZE',
    'Image download is missing or exceeds 25 MB.',
  );
  return result.imageBytes;
}
