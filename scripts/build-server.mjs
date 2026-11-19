import { spawnSync } from 'node:child_process';
import { readdir, mkdir, copyFile, rm, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, extname, dirname, basename } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const verify = process.argv.slice(2).includes('--verify');
// A verification build has its own output tree and cannot replace the running service.
const output = verify ? await mkdtemp(join(root, '.tmp-build-verify-')) : join(root, 'build');
try {
  if (!verify) await rm(output, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(root, 'tsconfig.server.json'),
      '--outDir',
      output,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw Error('TypeScript build failed: ' + result.status);
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
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const head = git('rev-parse', 'HEAD');
  const status = git(
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--',
    'server',
    'src',
    'shared',
    'native',
    'scripts',
    'desktop',
    'package*.json',
    'tsconfig*.json',
  );
  const commit =
    head.status === 0 && /^[0-9a-f]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  await writeFile(
    join(output, 'server', 'build-info.json'),
    JSON.stringify({
      version: pkg.version,
      commit,
      dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
      builtAt: new Date().toISOString(),
    }),
  );
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
    if (helper.status !== 0) throw Error('Windows helper build failed: ' + helper.status);
  }
  if (verify) {
    const smoke = spawnSync(process.execPath, [join(root, 'scripts/smoke-server.mjs'), output], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0) throw Error('Smoke test failed: ' + smoke.status);
  } else console.log('Server JavaScript and runtime assets built in build/.');
} finally {
  if (
    verify &&
    dirname(resolve(output)) === root &&
    basename(output).startsWith('.tmp-build-verify-')
  )
    await rm(output, { recursive: true, force: true });
}
