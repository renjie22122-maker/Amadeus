import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  copyFile,
  access,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
let preparing: Promise<string> | undefined;
export async function prepareDesktopCapture() {
  if (process.platform !== 'win32')
    throw Error('CAPTURE_PLATFORM: WGC requires Windows 10 version 2004 or newer.');
  preparing ||= (async () => {
    const source = fileURLToPath(new URL('../../native/windows-capture/', import.meta.url));
    const names = ['Amadeus.Capture.csproj', 'Program.cs'];
    const hash = createHash('sha256');
    for (const name of names) hash.update(await readFile(join(source, name)));
    const data =
      process.env.AGENTDEMO_DATA_DIR ||
      fileURLToPath(
        new URL(
          import.meta.url.endsWith('.ts') ? '../../.data/' : '../../../.data/',
          import.meta.url,
        ),
      );
    const folder = join(data, 'native-tools', 'wgc-v2-' + hash.digest('hex'));
    const executable = join(folder, 'out', 'Amadeus.Capture.exe');
    try {
      await access(join(folder, 'ready'));
      await access(executable);
      return executable;
    } catch {}
    const parent = join(data, 'native-tools');
    await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(join(parent, 'wgc-build-'));
    for (const name of names) await copyFile(join(source, name), join(temporary, name));
    try {
      await exec(
        'dotnet',
        [
          'build',
          join(temporary, names[0]),
          '-c',
          'Release',
          '-o',
          join(temporary, 'out'),
          '--nologo',
        ],
        {
          windowsHide: true,
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1',
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
          },
        },
      );
      await writeFile(join(temporary, 'ready'), 'built');
      try {
        await rename(temporary, folder);
      } catch (e) {
        // Another MCP process may have finished the same source build first.
        try {
          await access(join(folder, 'ready'));
          await access(executable);
        } catch {
          throw e;
        }
      }
    } catch {
      throw Error(
        'CAPTURE_SETUP: WGC helper build failed. Install .NET 8 SDK and restore the Windows SDK reference, then run scripts/setup-desktop-capture.ts. PrintWindow is available only by explicit selection.',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return executable;
  })().catch((e) => {
    preparing = undefined;
    throw e;
  });
  return preparing;
}
export async function captureWindow(windowId: string) {
  const executable = await prepareDesktopCapture();
  try {
    const { stdout } = await exec(executable, [windowId], {
      windowsHide: true,
      timeout: 18000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (e: any) {
    throw Error(
      typeof e.stderr === 'string' && e.stderr.trim()
        ? e.stderr.trim().slice(0, 1000)
        : 'CAPTURE_TIMEOUT: no confirmed WGC frame; no fallback capture was attempted.',
    );
  }
}
