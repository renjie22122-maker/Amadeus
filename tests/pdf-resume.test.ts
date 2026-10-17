import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PdfCheckpoints } from '../server/services/pdf-checkpoints.js';
import { ocrTiles } from '../server/services/ocr-page-size.js';
import { extract } from '../server/services/documents.js';

function twoPagePdf(word: string) {
  const content = `BT /F1 12 Tf 20 100 Td (${word} readable evidence) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[3, 4].map(
      () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  return (
    out +
    `xref\n0 7\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  );
}

test('PDF resumes persisted pages after interruption and never reuses changed source bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-resume-'));
  try {
    const path = join(dir, 'source.pdf'),
      checkpointDirectory = join(dir, 'cache');
    await writeFile(path, twoPagePdf('Original'));
    await assert.rejects(
      extract(path, {
        checkpointDirectory,
        onPage: () => {
          throw Error('interrupted');
        },
      }),
      /interrupted/,
    );
    const files = await readdir(checkpointDirectory);
    assert.equal(files.length, 1);
    const checkpoint = join(checkpointDirectory, files[0]);
    const before = await stat(checkpoint);
    const result = await extract(path, { checkpointDirectory });
    assert.match(result, /\[Page 2\]/);
    assert.equal(
      (await stat(checkpoint)).mtimeMs,
      before.mtimeMs,
      'cached page was not reparsed/rewritten',
    );
    await writeFile(path, twoPagePdf('Changed'));
    const updated = await extract(path, { checkpointDirectory });
    assert.match(updated, /Changed/);
    assert.doesNotMatch(updated, /Original/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkpoint integrity, OCR policy and incomplete writes do not produce false cache hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-cache-'));
  try {
    const cache = await PdfCheckpoints.open(dir, Buffer.from('source'), true);
    await cache.write('tile-1-0', 'recognized text');
    assert.equal(await cache.read('tile-1-0'), 'recognized text');
    assert.equal(
      await (await PdfCheckpoints.open(dir, Buffer.from('source'), false)).read('tile-1-0'),
      undefined,
    );
    const path = join(dir, (await readdir(dir))[0]);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.text = 'corrupted';
    await writeFile(path, JSON.stringify(record));
    assert.equal(await cache.read('tile-1-0'), undefined);
    await writeFile(path, 'null');
    assert.equal(await cache.read('tile-1-0'), undefined);
    await writeFile(path, '{');
    assert.equal(await cache.read('tile-1-0'), undefined);
    await assert.rejects(cache.write('../escape', 'x'), /Invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OCR tiles cover large pages at full resolution with bounded overlapping canvases', () => {
  for (const [width, height] of [
    [918, 1188],
    [6000, 9000],
    [2501, 2501],
  ]) {
    const tiles = ocrTiles(width, height);
    for (const t of tiles)
      assert.ok(t.width <= 2500 && t.height <= 2500 && t.width * t.height <= 6_250_000);
    for (const y of [0, 2404, 2499, height - 1].filter((y) => y < height))
      for (let x = 0; x < width; x += 127)
        assert.ok(
          tiles.some((t) => x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height),
        );
    assert.ok(tiles.some((t) => t.x + t.width >= width && t.y + t.height >= height));
  }
  assert.throws(() => ocrTiles(1e9, 1e9), /DOCUMENT_OCR_GEOMETRY/);
  for (const [w, h] of [
    [0, 1],
    [-1, 1],
    [Infinity, 1],
    [NaN, 1],
  ])
    assert.throws(() => ocrTiles(w, h), /DOCUMENT_PAGE_GEOMETRY/);
});

test(
  'Windows tiled OCR reads both ends of a wide scanned page and resumes completed tiles',
  {
    skip: process.platform !== 'win32' || process.env.AMADEUS_TEST_WINDOWS_OCR !== '1',
  },
  async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))(
      '@napi-rs/canvas',
    );
    const canvas = createCanvas(6000, 1200),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 6000, 1200);
    ctx.fillStyle = 'black';
    ctx.font = '60px Arial';
    ctx.fillText('ALPHA LEFT MARKER', 100, 300);
    ctx.fillText('OMEGA RIGHT MARKER', 4900, 300);
    const jpeg = canvas.toBuffer('image/jpeg');
    const commands = 'q 4000 0 0 800 0 0 cm /Im0 Do Q';
    const objects = [
      Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
      Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 800] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      ),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 6000 /Height 1200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        ),
        jpeg,
        Buffer.from('\nendstream'),
      ]),
      Buffer.from(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`),
    ];
    const buffers = [Buffer.from('%PDF-1.4\n')],
      offsets = [0];
    let size = buffers[0].length;
    objects.forEach((o, i) => {
      offsets.push(size);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
      buffers.push(b);
      size += b.length;
    });
    buffers.push(
      Buffer.from(
        'xref\n0 6\n0000000000 65535 f \n' +
          offsets
            .slice(1)
            .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
            .join('') +
          `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`,
      ),
    );
    const dir = await mkdtemp(join(tmpdir(), 'pdf-tiled-ocr-'));
    try {
      const path = join(dir, 'scan.pdf'),
        checkpointDirectory = join(dir, 'cache');
      await writeFile(path, Buffer.concat(buffers));
      await assert.rejects(
        extract(path, {
          ocr: true,
          checkpointDirectory,
          onTile: () => {
            throw Error('interrupt after tile');
          },
        }),
        /interrupt after tile/,
      );
      const tile = join(
        checkpointDirectory,
        (await readdir(checkpointDirectory)).find((n) => n.includes('tile-1-0'))!,
      );
      const before = (await stat(tile)).mtimeMs;
      const text = await extract(path, { ocr: true, checkpointDirectory });
      assert.match(text, /ALPHA/i);
      assert.match(text, /OMEGA/i);
      assert.equal((await stat(tile)).mtimeMs, before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
