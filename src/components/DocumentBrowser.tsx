import './DocumentBrowser.css';
import { useState } from 'react';
import { api } from '../api';
import { DocumentVersion } from './MemoryWorkbench';
export function DocumentBrowser({ documents, statuses, zh, go, query, scope }: any) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('current');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
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
    <section className="panel document-browser">
      <h3>{label('资料浏览与维护', 'Browse documents')}</h3>
      <div className="document-browser-toolbar">
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
      <div className="document-browser-pagination">
        <span>
          {label('找到 ', 'Found ')}
          <strong>{rows.length}</strong>
          {label(' 份资料', ' documents')} · {label('第 ', 'Page ')}
          {current + 1} / {pages}
        </span>
        <div>
          <button
            disabled={!current}
            onClick={() => {
              setPage(current - 1);
              setExpanded(undefined);
            }}
          >
            {label('上一页', 'Previous')}
          </button>
          <button
            disabled={current + 1 >= pages}
            onClick={() => {
              setPage(current + 1);
              setExpanded(undefined);
            }}
          >
            {label('下一页', 'Next')}
          </button>
        </div>
      </div>
      {filter === 'duplicate' && (
        <p className="muted">
          {label(
            '相同正文仅供人工核对，不会自动合并或删除。',
            'Identical text candidates are for review; no automatic merging or deletion.',
          )}
        </p>
      )}
      <div className="document-browser-cards">
        {rows.slice(current * 25, current * 25 + 25).map((d: any) => (
          <article
            key={d.id}
            className={'document-card' + (expanded === d.id ? ' is-expanded' : '')}
          >
            <div className="document-card-heading">
              <span className="document-file-type" aria-hidden="true">
                {d.name.split('.').length > 1
                  ? d.name.split('.').pop().slice(0, 6).toUpperCase()
                  : 'TXT'}
              </span>
              <div className="document-card-title">
                <h4 title={d.name}>{d.name}</h4>
                {d.reusedFrom && (
                  <small>
                    {label('复用版本 · 来源：', 'Reused snapshot · Source: ')}
                    {d.reusedFrom.scope} · v{d.reusedFrom.version}
                  </small>
                )}
                <div className="document-card-meta">
                  <span>
                    {d.characters.toLocaleString()} {label('字符', 'characters')}
                  </span>
                  <span>
                    {label('版本 ', 'Version ')}
                    {d.version || 1}
                    {d.validUntil ? ' · ' + label('历史', 'Historical') : ''}
                  </span>
                  <span
                    className={statuses[d.id]?.status === 'indexed' ? 'document-index-ready' : ''}
                  >
                    {statuses[d.id]?.status === 'indexed'
                      ? label('索引完整', 'Indexed')
                      : statuses[d.id]
                        ? label('索引待补齐', 'Incomplete index')
                        : label('索引待检查', 'Index unchecked')}
                  </span>
                  {(hashes.get(d.hash) || 0) > 1 && (
                    <span className="document-review-tag">
                      {label('正文重复候选', 'Possible duplicate')}
                    </span>
                  )}
                </div>
              </div>
              <button
                className="document-card-toggle"
                aria-expanded={expanded === d.id}
                aria-controls={'document-detail-' + d.id}
                onClick={() => setExpanded(expanded === d.id ? undefined : d.id)}
              >
                {expanded === d.id ? label('收起', 'Close') : label('查看／维护', 'View / manage')}
              </button>
            </div>
            {expanded === d.id && (
              <div className="document-card-detail" id={'document-detail-' + d.id}>
                <dl>
                  <dt>{label('来源', 'Source')}</dt>
                  <dd>{d.source || d.name}</dd>
                  <dt>{label('文档 ID', 'Document ID')}</dt>
                  <dd>{d.id}</dd>
                  {d.reusedFrom && (
                    <>
                      <dt>{label('原文档 ID（版本快照）', 'Original document ID (snapshot)')}</dt>
                      <dd>{d.reusedFrom.documentId}</dd>
                    </>
                  )}
                  <dt>{label('向量覆盖', 'Vector coverage')}</dt>
                  <dd>
                    {statuses[d.id]
                      ? statuses[d.id].completed +
                        '/' +
                        statuses[d.id].total +
                        label(' 分块', ' chunks')
                      : label('尚未获取状态', 'Not checked yet')}
                  </dd>
                </dl>
                <div className="document-card-actions">
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
                </div>
                <DocumentPreview id={d.id} zh={zh} />
                <DocumentVersion document={d} go={go} zh={zh} />
              </div>
            )}
          </article>
        ))}
      </div>
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
