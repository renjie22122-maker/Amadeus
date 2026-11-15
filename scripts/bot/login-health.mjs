import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function loginState(data) {
  // Explicit current phases override stale QR URLs and cached login flags.
  if (data?.loginPhase === 'reconnecting') return 'reconnecting';
  if (['qrcode_scanned', 'initializing'].includes(data?.loginPhase)) return 'login-confirming';
  if (['waiting_qrcode', 'generating_qrcode', 'offline'].includes(data?.loginPhase))
    return 'login-required';
  if (data?.isOffline === true) return 'reconnecting';
  if (data?.isLogin === true) return 'online';
  if (data?.qrLoginAccepted === true) return 'login-confirming';
  if (data?.isLogin === false && typeof data?.qrcodeurl === 'string' && data.qrcodeurl)
    return 'login-required';
  return 'unknown';
}
export class LoginPrompt {
  constructor(saved = {}) {
    this.prompted = saved.prompted === true;
    this.since = null;
    this.requiredSince = null;
  }
  observe(state, now = Date.now()) {
    if (state === 'online') {
      this.prompted = false;
      this.since = null;
      this.requiredSince = null;
      return false;
    }
    if (state !== 'login-required') this.requiredSince = null;
    if (!['login-required', 'reconnecting', 'login-confirming'].includes(state)) return false;
    // One outage may alternate between reconnecting and confirming; do not reset its deadline.
    if (this.since === null) this.since = now;
    if (state === 'login-required' && this.requiredSince === null) this.requiredSince = now;
    const elapsed = state === 'login-required' ? now - this.requiredSince : now - this.since;
    const delay = state === 'login-required' ? 15000 : 120000;
    if (this.prompted || elapsed < delay) return false;
    this.prompted = true;
    return true;
  }
}
export function createLoginProbe(config, fetcher = fetch) {
  let credential = '',
    expires = 0;
  return async () => {
    if (!config.bridgeWebUiConfig || !config.bridgePage) return 'unconfigured';
    let base;
    try {
      base = new URL(config.bridgePage);
    } catch {
      return 'unconfigured';
    }
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
