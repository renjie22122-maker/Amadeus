import { chartDocument } from '../chart-spec';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Eye, Code2, RotateCcw, Copy, Check, ShieldCheck, ArrowDownToLine, X } from 'lucide-react';
import { previewDocument } from '../markdown-rich';
import { PreviewContext } from '../preview-context';
import { parsePreviewResult, type PreviewResult } from '../preview-results';

export function CodePreview({
  source,
  language = 'html',
  code,
}: {
  source: string;
  language?: string;
  code?: ReactNode;
}) {
  const { zh, onResult, sourceId } = useContext(PreviewContext);
  const label = (en: string, cn: string) => (zh ? cn : en);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [version, setVersion] = useState(0);
  const [size, setSize] = useState('auto');
  const [contentHeight, setContentHeight] = useState(440);
  const [ready, setReady] = useState('');
  const [diagram, setDiagram] = useState('');
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [results, setResults] = useState<(PreviewResult & { id: string; added: boolean })[]>([]);
  const [active, setActive] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [full, setFull] = useState(false);
  const result = results[active];
  const enabled = !!onResult;
  const frame = useRef<HTMLIFrameElement>(null);
  const count = useRef(0);
  const token = useMemo(() => crypto.randomUUID(), [ready, version]);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => {
    if (language !== 'chart') return;
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [language]);
  const isDiagram = language === 'mermaid';
  const chart = useMemo(() => {
    if (language !== 'chart') return null;
    try {
      return { html: chartDocument(ready, theme), error: '' };
    } catch {
      return {
        html: '',
        error: label(
          'Chart data is incomplete or invalid. Open Code to inspect it.',
          '图表数据尚未完整或格式不正确，可切换代码查看。',
        ),
      };
    }
  }, [language, ready, zh, theme]);
  useEffect(() => {
    const timer = setTimeout(() => setReady(source), 450);
    return () => clearTimeout(timer);
  }, [source]);
  useEffect(() => {
    setResults([]);
    setActive(0);
    setFull(false);
    count.current = 0;
    setSelectedIds([]);
    const receive = (event: MessageEvent) => {
      if (
        !enabled ||
        isDiagram ||
        !frame.current?.contentWindow ||
        event.source !== frame.current.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== 'amadeus.preview.result' ||
        event.data?.token !== token
      )
        return;
      const next = parsePreviewResult(event.data.result);
      if (next && count.current >= 20) {
        setFull(true);
        return;
      }
      const id = crypto.randomUUID();
      if (next) {
        count.current++;
        setSelectedIds((ids) => [...ids, id]);
      }
      if (next)
        setResults((current) => {
          if (current.length >= 20) {
            return current;
          }
          return [...current, { ...next, id, added: false }];
        });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token, isDiagram, enabled]);
  useEffect(() => {
    if (!isDiagram || !ready) return;
    let cancelled = false;
    setDiagram('');
    setError(false);
    if (ready.length > 50000) {
      setError(true);
      return;
    }
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          maxTextSize: 50000,
          maxEdges: 500,
          suppressErrorRendering: true,
          theme: 'default',
        });
        const { svg } = await mermaid.render('diagram-' + crypto.randomUUID(), ready);
        if (!cancelled) setDiagram('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDiagram, ready, version]);
  useEffect(() => {
    setContentHeight(440);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== 'amadeus.preview.size' ||
        event.data?.token !== token
      )
        return;
      const height = event.data.height;
      if (typeof height === 'number' && Number.isFinite(height) && height > 0)
        setContentHeight(Math.max(160, Math.min(2400, Math.ceil(height))));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token]);
  const chosen = results.filter(
    (item) => selectedIds.includes(item.id) && !item.added && item.text.trim(),
  );
  const share = (items: typeof results) => {
    if (!onResult || !items.length) return;
    const text =
      label(
        'Interactive component results (user-selected, not independently verified)',
        '互动组件结果（用户选择分享，未经独立验证）',
      ) +
      (sourceId ? ' · #' + sourceId : '') +
      '\n' +
      items
        .map(
          (item) =>
            '[' +
            (results.findIndex((r) => r.id === item.id) + 1) +
            '] ' +
            item.title +
            '\n' +
            item.text,
        )
        .join('\n\n');
    if (onResult(text) === false) return;
    const ids = new Set(items.map((item) => item.id));
    setResults((current) =>
      current.map((item) => (ids.has(item.id) ? { ...item, added: true } : item)),
    );
  };
  return (
    <div className="inline-preview">
      <div className="preview-toolbar">
        <div className="preview-tabs" role="group" aria-label={label('View mode', '显示方式')}>
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            <Eye size={15} />
            {label('Preview', '预览')}
          </button>
          <button type="button" aria-pressed={mode === 'code'} onClick={() => setMode('code')}>
            <Code2 size={15} />
            {label('Code', '代码')}
          </button>
        </div>
        <span
          className="preview-kind"
          title={label('Isolated preview; no host access', '隔离预览，不能访问宿主页面')}
        >
          <ShieldCheck size={13} />
          {isDiagram
            ? 'Mermaid'
            : language === 'chart'
              ? label('Chart', '图表')
              : language === 'svg'
                ? 'SVG'
                : 'HTML'}
        </span>
        <div className="preview-utilities">
          <select
            aria-label={label('Preview height', '预览高度')}
            value={size}
            onChange={(e) => setSize(e.target.value)}
          >
            <option value="auto">{label('Fit content', '适应内容')}</option>
            <option value="viewport">{label('Fit window', '适应窗口')}</option>
            <option value="300">{label('Compact', '紧凑')}</option>
            <option value="440">{label('Standard', '标准')}</option>
            <option value="640">{label('Tall', '宽敞')}</option>
          </select>
          <button
            type="button"
            className="preview-icon"
            title={label('Copy code', '复制代码')}
            aria-label={label('Copy code', '复制代码')}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(source);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            className="preview-icon"
            title={label('Reset component state', '重置组件状态')}
            aria-label={label('Reset component state', '重置组件状态')}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
      <div
        className={'preview-stage' + (size === 'auto' ? ' preview-auto' : '')}
        style={{
          height: size === 'auto' ? contentHeight : size === 'viewport' ? '75vh' : Number(size),
        }}
      >
        <div className="preview-pane" hidden={mode !== 'preview'}>
          {isDiagram ? (
            error ? (
              <p role="status">
                {label(
                  'Cannot render this diagram. Check its source.',
                  '暂时无法绘制图表，请检查代码。',
                )}
              </p>
            ) : diagram ? (
              <img
                className="diagram-image"
                src={diagram}
                alt={label('Diagram', '关系图')}
                onLoad={(e) => {
                  const image = e.currentTarget;
                  if (image.naturalWidth)
                    setContentHeight(
                      Math.max(
                        160,
                        Math.min(
                          2400,
                          (image.clientWidth * image.naturalHeight) / image.naturalWidth + 32,
                        ),
                      ),
                    );
                }}
              />
            ) : (
              <p role="status">{label('Rendering…', '正在绘制…')}</p>
            )
          ) : chart?.error ? (
            <p role="status">{chart.error}</p>
          ) : ready ? (
            <iframe
              ref={frame}
              key={version}
              title="Interactive HTML preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={previewDocument(
                language === 'svg'
                  ? '<style>svg{max-width:100%;height:auto;display:block}</style>' + ready
                  : chart?.html || ready,
                onResult ? token : undefined,
                token,
              )}
            />
          ) : (
            <p>{label('Preparing preview…', '正在准备预览…')}</p>
          )}
        </div>
        <div className="preview-pane preview-code" hidden={mode !== 'code'}>
          <pre>{code || <code>{source}</code>}</pre>
        </div>
      </div>
      {size === 'auto' && contentHeight >= 2400 && (
        <small className="muted">
          {label(
            'Long content is capped at 2400px; scroll inside or use Fit window.',
            '长内容最多展开至 2400px；可在内部滚动或选择适应窗口。',
          )}
        </small>
      )}
      {full && (
        <p className="preview-result-limit" role="status">
          {label(
            '20 results retained. Dismiss a record, then submit again.',
            '已保留 20 条结果；请先关闭一条记录，再重新提交。',
          )}
        </p>
      )}
      {onResult && result && (
        <section className="preview-result" aria-label={label('Component result', '组件结果')}>
          <div className="preview-result-heading">
            <select
              aria-label={label('Result history', '结果历史')}
              value={active}
              onChange={(e) => setActive(Number(e.target.value))}
            >
              {results.map((item, index) => (
                <option key={item.id} value={index}>
                  {index + 1} / {results.length} · {item.title || label('Result', '结果')}
                  {item.added ? ' ✓' : ''}
                </option>
              ))}
            </select>
            <strong>{result.title || label('Component result', '组件结果')}</strong>
            <button
              type="button"
              className="preview-icon"
              aria-label={label('Dismiss result', '关闭结果')}
              onClick={() => {
                setResults((items) => items.filter((item) => item.id !== result.id));
                count.current = Math.max(0, count.current - 1);
                setActive(0);
                setFull(false);
              }}
            >
              <X size={14} />
            </button>
          </div>
          <details className="preview-result-selection">
            <summary>
              {label('Choose records', '选择记录')} · {chosen.length} / {results.length}
            </summary>
            <button
              type="button"
              onClick={() =>
                setSelectedIds(results.filter((item) => !item.added).map((item) => item.id))
              }
            >
              {label('Select all pending', '选择全部未加入')}
            </button>
            <button type="button" onClick={() => setSelectedIds([])}>
              {label('Clear selection', '取消选择')}
            </button>
            {results.map((item, index) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  disabled={item.added}
                  onChange={(e) =>
                    setSelectedIds((ids) =>
                      e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                    )
                  }
                />
                {index + 1}. {item.title || label('Result', '结果')}
                {item.added ? ' ✓' : ''}
              </label>
            ))}
          </details>
          <textarea
            aria-label={label('Result to share', '要分享的结果')}
            value={result.text}
            maxLength={16000}
            onChange={(e) => {
              setResults((items) =>
                items.map((item) =>
                  item.id === result.id ? { ...item, text: e.target.value, added: false } : item,
                ),
              );
            }}
          />
          <div className="preview-result-footer">
            <small>
              {label(
                'Component-reported data. Nothing is sent automatically.',
                '组件自报数据，不会自动发送。',
              )}
            </small>
            <button
              type="button"
              disabled={result.added || !result.text.trim()}
              onClick={() => share([result])}
            >
              <ArrowDownToLine size={14} />
              {result.added
                ? label('Added to draft', '已加入草稿')
                : label('Add current', '填入当前')}
            </button>
            <button type="button" disabled={!chosen.length} onClick={() => share(chosen)}>
              {label('Add selected', '填入所选')} ({chosen.length})
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
