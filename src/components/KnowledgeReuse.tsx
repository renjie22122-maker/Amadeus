import { useState } from 'react';
import { api } from '../api';
export function KnowledgeReuse({
  scope,
  documents,
  projects,
  conversations,
  zh,
  refresh,
  notify,
}: any) {
  const [source, setSource] = useState('general');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const label = (cn: string, en: string) => (zh ? cn : en);
  const present = new Set(
    documents
      .filter((d: any) => d.scope === scope && !d.validUntil)
      .map((d: any) => d.reusedFrom?.documentId),
  );
  const rows = documents.filter(
    (d: any) =>
      d.scope === source &&
      !d.validUntil &&
      (d.validFrom ?? 0) <= Date.now() &&
      (d.name + ' ' + (d.source || '')).toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const current = Math.min(page, pages - 1);
  async function reuse() {
    setBusy(true);
    let completed = 0,
      vectors = 0,
      missing = 0;
    try {
      for (const sourceId of selected) {
        const result = await api('/knowledge/reuse', {
          sourceId,
          sourceScope: source,
          targetScope: scope,
        });
        vectors += result.reusedVectors || 0;
        missing += result.pendingVectors || 0;
        completed++;
        setSelected((old) => old.filter((id) => id !== sourceId));
        setProgress(`${completed} / ${selected.length}`);
      }
      setProgress(
        label(
          `已加入 ${completed} 份，复用 ${vectors} 个向量；${missing} 个分块待补齐`,
          `Added ${completed}; reused ${vectors} vectors; ${missing} chunks need indexing`,
        ),
      );
    } catch (e: any) {
      notify(e.message);
    } finally {
      try {
        await refresh();
      } catch (e: any) {
        notify(e.message);
      } finally {
        setBusy(false);
      }
    }
  }
  return (
    <details className="panel">
      <summary>{label('从已有知识库复用文档', 'Reuse documents from another library')}</summary>
      <p className="muted">
        {label(
          '仅加入选中的当前版本，复用同模型有效向量，不调用向量服务。来源更新不会自动覆盖；移除项目副本不影响原库。缺失或模型不一致的向量可用“批量补齐”处理。',
          'Add selected version snapshots with valid vectors for the current model, without embedding requests. Source updates do not overwrite copies; removing a copy leaves the source intact. Use index completion for missing or incompatible vectors.',
        )}
      </p>
      <label>
        {label('来源知识库', 'Source library')}
        <select
          disabled={busy}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setSelected([]);
            setPage(0);
            setProgress('');
          }}
        >
          <option value="general">{label('普通对话共享知识库', 'General shared library')}</option>
          {projects
            .filter((p: any) => !p.removedAt && 'project:' + p.id !== scope)
            .map((p: any) => (
              <option key={p.id} value={'project:' + p.id}>
                {p.name}
              </option>
            ))}
          {conversations.map((c: any) => (
            <option key={c.id} value={'session:' + c.id}>
              {label('对话：', 'Chat: ')}
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <input
        disabled={busy}
        aria-label={label('搜索可复用文档', 'Search reusable documents')}
        placeholder={label('搜索名称或来源', 'Search name or source')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {rows.slice(current * 20, current * 20 + 20).map((d: any) => (
          <label
            key={d.id}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 10,
            }}
          >
            <input
              type="checkbox"
              style={{ width: 'auto', flex: '0 0 auto', margin: 0 }}
              disabled={busy || present.has(d.id)}
              checked={present.has(d.id) || selected.includes(d.id)}
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked ? [...old, d.id] : old.filter((id) => id !== d.id),
                )
              }
            />
            <span>
              {d.name}
              {present.has(d.id) ? label(' · 已加入', ' · Already added') : ''}
              <small style={{ display: 'block' }}>
                {d.characters} {label('字符', 'characters')}
              </small>
            </span>
          </label>
        ))}
      </div>
      {!rows.length && <p>{label('此来源没有匹配的当前文档', 'No matching current documents')}</p>}
      <div className="row wrap">
        <button disabled={busy || current === 0} onClick={() => setPage(current - 1)}>
          {label('上一页', 'Previous')}
        </button>
        <span>
          {current + 1} / {pages} · {rows.length}
        </span>
        <button disabled={busy || current + 1 >= pages} onClick={() => setPage(current + 1)}>
          {label('下一页', 'Next')}
        </button>
        <button disabled={busy || !selected.length} onClick={() => void reuse()}>
          {label('加入当前项目', 'Add to this project')} ({selected.length})
        </button>
      </div>
      {progress && <p role="status">{progress}</p>}
    </details>
  );
}
