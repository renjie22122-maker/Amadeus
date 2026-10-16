import { z } from 'zod';
import { assert } from '../core/errors.js';
export const documentInput = z
  .object({
    path: z.string().min(1).max(2048),
    format: z.enum(['docx', 'pdf', 'pptx', 'xlsx']),
    title: z.string().max(500).default(''),
    blocks: z
      .array(
        z.object({
          type: z.enum(['paragraph', 'heading', 'bullet', 'code', 'pageBreak']),
          text: z.string().max(30000).default(''),
        }),
      )
      .max(500)
      .default([]),
    slides: z
      .array(
        z.object({
          title: z.string().max(300),
          body: z.string().max(1500),
          notes: z.string().max(10000).optional(),
        }),
      )
      .max(100)
      .default([]),
    sheets: z
      .array(
        z.object({
          name: z.string().min(1).max(31),
          rows: z
            .array(
              z
                .array(z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]))
                .max(100),
            )
            .max(5000),
        }),
      )
      .max(20)
      .default([]),
  })
  .superRefine((v, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (JSON.stringify(v).length > 1000000)
      problem(
        'Document input exceeds 1,000,000 characters; use an approved script for larger documents.',
      );
    if (
      (v.format === 'docx' || v.format === 'pdf') &&
      (!v.blocks.length || v.slides.length || v.sheets.length)
    )
      problem('PDF/DOCX require blocks only.');
    if (v.format === 'pptx' && (!v.slides.length || v.blocks.length || v.sheets.length))
      problem('PPTX requires slides only.');
    if (v.format === 'xlsx' && (!v.sheets.length || v.blocks.length || v.slides.length))
      problem('XLSX requires sheets only.');
    if (!v.path.toLowerCase().endsWith('.' + v.format))
      problem('File extension must match format.');
    if (
      new Set(v.sheets.map((s) => s.name.toLowerCase())).size !== v.sheets.length ||
      v.sheets.some((s) => /[\\/?*\[\]:]/.test(s.name))
    )
      problem('Worksheet names must be unique and valid.');
  });
export type DocumentInput = z.infer<typeof documentInput>;
const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function documentHtml(v: DocumentInput) {
  return (
    '<!doctype html><meta charset="utf-8"><style>body{font-family:Arial,"Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-size:11pt;line-height:1.6;color:#172033}h1{font-size:24pt}h2{font-size:16pt;break-after:avoid}p,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{font-family:monospace;background:#f3f4f6;padding:10px}li{white-space:pre-wrap} .break{break-before:page}</style>' +
    (v.title ? '<h1>' + escapeHtml(v.title) + '</h1>' : '') +
    v.blocks
      .map((b) =>
        b.type === 'pageBreak'
          ? '<div class="break"></div>'
          : b.type === 'bullet'
            ? '<ul><li>' + escapeHtml(b.text) + '</li></ul>'
            : '<' +
              { heading: 'h2', code: 'pre', paragraph: 'p' }[b.type] +
              '>' +
              escapeHtml(b.text) +
              '</' +
              { heading: 'h2', code: 'pre', paragraph: 'p' }[b.type] +
              '>',
      )
      .join('')
  );
}
/** Fixed local renderers: no model-supplied code, HTML, external URLs or macros. */
export async function generateDocument(v: DocumentInput, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (v.format === 'docx') {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } = await import('docx');
    const children = v.title ? [new Paragraph({ text: v.title, heading: HeadingLevel.TITLE })] : [];
    for (const b of v.blocks)
      children.push(
        new Paragraph({
          children:
            b.type === 'pageBreak'
              ? [new PageBreak()]
              : b.text.split('\n').map(
                  (line, i) =>
                    new TextRun({
                      text: line,
                      break: i ? 1 : 0,
                      ...(b.type === 'code' ? { font: 'Consolas' } : {}),
                    }),
                ),
          ...(b.type === 'heading' ? { heading: HeadingLevel.HEADING_1 } : {}),
          ...(b.type === 'bullet' ? { bullet: { level: 0 } } : {}),
        }),
      );
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
  }
  if (v.format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    for (const s of v.sheets) {
      const sheet = book.addWorksheet(s.name);
      sheet.addRows(s.rows); // strings are literal cells, never promoted to formulas
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach((c) => {
        c.width = 24;
        c.alignment = { wrapText: true, vertical: 'top' };
      });
    }
    return Buffer.from(await book.xlsx.writeBuffer());
  }
  if (v.format === 'pptx') {
    // Upstream publishes ESM JavaScript with CJS-classified declarations. Keep the
    // interop boundary explicit so both Bundler and NodeNext builds agree.
    const { default: exported } = await import('pptxgenjs');
    assert(typeof exported === 'function', 'DOCUMENT_PPTX', 'PPTX renderer is not a constructor.');
    const PptxGenJS = exported as unknown as new () => {
      layout: string;
      title: string;
      addSlide(): {
        background: { color: string };
        addText(text: string, options: Record<string, unknown>): void;
        addNotes(text: string): void;
      };
      write(options: { outputType: 'nodebuffer' }): Promise<Uint8Array>;
    };
    const deck = new PptxGenJS();
    deck.layout = 'LAYOUT_WIDE';
    deck.title = v.title;
    for (const item of v.slides) {
      const slide = deck.addSlide();
      slide.background = { color: 'F8FAFC' };
      slide.addText(item.title, {
        x: 0.6,
        y: 0.4,
        w: 12.1,
        h: 1.2,
        fontSize: 28,
        bold: true,
        color: '172033',
        fontFace: 'Arial',
        fit: 'shrink',
      });
      slide.addText(item.body, {
        x: 0.6,
        y: 1.8,
        w: 12.1,
        h: 4.9,
        fontSize: 20,
        color: '334155',
        fontFace: 'Arial',
        breakLine: false,
        fit: 'shrink',
        valign: 'top',
      });
      if (item.notes) slide.addNotes(item.notes);
    }
    return Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as Uint8Array);
  }
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: 30000,
      ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    });
  } catch {
    throw new Error(
      'PDF renderer unavailable. Install Microsoft Edge on Windows or Playwright Chromium on this platform, or generate DOCX. No PDF was created.',
    );
  }
  const active = browser;
  const stop = () => {
    void active.close().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(stop, 60000);
  try {
    signal.throwIfAborted();
    const context = await active.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(documentHtml(v), { timeout: 30000, waitUntil: 'load' });
    const result = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
    });
    assert(
      result.subarray(0, 5).toString() === '%PDF-',
      'DOCUMENT_PDF',
      'Renderer did not return a PDF.',
    );
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
    await active.close();
  }
}
