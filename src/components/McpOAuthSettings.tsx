import { useState } from 'react';
import { api } from '../api';
import type { Settings } from '../../shared/types';
export function McpOAuthSettings({
  server,
  update,
  zh,
}: {
  server: Settings['mcp'][number];
  update: (patch: Partial<Settings['mcp'][number]>) => void;
  zh: boolean;
}) {
  const [message, setMessage] = useState(''),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false);
  const action = async (kind: 'login' | 'logout' | 'status') => {
    setBusy(true);
    setMessage('');
    setUrl('');
    try {
      const result = await api(
        '/mcp/' + encodeURIComponent(server.id) + '/oauth' + (kind === 'status' ? '' : '/' + kind),
        kind === 'status' ? undefined : {},
      );
      if (result.authorizationUrl) {
        setUrl(result.authorizationUrl);
        setMessage(
          zh
            ? '打开下方链接完成授权，再检查登录状态。'
            : 'Open the link to authorize, then check sign-in status.',
        );
      } else
        setMessage(
          (result.signedIn ? (zh ? '已登录' : 'Signed in') : zh ? '未登录' : 'Signed out') +
            (result.callbackUrl ? ` · Callback: ${result.callbackUrl}` : ''),
        );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const oauth = server.oauth || { enabled: false };
  return (
    <div className="wide">
      <label>
        <input
          type="checkbox"
          checked={oauth.enabled}
          onChange={(e) =>
            update({
              oauth: { ...oauth, enabled: e.target.checked },
              bearerTokenEnv: e.target.checked ? undefined : server.bearerTokenEnv,
            })
          }
        />
        {zh ? '使用 OAuth 网页登录' : 'Use OAuth browser sign-in'}
      </label>
      {oauth.enabled && (
        <>
          <p className="muted">
            {zh
              ? '先保存并启用此服务，再登录。留空客户端 ID 使用动态注册；预注册客户端须填写签发方。登录凭据不会进入模型上下文。'
              : 'Save and enable this server before signing in. An empty client ID uses dynamic registration; registered clients require an issuer. Credentials stay outside model context.'}
          </p>
          <div className="form-grid">
            <label>
              Client ID
              <input
                value={oauth.clientId || ''}
                onChange={(e) =>
                  update({ oauth: { ...oauth, clientId: e.target.value || undefined } })
                }
              />
            </label>
            <label>
              {zh ? '签发方地址（Issuer）' : 'Issuer URL'}
              <input
                value={oauth.issuer || ''}
                onChange={(e) =>
                  update({ oauth: { ...oauth, issuer: e.target.value || undefined } })
                }
              />
            </label>
            <label>
              {zh
                ? '客户端密钥环境变量名（可选）'
                : 'Client secret environment variable (optional)'}
              <input
                value={oauth.clientSecretEnv || ''}
                onChange={(e) =>
                  update({ oauth: { ...oauth, clientSecretEnv: e.target.value || undefined } })
                }
              />
            </label>
            <label>
              {zh ? '授权范围（空格分隔，可选）' : 'Scopes (space separated, optional)'}
              <input
                value={(oauth.scopes || []).join(' ')}
                onChange={(e) => update({ oauth: { ...oauth, scopes: e.target.value.split(' ') } })}
                onBlur={() =>
                  update({ oauth: { ...oauth, scopes: oauth.scopes?.filter(Boolean) } })
                }
              />
            </label>
          </div>
          <button disabled={busy} onClick={() => action('login')}>
            {zh ? '开始登录' : 'Sign in'}
          </button>{' '}
          <button disabled={busy} onClick={() => action('status')}>
            {zh ? '检查登录状态' : 'Check sign-in'}
          </button>{' '}
          <button disabled={busy} onClick={() => action('logout')}>
            {zh ? '清除本机登录' : 'Forget local login'}
          </button>
          {url && (
            <p>
              <a href={url} target="_blank" rel="noreferrer">
                {zh ? '打开授权页面' : 'Open authorization page'}
              </a>
            </p>
          )}
          <p role="status">{message}</p>
        </>
      )}
    </div>
  );
}
