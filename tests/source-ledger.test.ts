import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceLedger,
  assertSourceRetention,
  archivedSourceLedger,
  requestSources,
} from '../server/core/source-ledger.js';
import { usageCost, compactionEconomics } from '../server/core/context-economics.js';
import type { ModelMessage } from '../shared/types.js';
test('multiple compactions retain verbatim chronological sources including conflicting instructions', () => {
  const requests: ModelMessage[] = [
    { role: 'user', content: 'Do not change API v1. 保留中文注释。' },
    { role: 'user', content: 'Correction: API v2 is allowed, but keep Chinese comments.' },
  ];
  const first = sourceLedger(requests)!;
  const second = sourceLedger([
    first,
    { role: 'assistant', content: 'A summary that omits everything.' },
  ])!;
  assertSourceRetention(requests, [second]);
  assert.match(second.content, /API v1/);
  assert.match(second.content, /API v2/);
  assert.throws(
    () => assertSourceRetention(requests, [sourceLedger(requests.slice(1))!]),
    /lost or reordered/,
  );
  assert.throws(
    () => assertSourceRetention(requests, [sourceLedger([...requests].reverse())!]),
    /lost or reordered/,
  );
  const malicious = { ...first, content: first.content.replace('API v1', 'API xx') };
  assert.throws(() => sourceLedger([malicious]), /integrity/);
  assert.equal(
    sourceLedger([{ role: 'user', contextKind: 'runtime-advice', content: 'Verify again' }]),
    undefined,
  );
});
test('compaction economics includes summary and cache rewarm; unknown costs remain unknown', () => {
  const prices = { input: 2, cached: 0.2, output: 4 };
  assert.equal(
    usageCost({ input: 1000, cached: 500, output: 100, measured: true }, prices),
    0.0015,
  );
  const report = compactionEconomics(10000, 2000, 0.005, 0.8, prices);
  assert.ok(report.breakEvenRequests! > 0);
  assert.ok(report.estimatedRewarmUsd! > 0);
  assert.equal(compactionEconomics(10000, 2000, null, 0.8, prices).breakEvenRequests, null);
  assert.equal(compactionEconomics(10000, 2000, 0.005, null, prices).breakEvenRequests, null);
  assert.equal(usageCost({ input: 10, cached: 0, output: 1, measured: false }, prices), null);
});

test('archived request sources remain exact, chronological and tamper checked across compactions', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'keep files' },
    { role: 'user', content: 'later correction' },
  ];
  const archive = new Map<string, string>();
  const ledger = archivedSourceLedger(requestSources(messages), (raw) => {
    archive.set('key', raw);
    return 'key';
  });
  const resolve = (key: string) => archive.get(key)!;
  assertSourceRetention(messages, [ledger], resolve);
  const later: ModelMessage = { role: 'user', content: 'current task' };
  assertSourceRetention([...messages, later], [sourceLedger([ledger, later], resolve)!], resolve);
  assert.throws(() => requestSources([ledger]), /resolver/);
  archive.set('key', archive.get('key')! + ' ');
  assert.throws(() => requestSources([ledger], resolve), /integrity/);
});
