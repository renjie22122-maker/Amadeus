import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function loginState(data) {
  if (data?.isLogin === true) return 'online';
  if (data?.qrLoginAccepted || ['qrcode_scanned', 'initializing'].includes(data?.loginPhase))
    return 'login-confirming';
  if (
    ['waiting_qrcode', 'generating_qrcode', 'offline'].includes(data?.loginPhase) ||
    (data?.isLogin === false && !!data?.qrcodeurl)
  )
    return 'login-required';
  if (data?.isOffline || data?.loginPhase === 'reconnecting') return 'reconnecting';
  return 'unknown';
}
export class LoginPrompt {
  constructor(saved = {}) {
    this.prompted = saved.prompted === true;
    this.since = 0;
    this.waitState = null;
  }
  observe(state, now = Date.now()) {
    if (state === 'online') {
      this.prompted = false;
      this.since = 0;
      return false;
    }
    if (!['login-required', 'reconnecting', 'login-confirming'].includes(state)) {
      this.since = 0;
      return false;
    }
    if (!this.since || this.waitState !== state) {
      this.since = now;
      this.waitState = state;
    }
    const delay = state === 'login-required' ? 15000 : 120000;
    if (this.prompted || now - this.since < delay) return false;
    this.prompted = true;
    return true;
  }
}
export function createLoginProbe(config, fetcher = fetch) {
  let credential = '',
    expires = 0;
  return async () => {
    if (!config.bridgeWebUiConfig || !config.bridgePage) return 'unconfigured';
    const base = new URL(config.bridgePage);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.username ||
      base.password
    )
      return 'unconfigured';
    const call = async (path, body, auth = '') => {
      const response = await fetcher(new URL('/api' + path, base.origin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw Error('Management probe failed');
      return result.data;
    };
    try {
      if (!credential || Date.now() >= expires) {
        const { token } = JSON.parse(
          readFileSync(config.bridgeWebUiConfig, 'utf8').replace(/^\uFEFF/, ''),
        );
        if (typeof token !== 'string' || !token) return 'management-auth-required';
        const login = await call('/auth/login', {
          hash: createHash('sha256')
            .update(token + '.napcat')
            .digest('hex'),
        });
        if (!login?.Credential) return 'management-auth-required';
        credential = login.Credential;
        expires = Date.now() + 45 * 60000;
      }
      return loginState(await call('/QQLogin/CheckLoginStatus', {}, credential));
    } catch {
      credential = '';
      return 'probe-unavailable';
    }
  };
}
