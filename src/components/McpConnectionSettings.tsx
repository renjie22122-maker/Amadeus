import type { Settings } from '../../shared/types';

type Server = Settings['mcp'][number];
export function McpConnectionSettings({
  server,
  update,
  zh,
}: {
  server: Server;
  update: (patch: Partial<Server>) => void;
  zh: boolean;
}) {
  return (
    <div className="form-grid">
      {!server.builtin && (
        <label>
          {zh ? '连接方式' : 'Connection'}
          <select
            value={server.transport || 'stdio'}
            onChange={(e) => update({ transport: e.target.value as 'stdio' | 'http' })}
          >
            <option value="stdio">Stdio</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
      )}
      {server.transport === 'http' ? (
        <>
          <label>
            {zh ? '服务地址' : 'Endpoint'}
            <input
              value={server.url || ''}
              placeholder="https://example.com/mcp"
              onChange={(e) => update({ url: e.target.value })}
            />
          </label>
          <label>
            {zh ? '令牌环境变量名（可选）' : 'Token environment variable (optional)'}
            <input
              value={server.bearerTokenEnv || ''}
              placeholder="MCP_ACCESS_TOKEN"
              onChange={(e) => update({ bearerTokenEnv: e.target.value || undefined })}
            />
          </label>
        </>
      ) : (
        <div className="wide">
          <p>
            {zh
              ? '环境变量引用：目标变量名 → 宿主变量名（不填写密钥值）'
              : 'Environment references: child variable → host variable (never enter secret values)'}
          </p>
          {Object.entries(server.envFromHost || {}).map(([key, value], index) => (
            <div className="form-grid" key={index}>
              <input
                aria-label="Child environment variable"
                value={key}
                onChange={(e) =>
                  update({
                    envFromHost: Object.fromEntries(
                      Object.entries(server.envFromHost || {}).map(([k, v]) => [
                        k === key ? e.target.value : k,
                        v,
                      ]),
                    ),
                  })
                }
              />
              <input
                aria-label="Host environment variable"
                value={value}
                onChange={(e) =>
                  update({ envFromHost: { ...server.envFromHost, [key]: e.target.value } })
                }
              />
              <button
                type="button"
                onClick={() =>
                  update({
                    envFromHost: Object.fromEntries(
                      Object.entries(server.envFromHost || {}).filter(([k]) => k !== key),
                    ),
                  })
                }
              >
                {zh ? '删除' : 'Remove'}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              update({
                envFromHost: {
                  ...server.envFromHost,
                  ['MCP_VARIABLE_' + Object.keys(server.envFromHost || {}).length]: 'HOST_VARIABLE',
                },
              })
            }
          >
            {zh ? '添加环境变量引用' : 'Add environment reference'}
          </button>
        </div>
      )}
      {server.transport !== 'http' && (
        <label>
          {zh ? '工作目录（可选，绝对路径）' : 'Working directory (optional, absolute path)'}
          <input
            value={server.cwd || ''}
            onChange={(e) => update({ cwd: e.target.value || undefined })}
          />
        </label>
      )}
      <label>
        {zh ? '连接与发现超时（秒）' : 'Connection and discovery timeout (seconds)'}
        <input
          type="number"
          min={1}
          max={120}
          value={server.startupTimeoutSeconds ?? 20}
          onChange={(e) =>
            update({ startupTimeoutSeconds: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </label>
      <label>
        {zh ? '工具调用超时（秒）' : 'Tool timeout (seconds)'}
        <input
          type="number"
          min={1}
          max={600}
          value={server.toolTimeoutSeconds ?? 120}
          onChange={(e) =>
            update({ toolTimeoutSeconds: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </label>
      {server.transport === 'http' && (
        <div className="wide">
          <p>
            {zh
              ? '请求头名 → 宿主环境变量名（不填写密钥值）'
              : 'Header name → host environment variable (never enter secret values)'}
          </p>
          {Object.entries(server.headersFromHost || {}).map(([key, value], index) => (
            <div className="form-grid" key={index}>
              <input
                aria-label="HTTP header name"
                value={key}
                onChange={(e) =>
                  update({
                    headersFromHost: Object.fromEntries(
                      Object.entries(server.headersFromHost || {}).map(([k, v]) => [
                        k === key ? e.target.value : k,
                        v,
                      ]),
                    ),
                  })
                }
              />
              <input
                aria-label="Header environment variable"
                value={value}
                onChange={(e) =>
                  update({ headersFromHost: { ...server.headersFromHost, [key]: e.target.value } })
                }
              />
              <button
                type="button"
                onClick={() =>
                  update({
                    headersFromHost: Object.fromEntries(
                      Object.entries(server.headersFromHost || {}).filter(([k]) => k !== key),
                    ),
                  })
                }
              >
                {zh ? '删除' : 'Remove'}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              update({
                headersFromHost: {
                  ...server.headersFromHost,
                  ['X-MCP-Custom-' + Object.keys(server.headersFromHost || {}).length]:
                    'HOST_VARIABLE',
                },
              })
            }
          >
            {zh ? '添加请求头引用' : 'Add header reference'}
          </button>
        </div>
      )}
      <label className="wide">
        <input
          type="checkbox"
          checked={server.allowedTools !== undefined}
          onChange={(e) => update({ allowedTools: e.target.checked ? [] : undefined })}
        />
        {zh
          ? '仅开放指定工具（启用且为空时不开放任何工具）'
          : 'Allow only named tools (enabled and empty permits none)'}
      </label>
      {server.allowedTools !== undefined && (
        <label className="wide">
          {zh ? '工具名称，每行一个' : 'Exact tool names, one per line'}
          <textarea
            value={server.allowedTools.join('\n')}
            onChange={(e) => update({ allowedTools: e.target.value.split('\n') })}
            onBlur={() =>
              update({ allowedTools: server.allowedTools?.map((s) => s.trim()).filter(Boolean) })
            }
          />
        </label>
      )}
    </div>
  );
}
