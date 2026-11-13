import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLoginRecovery, safeLoginReason } from './login-recovery.mjs';
const marker = '// Amadeus login recovery diagnostics v1';
export function patchLoginRecovery(bytes) {
  // latin1 round-trips every byte: do not corrupt non-UTF8 bridge strings.
  let source = bytes.toString('latin1');
  if (source.includes(marker)) return bytes;
  const start = source.indexOf('function UAe({');
  const end = source.indexOf('class LAe {', start);
  const event = 'const i = `[KickedOffLine] [${r.tipsTitle}] ${r.tipsDesc}`;';
  if (
    start < 0 ||
    end < start ||
    source.indexOf(event) < 0 ||
    source.indexOf(event) !== source.lastIndexOf(event)
  )
    throw Error('Unsupported bridge layout; no files changed');
  const old = source.slice(start, end);
  if (
    !old.includes('kickedDelayMs: i = 3500') ||
    !old.includes('selfOfflineDelayMs: o = 6e4') ||
    !old.includes('r(c).then')
  )
    throw Error('Recovery implementation changed; review before patching');
  const helpers =
    marker +
    '\n' +
    createLoginRecovery.toString() +
    '\n' +
    safeLoginReason.toString() +
    '\n' +
    'function UAe(options) { console.warn("[AmadeusLoginRecovery] ready v1"); return createLoginRecovery({ ...options, report: (event) => console.warn("[AmadeusLoginRecovery]", JSON.stringify(event)) }); }\n';
  source = source.slice(0, start) + helpers + source.slice(end);
  source = source.replace(
    event,
    event +
      '\n      try { this.context.logger.logWarn("[AmadeusLoginDiagnostic]", JSON.stringify({ event: "session-invalidated", at: new Date().toISOString(), pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), bridgeVersion: Vu, clientVersion: this.context.basicInfoWrapper.getFullQQVersion(), reason: safeLoginReason(r) })); } catch {}',
  );
  return Buffer.from(source, 'latin1');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, expectedHash] = process.argv.slice(2);
  if (!file || !/^[a-f0-9]{64}$/.test(expectedHash || ''))
    throw Error('Usage: node patch-login-recovery.mjs BUNDLE EXPECTED_SHA256');
  const before = readFileSync(file);
  const hash = createHash('sha256').update(before).digest('hex');
  if (hash !== expectedHash) throw Error('Bundle changed; refusing patch');
  const after = patchLoginRecovery(before);
  if (after.equals(before)) {
    console.log('Already patched');
  } else {
    const backup = file + '.before-login-recovery-' + hash + '.bak';
    copyFileSync(file, backup, 1);
    const temp = file + '.login-recovery.tmp';
    writeFileSync(temp, after, { flag: 'wx' });
    renameSync(temp, file);
    console.log(
      'Patched with byte-preserving local backup. Takes effect on next bridge worker start.',
    );
  }
}
