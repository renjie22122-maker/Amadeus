import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentInput,
  documentHtml,
  generateDocument,
} from '../server/services/document-generation.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

test('document contracts reject mismatched formats and ignored input; HTML is inert', () => {
  assert.equal(
    documentInput.safeParse({
      path: 'report.pdf',
      format: 'docx',
      blocks: [{ type: 'paragraph', text: 'hello' }],
    }).success,
    false,
  );
  assert.equal(
    documentInput.safeParse({
      path: 'report.xlsx',
      format: 'xlsx',
      sheets: [
        { name: 'one', rows: [] },
        { name: 'ONE', rows: [] },
      ],
    }).success,
    false,
  );
  const input = documentInput.parse({
    path: 'report.pdf',
    format: 'pdf',
    title: '<script>bad</script>',
    blocks: [{ type: 'paragraph', text: '<img src="https://example.com/">' }],
  });
  assert(!documentHtml(input).includes('<script>'));
  assert(!documentHtml(input).includes('<img'));
});
test('DOCX is a real package with preserved Unicode and paragraphs', async () => {
  const bytes = await generateDocument(
    documentInput.parse({
      path: 'report.docx',
      format: 'docx',
      title: '报告',
      blocks: [
        { type: 'paragraph', text: 'hello 中文\nnext line' },
        { type: 'bullet', text: 'item' },
      ],
    }),
    new AbortController().signal,
  );
  const text = await mammoth.extractRawText({ buffer: bytes });
  assert.match(text.value, /报告/);
  assert.match(text.value, /hello 中文/);
  assert.match(text.value, /next line/);
});
test('XLSX preserves literal formula-like text, numeric types and sheets', async () => {
  const bytes = await generateDocument(
    documentInput.parse({
      path: 'report.xlsx',
      format: 'xlsx',
      sheets: [
        {
          name: '数据',
          rows: [
            ['Name', 'Value'],
            ['=HYPERLINK("bad")', 42],
          ],
        },
        { name: 'Second', rows: [[true, null]] },
      ],
    }),
    new AbortController().signal,
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as any);
  assert.equal(book.worksheets.length, 2);
  assert.equal(book.worksheets[0].getCell('B2').value, 42);
  assert.equal(book.worksheets[0].getCell('A2').value, '=HYPERLINK("bad")');
});
test('PPTX generation produces a ZIP package and handles Unicode', async () => {
  const bytes = await generateDocument(
    documentInput.parse({
      path: 'deck.pptx',
      format: 'pptx',
      title: '标题',
      slides: [{ title: '中文', body: 'One\nTwo', notes: 'Speaker notes' }],
    }),
    new AbortController().signal,
  );
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert(bytes.length > 1000);
});
test('cancelled generation does not publish an output', async () => {
  await assert.rejects(
    generateDocument(
      documentInput.parse({
        path: 'x.docx',
        format: 'docx',
        blocks: [{ type: 'paragraph', text: 'hi' }],
      }),
      AbortSignal.abort(),
    ),
  );
});

test(
  'local PDF renderer produces readable Unicode pages',
  { skip: process.env.AMADEUS_TEST_DOCUMENT_PDF !== '1' },
  async () => {
    const input = documentInput.parse({
      path: 'report.pdf',
      format: 'pdf',
      title: '文档生成验证',
      blocks: [
        { type: 'heading', text: '下载与交付' },
        { type: 'paragraph', text: '中文内容 Hello world' },
        { type: 'pageBreak' },
        { type: 'paragraph', text: '第二页' },
      ],
    });
    const bytes = await generateDocument(input, new AbortController().signal);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    try {
      assert.equal(pdf.numPages, 2);
      const page = await pdf.getPage(1);
      const text = await page.getTextContent();
      assert.match(text.items.map((i: any) => i.str || '').join(''), /中文内容/);
    } finally {
      await pdf.destroy();
    }
  },
);
