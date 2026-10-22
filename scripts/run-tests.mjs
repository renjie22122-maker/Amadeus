import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = (directory, suffix) =>
  readdirSync(new URL('../' + directory + '/', import.meta.url))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => directory + '/' + name);
// Real-process runtime fixtures must not compete with unrelated file suites.
// Concurrency inside Runtime is still tested, including independent conversations.
const runtime = 'tests/runtime.test.ts';
const suites = [
  ['runtime', ['--import', 'tsx', '--test', '--test-concurrency=1', runtime]],
  [
    'other tests',
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=2',
      ...files('tests', '.test.ts').filter((file) => file !== runtime),
    ],
  ],
  ['bot launcher tests', ['--test', ...files('scripts/bot', '.test.mjs')]],
];
for (const [name, args] of suites) {
  console.log('Running ' + name);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error);
  if (result.error || result.signal || result.status !== 0) process.exit(result.status || 1);
}
