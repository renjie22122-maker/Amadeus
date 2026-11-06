import { importOffice, queryOffice, editOffice } from './office-engine.js';
import { generateDocument, documentInput } from './document-generation.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
process.once('message', async (m: any) => {
  try {
    let result: any;
    if (m.operation === 'import') result = await importOffice(m.folder, m.format);
    else if (m.operation === 'query') result = await queryOffice(m.folder, m.query);
    else if (m.operation === 'edit')
      result = await editOffice(m.folder, m.format, m.edits, m.outputId);
    else if (m.operation === 'create') {
      const input = documentInput.parse(m.input);
      const output = join(m.folder, 'result-' + m.outputId + '.' + input.format);
      await writeFile(output, await generateDocument(input, new AbortController().signal));
      result = {
        output,
        format: input.format,
        visualVerified: false,
        notice: 'Generated file; verify content and rendered appearance before claiming quality.',
      };
    } else throw Error('OFFICE_OPERATION: Unknown operation.');
    // Page content is bounded independently from how many rows the engine scanned.
    if (result.rows) {
      while (JSON.stringify(result).length > 180000 && result.rows.length > 1) result.rows.pop();
      result.nextOffset =
        m.query.offset + result.rows.length < result.matchedRows
          ? m.query.offset + result.rows.length
          : null;
    }
    if (result.blocks) {
      while (JSON.stringify(result).length > 180000 && result.blocks.length > 1)
        result.blocks.pop();
      result.nextOffset =
        m.query.offset + result.blocks.length < result.total
          ? m.query.offset + result.blocks.length
          : null;
    }
    if (JSON.stringify(result).length > 500000)
      throw Error(
        'OFFICE_RESULT: A single result is too large; select fewer columns or a narrower block.',
      );
    process.send?.({ result });
  } catch (e) {
    process.send?.({ error: e instanceof Error ? e.message : 'Office processing failed.' });
  }
});
