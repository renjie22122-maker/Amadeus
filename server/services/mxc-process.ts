import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AppError, NotStartedError } from '../core/errors.js';
import type { Settings } from '../../shared/types.js';
import type { CommandResult } from './process.js';

export async function executeMxc(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  settings: Settings,
): Promise<CommandResult> {
  const installed = join(process.env.LOCALAPPDATA || homedir(), 'Amadeus', 'mxc', 'node_modules');
  const node = process.env.AMADEUS_MXC_NODE || join(installed, 'node-win-x64', 'bin', 'node.exe'),
    entry =
      process.env.AMADEUS_MXC_SDK ||
      join(installed, '@microsoft', 'mxc-sdk', 'dist', 'v1', 'index.js'),
    python = process.env.AMADEUS_MXC_PYTHON || settings.nativePython;

  if (
    process.platform !== 'win32' ||
    ![node, entry, python].every((p) => p && isAbsolute(p) && existsSync(p))
  )
    throw new NotStartedError(
      'MXC_UNAVAILABLE',
      'Configure absolute MXC SDK, Node and Python runtime paths on the service host.',
    );
  const windows = process.env.SystemRoot!;
  const parent = await mkdtemp(join(tmpdir(), 'amadeus-mxc-call-')),
    work = join(parent, 'scratch'),
    control = join(parent, 'broker');
  const acl = join(windows, 'System32', 'icacls.exe');
  let protectedDir = false;
  try {
    await mkdir(work);
    await mkdir(control);
    const { withPinnedDirectories } = await import(
      new URL('../../native/windows/mxc-directory-grants.mjs', import.meta.url).href
    );
    const koffi = createRequire(entry)('koffi');
    return await withPinnedDirectories(koffi, [work, control], async () => {
      try {
        const env = {
          SystemRoot: windows,
          WINDIR: windows,
          Path: join(windows, 'System32'),
          TEMP: work,
          TMP: work,
          APPDATA: work,
          LOCALAPPDATA: work,
          USERPROFILE: work,
        };
        const policy = {
          containment: {
            type: 'processcontainer',
            config: {
              ui: {
                isolation: 'container',
                desktopSystemControl: false,
                systemSettings: 'none',
                ime: false,
              },
            },
          },
          workingDirectory: work,
          timeoutMs,
          inheritDefaultEnvironment: false,
          environment: env,
          ui: { disable: false, clipboard: 'none', allowInputInjection: false },
          network: {
            egress: { default: 'deny' },
            ingress: { default: 'deny', hostLoopback: 'deny' },
          },
          filesystem: {
            readwritePaths: [work],
            readonlyPaths: [windows],
            deniedPaths: [
              control,
              resolve(cwd),
              resolve(process.env.AGENTDEMO_DATA_DIR || '.data'),
              ...['.ssh', '.aws', '.codex'].map((n) => join(homedir(), n)),
            ].filter(existsSync),
            clearPolicyOnExit: true,
          },
        };
        await writeFile(join(work, 'workload.cmd'), '@echo off\r\n' + command + '\r\n');
        const input = join(control, 'request.json'),
          out = join(control, 'result.json');
        await writeFile(input, JSON.stringify(policy));
        execFileSync(acl, [work, '/deny', '*S-1-1-0:(CI)(DC)'], { windowsHide: true });
        protectedDir = true;
        execFileSync(acl, [work, '/deny', '*S-1-1-0:(CI)(IO)(DE)'], { windowsHide: true });
        signal.throwIfAborted();
        try {
          await promisify(execFile)(
            python!,
            [
              '-I',
              fileURLToPath(
                new URL('../../native/windows/mxc-private-desktop-test.py', import.meta.url),
              ),
              'execute',
              node,
              entry!,
              input,
              'command',
              out,
            ],
            {
              signal,
              timeout: timeoutMs + 25000,
              windowsHide: true,
              env: {
                SystemRoot: windows,
                WINDIR: windows,
                Path: join(windows, 'System32'),
                TEMP: parent,
                TMP: parent,
                LOCALAPPDATA: process.env.LOCALAPPDATA,
              },
            },
          );
          const receipt = JSON.parse(await readFile(out, 'utf8'));
          if (
            !Number.isInteger(receipt.code) ||
            typeof receipt.stdout !== 'string' ||
            typeof receipt.stderr !== 'string' ||
            typeof receipt.timedOut !== 'boolean'
          )
            throw Error('Invalid MXC receipt');
          return {
            ...receipt,
            execution: { backend: 'mxc', shell: 'cmd.exe', cwd: 'disposable workspace' },
          };
        } catch {
          throw new AppError(
            'MXC_OUTCOME_UNKNOWN',
            'MXC broker did not deliver a verified result. Inspect before retrying.',
          );
        }
      } finally {
        if (protectedDir)
          execFileSync(acl, [work, '/remove:d', '*S-1-1-0', '/L'], { windowsHide: true });
      }
    });
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 2 });
  }
}
