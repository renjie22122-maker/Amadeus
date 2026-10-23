import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDocumentText } from '../shared/document-cleaning.js';
test('cleanup is opt-in and retains content, tables, indentation and multilingual text', () => {
  const raw = '标题  \r\n\r\n\r\n  code\tvalue\r\n| 表格 | 日本語 |\r\n\u0000正文';
  assert.equal(cleanDocumentText(raw, {}), raw);
  assert.equal(
    cleanDocumentText(raw, { trailingSpaces: true, blankLines: true, controlCharacters: true }),
    '标题\r\n\r\n  code\tvalue\r\n| 表格 | 日本語 |\r\n正文',
  );
  const repeated = 'Header\nSame paragraph\nHeader\nSame paragraph';
  assert.equal(
    cleanDocumentText(repeated, {
      trailingSpaces: true,
      blankLines: true,
      controlCharacters: true,
    }),
    repeated,
  );
});
