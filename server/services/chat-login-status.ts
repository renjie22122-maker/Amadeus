import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatConnection } from '../../shared/chat-connections.js';
export function localLoginStatus(directory: string, c: ChatConnection, now = Date.now()) {
  if (!c.enabled || !['onebot11', 'onebot12'].includes(c.transport)) return undefined;
  try {
    const config = JSON.parse(
      readFileSync(join(directory, 'bot', 'config.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    const state = JSON.parse(readFileSync(config.offline.statusFile + '.login.json', 'utf8'));
    if (
      now - state.at > 60000 ||
      state.at > now + 5000 ||
      String(state.accountId) !== String(c.accountId) ||
      new URL(state.endpoint).href !== new URL(c.endpoint).href
    )
      return undefined;
    if (state.state === 'login-required')
      return {
        status: 'login-required',
        error: 'QQ 登录已失效或正在等待扫码，请在本机 NapCat 登录页确认登录。',
        updatedAt: state.at,
      };
    if (state.state === 'login-confirming')
      return {
        status: 'login-confirming',
        error: '已扫码，正在等待手机确认或 QQ 初始化。',
        updatedAt: state.at,
      };
  } catch {}
  return undefined;
}
