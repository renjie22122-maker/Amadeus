/** Strict decoding: never silently embed replacement characters from invalid bytes. */
export const TEXT_DECODING_REVISION = 1;
export const textFormats = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.jsonl',
  '.ts',
  '.tsx',
  '.js',
  '.py',
  '.java',
  '.html',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.sql',
  '.rs',
  '.go',
  '.c',
  '.cpp',
  '.h',
  '.toml',
]);
export function suspiciousText(text: string) {
  if (!text.length) return false;
  const replacements = (text.match(/\uFFFD/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000b\u000e-\u001f]/g) || []).length;
  return replacements / text.length > 0.01 || controls / text.length > 0.01;
}
export function decodeDocumentText(bytes: Uint8Array): { text: string; encoding: string } {
  const decode = (encoding: string) => {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (suspiciousText(text))
      throw Error('Decoded text contains excessive replacement or control characters');
    return { text, encoding };
  };
  // BOMs are authoritative: malformed declared Unicode must not fall back to a legacy codec.
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  )
    throw Error('TEXT_ENCODING: UTF-32 is not supported; convert to UTF-8.');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode('utf-8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be');
  // BOM-less UTF-16 is accepted only with strong alternating NUL evidence.
  if (bytes.length >= 8 && bytes.length % 2 === 0) {
    let even = 0,
      odd = 0;
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) i % 2 ? odd++ : even++;
    if (odd > n * 0.2 && even < n * 0.02) return decode('utf-16le');
    if (even > n * 0.2 && odd < n * 0.02) return decode('utf-16be');
  }
  let utf8: string | undefined;
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}
  if (utf8 !== undefined) return decode('utf-8');
  try {
    const result = decode('gb18030');
    // Avoid treating arbitrary binary / Western single-byte input as Chinese prose.
    if (!/[\u3400-\u9fff]/.test(result.text))
      throw Error('No evidence for legacy Chinese encoding');
    return result;
  } catch {
    throw Error(
      'TEXT_ENCODING: Cannot safely decode this text as UTF-8, UTF-16 or GB18030. Convert the original file to UTF-8 and retry; no lossy text was imported.',
    );
  }
}
