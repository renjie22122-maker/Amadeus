import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('Node 24 or later is required.');
for (const file of ['build/server/main.js', 'dist/index.html'])
  if (!existsSync(join(root, file))) throw new Error('Build Amadeus first: pnpm build');
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env, AMADEUS_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(electron, [join(root, 'desktop/main.mjs')], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
