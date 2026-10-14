import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Excel from 'exceljs';
import { validateDocumentText } from '../server/services/document-quality.js';
import { extract } from '../server/services/documents.js';

function pdf(content: string) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('');
  return Buffer.from(out + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
test('document quality rejects empty OCR/page wrappers and corrupted text without removing valid prose', () => {
  for (const s of [
    '',
    '   ',
    '[Page 1]\n[Page 2]',
    '[Local OCR; recognition may contain errors]\n[OCR language: zh-Hans-CN]',
    'bad ' + '\ufffd'.repeat(10),
  ])
    assert.throws(() => validateDocumentText(s));
  for (const s of [
    '中文 English',
    '[Page 1]\nActual evidence',
    '123.45',
    '[Page 1]\n[Page 2]\nReal text',
  ])
    assert.equal(validateDocumentText(s), s);
});
test('real PDF and spreadsheet extraction distinguish empty structure from usable contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'document-quality-'));
  try {
    const blank = join(dir, 'blank.pdf'),
      readable = join(dir, 'readable.pdf');
    await writeFile(blank, pdf(''));
    await writeFile(readable, pdf('BT /F1 12 Tf 50 700 Td (Readable evidence) Tj ET'));
    await assert.rejects(extract(blank), /DOCUMENT_EMPTY/);
    assert.match(await extract(readable), /Readable evidence/);
    const workbook = new Excel.Workbook();
    const sheet = workbook.addWorksheet('Sheet');
    sheet.getCell('A1').font = { bold: true };
    const path = join(dir, 'data.xlsx');
    await workbook.xlsx.writeFile(path);
    await assert.rejects(extract(path), /DOCUMENT_EMPTY/);
    sheet.getCell('A1').value = '中文 evidence';
    await workbook.xlsx.writeFile(path);
    assert.match(await extract(path), /中文 evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
