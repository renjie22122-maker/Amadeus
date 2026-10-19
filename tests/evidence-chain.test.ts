import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import Excel from 'exceljs';
import { sourceAllowed, checkSourceText, filterSearch } from '../server/services/source-policy.js';
import { evaluationSources } from '../evals/public-qa/evidence-policy.js';
import { fetchPublic } from '../server/services/network.js';
import { extract } from '../server/services/documents.js';
import { normalizeImage } from '../server/services/images.js';
import { checkResponse } from '../server/core/response-contract.js';
import { researchProgress } from '../server/services/research-progress.js';
import { sharedCatalog, sharedSpecs } from '../evals/public-qa/shared-catalog.js';
test('source policy excludes encoded mirrors and never releases generated synthesis, titles or snippets', () => {
  const p = evaluationSources;
  assert(!sourceAllowed('https://huggingface.co/datasets/anything', p));
  assert(!sourceAllowed('https://example.org/%2567round_truth/data', p));
  assert(!sourceAllowed('https://github.com/team/evaluation/results', p));
  assert(sourceAllowed('https://example.org/original-paper', p));
  assert(sourceAllowed('https://huggingface.co/datasets/anything'));
  const r = filterSearch(
    {
      summary: 'LEAKED ANSWER',
      sources: [
        { url: 'https://huggingface.co/a', title: 'LEAKED', snippet: 'LEAKED' },
        { url: 'https://example.org/paper', title: 'GENERATED ANSWER', snippet: 'LEAKED' },
      ],
    },
    p,
  );
  assert.equal(r.sources.length, 1);
  assert(!JSON.stringify(r).includes('LEAKED'));
  assert(!JSON.stringify(r).includes('GENERATED ANSWER'));
  assert.throws(
    () => checkSourceText('prefix ' + JSON.stringify({ ground_truth: 'secret' }), p),
    /withheld/,
  );
});
test('fetch rejects excluded destinations before any network operation', async () => {
  await assert.rejects(
    fetchPublic(
      'https://huggingface.co/data',
      new AbortController().signal,
      0,
      undefined,
      false,
      evaluationSources,
    ),
    { code: 'SOURCE_EXCLUDED' },
  );
});
test('spreadsheet extraction retains empty styled coordinates, formulas and merged cell identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amadeus-cells-'));
  try {
    const book = new Excel.Workbook();
    const sheet = book.addWorksheet('Map');
    sheet.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12ABCD' } };
    sheet.getCell('D4').value = { formula: '1+2', result: 3 };
    sheet.mergeCells('F2:G2');
    sheet.getCell('F2').value = 'joined';
    const path = join(root, 'map.xlsx');
    await book.xlsx.writeFile(path);
    const text = await extract(path);
    assert.match(text, /"address":"B2"/);
    assert.match(text, /FF12ABCD/);
    assert.match(text, /"formula":"1\+2"/);
    assert.match(text, /"mergedWith":"F2"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('image crop inspects original detail and rejects out-of-bounds rectangles', async () => {
  const bytes = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const image = await normalizeImage(bytes, { left: 1700, top: 800, width: 200, height: 100 });
  assert.equal(image.metadata.width, 200);
  assert.equal(image.metadata.height, 100);
  await assert.rejects(
    normalizeImage(bytes, { left: 1900, top: 0, width: 200, height: 100 }),
    /bounds/,
  );
});
test('format checks reject malformed wrappers, precision and ordering without rewriting values', () => {
  const base = { format: 'single-line' as const, prefix: '', userRequirement: 'one line' };
  assert(checkResponse('42**', base).length);
  assert(checkResponse('<answer>42</answer>', base).length);
  assert(checkResponse('9.12', { ...base, format: 'number', decimalPlaces: 3 }).length);
  assert.equal(checkResponse('9.120', { ...base, format: 'number', decimalPlaces: 3 }).length, 0);
  assert(
    checkResponse('Zeta, Alpha', {
      ...base,
      delimiter: ',',
      itemCount: 2,
      ordering: 'alphabetical',
    }).length,
  );
  assert.equal(
    checkResponse('Alpha, Zeta', {
      ...base,
      delimiter: ',',
      itemCount: 2,
      ordering: 'alphabetical',
    }).length,
    0,
  );
  assert.equal(checkResponse('**requested**', { ...base, format: 'text' }).length, 0);
});
test('repeated observations do not count as corroboration; new evidence clears repetition', () => {
  const a = researchProgress(undefined, 'same'),
    b = researchProgress(a, 'same'),
    c = researchProgress(b, 'same');
  assert.match(c.advice!, /Repeated/);
  assert.equal(researchProgress(c, 'new').repeated, 0);
});
test('shared catalog contains only schema-backed tools, never an answer reader', () => {
  assert.equal(new Set(sharedSpecs.map((s) => s.name)).size, sharedSpecs.length);
  for (const d of sharedCatalog)
    assert.equal(sharedSpecs.find((s) => s.name === d.name)?.description, d.description);
  assert(sharedSpecs.some((s) => s.name === 'calculate'));
  assert(!sharedSpecs.some((s) => /grade|reference_answer/.test(s.name)));
});

test('failed pages never increase evidence coverage; mirrored bodies are repeated', () => {
  const initial = researchProgress(undefined, {
    status: 200,
    text: 'useful',
    url: 'https://a.test',
  });
  const failed = researchProgress(initial, { status: 404, text: 'missing', url: 'https://b.test' });
  assert.deepEqual(failed.hashes, initial.hashes);
  assert.equal(failed.usable, false);
  const mirrored = researchProgress(initial, {
    status: 200,
    text: 'useful',
    url: 'https://b.test',
  });
  assert.equal(mirrored.repeated, 1);
  assert.deepEqual(researchProgress(initial, []).hashes, initial.hashes);
});

test('failed acquisitions retain cumulative diagnostics across later successful retrievals', () => {
  const failed = researchProgress(researchProgress(undefined, null), {
    status: 503,
    text: 'Unavailable',
  });
  const next = researchProgress(failed, { status: 200, text: 'new material' });
  assert.equal(next.attempts, 3);
  assert.equal(next.unusable, 2);
  assert.equal(next.novel, 1);
  assert.equal(researchProgress(next, { status: 200, text: 'new material' }).novel, 1);
});
