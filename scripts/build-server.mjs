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
    else if (['.mjs', '.cjs', '.cs', '.csproj', '.ps1', '.py'].includes(extname(e.name))) {
      await mkdir(resolve(output, relative, '..'), { recursive: true });
      await copyFile(join(root, relative), join(output, relative));
    }
  }
}
await assets('server');
await assets('native');
if (process.platform === 'win32') {
  const framework = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const references = [
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Net.Http.dll',
    'System.Web.Extensions.dll',
    'WPF/WindowsBase.dll',
    'WPF/UIAutomationClient.dll',
    'WPF/UIAutomationTypes.dll',
  ];
  const helper = spawnSync(
    join(framework, 'csc.exe'),
    [
      '/nologo',
      '/codepage:65001',
      '/target:winexe',
      '/optimize+',
      '/out:' + join(output, 'native', 'windows', 'AmadeusWriting.exe'),
      ...references.map((r) => '/r:' + join(framework, r)),
      join(root, 'desktop', 'windows-writing', 'Writing.cs'),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (helper.error) throw helper.error;
  if (helper.status !== 0) process.exit(helper.status || 1);
}
console.log('Server JavaScript and runtime assets built in build/.');
