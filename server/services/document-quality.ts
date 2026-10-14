import { suspiciousText } from './text-decoding.js';
export function documentBody(text: string) {
  return text
    .replace(/^\s*\[Page \d+\]\s*$/gm, '')
    .replace(/^\s*\[(?:Local OCR[^\]]*|OCR language:[^\]]*)\]\s*$/gm, '')
    .trim();
}
export function validateDocumentText(text: string) {
  const body = documentBody(text);
  if (!body || !/[\p{L}\p{N}\p{S}]/u.test(body))
    throw Error(
      'DOCUMENT_EMPTY: No readable document content was extracted. For scanned files enable OCR and check installed language packs; blank documents cannot be indexed.',
    );
  if (suspiciousText(body))
    throw Error(
      'DOCUMENT_TEXT_QUALITY: Extracted content contains excessive replacement/control characters. Repair encoding or PDF text mapping, or use OCR; corrupt text was not imported.',
    );
  return text;
}
