import Excel from 'exceljs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extract } from './documents.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const scalar = (cell: Excel.Cell): unknown => {
  const v = cell.value;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return v;
  if ('formula' in v || 'sharedFormula' in v) return (v as any).result ?? null;
  if ('richText' in v) return v.richText.map((t) => t.text).join('');
  if ('text' in v) return v.text;
  if ('error' in v) return null;
  return cell.text;
};
const xml = (s: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw Error('OFFICE_XML: DTD/entities are not supported.');
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (m) => errors.push(m),
      fatalError: (m) => errors.push(m),
    },
  }).parseFromString(s, 'application/xml');
  if (errors.length) throw Error('OFFICE_XML: Invalid XML.');
  return doc;
};
async function packageFile(path: string) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const entries = Object.values(zip.files);
  if (entries.length > 50000) throw Error('OFFICE_ARCHIVE: Too many entries.');
  let expanded = 0;
  for (const entry of entries) {
    expanded += (entry as any)._data?.uncompressedSize || 0;
    if (expanded > 512 * 1024 * 1024)
      throw Error('OFFICE_ARCHIVE: Expanded package exceeds processing memory budget.');
  }
  return zip;
}
async function parts(zip: JSZip, format: string) {
  const names = Object.keys(zip.files);
  if (format === 'docx')
    return names
      .filter((n) =>
        /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(n),
      )
      .sort((a, b) =>
        a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b),
      );
  // Respect presentation relationship order, not lexical slide file order.
  const rel = zip.file('ppt/_rels/presentation.xml.rels'),
    presentation = zip.file('ppt/presentation.xml');
  if (!rel || !presentation) throw Error('OFFICE_PACKAGE: Presentation structure missing.');
  const relationships = xml(await rel.async('string')).getElementsByTagName('Relationship');
  const map = new Map<string, string>();
  for (let i = 0; i < relationships.length; i++) {
    const e = relationships.item(i)!;
    if (e.getAttribute('TargetMode') === 'External') continue;
    const target = e.getAttribute('Target') || '';
    if (/^slides\/slide\d+\.xml$/.test(target))
      map.set(e.getAttribute('Id') || '', 'ppt/' + target);
  }
  const slideIds = xml(await presentation.async('string')).getElementsByTagNameNS(
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'sldId',
  );
  const slides: string[] = [];
  for (let i = 0; i < slideIds.length; i++) {
    const key = slideIds
      .item(i)!
      .getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const name = map.get(key || '');
    if (name) slides.push(name);
  }
  return [
    ...slides,
    ...names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).sort(),
  ];
}
function paragraphs(doc: any, format: string) {
  return doc.getElementsByTagNameNS(format === 'docx' ? W : A, 'p');
}
function paraText(p: any, format: string) {
  const nodes = p.getElementsByTagNameNS(format === 'docx' ? W : A, 't');
  let text = '';
  for (let j = 0; j < nodes.length; j++) text += nodes.item(j).textContent || '';
  return text;
}

