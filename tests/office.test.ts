import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Excel from 'exceljs';
import { importOffice, queryOffice, editOffice } from '../server/services/office-engine.js';
import { officeProcess } from '../server/services/office-process.js';
import { generateDocument, documentInput } from '../server/services/document-generation.js';
import { installOfficeTools } from '../server/tools/office-tools.js';
const query = {
  sheet: 'Jobs',
  headerRow: 2,
  columns: [],
  all: [],
  any: [],
  sort: [],
  groupBy: [],
  offset: 0,
  limit: 2,
};
test('office scans full table, exports every match and column, reuses immutable cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-test-'));
  try {
    const book = new Excel.Workbook(),
      sheet = book.addWorksheet('Jobs');
    sheet.getCell('A1').value = 'Title';
    sheet.addRow(['City', 'Education', 'Discipline', 'Restriction', 'Salary']);
    for (let i = 0; i < 3200; i++)
      sheet.addRow([
        i % 2 ? '宁波' : '杭州',
        '研究生',
        '计算机视觉',
        i % 3 ? '不限' : '2027应届',
        i,
      ]);
    sheet.addRow(['宁波', '研究生', '计算机视觉', null, 9000]);
    await book.xlsx.writeFile(join(dir, 'source.xlsx'));
    const original = await readFile(join(dir, 'source.xlsx'));
    const meta = await officeProcess(
      { operation: 'import', folder: dir, format: 'xlsx' },
      new AbortController().signal,
    );
    assert.equal(meta.sheets[0].rows, 3203);
    assert.equal((await importOffice(dir, 'xlsx')).reused, true);
    const result = await queryOffice(dir, {
      ...query,
      all: [
        { column: 'A', op: 'eq', value: '宁波' },
        { column: 'D', op: 'not_contains', value: '应届' },
      ],
      sort: [{ column: 'E', direction: 'desc' }],
      aggregate: { column: 'E' },
      export: true,
      outputId: 'test',
      sha256: 'version',
    });
    assert.equal(result.matchedRows, 1067);
    assert.equal(result.rows!.length, 2);
    assert.equal(result.rows![0].row, 3202);
    assert.equal(result.aggregate.numericCount, 1067);
    const out = new Excel.Workbook();
    await out.xlsx.readFile(result.output!);
    assert.equal(out.worksheets[0].rowCount, 1068);
    assert.equal(out.worksheets[0].columnCount, 7);
    assert.equal(out.worksheets[0].getCell('G2').value, 3199);
    await assert.rejects(
      queryOffice(dir, { ...query, all: [{ column: 'A', op: 'contains' }] }),
      /comparison value/,
    );
    await assert.rejects(
      editOffice(
        dir,
        'xlsx',
        [{ sheet: 'Jobs', cell: 'A3', expected: 'wrong', value: 'change' }],
        'bad',
      ),
      /STALE/,
    );
    const changed = await editOffice(
      dir,
      'xlsx',
      [{ sheet: 'Jobs', cell: 'A3', expected: '杭州', value: '=1+1' }],
      'edit',
    );
    const edited = new Excel.Workbook();
    await edited.xlsx.readFile(changed.output);
    assert.equal(edited.worksheets[0].getCell('A3').value, '=1+1');
    assert.deepEqual(await readFile(join(dir, 'source.xlsx')), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const format of ['docx', 'pptx'] as const)
  test('office ' + format + ' reads and edits verified text with original intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'office-text-'));
    try {
      const input = documentInput.parse({
        path: 'test.' + format,
        format,
        ...(format === 'docx'
          ? { blocks: [{ type: 'paragraph', text: 'Original content' }] }
          : { slides: [{ title: 'Original content', body: 'Details' }] }),
      });
      const source = await generateDocument(input, new AbortController().signal);
      await writeFile(join(dir, 'source.' + format), source);
      await importOffice(dir, format);
      const result = await queryOffice(dir, {
        operation: 'blocks',
        search: 'Original',
        offset: 0,
        limit: 10,
      });
      assert.equal(result.total, 1);
      const b = result.blocks![0] as any;
      const out = await editOffice(
        dir,
        format,
        [{ blockId: b.id, expected: b.text, value: 'Revised content' }],
        'edit',
      );
      assert.equal(out.visualVerified, false);
      const next = join(dir, 'next');
      await mkdir(next);
      await writeFile(join(next, 'source.' + format), await readFile(out.output));
      await importOffice(next, format);
      const reread = await queryOffice(next, {
        operation: 'blocks',
        search: 'Revised',
        offset: 0,
        limit: 10,
      });
      assert.equal(reread.total, 1);
      assert.deepEqual(await readFile(join(dir, 'source.' + format)), source);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
test('ordinary chat office tools reject host paths and attachments/sessions from other conversations', async () => {
  const definitions = new Map<string, any>();
  installOfficeTools({ add: (d: any) => definitions.set(d.name, d) } as any);
  const context: any = {
    conversation: { id: 'current', remoteChatOnly: true },
    store: { get: () => ({ conversationId: 'other', messageEventId: 1 }) },
  };
  await assert.rejects(
    definitions.get('office_open').run({ path: 'C:/secret.xlsx' }, context),
    /Ordinary chat/,
  );
  await assert.rejects(
    definitions.get('office_open').run({ attachmentId: 'other' }, context),
    /sent attachment/,
  );
  await assert.rejects(
    definitions.get('office_query').run({ sessionId: 'other' }, context),
    /another conversation/,
  );
  context.conversation.remoteChatOnly = false;
  context.store.get = () => ({ conversationId: 'current', sourcePath: 'revoked' });
  context.files = {
    resolve: async () => {
      throw Error('revoked scope');
    },
  };
  await assert.rejects(
    definitions.get('office_read').run({ sessionId: 'old' }, context),
    /revoked scope/,
  );
});
test('cancelled office request does not execute', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    officeProcess({ operation: 'import', folder: 'nonexistent', format: 'xlsx' }, abort.signal),
    /abort/i,
  );
});

test('ordinary chat can create, reopen, query and export its own attachment end to end', async () => {
  const { createApp } = await import('../server/http/app.js');
  const { FileScope } = await import('../server/services/paths.js');
  const dir = await mkdtemp(join(tmpdir(), 'office-chat-'));
  const { app, store } = await createApp({ directory: dir });
  try {
    const defs = new Map<string, any>();
    installOfficeTools({ add: (d: any) => defs.set(d.name, d) } as any);
    const ctx: any = {
      store,
      conversation: { id: 'office-chat', remoteChatOnly: true, permission: 'ask' },
      run: { id: 'office-run', depth: 0 },
      signal: new AbortController().signal,
      files: new FileScope([]),
    };
    const call = async (name: string, args: any) =>
      JSON.parse((await defs.get(name).run(defs.get(name).schema.parse(args), ctx)).content);
    const created = await call('office_create', {
      document: {
        path: 'report.xlsx',
        format: 'xlsx',
        sheets: [
          {
            name: 'Data',
            rows: [
              ['Name', 'Count'],
              ['A', 3],
              ['B', 9],
            ],
          },
        ],
      },
    });
    const opened = await call('office_open', { attachmentId: created.delivery.id });
    assert.equal(opened.sheets[0].rows, 3);
    const again = await call('office_open', { attachmentId: created.delivery.id });
    assert.equal(again.reused, true);
    const filtered = await call('office_query', {
      sessionId: opened.sessionId,
      sheet: 'Data',
      headerRow: 1,
      all: [{ column: 'B', op: 'gt', value: 4 }],
    });
    assert.equal(filtered.matchedRows, 1);
    assert.equal(filtered.rows[0].row, 3);
    const exported = await call('office_export', {
      sessionId: opened.sessionId,
      sheet: 'Data',
      headerRow: 1,
    });
    assert.equal(exported.matchedRows, 2);
    assert.ok(exported.delivery.id);
    assert.equal(defs.get('office_export').effect, 'write');
    assert.equal(defs.get('office_query').effect, 'read');
    assert.equal(
      store.events(ctx.conversation.id).filter((e) => e.type === 'file.attached').length,
      2,
    );
    const a = await call('office_open', { attachmentId: exported.delivery.id });
    assert.equal(a.sheets[0].rows, 3);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
