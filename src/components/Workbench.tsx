import { useEffect, useState, type ReactNode } from 'react';
import { X, Monitor, Download } from 'lucide-react';
import { api } from '../api';
import { Markdown } from './Markdown';
import type { AgentEvent } from '../../shared/types';
import { WorkbenchContext as Context, type WorkbenchFile as File } from '../workbench-context';
function FileView({ file, zh }: { file: File; zh: boolean }) {
  const [result, setResult] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState(''),
    [source, setSource] = useState(false);
  const url = '/api/attachments/' + encodeURIComponent(file.id);
  const image = /^image\/(png|jpeg|webp|gif)$/.test(file.mime);
  const media = /^(video|audio)\//.test(file.mime);
  const pdf = /\.pdf$/i.test(file.name);
  useEffect(() => {
    if (image || media || pdf) return;
    const controller = new AbortController();
    api(
      '/attachments/' + encodeURIComponent(file.id) + '?view=text',
      undefined,
      undefined,
      {},
      controller.signal,
    )
      .then(setResult)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [file.id, image, media, pdf]);
  return (
    <>
      <div className="workbench-actions">
        <a href={url} download={file.name}>
          <Download size={15} />
          {zh ? '下载' : 'Download'}
        </a>
        {result && /\.(md|markdown)$/i.test(file.name) && (
          <button onClick={() => setSource(!source)}>
            {source ? (zh ? '预览' : 'Preview') : zh ? '源码' : 'Source'}
          </button>
        )}
      </div>
      {image ? (
        <img className="workbench-image" alt={file.name} src={url + '?preview=1'} />
      ) : media ? (
        file.mime.startsWith('video/') ? (
          <video controls src={url + '?inline=1'} />
        ) : (
          <audio controls src={url + '?inline=1'} />
        )
      ) : pdf ? (
        <iframe title={file.name} sandbox="" src={url + '?view=pdf'} />
      ) : error ? (
        <p role="alert">
          {error} {zh ? '可下载原文件查看。' : 'Download the original to view.'}
        </p>
      ) : result ? (
        <>
          {result.truncated && (
            <p role="status">
              {zh
                ? '预览仅显示前 256 KiB；下载包含完整内容。'
                : 'Preview limited to 256 KiB; download contains the full file.'}
            </p>
          )}
          {!source && /\.(md|markdown)$/i.test(file.name) ? (
            <Markdown text={result.text} />
          ) : (
            <pre>{result.text}</pre>
          )}
        </>
      ) : (
        <p role="status">{zh ? '正在加载…' : 'Loading…'}</p>
      )}
    </>
  );
}
export function WorkbenchProvider({
  children,
  events,
  zh,
}: {
  children: ReactNode;
  events: AgentEvent[];
  zh: boolean;
}) {
  const [file, setFile] = useState<File | null>(null),
    [mode, setMode] = useState<'file' | 'operations' | null>(null);
  const frames = events.filter((e) => e.type === 'interaction.frame');
  const latest = frames.at(-1);
  const operations = events
    .filter((e) => e.type === 'tool.started' && e.data.name === 'mcp_call')
    .slice(-50);
  const [frameId, setFrameId] = useState<number | null>(null);
  const frame = frames.find((e) => e.id === frameId) || latest;
  return (
    <Context.Provider
      value={(f) => {
        setFile(f);
        setMode('file');
      }}
    >
      <div className="workbench-shell">
        <button
          className="workbench-toggle"
          onClick={() => setMode(mode === 'operations' ? null : 'operations')}
        >
          <Monitor size={15} />
          {zh ? '操作视图' : 'Operations'}
        </button>
        <div className="workbench-layout">
          <div className="workbench-chat">{children}</div>
          {mode && (
            <aside className="workbench" aria-label={zh ? '工作面板' : 'Workbench'}>
              <header>
                <strong>
                  {mode === 'file'
                    ? file?.name
                    : zh
                      ? '浏览器 / Computer Use'
                      : 'Browser / Computer Use'}
                </strong>
                <button aria-label={zh ? '关闭面板' : 'Close panel'} onClick={() => setMode(null)}>
                  <X size={17} />
                </button>
              </header>
              <div className="workbench-body">
                {mode === 'file' && file ? (
                  <FileView key={file.id} file={file} zh={zh} />
                ) : (
                  <>
                    <p>
                      {zh
                        ? '显示已批准工具返回的画面，不是实时视频或隔离桌面。操作仍由 Agent 经现有审批执行。'
                        : 'Captured frames from approved tools, not live video or an isolated desktop. Agent actions retain existing approval checks.'}
                    </p>
                    {frame ? (
                      <>
                        <select
                          aria-label={zh ? '画面记录' : 'Captured frames'}
                          value={frame.id}
                          onChange={(e) => setFrameId(Number(e.target.value))}
                        >
                          {frames.slice(-100).map((e) => (
                            <option key={e.id} value={e.id}>
                              {new Date(e.createdAt).toLocaleTimeString()} · {e.data.adapter} ·{' '}
                              {e.data.tool}
                            </option>
                          ))}
                        </select>
                        <p>
                          {frame.data.capability} · {new Date(frame.createdAt).toLocaleString()}
                        </p>
                        <img
                          className="workbench-image"
                          src={
                            '/api/attachments/' +
                            encodeURIComponent(frame.data.attachment.id) +
                            '?preview=1'
                          }
                          alt={zh ? '工具返回的画面' : 'Captured tool frame'}
                        />
                        <button onClick={() => setFrameId(null)}>
                          {zh ? '跟随最新画面' : 'Follow latest frame'}
                        </button>
                      </>
                    ) : (
                      <p>
                        {zh
                          ? '当前已加载记录中没有画面。需要已配置的浏览器或桌面 MCP 返回截图。'
                          : 'No frame in loaded history. A configured browser or desktop MCP must return a screenshot.'}
                      </p>
                    )}
                    <h4>{zh ? '最近操作（最多 50 项）' : 'Recent operations (up to 50)'}</h4>
                    {operations.map((e) => (
                      <details key={e.id}>
                        <summary>
                          {new Date(e.createdAt).toLocaleTimeString()} · {e.data.arguments?.tool}
                        </summary>
                        <pre>{JSON.stringify(e.data.arguments, null, 2)}</pre>
                      </details>
                    ))}
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </Context.Provider>
  );
}
