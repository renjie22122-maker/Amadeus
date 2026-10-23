import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechAdmission } from '../server/services/speech-admission.js';
test('service admission rotates conversations, keeps FIFO and cancels queued entries', async () => {
  const gate = new SpeechAdmission(),
    order: string[] = [];
  const first = await gate.acquire('service', 'a');
  const enqueue = (owner: string, name: string, signal?: AbortSignal) =>
    gate.acquire('service', owner, signal).then((release) => {
      order.push(name);
      release();
    });
  const cancelled = new AbortController();
  const gone = enqueue('a', 'cancelled', cancelled.signal);
  const rejection = assert.rejects(gone, /cancelled/);
  const waiting = [
    enqueue('a', 'a2'),
    enqueue('a', 'a3'),
    enqueue('b', 'b1'),
    enqueue('b', 'b2'),
    enqueue('c', 'c1'),
  ];
  cancelled.abort();
  await rejection;
  first();
  await Promise.all(waiting);
  assert.deepEqual(order, ['b1', 'c1', 'a2', 'b2', 'a3']);
});
test('declared capacity admits different conversations but never overlaps one conversation', async () => {
  const gate = new SpeechAdmission();
  const a = await gate.acquire('service', 'a', undefined, 2);
  let admitted = false;
  const secondA = gate.acquire('service', 'a', undefined, 2).then((release) => {
    admitted = true;
    return release;
  });
  const b = await gate.acquire('service', 'b', undefined, 2);
  assert.equal(admitted, false);
  const other = await gate.acquire('other-service', 'a');
  other();
  b();
  a();
  (await secondA)();
});
