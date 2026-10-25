import { useState } from 'react';
import { mcpExamples } from '../../shared/mcp-examples';
import type { Settings } from '../../shared/types';
export function McpExamples({
  add,
  zh,
}: {
  add: (server: Settings['mcp'][number]) => void;
  zh: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const example = mcpExamples[selected];
  return (
    <div className="panel">
      <label>
        {zh ? '官方 MCP 配置示例' : 'Official MCP configuration examples'}
        <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
          {mcpExamples.map((e, i) => (
            <option key={e.name} value={i}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        {example.note} ·{' '}
        <a href={example.source} target="_blank" rel="noreferrer">
          {zh ? '官方说明' : 'Official instructions'}
        </a>
      </p>
      <pre>{JSON.stringify(example.config, null, 2)}</pre>
      <p className="muted">
        {zh
          ? '添加后仍为禁用状态。请核对程序版本、路径及账号权限，再保存并启用；本地程序需要已安装 Node.js 或 uv。'
          : 'Added disabled. Review versions, paths and account permissions before saving and enabling; local examples require Node.js or uv.'}
      </p>
      <button
        type="button"
        onClick={() =>
          add({
            ...structuredClone(example.config),
            id: crypto.randomUUID(),
            name: example.name,
            enabled: false,
          })
        }
      >
        {zh ? '添加此配置' : 'Add configuration'}
      </button>
    </div>
  );
}
