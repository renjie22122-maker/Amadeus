// Speak prose, not code fences, image addresses or Markdown control characters.
export function speechChunks(
  markdown: string,
  size = 600,
  weighted = false,
  sentenceAware = false,
): string[] {
  const text = markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[ \t]*[>#|*-]+/gm, '')
    .replace(/[`*_#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  size = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 600;
  const points = Array.from(text);
  const chunks: string[] = [];
  while (points.length) {
    let end = 0;
    let units = 0;
    while (end < points.length) {
      const cost = weighted && /^[\x00-\x7f]$/.test(points[end]) ? 0.25 : 1;
      if (units + cost > size) break;
      units += cost;
      end++;
    }
    if (sentenceAware && end < points.length && !/[。！？.!?；;]/u.test(points[end - 1] || '')) {
      // Soft budget: finish a sentence when possible, but keep a bounded hard fallback.
      let extended = end,
        extraUnits = units;
      const hard = Math.min(600, Math.max(size, Math.min(80, size * 3)));
      while (extended < points.length && extraUnits < hard) {
        const point = points[extended];
        const cost = weighted && /^[\x00-\x7f]$/.test(point) ? 0.25 : 1;
        if (extraUnits + cost > hard) break;
        extraUnits += cost;
        extended++;
        if (/[。！？.!?；;]/u.test(point)) {
          end = extended;
          break;
        }
      }
      if (extended === points.length && extraUnits <= hard) end = extended;
    }
    if (end < points.length && !(sentenceAware && /[。！？.!?；;]/u.test(points[end - 1] || ''))) {
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
