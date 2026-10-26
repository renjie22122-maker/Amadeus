import test from 'node:test';
import assert from 'node:assert/strict';
import { transientModelFailure, modelReconnectDelay } from '../server/core/model-recovery.js';
import { AppError } from '../server/core/errors.js';
import { termination } from '../server/core/termination.js';
test('network recovery excludes credentials, cancellation, coding bugs and content refusals', () => {
  for (const code of ['MODEL_HTTP_401', 'MODEL_HTTP_403', 'MODEL_HTTP_400', 'INVALID_ARGUMENTS'])
    assert.equal(transientModelFailure(new AppError(code, 'no')), false);
  assert.equal(transientModelFailure(new TypeError('programming bug')), false);
  assert.equal(transientModelFailure(new DOMException('stop', 'AbortError')), false);
  assert.equal(
    transientModelFailure(
      Object.assign(new AppError('MODEL_INCOMPLETE', 'no'), { finishReason: 'content_filter' }),
    ),
    false,
  );
  assert.equal(
    transientModelFailure(
      new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) }),
    ),
    true,
  );
  assert.equal(transientModelFailure(new AppError('MODEL_STREAM_IDLE', 'idle')), true);
  assert.deepEqual([1, 2, 3, 4, 5].map(modelReconnectDelay), [2000, 4000, 8000, 16000, 30000]);
  assert.equal(termination(new AppError('INVALID_ARGUMENTS', 'bad')).recoverable, true);
  assert.equal(termination(new AppError('MODEL_TIMEOUT', 'timeout')).recoverable, true);
});

import { remainingModelTime, canReconnectModel } from '../server/core/model-recovery.js';
test('model transport retries share one deadline while preserving the five retry cap', () => {
  assert.equal(remainingModelTime(300000, 299000), 1000);
  assert.equal(canReconnectModel(0, 300000, 299000), false);
  assert.equal(canReconnectModel(0, 300000, 10000), true);
  assert.equal(canReconnectModel(5, 300000, 10000), false);
  assert.equal(remainingModelTime(300000, 310000), 0);
});
