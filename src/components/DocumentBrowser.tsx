import { useState } from 'react';
import { api } from '../api';
import { DocumentVersion } from './MemoryWorkbench';
export function DocumentBrowser({ documents, statuses, zh, go, query, scope }: any) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('current');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const hashes = new Map<string, number>();
  for (const d of documents)
    if (d.hash && !d.validUntil) hashes.set(d.hash, (hashes.get(d.hash) || 0) + 1);
  const rows = documents
    .filter((d: any) => {
      if (
        !(d.name + ' ' + (d.source || '') + ' ' + d.id)
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())
      )
        return false;
      if (filter === 'current') return !d.validUntil;
      if (filter === 'old') return !!d.validUntil;
      if (filter === 'missing') return !d.validUntil && statuses[d.id]?.status !== 'indexed';
      if (filter === 'duplicate') return !d.validUntil && (hashes.get(d.hash) || 0) > 1;
      return true;
    })
    .sort((a: any, b: any) =>
      sort === 'size'
        ? b.characters - a.characters
        : sort === 'date'
          ? b.createdAt - a.createdAt
          : a.name.localeCompare(b.name),
    );
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const current = Math.min(page, pages - 1);
  const label = (cn: string, en: string) => (zh ? cn : en);
  return (
    <section className="panel">
      <h3>{label('资料浏览与维护', 'Browse documents')}</h3>
      <div className="row">
        <input
          aria-label={label('搜索资料', 'Search documents')}
          placeholder={label('文件名、来源路径或文档 ID', 'Name, source or document ID')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label={label('筛选', 'Filter')}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="current">{label('当前版本', 'Current')}</option>
          <option value="all">{label('全部版本', 'All')}</option>
          <option value="old">{label('历史版本', 'Historical')}</option>
          <option value="missing">
            {label('向量待补齐／状态待确认', 'Missing vectors / unknown status')}
          </option>
          <option value="duplicate">{label('相同正文候选', 'Identical text candidates')}</option>
        </select>
        <select
          aria-label={label('排序', 'Sort')}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(0);
          }}
        >
          <option value="name">{label('名称', 'Name')}</option>
          <option value="size">{label('正文最长', 'Longest text')}</option>
          <option value="date">{label('最新导入', 'Newest')}</option>
        </select>
      </div>
      <p className="muted">
        {label(
          '同正文按提取文本哈希识别，仅供人工核对，不自动合并或删除。清洗后可保存新版本，旧版引用保留。',
          'Identical extracted-text hashes are review candidates only. No automatic merge or deletion. Save cleaned text as a new version; old citations remain.',
        )}
      </p>
      <p>
        {rows.length} · {current + 1}/{pages}{' '}
        <button disabled={!current} onClick={() => setPage(current - 1)}>
          {label('上一页', 'Previous')}
        </button>
        <button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
          {label('下一页', 'Next')}
        </button>
      </p>
      {rows.slice(current * 25, current * 25 + 25).map((d: any) => (
        <article
          key={d.id}
          style={{
            borderTop: '1px solid var(--border)',
            padding: '12px 0',
            overflowWrap: 'anywhere',
          }}
        >
          <strong>{d.name}</strong>
          <p className="muted">
            {d.characters.toLocaleString()} {label('字符', 'characters')} ·{' '}
            {d.validUntil ? label('历史', 'Historical') : label('当前', 'Current')} · v
            {d.version || 1}
            {(hashes.get(d.hash) || 0) > 1
              ? ' · ' + label('相同正文候选', 'Identical text candidate')
              : ''}
          </p>
          <p className="muted">{d.source || d.name}</p>
          <p>
            {statuses[d.id]
              ? label('向量 ', 'Vectors ') + statuses[d.id].completed + '/' + statuses[d.id].total
              : label('向量状态待确认', 'Vector status unknown')}
          </p>
          {!d.validUntil && (
            <button
              disabled={statuses[d.id]?.status === 'indexed'}
              onClick={() => go(() => api('/knowledge/' + d.id + '/index', {}))}
            >
              {label('检查并补齐向量', 'Check and fill vectors')}
            </button>
          )}
          {query && (
            <button
              onClick={() =>
                go(() => api('/knowledge/feedback', { scope, query, documentId: d.id }))
              }
            >
              {label('标记为本次查询来源', 'Mark as source for this query')}
            </button>
          )}
          <button
            onClick={() => {
              if (
                window.confirm(
                  label(
                    '移除此知识库文档及索引？源文件不会删除，自动维护可能重新导入。',
                    'Remove this library document and index? Source files remain and maintenance may import them again.',
                  ),
                )
              )
                go(() => api('/knowledge/' + d.id, undefined, 'DELETE'));
            }}
          >
            {label('移出知识库', 'Remove from library')}
          </button>
          <DocumentPreview id={d.id} zh={zh} />
          <DocumentVersion document={d} go={go} zh={zh} />
        </article>
      ))}
      {!rows.length && <p>{label('没有匹配资料', 'No matching documents')}</p>}
    </section>
  );
}
function DocumentPreview({ id, zh }: { id: string; zh: boolean }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load(offset = 0) {
    setLoading(true);
    setError('');
    try {
      setData(await api('/knowledge/' + id + '/chunks?offset=' + offset + '&limit=5'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !data && !loading) void load();
      }}
    >
      <summary>{zh ? '查看提取正文（分块加载）' : 'Preview extracted chunks'}</summary>
      {loading && <p>{zh ? '加载中…' : 'Loading…'}</p>}
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            {data.offset + 1}–{data.offset + data.chunks.length} / {data.total}
          </p>
          {data.chunks.map((c: any) => (
            <pre key={c.id} style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
              {c.text}
            </pre>
          ))}
          <button
            disabled={loading || !data.offset}
            onClick={() => void load(Math.max(0, data.offset - 5))}
          >
            {zh ? '上一组' : 'Previous'}
          </button>
          <button
            disabled={loading || data.offset + data.chunks.length >= data.total}
            onClick={() => void load(data.offset + 5)}
          >
            {zh ? '下一组' : 'Next'}
          </button>
        </>
      )}
    </details>
  );
}