export async function importOffice(folder: string, format: string) {
  const source = join(folder, 'source.' + format),
    cache = join(folder, 'data.sqlite');
  try {
    const db = new DatabaseSync(cache, { readOnly: true });
    try {
      const meta = JSON.parse((db.prepare('SELECT value FROM metadata').get() as any).value);
      if (meta.parserVersion === 1 && meta.format === format) return { ...meta, reused: true };
    } finally {
      db.close();
    }
  } catch {}
  const temp = cache + '.pending';
  await rm(temp, { force: true });
  const db = new DatabaseSync(temp);
  try {
    db.exec(
      'CREATE TABLE metadata(value TEXT); CREATE TABLE sheets(name TEXT PRIMARY KEY,rows INTEGER,columns INTEGER,details TEXT); CREATE TABLE cells(sheet TEXT,row INTEGER,data TEXT,formulas TEXT,PRIMARY KEY(sheet,row)); CREATE TABLE blocks(id TEXT PRIMARY KEY,part TEXT,ordinal INTEGER,text TEXT,kind TEXT);',
    );
    const meta: any = { format, sheets: [], parts: [], warnings: [], parserVersion: 1 };
    if (format === 'xlsx' || format === 'csv') {
      const book = new Excel.Workbook();
      if (format === 'xlsx') {
        await packageFile(source);
        await book.xlsx.readFile(source);
      } else await book.csv.readFile(source, { map: (v: any) => v });
      const insert = db.prepare('INSERT INTO cells VALUES(?,?,?,?)');
      db.exec('BEGIN');
      for (const sheet of book.worksheets) {
        let rows = 0,
          columns = 0,
          formulaCount = 0;
        const samples: any[] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const values: Record<string, unknown> = {},
            formulas: Record<string, unknown> = {};
          row.eachCell({ includeEmpty: false }, (cell) => {
            const col = cell.address.replace(/[0-9]/g, '');
            const value = scalar(cell);
            if (value !== null) values[col] = value;
            if (cell.type === Excel.ValueType.Formula) {
              formulaCount++;
              formulas[col] = {
                formula: (cell.value as any).formula || null,
                sharedFormula: (cell.value as any).sharedFormula || null,
                cachedResult: value,
              };
            }
            columns = Math.max(columns, Number(cell.col));
          });
          if (!Object.keys(values).length && !Object.keys(formulas).length) return;
          rows++;
          insert.run(sheet.name, row.number, JSON.stringify(values), JSON.stringify(formulas));
          if (samples.length < 8) samples.push({ row: row.number, values });
        });
        const info = {
          name: sheet.name,
          rows,
          columns,
          hidden: sheet.state !== 'visible',
          mergedRanges: (sheet.model as any).merges || [],
          formulaCount,
          sampleRows: samples,
        };
        db.prepare('INSERT INTO sheets VALUES(?,?,?,?)').run(
          sheet.name,
          rows,
          columns,
          JSON.stringify(info),
        );
        meta.sheets.push(info);
      }
      db.exec('COMMIT');
      meta.warnings.push(
        'Formula results are stored caches, not recalculated. Filters use literal cell values/cached results. Merged cells must be interpreted using mergedRanges; do not assume blank means unrestricted.',
      );
    } else if (format === 'docx' || format === 'pptx') {
      const zip = await packageFile(source);
      const names = await parts(zip, format);
      const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?)');
      db.exec('BEGIN');
      for (const [partIndex, name] of names.entries()) {
        const entry = zip.file(name);
        if (!entry) throw Error('OFFICE_PACKAGE: Missing part.');
        const doc = xml(await entry.async('string'));
        const ps = paragraphs(doc, format);
        let count = 0;
        for (let i = 0; i < ps.length; i++) {
          const p = ps.item(i);
          const text = paraText(p, format);
          if (!text.trim()) continue;
          let inTable = false,
            ancestor = p.parentNode;
          while (ancestor) {
            if (ancestor.localName === 'tc') inTable = true;
            ancestor = ancestor.parentNode;
          }
          insert.run(
            partIndex + ':' + i,
            name,
            i,
            text,
            inTable ? 'table-cell-paragraph' : 'paragraph',
          );
          count++;
        }
        meta.parts.push({ id: partIndex, name, blocks: count });
      }
      db.exec('COMMIT');
      meta.warnings.push(
        'Text objects retain part and paragraph identity. Embedded images, charts and layout need separate visual inspection. This is not a rendered preview.',
      );
    } else {
      const text = await extract(source, { ocr: format === 'pdf' });
      const insert = db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?)');
      db.exec('BEGIN');
      let i = 0;
      for (let offset = 0; offset < text.length; offset += 6000)
        insert.run(
          'text:' + i,
          'extracted-text',
          i++,
          text.slice(offset, offset + 6000),
          'extracted-text',
        );
      db.exec('COMMIT');
      meta.parts = [{ id: 'text', name: 'extracted-text', blocks: i }];
      meta.warnings.push(
        'Extracted text/OCR can contain errors; block offsets are not page coordinates.',
      );
    }
    db.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify(meta));
    db.close();
    await rename(temp, cache);
    return { ...meta, reused: false };
  } catch (e) {
    try {
      db.close();
    } catch {}
    await rm(temp, { force: true });
    throw e;
  }
}
const column = (c: string) => {
  if (!/^[A-Z]{1,3}$/.test(c))
    throw Error('OFFICE_COLUMN: Use a column letter from inspect results.');
  return `json_extract(data,'$.${c}')`;
};
function predicate(f: any, params: any[]) {
  const col = column(f.column),
    v = f.value;
  if (!['empty', 'not_empty'].includes(f.op) && v === undefined)
    throw Error('OFFICE_FILTER: A comparison value is required.');
  switch (f.op) {
    case 'empty':
      return `(${col} IS NULL OR trim(CAST(${col} AS TEXT))='')`;
    case 'not_empty':
      return `(${col} IS NOT NULL AND trim(CAST(${col} AS TEXT))<>'')`;
    case 'contains':
    case 'not_contains':
      params.push(String(v ?? ''));
      return `${col} IS NOT NULL AND instr(lower(CAST(${col} AS TEXT)),lower(?))${f.op === 'contains' ? '>0' : '=0'}`;
    case 'eq':
    case 'ne':
      params.push(typeof v === 'boolean' ? Number(v) : v);
      return `${col} ${f.op === 'eq' ? '=' : '<>'} ?`;
    default:
      if (!['gt', 'gte', 'lt', 'lte'].includes(f.op) || typeof v !== 'number')
        throw Error('OFFICE_FILTER: Numeric comparison requires a number.');
      params.push(v);
      return `typeof(${col}) IN ('integer','real') AND ${col} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op as 'gt']} ?`;
  }
}
export async function queryOffice(folder: string, q: any) {
  const db = new DatabaseSync(join(folder, 'data.sqlite'), { readOnly: true });
  try {
    if (q.operation === 'blocks') {
      const args: any[] = [];
      let where = '1=1';
      if (q.part) {
        where += ' AND part=?';
        args.push(q.part);
      }
      if (q.search) {
        where += ' AND instr(lower(text),lower(?))>0';
        args.push(q.search);
      }
      const total = (db.prepare('SELECT COUNT(*) n FROM blocks WHERE ' + where).get(...args) as any)
        .n;
      const blocks = db
        .prepare('SELECT * FROM blocks WHERE ' + where + ' ORDER BY rowid LIMIT ? OFFSET ?')
        .all(...args, q.limit, q.offset);
      return {
        total,
        blocks,
        nextOffset: q.offset + blocks.length < total ? q.offset + blocks.length : null,
        complete: true,
      };
    }
    const sheet = db.prepare('SELECT * FROM sheets WHERE name=?').get(q.sheet) as any;
    if (!sheet) throw Error('OFFICE_SHEET: Unknown sheet; inspect first.');
    const params: any[] = [q.sheet, q.headerRow || 0];
    let where = 'sheet=? AND row>?';
    for (const f of q.all || []) where += ' AND (' + predicate(f, params) + ')';
    if (q.any?.length)
      where +=
        ' AND (' + q.any.map((f: any) => '(' + predicate(f, params) + ')').join(' OR ') + ')';
    const total = (db.prepare('SELECT COUNT(*) n FROM cells WHERE ' + where).get(...params) as any)
      .n;
    let order = 'row';
    if (q.sort?.length)
      order =
        q.sort
          .map((s: any) => column(s.column) + (s.direction === 'desc' ? ' DESC' : ' ASC'))
          .join(',') + ',row';
    const projection = (row: any) => {
      const data = JSON.parse(row.data),
        formulas = JSON.parse(row.formulas);
      return {
        row: row.row,
        values: q.columns?.length
          ? Object.fromEntries(q.columns.map((c: string) => [c, data[c] ?? null]))
          : data,
        formulas,
      };
    };
    const rows = db
      .prepare(
        'SELECT row,data,formulas FROM cells WHERE ' +
          where +
          ' ORDER BY ' +
          order +
          ' LIMIT ? OFFSET ?',
      )
      .all(...params, q.limit, q.offset)
      .map(projection);
    let summary: any;
    let summaryTruncated = false;
    if (q.groupBy?.length) {
      const cols = q.groupBy.map(column);
      summary = db
        .prepare(
          'SELECT ' +
            cols.map((c: string, i: number) => c + ' AS key' + i).join(',') +
            ',COUNT(*) AS count FROM cells WHERE ' +
            where +
            ' GROUP BY ' +
            cols.join(',') +
            ' ORDER BY count DESC LIMIT 201',
        )
        .all(...params);
      summaryTruncated = summary.length > 200;
      summary = summary.slice(0, 200);
    }
    let aggregate: any;
    if (q.aggregate) {
      const col = column(q.aggregate.column);
      aggregate = db
        .prepare(
          `SELECT COUNT(${col}) AS nonEmpty, SUM(CASE WHEN typeof(${col}) IN ('integer','real') THEN 1 ELSE 0 END) AS numericCount, SUM(CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} END) AS sum, AVG(CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} END) AS average, MIN(CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} END) AS minimum, MAX(CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} END) AS maximum FROM cells WHERE ${where}`,
        )
        .get(...params);
    }
    let output;
    if (q.export) {
      output = join(folder, 'result-' + q.outputId + '.xlsx');
      const book = new Excel.stream.xlsx.WorkbookWriter({ filename: output, useStyles: true });
      const out = book.addWorksheet('Results');
      const names = q.columns?.length
        ? q.columns
        : Array.from({ length: sheet.columns }, (_, i) => {
            let n = i + 1,
              s = '';
            while (n) {
              s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
              n = Math.floor((n - 1) / 26);
            }
            return s;
          });
      const header = q.headerRow
        ? JSON.parse(
            (
              db
                .prepare('SELECT data FROM cells WHERE sheet=? AND row=?')
                .get(q.sheet, q.headerRow) as any
            )?.data || '{}',
          )
        : {};
      out
        .addRow(['Source sheet', 'Source row', ...names.map((c: string) => String(header[c] ?? c))])
        .commit();
      for (const row of db
        .prepare('SELECT row,data,formulas FROM cells WHERE ' + where + ' ORDER BY ' + order)
        .iterate(...params) as Iterable<any>) {
        const data = JSON.parse(row.data);
        out.addRow([q.sheet, row.row, ...names.map((c: string) => data[c] ?? null)]).commit();
      }
      const audit = book.addWorksheet('Query');
      audit.addRow(['Query', JSON.stringify({ ...q, outputId: undefined })]).commit();
      audit.addRow(['Matched rows', total]).commit();
      audit.addRow(['Source version', q.sha256]).commit();
      audit.addRow(['Formula values', 'Stored cache only; not recalculated']).commit();
      await book.commit();
    }
    return {
      sheet: q.sheet,
      sourceRows: sheet.rows,
      matchedRows: total,
      rows,
      nextOffset: q.offset + rows.length < total ? q.offset + rows.length : null,
      summary,
      summaryTruncated,
      aggregate,
      output,
      complete: true,
      filters: { all: q.all || [], any: q.any || [] },
      notice:
        'Full sheet filtered locally. Null values do not satisfy negative predicates. Ranking is not semantic; evaluate all eligible candidates before claiming global top N. Summary returns at most 200 groups.',
    };
  } finally {
    db.close();
  }
}

