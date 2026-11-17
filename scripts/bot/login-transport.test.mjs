import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchLoginTransport } from './patch-login-transport.mjs';
const fixture = `async function KAe() {
  c.onLoginDisConnected = () => {
    o.isLogined = !1, pe.setQQLoginStatus(!1), pe.setQQLoginPhase("offline");
  }, c.onLogoutSucceed = () => { o.isLogined = false; }, c.onLoginConnected = () => {
    JAe(t, e).then(async () => {
      if (!o.isLogined) t.getQRCodePicture();
    });
  };
  return c;
}
async function VAe() {}`;
for (const version of ['4.18.38', '4.18.42'])
  test(`authenticated reconnect and explicit logout: ${version}`, async () => {
    let qr = 0,
      phase,
      online = true;
    const o = { isLogined: true },
      c = {};
    const context = {
      o,
      c,
      t: { getQRCodePicture: () => qr++ },
      e: { logWarn() {} },
      JAe: async () => {},
      pe: {
        setQQLoginStatus() {},
        setQQLoginError() {},
        setQQLoginPhase: (v) => (phase = v),
        getOneBotContext: () => ({ core: { selfInfo: { online } } }),
      },
    };
    context.de = context.pe;
    context.Tke = context.JAe;
    const source =
      version === '4.18.42'
        ? fixture
            .replaceAll('KAe', 'Ake')
            .replaceAll('VAe', 'Ike')
            .replaceAll('JAe', 'Tke')
            .replaceAll('pe.', 'de.')
        : fixture;
    vm.createContext(context);
    vm.runInContext(
      patchLoginTransport(Buffer.from(source)).toString() +
        (version === '4.18.42' ? '; Ake();' : '; KAe();'),
      context,
    );
    c.onLoginDisConnected();
    assert.equal(o.isLogined, true);
    assert.equal(phase, 'reconnecting');
    c.onLoginConnected();
    await new Promise(setImmediate);
    assert.equal(qr, 0);
    assert.equal(phase, 'ready');
    online = false;
    c.onLoginDisConnected();
    c.onLoginConnected();
    await new Promise(setImmediate);
    assert.equal(qr, 0);
    assert.equal(phase, 'reconnecting');
    c.onLogoutSucceed();
    c.onLoginConnected();
    await new Promise(setImmediate);
    assert.equal(qr, 1);
  });
test('transport patch preserves encoding, refuses unknown callbacks and is idempotent', () => {
  const original = Buffer.concat([Buffer.from([255, 128]), Buffer.from(fixture)]);
  const patched = patchLoginTransport(original);
  assert.deepEqual(patched.subarray(0, 2), original.subarray(0, 2));
  assert.deepEqual(patchLoginTransport(patched), patched);
  assert.throws(() => patchLoginTransport(Buffer.from('changed bridge')));
  assert.throws(() =>
    patchLoginTransport(Buffer.from(fixture.replace('o.isLogined = !1', 'customLogout()'))),
  );
});
