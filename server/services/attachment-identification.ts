import { extname } from 'node:path';
import JSZip from 'jszip';
import { attachmentMediaType } from './attachment-media.js';
import { decodeDocumentText } from './text-decoding.js';

/** Content evidence wins over transport labels; never executes or expands archive entries. */
export async function identifyAttachment(name: string, bytes: Buffer) {
  let extension: string | undefined;
  let mime = attachmentMediaType(bytes);
  const mediaExtensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
    'audio/ogg': '.ogg',
    'video/ogg': '.ogv',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };
  if (mime) extension = mediaExtensions[mime];
  else if (
    bytes.subarray(0, 2).toString() === 'MZ' ||
    bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
  ) {
    return { name, executable: true, evidence: 'signature' };
  } else if (bytes.subarray(0, 5).toString() === '%PDF-') {
    extension = '.pdf';
    mime = 'application/pdf';
  } else if (bytes.subarray(0, 6).equals(Buffer.from([55, 122, 188, 175, 39, 28]))) {
    extension = '.7z';
    mime = 'application/x-7z-compressed';
  } else if (bytes.subarray(0, 4).toString() === 'Rar!') {
    extension = '.rar';
    mime = 'application/vnd.rar';
  } else if (bytes[0] === 31 && bytes[1] === 139) {
    extension = /\.(tgz|tar\.gz)$/i.test(name) ? undefined : '.gz';
    mime = 'application/gzip';
  } else if (bytes.subarray(0, 3).toString() === 'BZh') {
    extension = /\.(tbz2?|tar\.bz2)$/i.test(name) ? undefined : '.bz2';
    mime = 'application/x-bzip2';
  } else if (bytes.subarray(0, 6).equals(Buffer.from([253, 55, 122, 88, 90, 0]))) {
    extension = /\.(txz|tar\.xz)$/i.test(name) ? undefined : '.xz';
    mime = 'application/x-xz';
  } else if (bytes.subarray(257, 262).toString() === 'ustar') {
    extension = '.tar';
    mime = 'application/x-tar';
  } else if (bytes.subarray(0, 2).toString() === 'PK') {
    extension = '.zip';
    mime = 'application/zip';
    try {
      const zip = await JSZip.loadAsync(bytes);
      // Only central-directory names are inspected, never inflate document contents here.
      if (zip.file('[Content_Types].xml')) {
        const kinds = [
          ['word/document.xml', '.docx'],
          ['xl/workbook.xml', '.xlsx'],
          ['ppt/presentation.xml', '.pptx'],
        ].filter(([entry]) => zip.file(entry));
        if (kinds.length === 1) {
          extension = kinds[0][1];
          mime = undefined;
        }
      }
    } catch {
      /* Retain the archive for inspection; malformed ZIP is not plain text. */
    }
  } else {
    let decoded: string;
    try {
      decoded = decodeDocumentText(bytes).text;
    } catch {
      return { name, executable: false, evidence: 'unknown-binary' };
    }
    const head = decoded
      .slice(0, 8192)
      .replace(/^\uFEFF/, '')
      .trimStart();
    if (/^(?:<!doctype\s+html\b|<html[\s>])/i.test(head)) {
      extension = '.html';
      mime = 'text/html';
    } else if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) {
      extension = '.svg';
      mime = 'image/svg+xml';
    } else if (/^<\?xml\s/i.test(head)) {
      extension = '.xml';
      mime = 'application/xml';
    } else if (!extname(name) && head && !/[\x00-\x08\x0e-\x1f\ufffd]/.test(head)) {
      extension = '.txt';
      mime = 'text/plain';
    }
  }
  const old = extname(name);
  return {
    name:
      extension && old.toLowerCase() !== extension
        ? name.slice(0, name.length - old.length) + extension
        : name,
    mime,
    executable: false,
    evidence: extension ? 'content' : 'filename-only',
  };
}
