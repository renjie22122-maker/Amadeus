import { z } from 'zod';
const text = z.string().max(2000);
const common = { title: text.optional(), caption: text.optional() };
const point = z.object({ label: text, value: z.number().finite().min(-1e12).max(1e12) });
export const chartSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('bar'),
    unit: text.optional(),
    max: z.number().positive().max(1e12).optional(),
    data: z.array(point).min(1).max(100),
  }),
  z.object({
    ...common,
    type: z.literal('line'),
    unit: text.optional(),
    data: z.array(point).min(2).max(100),
  }),
  z.object({
    ...common,
    type: z.literal('flow'),
    steps: z
      .array(z.object({ title: text, detail: text.optional() }))
      .min(1)
      .max(50),
  }),
  z.object({
    ...common,
    type: z.literal('table'),
    columns: z.array(text).min(1).max(20),
    rows: z.array(z.array(z.union([text, z.number().finite(), z.null()])).max(20)).max(100),
  }),
]);
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function chartDocument(source: string, theme?: string): string {
  if (source.length > 100000) throw new Error('Chart source exceeds 100,000 characters.');
  const spec = chartSchema.parse(JSON.parse(source));
  let content = '';
  if (spec.type === 'flow') {
    content =
      '<ol class="flow">' +
      spec.steps
        .map(
          (step, i) =>
            '<li><span class="number">' +
            (i + 1) +
            '</span><div><strong>' +
            escape(step.title) +
            '</strong>' +
            (step.detail ? '<p>' + escape(step.detail) + '</p>' : '') +
            '</div></li>',
        )
        .join('') +
      '</ol>';
  } else if (spec.type === 'table') {
    if (spec.rows.some((row) => row.length !== spec.columns.length))
      throw new Error('Every table row must match the column count.');
    content =
      '<div class="table-scroll"><table><thead><tr>' +
      spec.columns.map((c) => '<th scope="col">' + escape(c) + '</th>').join('') +
      '</tr></thead><tbody>' +
      spec.rows
        .map(
          (row) => '<tr>' + row.map((cell) => '<td>' + escape(cell) + '</td>').join('') + '</tr>',
        )
        .join('') +
      '</tbody></table></div>';
  } else {
    const low = Math.min(0, ...spec.data.map((p) => p.value));
    const high = Math.max(
      0,
      ...spec.data.map((p) => p.value),
      spec.type === 'bar' ? spec.max || 0 : 0,
    );
    const span = high - low || 1;
    const unit = escape(spec.unit || '');
    if (spec.type === 'bar') {
      const zero = (100 * (0 - low)) / span;
      content =
        '<div class="bars">' +
        spec.data
          .map((p) => {
            const end = (100 * (p.value - low)) / span;
            return (
              '<div class="bar-row"><div class="bar-label"><span>' +
              escape(p.label) +
              '</span><strong>' +
              escape(p.value) +
              unit +
              '</strong></div><div class="track"><i style="left:' +
              Math.min(zero, end) +
              '%;width:' +
              Math.abs(end - zero) +
              '%"></i><b style="left:' +
              zero +
              '%"></b></div></div>'
            );
          })
          .join('') +
        '</div><p class="scale">' +
        escape(low) +
        ' — ' +
        escape(high) +
        unit +
        '</p>';
    } else {
      const points = spec.data.map((p, i) => [
        40 + (560 * i) / (spec.data.length - 1),
        200 - (160 * (p.value - low)) / span,
      ]);
      content =
        '<svg viewBox="0 0 640 240" role="img" aria-label="' +
        escape(spec.title || 'Line chart') +
        '"><line x1="40" y1="200" x2="600" y2="200" class="axis"/><text x="8" y="35">' +
        escape(high) +
        '</text><text x="8" y="200">' +
        escape(low) +
        '</text><polyline fill="none" stroke="var(--accent)" stroke-width="3" points="' +
        points.map((p) => p.join(',')).join(' ') +
        '"/>' +
        points
          .map(
            (p, i) =>
              '<circle cx="' +
              p[0] +
              '" cy="' +
              p[1] +
              '" r="4" fill="var(--accent)"><title>' +
              escape(spec.data[i].label) +
              ': ' +
              escape(spec.data[i].value) +
              unit +
              '</title></circle>',
          )
          .join('') +
        '</svg><details><summary>Data / 数据</summary><table><tbody>' +
        spec.data
          .map(
            (p) =>
              '<tr><th scope="row">' +
              escape(p.label) +
              '</th><td>' +
              escape(p.value) +
              unit +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></details>';
    }
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    `
:root {color-scheme:light dark;--accent:#4f8df5;--border:#d8dfe8;--muted:#596579;--panel:#fff;--track:#edf0f5;color:#182235;background:transparent;font:15px/1.55 system-ui,sans-serif}
@media(prefers-color-scheme:dark){:root{--border:#343e4c;--muted:#a5b1c2;--panel:#171c24;--track:#2a3340;color:#eef3fa}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--panel)}article{padding:20px;border:1px solid var(--border);border-radius:14px;background:var(--panel);overflow-wrap:anywhere}h2{font-size:19px;margin:0 0 6px}p{margin:6px 0;color:var(--muted)}.caption{margin-bottom:18px}.bar-row{margin:15px 0}.bar-label{display:flex;justify-content:space-between;gap:16px;margin-bottom:7px}.bar-label strong{white-space:nowrap;font-variant-numeric:tabular-nums}.track{position:relative;height:9px;border-radius:6px;background:var(--track);overflow:hidden}.track i{position:absolute;top:0;bottom:0;background:var(--accent);border-radius:6px}.track b{position:absolute;top:0;bottom:0;border-left:1px solid var(--muted)}.scale{text-align:right;font-size:12px}.flow{list-style:none;padding:0;margin:0}.flow li{display:flex;gap:14px;position:relative;padding:16px 0}.flow li+li{border-top:1px solid var(--border)}.number{flex:0 0 30px;height:30px;display:grid;place-items:center;background:var(--track);color:var(--accent);border-radius:50%;font-weight:700}.flow p{margin:4px 0 0}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--border)}thead{background:var(--track)}svg{width:100%;height:auto}svg text{fill:var(--muted);font-size:12px}.axis{stroke:var(--border)}summary{cursor:pointer;color:var(--muted)}@media(max-width:400px){body{padding:5px}article{padding:12px}.bar-label{font-size:13px}}
` +
    (theme === 'dark'
      ? ':root{color-scheme:dark;--border:#343e4c;--muted:#a5b1c2;--panel:#171c24;--track:#2a3340;color:#eef3fa}'
      : theme === 'light'
        ? ':root{color-scheme:light;--border:#d8dfe8;--muted:#596579;--panel:#fff;--track:#edf0f5;color:#182235}'
        : '') +
    '</style></head><body><article>' +
    (spec.title ? '<h2>' + escape(spec.title) + '</h2>' : '') +
    (spec.caption ? '<p class="caption">' + escape(spec.caption) + '</p>' : '') +
    content +
    '</article></body></html>'
  );
}
