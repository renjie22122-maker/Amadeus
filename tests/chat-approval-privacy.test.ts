import test from 'node:test';
import assert from 'node:assert/strict';
import { chatApprovalContainsCredentials as sensitive } from '../server/services/chat-approval-privacy.js';
test('permission metadata keys and booleans are not credential values', () => {
  assert.equal(
    sensitive({
      serviceContext: {
        localityIsAuthorization: false,
        requiresAuthorization: true,
        credentialConfigured: true,
      },
      request: { prompt: 'Good evening.', options: { voice: 'fixture' } },
    }),
    false,
  );
});
test('actual credential fields stay local at any depth and with alternate key spelling', () => {
  for (const key of [
    'Authorization',
    'api_key',
    'X-API-Key',
    'serviceSecret',
    'access-token',
    'password',
    'clientSecret',
    'private_key',
    'Cookie',
  ]) {
    assert.equal(sensitive({ request: [{ headers: { [key]: 'fixture-value' } }] }), true, key);
  }
  for (const text of [
    'Bearer fixture',
    'password=fixture',
    '-----BEGIN RSA PRIVATE KEY-----',
    'api_key: fixture',
  ])
    assert.equal(sensitive({ command: text }), true);
});
test('nested text remains inspected despite benign metadata names', () => {
  assert.equal(sensitive({ localityIsAuthorization: 'Bearer fixture' }), true);
  assert.equal(sensitive({ request: [null, false, 1, { text: 'secret=fixture' }] }), true);
  assert.equal(sensitive({ authorization: null, api_key: '', request: 'hello' }), false);
});
