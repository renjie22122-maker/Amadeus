import { PdfCheckpoints } from './pdf-checkpoints.js';
import { ocrTiles } from './ocr-page-size.js';
import { validateDocumentText } from './document-quality.js';
import { suspiciousText } from './text-decoding.js';
import { decodeDocumentText } from './text-decoding.js';
import { ocrImage } from './ocr.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
export interface ExtractionOptions {
  ocr?: boolean;
  checkpointDirectory?: string;
  onTile?: (page: number, total: number, tile: number, tiles: number) => void;
  onPage?: (page: number, total: number) => void;
}
export async function extract(path: string, options: ExtractionOptions = {}): Promise<string> {
  const text = await extractContent(path, options);
  // Image placeholders remain valid chat attachments, but knowledge imports request OCR.
  if (
    !options.ocr &&
    ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase())
  )
    return text;
  return validateDocumentText(text);
}
async function extractContent(path: string, options: ExtractionOptions): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext))
    return options.ocr
      ? ocrImage(path)
      : '[Image attachment. Use a vision-capable model; no OCR was performed.]';
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ path })).value;
  }
  if (ext === '.xlsx') {
    const { default: Excel } = await import('exceljs');
    const book = new Excel.Workbook();
    await book.xlsx.readFile(path);
    const text: string[] = [];
    let populated = 0;
    book.eachSheet((sheet) => {
      text.push('# ' + sheet.name);
      text.push(
        'Coordinates and stored styles follow; colors may be theme/index based. Formulas are not executed. Conditional formatting is not rendered.',
      );
      let count = 0;
      sheet.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (cell.value == null && !Object.keys(cell.style || {}).length && !cell.isMerged) return;
          if (cell.value != null && String(cell.value).trim()) populated++;
          if (++count > 100000)
            throw Error(
              'Spreadsheet exceeds 100000 inspected cells; select a smaller workbook/range.',
            );
          text.push(
            JSON.stringify({
              address: cell.address,
              value: cell.value,
              numberFormat: cell.numFmt,
              fill: cell.fill,
              fontColor: cell.font?.color,
              ...(cell.isMerged ? { mergedWith: cell.master.address } : {}),
            }),
          );
        });
      });
    });
    if (!populated)
      throw Error(
        'DOCUMENT_EMPTY: Spreadsheet contains no cell values; formatting alone is not knowledge.',
      );
    return text.join('\n');
  }
  if (ext === '.pdf') {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = new Uint8Array(await readFile(path));
    const cache = options.checkpointDirectory
      ? await PdfCheckpoints.open(options.checkpointDirectory, bytes, !!options.ocr)
      : undefined;
    const doc = await pdf.getDocument({
      data: bytes,
      useSystemFonts: true,
    }).promise;
    try {
      const pages: string[] = [];
      let characters = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        let text = await cache?.read('page-' + i);
        if (text === undefined) {
          const page = await doc.getPage(i);
          try {
            const content = await page.getTextContent();
            text = content.items.map((x) => ('str' in x ? x.str : '')).join(' ');
            if (options.ocr && (text.trim().length < 12 || suspiciousText(text))) {
              const require = createRequire(import.meta.url);
              const canvasModule = createRequire(require.resolve('pdfjs-dist/package.json'))(
                '@napi-rs/canvas',
              );
              const viewport = page.getViewport({ scale: 1.5 });
              const tiles = ocrTiles(viewport.width, viewport.height);
              const regions: string[] = [];
              let regionCharacters = 0;
              for (const [index, tile] of tiles.entries()) {
                const key = `tile-${i}-${index}`;
                let region = await cache?.read(key);
                if (region === undefined) {
                  const canvas = canvasModule.createCanvas(tile.width, tile.height);
                  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-ocr-'));
                  try {
                    await page.render({
                      canvasContext: canvas.getContext('2d'),
                      viewport,
                      canvas,
                      transform: [1, 0, 0, 1, -tile.x, -tile.y],
                    } as any).promise;
                    const image = join(dir, 'tile.png');
                    await writeFile(image, canvas.toBuffer('image/png'));
                    region = await ocrImage(image);
                    if (suspiciousText(region))
                      throw Error(
                        `DOCUMENT_TEXT_QUALITY: Unreadable OCR on page ${i}, tile ${index + 1}.`,
                      );
                    await cache?.write(key, region);
                  } finally {
                    canvas.width = 1;
                    canvas.height = 1;
                    await rm(dir, { recursive: true, force: true });
                  }
                }
                regionCharacters += region.length;
                if (characters + regionCharacters > 5_000_000)
                  throw Error(
                    'Extracted PDF text exceeds 5 million characters; no partial document was imported.',
                  );
                regions.push(region);
                options.onTile?.(i, doc.numPages, index + 1, tiles.length);
              }
              // Preserve overlap rather than guessing which repeated words may be discarded.
              text =
                (tiles.length > 1
                  ? '[Local OCR; overlapping regions may repeat boundary text; tables and reading order require visual verification]\n'
                  : '') + regions.join('\n\n');
            }
            if (suspiciousText(text))
              throw Error(`DOCUMENT_TEXT_QUALITY: Unreadable text mapping on page ${i}.`);
            await cache?.write('page-' + i, text);
          } finally {
            page.cleanup();
          }
        }

        if (suspiciousText(text))
          throw Error(
            'DOCUMENT_TEXT_QUALITY: PDF page ' +
              i +
              ' has unreadable text mapping; OCR is unavailable or did not recover readable text.',
          );
        characters += text.length;
        if (characters > 5_000_000)
          throw Error('Extracted PDF text exceeds 5 million characters; split the source.');
        pages.push('[Page ' + i + ']\n' + text);
        options.onPage?.(i, doc.numPages);
      }
      const result = pages.join('\n\n');
      try {
        return validateDocumentText(result);
      } catch (error) {
        if (options.ocr && String(error).includes('DOCUMENT_EMPTY'))
          throw Error(
            'DOCUMENT_EMPTY: PDF has no indexable text after local OCR. It may contain only maps, illustrations or blank pages; retain the original for visual inspection. Retrying unchanged input is unlikely to help.',
          );
        throw error;
      }
    } finally {
      await doc.destroy();
    }
  }
  if (
    ![
      '.txt',
      '.md',
      '.csv',
      '.json',
      '.jsonl',
      '.ts',
      '.tsx',
      '.js',
      '.py',
      '.java',
      '.html',
      '.css',
      '.xml',
      '.yaml',
      '.yml',
      '.log',
      '.sql',
      '.rs',
      '.go',
      '.c',
      '.cpp',
      '.h',
      '.toml',
    ].includes(ext)
  )
    throw new Error('Unsupported document format: ' + ext);
  return decodeDocumentText(await readFile(path)).text;
}
