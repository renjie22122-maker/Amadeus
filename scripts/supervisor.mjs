import { processStartedAt, isReusedOwner } from './supervisor-lock.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..'),
  data = resolve(process.env.AGENTDEMO_DATA_DIR || join(root, '.data')),
  logs = join(data, 'logs');
mkdirSync(logs, { recursive: true });
const lock = join(data, 'supervisor.lock');
try {
  const previous = JSON.parse(readFileSync(lock, 'utf8'));
  try {
    if (!isReusedOwner(previous, statSync(lock).mtimeMs, processStartedAt(previous.pid))) {
      process.kill(previous.pid, 0);
      throw new Error('Supervisor is already running.');
    }
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  unlinkSync(lock);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const owner = { pid: process.pid, startedAt: processStartedAt(process.pid), token: randomUUID() };
const lockFd = openSync(lock, 'wx');
writeFileSync(lockFd, JSON.stringify(owner));
closeSync(lockFd);
let child,
  stopping = false,
  crashes = [];
const status = (state, extra = {}) =>
  writeFileSync(
    join(data, 'supervisor-status.json'),
    JSON.stringify(
      { state, pid: process.pid, childPid: child?.pid, at: new Date().toISOString(), ...extra },
      null,
      2,
    ),
  );
function launch() {
  const output = openSync(join(logs, 'server.log'), 'a'),
    errors = openSync(join(logs, 'server-errors.log'), 'a');
  child = spawn(process.execPath, [join(root, 'build/server/main.js')], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', output, errors],
  });
  closeSync(output);
  closeSync(errors);
  status('running');
  child.on('error', (error) => {
    status('failed', { error: error.message });
  });
  child.on('exit', (code, signal) => {
    if (stopping) {
      cleanup();
      return;
    }
    crashes = crashes.filter((t) => Date.now() - t < 300000);
    crashes.push(Date.now());
    if (crashes.length > 5) {
      status('stopped', { reason: 'More than five exits in five minutes.', code, signal });
      cleanup();
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (crashes.length - 1));
    status('backoff', { code, signal, delayMs: delay });
    setTimeout(launch, delay);
  });
}
function cleanup() {
  try {
    if (JSON.parse(readFileSync(lock, 'utf8')).token === owner.token) unlinkSync(lock);
  } catch {}
  process.exitCode = stopping ? 0 : 1;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    status('stopping');
    child?.kill('SIGTERM');
  });
launch();
