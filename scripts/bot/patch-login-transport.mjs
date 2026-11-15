import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function patchLoginTransport(bytes) {
  const source = bytes.toString('latin1');
  const marker = '// Amadeus preserve authenticated session on transport loss v1';
  if (source.includes(marker)) return bytes;
  const start = source.indexOf('async function KAe(');
  const end = source.indexOf('async function VAe(', start);
  if (start < 0 || end < start) throw Error('Unknown login implementation');
  let login = source.slice(start, end);
  const disconnected = /c\.onLoginDisConnected = \(\) => \{[\s\S]*?\n  \}, c\.onLogoutSucceed/;
  const existing = login.match(disconnected)?.[0];
  const connected = 'JAe(t, e).then(async () => {';
  if (
    !existing?.includes('o.isLogined = !1') ||
    !existing.includes('pe.setQQLoginPhase("offline")') ||
    !login.includes(connected)
  )
    throw Error('Unsupported login callbacks');
  login = login.replace(
    disconnected,
    `c.onLoginDisConnected = () => {
    ${marker}
    pe.setQQLoginStatus(!1), pe.setQQLoginPhase("reconnecting");
    e.logWarn("[Core] [Login] transport disconnected; preserving authentication until explicit logout or session invalidation");
  }, c.onLogoutSucceed`,
  );
  login = login.replace(
    connected,
    connected +
      `
      if (o.isLogined) {
        const core = pe.getOneBotContext()?.core;
        if (core?.selfInfo?.online === true) {
          pe.setQQLoginStatus(true), pe.setQQLoginError(""), pe.setQQLoginPhase("ready");
        } else { pe.setQQLoginPhase("reconnecting"); }
        e.logWarn("[Core] [Login] transport reconnected; preserving existing session without requesting a QR code");
        return;
      }`,
  );
  return Buffer.from(source.slice(0, start) + login + source.slice(end), 'latin1');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, expected] = process.argv.slice(2);
  if (!file || !/^[a-f0-9]{64}$/.test(expected || ''))
    throw Error('Usage: patch-login-transport.mjs BUNDLE SHA256');
  const before = readFileSync(file);
  if (createHash('sha256').update(before).digest('hex') !== expected)
    throw Error('Bundle hash changed');
  const after = patchLoginTransport(before);
  if (!before.equals(after)) {
    copyFileSync(file, file + '.before-transport-' + expected + '.bak', 1);
    writeFileSync(file + '.transport.tmp', after, { flag: 'wx' });
    renameSync(file + '.transport.tmp', file);
  }
  console.log('Transport patch ready for next worker start; credentials unchanged.');
}
