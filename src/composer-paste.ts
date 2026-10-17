export function shouldAttachPaste(text: string) {
  return text.length >= 8000 || text.split(/\r?\n/).length >= 100;
}
export function hasMarkdown(text: string) {
  return /(?:^|\n)\s*(?:#{1,6} |[-*] |>[ ]|```)|\*\*[^*]+\*\*|\$[^$\n]+\$|\\[([]/.test(text);
}
export function insertPaste(draft: string, text: string, start: number, end: number) {
  return draft.slice(0, start) + text + draft.slice(end);
}

/** A local, readable label, not a model-generated summary or a storage key. */
export function pastedTextFilename(text: string) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const first = heading ?? lines.find((line) => line && !/^(?:`{3,}|~{3,}|[-=_*]{3,})/.test(line));
  const label = (first ?? '')
    .replace(/^#{1,6}\s+|^>\s*|^[-*+]\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`_]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const short = Array.from(label)
    .slice(0, 48)
    .join('')
    .replace(/[. ]+$/, '');
  const safe =
    short && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(short) ? short : 'Pasted text';
  return safe + '.md';
}
