// Only repair copy/paste transport escaping, never invent nodes or relationships.
export function diagramCopySource(source: string) {
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/\\[ \t]*$/gm, '')
    .replace(/\\([<>])/g, '$1')
    .replace(/^(?:&#x20;|&#32;|&nbsp;)+/gm, ' ');
}
export function diagramDirection(source: string, direction: string) {
  return ['TD', 'LR', 'RL', 'BT'].includes(direction)
    ? source.replace(/^(\s*(?:flowchart|graph)\s+)(TD|TB|LR|RL|BT)\b/m, '$1' + direction)
    : source;
}
export function diagramError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1600);
}
