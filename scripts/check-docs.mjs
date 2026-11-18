import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const index = readFileSync(resolve(root, 'docs/README.md'), 'utf8');
const section = index.split('## Current guides')[1].split(/^## /m)[0];
const guides = [...section.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => 'docs/' + m[1]);
if (!guides.length) throw new Error('No current guides found in the documentation index');
const files = ['README.md', 'CHANGELOG.md', 'docs/README.md', ...guides];
const errors = [];
for (const file of files) {
  const pair = file.replace(/\.md$/, '.zh-CN.md');
  for (const relative of [file, pair]) {
    const path = resolve(root, relative);
    if (!existsSync(path)) {
      errors.push('Missing language pair: ' + relative);
      continue;
    }
    const text = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = m[1].split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      if (!existsSync(resolve(dirname(path), decodeURIComponent(link))))
        errors.push(relative + ': missing target ' + link);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Current documentation language pairs and local link targets passed (' +
      files.length * 2 +
      ' files). This does not prove semantic freshness.',
  );
