import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPlainText } from '../server/services/chat-format.js';
import { messageParts } from '../server/services/chat-protocols.js';
test('social replies remove markup but retain code, links, references and mathematical content', () => {
  const result = chatPlainText(
    '# 标题\n\n**重要**，*强调*，`x_y ** z`\n\n[资料](https://example.org/a_(b))\n\n```python\nx_y = "**not bold**"\nprint(x_y)\n```\n\n公式 $x_i + 1$\n\n[引用][r]\n\n[r]: https://example.org/reference',
  );
  assert(result.startsWith('标题\n\n重要，强调，x_y ** z'));
  assert(result.includes('资料 (https://example.org/a_(b))'));
  assert(result.includes('x_y = "**not bold**"\nprint(x_y)'));
  assert(result.includes('公式 x_i + 1'));
  assert(result.includes('引用 (https://example.org/reference)'));
  assert(!result.includes('```'));
});
test('tables become labeled records and nested lists remain readable', () => {
  const result = chatPlainText(
    '| 人物 | 状态 |\n|---|---|\n| 甲 | **完成** |\n| 乙 | 等待 |\n\n- 第一项\n  - 子项\n- [x] 已确认',
  );
  assert(result.includes('1. 人物：甲；状态：完成'));
  assert(result.includes('2. 人物：乙；状态：等待'));
  assert(result.includes('• 第一项'));
  assert(result.includes('• 子项'));
  assert(result.includes('☑ 已确认'));
});
test('plain text punctuation is preserved and splitting follows conversion without lost characters', () => {
  const source = '中文不变，a_b_c，2 * 3 < 9。\n\n原文：你好。';
  assert.equal(chatPlainText(source), source);
  const converted = chatPlainText('**中文🙂** '.repeat(4000));
  assert.equal(messageParts(converted).join(''), converted);
});