export async function editOffice(folder: string, format: string, edits: any[], outputId: string) {
  const targets = edits.map((e) =>
    format === 'xlsx' ? JSON.stringify([e.sheet, e.cell]) : e.blockId,
  );
  if (new Set(targets).size !== targets.length) throw Error('OFFICE_EDIT: Duplicate edit targets.');
  const source = join(folder, 'source.' + format),
    output = join(folder, 'result-' + outputId + '.' + format);
  let changed = 0;
  if (format === 'xlsx') {
    const book = new Excel.Workbook();
    await book.xlsx.readFile(source);
    for (const e of edits) {
      const sheet = book.getWorksheet(e.sheet);
      if (!sheet) throw Error('OFFICE_SHEET: Unknown worksheet.');
      const cell = sheet.getCell(e.cell);
      if (JSON.stringify(scalar(cell)) !== JSON.stringify(e.expected))
        throw Error('OFFICE_STALE: Expected cell value does not match.');
      if (cell.isMerged && cell.master.address !== cell.address)
        throw Error('OFFICE_MERGED: Edit the master cell.');
      cell.value = e.value;
      changed++;
    }
    await book.xlsx.writeFile(output);
    const verify = new Excel.Workbook();
    await verify.xlsx.readFile(output);
    for (const e of edits)
      if (
        JSON.stringify(scalar(verify.getWorksheet(e.sheet)!.getCell(e.cell))) !==
        JSON.stringify(e.value)
      )
        throw Error('OFFICE_VERIFY: Cell verification failed.');
  } else if (format === 'docx' || format === 'pptx') {
    const zip = await packageFile(source);
    const names = await parts(zip, format);
    const docs = new Map<string, any>();
    for (const e of edits) {
      const match = /^(\d+):(\d+)$/.exec(e.blockId || '');
      if (!match) throw Error('OFFICE_BLOCK: Use a block ID from office_read.');
      const name = names[Number(match[1])];
      if (!name) throw Error('OFFICE_BLOCK: Unknown part.');
      let doc = docs.get(name);
      if (!doc) {
        doc = xml(await zip.file(name)!.async('string'));
        docs.set(name, doc);
      }
      const p = paragraphs(doc, format).item(Number(match[2]));
      if (!p || paraText(p, format) !== e.expected)
        throw Error('OFFICE_STALE: Expected paragraph text does not match.');
      const texts = p.getElementsByTagNameNS(format === 'docx' ? W : A, 't');
      if (!texts.length) throw Error('OFFICE_BLOCK: No editable text.');
      texts.item(0)!.textContent = e.value;
      texts.item(0)!.setAttribute('xml:space', 'preserve');
      for (let j = 1; j < texts.length; j++) texts.item(j)!.textContent = '';
      changed++;
    }
    for (const [name, doc] of docs) zip.file(name, new XMLSerializer().serializeToString(doc));
    await writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }));
    const verify = await packageFile(output);
    for (const e of edits) {
      const [part, index] = e.blockId.split(':').map(Number);
      const doc = xml(await verify.file(names[part])!.async('string'));
      if (paraText(paragraphs(doc, format).item(index), format) !== e.value)
        throw Error('OFFICE_VERIFY: Text verification failed.');
    }
  } else throw Error('OFFICE_EDIT: Only XLSX, DOCX and PPTX support structured editing.');
  return {
    output,
    changed,
    verified: 'reopened-and-compared-edited-values',
    visualVerified: false,
    notice:
      'New copy only. Whole-paragraph replacement uses first text run styling; unrelated package parts retained. XLSX library round-trip can change unsupported Excel features. Formula recalculation and layout are not verified.',
  };
}
