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
// Source checkout launches share the independent web service. Standalone is explicit.
if (!env.AMADEUS_BACKEND_URL && env.AMADEUS_DESKTOP_STANDALONE !== '1') {
  const url = 'http://127.0.0.1:8810';
  const health = await fetch(url + '/api/health', { signal: AbortSignal.timeout(5000) }).catch(
    () => null,
  );
  if (!health?.ok)
    throw new Error(
      'Start Amadeus first (Start-Amadeus-Desktop.ps1 starts the shared service automatically).',
    );
  env.AMADEUS_BACKEND_URL = url;
}
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
