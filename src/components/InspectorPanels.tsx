import { Markdown } from './Markdown';
import { useEffect, useState } from 'react';
import { Folder, FileText, ArrowUp, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { ContextUsage } from './ContextUsage';
import { WebPreview } from './WebPreview';
const inspectionCache = new Map<string, { data: any; at: number }>();
const inspectionPending = new Map<string, Promise<any>>();
function requestInspection(url: string) {
  let pending = inspectionPending.get(url);
  if (!pending) {
    pending = api(url)
      .then((data) => {
        inspectionCache.delete(url);
        inspectionCache.set(url, { data, at: Date.now() });
        while (inspectionCache.size > 24)
          inspectionCache.delete(inspectionCache.keys().next().value!);
        return data;
      })
      .finally(() => inspectionPending.delete(url));
    inspectionPending.set(url, pending);
  }
  return pending;
}
export function useInspectionResource(url: string | null, live: boolean) {
  const [state, setState] = useState<{ url: string | null; data: any }>({ url: null, data: null });
  const [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    setError('');
    if (!url) return;
    const cached = inspectionCache.get(url);
    if (cached) setState({ url, data: cached.data });
    const load = async () => {
      try {
        const data = await requestInspection(url);
        if (active) {
          setState({ url, data });
          setError('');
        }
      } catch (e: any) {
        if (active) setError(e.message);
      } finally {
        if (active && live) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [url, live, revision]);
  const data = state.url === url ? state.data : url ? inspectionCache.get(url)?.data : null;
  return { data, error, refresh: () => setRevision((n) => n + 1) };
}
export function ContextPanel({ id, zh, live }: { id: string; zh: boolean; live: boolean }) {
  const [offset, setOffset] = useState(0),
    [run, setRun] = useState('');
  const { data, error, refresh } = useInspectionResource(
    '/conversations/' +
      id +
      '/context?offset=' +
      offset +
      (run ? '&runId=' + encodeURIComponent(run) : ''),
    live,
  );
  return (
    <div className="inspection-panel">
      <div className="inspection-caption">
        <strong>{zh ? '模型上下文' : 'Model context'}</strong>
        <button aria-label={zh ? '刷新上下文' : 'Refresh context'} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">{zh ? '\u52a0\u8f7d\u4e2d\u2026' : 'Loading…'}</p>}
      {data && (
        <>
          <label>
            {zh ? '运行轮次' : 'Run'}
            <select
              value={run}
              onChange={(e) => {
                setRun(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">{zh ? '最新一轮' : 'Latest run'}</option>
              {data.runs.map((r: any, i: number) => (
                <option key={r.id} value={r.id}>
                  {data.runs.length - i} · {new Date(r.createdAt).toLocaleTimeString()} · {r.status}
                </option>
              ))}
            </select>
          </label>
          <ContextUsage data={data} zh={zh} />
          <div className="inspection-metrics">
            <span>
              <b>{data.total}</b>
              {zh ? '条消息' : 'messages'}
            </span>
            <span>
              <b>{data.characters.toLocaleString()}</b>
              {zh ? '序列化字符' : 'serialized chars'}
            </span>
            <span>
              <b>{data.compactionCount ?? data.compactions.length}</b>
              {zh ? '次压缩（本对话累计）' : 'compactions in this conversation'}
              {' · '}
              {data.compactions.length}
              {zh ? ' 次（所选轮次）' : ' in selected run'}
            </span>
          </div>
          <p className="muted">
            {data.model} · {zh ? '模型容量' : 'Model capacity'}{' '}
            {data.capacity?.toLocaleString() || '—'} tokens
          </p>
          <p className="inspection-note">
            {zh ? '最近请求 API 实测输入' : 'Latest request API input'}:{' '}
            {data.measuredInput?.toLocaleString() ?? '—'} tokens
            <br />
            {zh ? '压缩触发阈值（tokens）' : 'Compression threshold (tokens)'}:{' '}
            {data.compressionThresholdTokens?.toLocaleString() ?? '—'}
          </p>
          <p className="inspection-note">
            {zh
              ? '这是保存的上下文检查点，不是累计账单 token，也不包含尚未保存的流式片段。'
              : 'Saved context checkpoint; not cumulative billed tokens or unsaved streaming fragments.'}
          </p>
          {!!data.compactions.length && (
            <details>
              <summary>{zh ? '压缩记录' : 'Compaction history'}</summary>
              {data.compactions.map((c: any, i: number) => (
                <p key={i} className="inspection-note">
                  {new Date(c.at).toLocaleTimeString()} · {c.beforeCharacters} → {c.afterCharacters}{' '}
                  {zh ? '字符' : 'characters'}
                  {c.economics && (
                    <>
                      <br />
                      {zh ? '摘要费用' : 'Summary cost'}:{' '}
                      {c.economics.summaryUsd == null
                        ? zh
                          ? '未知'
                          : 'unknown'
                        : '$' + c.economics.summaryUsd.toFixed(6)}
                      {' · '}
                      {zh ? '估算回本请求数' : 'Estimated break-even requests'}:{' '}
                      {c.economics.breakEvenRequests ?? (zh ? '未知' : 'unknown')}
                      <br />
                      <small>
                        {zh
                          ? '包含缓存重建估算；取决于后续上下文与缓存比例，不是账单保证。'
                          : 'Includes estimated cache rewarm; depends on future context and cache ratio, not guaranteed billing savings.'}
                      </small>
                    </>
                  )}
                </p>
              ))}
            </details>
          )}
          {data.messages.map((m: any) => (
            <details className="context-entry" key={data.runId + ':' + m.index}>
              <summary>
                <span>
                  {m.index + 1}. {m.role}
                </span>
                <small>{m.characters.toLocaleString()}</small>
              </summary>
              <pre>{m.text}</pre>
              {m.truncated && (
                <p className="inspection-note">
                  {zh ? '此条仅展示前 16,000 字符。' : 'Showing the first 16,000 characters.'}
                </p>
              )}
            </details>
          ))}
          {!data.total && (
            <p className="muted">
              {zh ? '发送消息后可查看上下文。' : 'Send a message to inspect context.'}
            </p>
          )}
          <div className="inspection-pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 10))}>
              {zh ? '上一页' : 'Previous'}
            </button>
            <span>
              {Math.min(offset + 1, data.total)}–{Math.min(offset + 10, data.total)} / {data.total}
            </span>
            <button disabled={offset + 10 >= data.total} onClick={() => setOffset(offset + 10)}>
              {zh ? '下一页' : 'Next'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
export function FilesPanel({ id, zh, live }: { id: string; zh: boolean; live: boolean }) {
  const [path, setPath] = useState('@0/.'),
    [file, setFile] = useState(''),
    [preview, setPreview] = useState(false);
  const { data, error, refresh } = useInspectionResource(
    '/conversations/' + id + '/files?path=' + encodeURIComponent(path),
    live,
  );
  const text = useInspectionResource(
    file ? '/conversations/' + id + '/files?view=text&path=' + encodeURIComponent(file) : null,
    false,
  );
  const open = (name: string, type: string) => {
    const next = path.replace(/\/\.$/, '').replace(/\/$/, '') + '/' + name;
    if (type === 'directory') {
      setPath(next);
      setFile('');
      setPreview(false);
    } else {
      setFile(next);
      setPreview(false);
    }
  };
  return (
    <div className="inspection-panel">
      <div className="inspection-caption">
        <strong>{zh ? '文件浏览' : 'Files'}</strong>
        <button aria-label={zh ? '刷新文件' : 'Refresh files'} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      {data && (
        <>
          <p className="inspection-note">
            {data.kind === 'artifacts'
              ? zh
                ? '普通对话的独立产物目录，未绑定项目。'
                : 'Conversation artifacts; no project is attached.'
              : data.kind === 'isolated'
                ? zh
                  ? '子任务独立副本；修改尚未自动进入主目录。'
                  : 'Isolated child copy; changes are not automatically merged.'
                : zh
                  ? '项目授权目录'
                  : 'Authorized project folders'}
          </p>
          <select
            aria-label={zh ? '工作区目录' : 'Workspace folder'}
            value={path.match(/^@\d+/)?.[0] || '@0'}
            onChange={(e) => {
              setPath(e.target.value + '/.');
              setFile('');
              setPreview(false);
            }}
          >
            {data.roots.map((r: string, i: number) => (
              <option key={r} value={'@' + i}>
                {'@' + i + ' · ' + r}
              </option>
            ))}
          </select>
          <div className="file-breadcrumb">
            <button
              aria-label={zh ? '上级目录' : 'Parent folder'}
              disabled={/^@\d+\/\.?$/.test(path)}
              onClick={() => {
                setPath(path.replace(/\/\.$/, '').split('/').slice(0, -1).join('/') + '/.');
                setFile('');
              }}
            >
              <ArrowUp size={14} />
            </button>
            <code>{path}</code>
          </div>
          <div className="workspace-entries">
            {data.entries.map((e: any) => (
              <button
                className={file.endsWith('/' + e.name) ? 'selected' : ''}
                key={e.name}
                onClick={() => open(e.name, e.type)}
              >
                {e.type === 'directory' ? <Folder size={15} /> : <FileText size={15} />}
                <span>{e.name}</span>
              </button>
            ))}
          </div>
          {!data.entries.length && <p className="muted">{zh ? '目录为空' : 'Empty folder'}</p>}
          {data.truncated && (
            <p className="inspection-note">
              {zh ? '仅列出前 500 项。' : 'Showing the first 500 entries.'}
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {file && (
        <section className="file-preview">
          <strong>{file}</strong>
          {text.error && <p role="alert">{text.error}</p>}
          {text.data && (
            <>
              <div className="preview-actions">
                <button onClick={() => setPreview(false)} aria-pressed={!preview}>
                  {zh ? '源码' : 'Source'}
                </button>
                {/\.(html?|md|markdown)$/i.test(file) && (
                  <button onClick={() => setPreview(true)} aria-pressed={preview}>
                    {zh ? '预览' : 'Preview'}
                  </button>
                )}
              </div>
              {preview ? (
                /\.(md|markdown)$/i.test(file) ? (
                  <Markdown text={text.data.text} />
                ) : (
                  <WebPreview id={id} path={file} source={text.data.text} zh={zh} />
                )
              ) : (
                <pre>{text.data.text}</pre>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
