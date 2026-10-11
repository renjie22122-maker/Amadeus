export function structuredChunks(
  text: string,
): { text: string; heading: string; start: number; end: number }[] {
  const lines = text.split('\n'),
    out: { text: string; heading: string; start: number; end: number }[] = [];
  let heading = '',
    buffer = '',
    start = 0,
    offset = 0;
  const flush = () => {
    if (buffer.trim())
      out.push({ text: (heading ? heading + '\n' : '') + buffer, heading, start, end: offset });
    buffer = '';
    start = offset;
  };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = line;
      start = offset;
    }
    if (buffer.length + line.length > 600) flush();
    if (line.length > 600) {
      flush();
      for (let i = 0; i < line.length; i += 480)
        out.push({
          text: (heading ? heading + '\n' : '') + line.slice(i, i + 600),
          heading,
          start: offset + i,
          end: offset + Math.min(line.length, i + 600),
        });
      offset += line.length + 1;
      start = offset;
      continue;
    }
    buffer += line + '\n';
    offset += line.length + 1;
  }
  flush();
  return out;
}
export const documentAt = (d: any, at: number) =>
  !!d && (d.validFrom ?? d.createdAt ?? 0) <= at && (d.validUntil == null || at < d.validUntil);
export const documentEligibilitySQL =
  "SELECT id FROM records WHERE kind='document' AND COALESCE(json_extract(data,'$.validFrom'),json_extract(data,'$.createdAt'),0)<=? AND (json_extract(data,'$.validUntil') IS NULL OR json_extract(data,'$.validUntil')>?)";
