import { processStartedAt, isReusedOwner } from '../supervisor-lock.mjs';
import { randomUUID } from 'node:crypto';
import { BotHealthHistory } from './health-history.mjs';
import { createLoginProbe, LoginPrompt } from './login-health.mjs';
import { BridgeHealth } from './bridge-health.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfflineNotice, validateConfig } from './offline-core.mjs';
const file = process.argv[2];
if (!file) throw new Error('Usage: node offline-notice.mjs LOCAL_CONFIG.json');
const all = JSON.parse(readFileSync(resolve(file), 'utf8'));
const c = validateConfig(all.offline);
for (const p of [c.statusFile, c.ledgerFile, c.lockFile])
  mkdirSync(dirname(p), { recursive: true });
// Refuse a second independent watcher; Task Scheduler also uses IgnoreNew.
try {
  const saved = JSON.parse(readFileSync(c.lockFile, 'utf8'));
  const previous = typeof saved === 'number' ? { pid: saved } : saved;
  try {
    if (!isReusedOwner(previous, statSync(c.lockFile).mtimeMs, processStartedAt(previous.pid))) {
      process.kill(previous.pid, 0);
      throw new Error('Offline watcher already running');
    }
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  unlinkSync(c.lockFile);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const lockOwner = {
  pid: process.pid,
  startedAt: processStartedAt(process.pid),
  token: randomUUID(),
};
const fd = openSync(c.lockFile, 'wx', 0o600);
writeFileSync(fd, JSON.stringify(lockOwner));
closeSync(fd);
process.on('exit', () => {
  try {
    if (JSON.parse(readFileSync(c.lockFile, 'utf8')).token === lockOwner.token)
      unlinkSync(c.lockFile);
  } catch {}
});
const db = new DatabaseSync(c.database, { readOnly: true });
db.exec('PRAGMA busy_timeout=1000');
let ws,
  stopping = false;
const atomic = (path, data) => {
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
};
const historyFile = c.statusFile + '.history.json';
let savedHistory = [];
try {
  const raw = readFileSync(historyFile, 'utf8');
  if (raw.length <= 100000) savedHistory = JSON.parse(raw);
} catch {}
const history = new BotHealthHistory(savedHistory);
const recordState = (source, state) => {
  if (history.observe(source, state)) atomic(historyFile, history.entries);
};
const loginStatusFile = c.statusFile + '.login.json';
let loginSaved = {};
try {
  loginSaved = JSON.parse(readFileSync(loginStatusFile, 'utf8'));
} catch {}
const loginPrompt = new LoginPrompt(loginSaved),
  loginProbe = createLoginProbe(all);
let lastLoginProbe = 0;
async function inspectLogin() {
  if (Date.now() - lastLoginProbe < 15000) return;
  lastLoginProbe = Date.now();
  const state = await loginProbe();
  recordState('login', state);
  const open = loginPrompt.observe(state);
  atomic(loginStatusFile, {
    state,
    accountId: c.accountId,
    endpoint: c.bridgeUrl,
    at: Date.now(),
    prompted: loginPrompt.prompted,
  });
  if (open && all.bridgeHealth?.openLoginOnDisconnect !== false) {
    await new Promise((resolve) =>
      execFile(
        all.powershell,
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fileURLToPath(new URL('./Open-Login.ps1', import.meta.url)),
          '-Config',
          resolveConfig,
        ],
        { windowsHide: true, timeout: 15000 },
        (error) => {
          if (error) loginPrompt.prompted = false;
          resolve();
        },
      ),
    );
  }
}
let bridgeHealthState = 'not-probed';
const status = (state) => {
  recordState('watcher', state);
  recordState('bridge', bridgeHealthState);
  atomic(c.statusFile, {
    state,
    bridgeHealth: bridgeHealthState,
    healthFailures: engine.failures,
    at: new Date().toISOString(),
  });
};
let saved = {};
try {
  saved = JSON.parse(readFileSync(c.ledgerFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error('Invalid notice ledger; refusing unsafe replay');
}
const engine = new OfflineNotice(
  c,
  {
    now: Date.now,
    healthy: async () => {
      try {
        const r = await fetch(c.healthUrl, {
          signal: AbortSignal.timeout(c.timeoutMs),
          redirect: 'error',
        });
        const j = await r.json();
        return r.ok && ['Amadeus', 'AgentDemo'].includes(j.application) && j.ready === true;
      } catch {
        return false;
      }
    },
    routes: () =>
      db
        .prepare(
          "SELECT c.data,s.data AS state FROM records c LEFT JOIN records s ON s.kind='chat-transport-state' AND s.id=c.id WHERE c.kind='chat-connection'",
        )
        .all()
        .map((r) => ({
          ...JSON.parse(r.data),
          pauseReason: r.state ? JSON.parse(r.state).status : undefined,
        })),
    connected: () => ws?.readyState === 1,
    save: (s) => atomic(c.ledgerFile, s),
    send: (m) => ws.send(JSON.stringify(m)),
  },
  saved,
);
const bridgeStateFile = c.statusFile + '.bridge-health.json';
let bridgeSaved = {};
try {
  bridgeSaved = JSON.parse(readFileSync(bridgeStateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Invalid bridge health ledger');
}
const bridgeHealth = new BridgeHealth(c.accountId, bridgeSaved);
const pendingProbes = new Map();
let lastProbe = 0,
  probing = false;
function probe(action) {
  return new Promise((resolve, reject) => {
    const echo = 'bridge-health-' + action + '-' + Date.now();
    const timer = setTimeout(() => {
      pendingProbes.delete(echo);
      reject(new Error('Probe timeout'));
    }, 8000);
    pendingProbes.set(echo, (response) => {
      clearTimeout(timer);
      pendingProbes.delete(echo);
      if (response.status !== 'ok' || response.retcode !== 0) reject(new Error('Probe rejected'));
      else resolve(response.data);
    });
    try {
      ws.send(JSON.stringify({ action, params: { no_cache: true }, echo }));
    } catch (error) {
      clearTimeout(timer);
      pendingProbes.delete(echo);
      reject(error);
    }
  });
}
async function inspectBridge() {
  if (
    !all.bridgeHealth?.enabled ||
    probing ||
    ws?.readyState !== 1 ||
    Date.now() - lastProbe < 60000
  )
    return;
  probing = true;
  lastProbe = Date.now();
  try {
    const [platform, login, friends] = await Promise.all([
      probe('get_status'),
      probe('get_login_info'),
      probe('get_friend_list'),
    ]);
    const result = bridgeHealth.observe({
      online: platform?.online,
      accountId: login?.user_id,
      friends: Array.isArray(friends) ? friends.length : undefined,
    });
    bridgeHealthState = result.state;
    atomic(bridgeStateFile, bridgeHealth.snapshot());
    if (result.restart && all.bridgeHealth.autoReconnect === true) {
      // Persist the attempt before launching; restart never grants chat permissions.
      bridgeHealth.markRestart();
      atomic(bridgeStateFile, bridgeHealth.snapshot());
      bridgeHealthState = 'reconnecting';
      await new Promise((resolve, reject) =>
        execFile(
          all.powershell,
          [
            '-NoProfile',
            '-WindowStyle',
            'Hidden',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            fileURLToPath(new URL('./Run-Bot.ps1', import.meta.url)),
            '-Config',
            resolveConfig,
            '-Mode',
            'bridge',
            '-RestartBridge',
          ],
          { windowsHide: true, timeout: 30000 },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
  } catch {
    bridgeHealthState = 'probe-or-reconnect-failed';
    bridgeHealth.failures = 0;
  } finally {
    probing = false;
  }
}
const resolveConfig = resolve(file);
function token() {
  if (c.tokenEnv) {
    const v = process.env[c.tokenEnv];
    if (!v) throw new Error('Token environment variable missing');
    return v;
  }
  if (!c.tokenFile || !Array.isArray(c.tokenPath)) throw new Error('Token source missing');
  let v = JSON.parse(readFileSync(c.tokenFile, 'utf8'));
  for (const k of c.tokenPath) v = v?.[k];
  if (typeof v !== 'string' || !v) throw new Error('Token source invalid');
  return v;
}
function connect() {
  if (stopping) return;
  try {
    const u = new URL(c.bridgeUrl);
    u.searchParams.set('access_token', token());
    ws = new WebSocket(u);
    const timeout = setTimeout(() => {
      if (ws.readyState !== 1) ws.close();
    }, 10000);
    ws.onopen = () => {
      clearTimeout(timeout);
      status('bridge-connected');
    };
    ws.onmessage = (e) => {
      try {
        if (typeof e.data !== 'string' || e.data.length > 262144) return;
        const m = JSON.parse(e.data);
        if (pendingProbes.has(m.echo)) {
          pendingProbes.get(m.echo)(m);
          return;
        }
        if (m.post_type === 'message' && String(m.self_id) === String(c.accountId))
          bridgeHealth.lastMessage = Date.now();
        if (String(m.echo || '').startsWith('offline-notice-')) {
          status(m.status === 'ok' ? 'notice-delivered' : 'notice-send-failed');
          return;
        }
        engine.receive(m).catch(() => status('notice-check-failed'));
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timeout);
      status('bridge-disconnected');
      if (!stopping) setTimeout(connect, 5000);
    };
  } catch {
    status('bridge-unavailable');
    setTimeout(connect, 5000);
  }
}
async function poll() {
  if (stopping) return;
  try {
    await engine.poll();
    await inspectBridge();
    await inspectLogin();
    status(
      ws?.readyState === 1
        ? engine.failures >= c.failureThreshold
          ? 'fallback-ready'
          : 'agent-online'
        : 'bridge-disconnected',
    );
  } catch {
    status('health-check-error');
  }
  setTimeout(poll, c.pollMs);
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    ws?.close();
    db.close();
    process.exit(0);
  });
connect();
await poll();
