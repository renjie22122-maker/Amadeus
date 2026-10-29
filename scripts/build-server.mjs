import { spawnSync } from 'node:child_process';
import { readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const output = join(root, 'build');
// Fixed repository-owned output, never a configurable deletion target.
await rm(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.server.json')],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status || 1);
async function assets(directory) {
  for (const e of await readdir(join(root, directory), { withFileTypes: true })) {
    const relative = join(directory, e.name);
    if (e.isDirectory()) await assets(relative);
    else if (['.cjs', '.cs', '.csproj', '.ps1', '.py'].includes(extname(e.name))) {
      await mkdir(resolve(output, relative, '..'), { recursive: true });
      await copyFile(join(root, relative), join(output, relative));
    }
  }
}
await assets('server');
await assets('native');
console.log('Server JavaScript and runtime assets built in build/.');
