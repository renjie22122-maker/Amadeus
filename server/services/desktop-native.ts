import { captureWindow } from './desktop-capture.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
let building: Promise<string> | undefined;
async function compile() {
  if (process.platform !== 'win32') throw Error('Windows desktop backend required.');
  const source = fileURLToPath(new URL('./desktop-native.cs', import.meta.url));
  const hash = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const dir = join(
    process.env.AGENTDEMO_DATA_DIR ||
      fileURLToPath(
        new URL(
          import.meta.url.endsWith('.ts') ? '../../.data/' : '../../../.data/',
          import.meta.url,
        ),
      ),
    'native-tools',
  );
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'desktop-' + hash + '.exe');
  if (existsSync(target)) return target;
  const compiler = join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  if (!existsSync(compiler))
    throw Error(
      'Windows .NET Framework compiler unavailable. Configure a separately installed desktop MCP backend.',
    );
  const temp = target + '.' + process.pid + '.exe';
  await exec(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/out:' + temp,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      '/r:System.Web.Extensions.dll',
      '/r:' +
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'Microsoft.NET',
          'Framework64',
          'v4.0.30319',
          'WPF',
          'UIAutomationClient.dll',
        ),
      '/r:' +
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'Microsoft.NET',
          'Framework64',
          'v4.0.30319',
          'WPF',
          'UIAutomationTypes.dll',
        ),
      '/r:' +
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'Microsoft.NET',
          'Framework64',
          'v4.0.30319',
          'WPF',
          'WindowsBase.dll',
        ),
      source,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  await rename(temp, target);
  return target;
}
export async function desktopAction(action: Record<string, unknown>) {
  if (action.action === 'screenshot' && action.windowId && action.captureBackend !== 'print-window')
    return captureWindow(String(action.windowId));
  building ||= compile().catch((e) => {
    building = undefined;
    throw e;
  });
  const executable = await building;
  try {
    const { stdout } = await exec(
      executable,
      [Buffer.from(JSON.stringify(action)).toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (e: any) {
    throw Error(
      typeof e.stderr === 'string' && e.stderr.trim()
        ? e.stderr.trim().slice(0, 1000)
        : 'Desktop operation failed or timed out. Inspect state before retrying.',
    );
  }
}
