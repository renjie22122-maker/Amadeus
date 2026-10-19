// Speak prose, not code fences, image addresses or Markdown control characters.
export function speechChunks(markdown: string, size = 600): string[] {
  const text = markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[ \t]*[>#|*-]+/gm, '')
    .replace(/[`*_#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(text);
  const chunks: string[] = [];
  while (points.length) {
    let end = Math.min(size, points.length);
    if (end < points.length) {
      for (let i = end - 1; i >= Math.floor(end / 2); i--) {
        if (/[。！？.!?；;\s]/u.test(points[i])) {
          end = i + 1;
          break;
        }
      }
    }
    const part = points.splice(0, end).join('').trim();
    if (part) chunks.push(part);
  }
  return chunks;
}
