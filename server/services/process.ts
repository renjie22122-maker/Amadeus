import { isAbsolute } from 'node:path';
import { dockerMetadataMasks } from './protected-metadata.js';
import { executeNative } from './native-process.js';
import { spawnProcess as spawn } from './spawn-process.js';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../../shared/types.js';
import { AppError, NotStartedError } from '../core/errors.js';
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
  truncated: boolean;
  execution?: { backend: string; shell: string; cwd: string };
}
export function execute(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  settings: Settings,
  onOutput?: (stream: string, text: string) => void,
): Promise<CommandResult> {
  if (signal.aborted) return Promise.reject(new AppError('CANCELLED', 'Cancelled'));
  if (settings.commandBackend === 'native-windows')
    return executeNative(command, cwd, signal, timeoutMs, settings);
  if (!['approval-host', 'docker'].includes(settings.commandBackend))
    return Promise.reject(
      new NotStartedError('UNKNOWN_BACKEND', 'Unknown execution backend. No host fallback.'),
    );
  if (
    settings.commandBackend === 'docker' &&
    (!isAbsolute(cwd) ||
      /[,\r\n]/.test(cwd) ||
      !/^[1-9]\d*(?::\d+)?$/.test(settings.dockerUser || '1000:1000'))
  )
    return Promise.reject(
      new NotStartedError(
        'DOCKER_POLICY',
        'Docker requires an absolute mount path without commas and a non-root numeric user.',
      ),
    );
  const docker = settings.commandBackend === 'docker',
    container = 'agentdemo-' + randomUUID();
  const executable = docker
    ? 'docker'
    : process.platform === 'win32'
      ? 'C:\\Windows\\System32\\cmd.exe'
      : '/bin/sh';
  const args = docker
    ? [
        'run',
        '--pull=never',
        '--rm',
        '--name',
        container,
        '--network=none',
        '--user',
        settings.dockerUser || '1000:1000',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=128',
        '--memory=1g',
        '--cpus=2',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=128m',
        '--mount',
        'type=bind,source=' + cwd + ',target=/workspace',
        ...dockerMetadataMasks(cwd),
        '--workdir',
        '/workspace',
        settings.dockerImage,
        'sh',
        '-lc',
        command,
      ]
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', '"' + command + '"']
      : ['-c', command];
  // Deliberately omit API keys and service secrets. This is environment hygiene, not host isolation.
  const env: NodeJS.ProcessEnv = {};
  for (const k of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'LANG',
  ])
    if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32' && !docker,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawned = false;
    child.once('spawn', () => {
      spawned = true;
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      truncated = false,
      settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const take = (s: string, v: string) => {
      if (s.length + v.length > 1000000) truncated = true;
      return (s + v).slice(0, 1000000);
    };
    child.stdout.on('data', (v) => {
      stdout = take(stdout, v);
      onOutput?.('stdout', v);
    });
    child.stderr.on('data', (v) => {
      stderr = take(stderr, v);
      onOutput?.('stderr', v);
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const forceReturn = () => {
      if (deadline || settled) return;
      deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(
          new AppError(
            'EXECUTION_OUTCOME_UNKNOWN',
            'Command did not close after termination was requested. Execution outcome and descendant cleanup are unknown; inspect before retrying. Partial stdout: ' +
              stdout.slice(-8000) +
              '\nPartial stderr: ' +
              stderr.slice(-4000),
          ),
        );
      }, 2000);
    };
    const kill = () => {
      forceReturn();
      if (docker)
        spawn('docker', ['rm', '-f', container], { windowsHide: true, stdio: 'ignore' }).on(
          'error',
          () => {},
        );
      if (child.pid) {
        if (process.platform === 'win32')
          spawn('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).on('error', () => child.kill());
        else
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      signal.removeEventListener('abort', kill);
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        spawned
          ? new AppError('EXECUTION_OUTCOME_UNKNOWN', e.message)
          : new NotStartedError('EXECUTION_UNAVAILABLE', e.message),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        aborted: signal.aborted,
        truncated,
        execution: {
          backend: settings.commandBackend,
          shell: docker ? 'sh' : process.platform === 'win32' ? 'cmd.exe' : 'sh',
          cwd: docker ? '/workspace' : cwd,
        },
      });
    });
  });
}
