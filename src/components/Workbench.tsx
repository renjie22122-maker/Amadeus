import { useEffect, useState, type ReactNode } from 'react';
import { X, Monitor, Download } from 'lucide-react';
import { api } from '../api';
import { Markdown } from './Markdown';
import { previewDocument } from '../markdown-rich';
import type { AgentEvent } from '../../shared/types';
import { WorkbenchContext as Context, type WorkbenchFile as File } from '../workbench-context';
function FileView({
  file,
  zh,
  onDirty,
  onSaved,
}: {
  file: File;
  zh: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: (file: File) => void;
}) {
  const [result, setResult] = useState<{ text: string; truncated: boolean; sha256: string } | null>(
    null,
  );
  const [error, setError] = useState(''),
    [source, setSource] = useState(false);
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(''),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  useEffect(() => {
    onDirty(editing && draft !== result?.text);
  }, [editing, draft, result, onDirty]);
  async function save() {
    setSaving(true);
    setSaveError('');
    try {
      const saved = await api('/attachments/' + encodeURIComponent(file.id) + '/revisions', {
        text: draft,
        sha256: result!.sha256,
      });
      onDirty(false);
      onSaved(saved);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const url = '/api/attachments/' + encodeURIComponent(file.id);
  const image = /^image\/(png|jpeg|webp|gif)$/.test(file.mime);
  const media = /^(video|audio)\//.test(file.mime);
  const html = /\.html?$/i.test(file.name);
  const svg = /\.svg$/i.test(file.name);
  const latex = /\.(tex|latex)$/i.test(file.name);
  const fullLatex = latex && /\\(?:documentclass|begin\s*\{document\})/.test(result?.text || '');
  const markdown = /\.(md|markdown)$/i.test(file.name);
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
        {!editing && result && (markdown || html || svg || latex) && !result.truncated && (
          <button onClick={() => setSource(!source)}>
            {source ? (zh ? '预览' : 'Preview') : zh ? '源码' : 'Source'}
          </button>
        )}
        {result && !result.truncated && !editing && (
          <button
            onClick={() => {
              setDraft(result.text);
              setEditing(true);
            }}
          >
            {zh ? '编辑' : 'Edit'}
          </button>
        )}
        {editing && (
          <>
            <button disabled={saving} onClick={save}>
              {saving ? (zh ? '保存中…' : 'Saving…') : zh ? '保存新版本' : 'Save new version'}
            </button>
            <button
              disabled={saving}
              onClick={() => {
                if (
                  draft === result?.text ||
                  window.confirm(zh ? '放弃未保存的修改？' : 'Discard unsaved changes?')
                )
                  setEditing(false);
              }}
            >
              {zh ? '取消编辑' : 'Cancel edit'}
            </button>
          </>
        )}
      </div>
      {saveError && <p role="alert">{saveError}</p>}
      {editing ? (
        <>
          <p>
            {zh
              ? '保存为当前对话的新附件，保留原文件，不覆盖项目源码或自动发送到聊天平台。'
              : 'Save a new attachment in this conversation; preserve the original without changing workspace files or sending chat messages.'}
          </p>
          <textarea
            aria-label={zh ? '编辑文件内容' : 'Edit file content'}
            className="workbench-editor"
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
          />
        </>
      ) : image ? (
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
                ? '文件超过预览上限，仅显示前 256 KiB；HTML 不执行截断内容，请下载完整文件查看。'
                : 'Only the first 256 KiB is shown. Truncated HTML is not executed; download the complete file to view.'}
            </p>
          )}
          {!source && (html || svg) && !result.truncated ? (
            <>
              <p className="inspection-note">
                {zh
                  ? '隔离网页预览：支持内嵌样式与脚本；外部资源、网络请求和持久存储不可用。'
                  : 'Sandboxed web preview: embedded styles and scripts work; external resources, network requests and persistent storage are unavailable.'}
              </p>
              <iframe
                title={file.name}
                sandbox={svg ? '' : 'allow-scripts'}
                referrerPolicy="no-referrer"
                srcDoc={previewDocument(result.text)}
              />
            </>
          ) : !source && latex && !result.truncated ? (
            fullLatex ? (
              <>
                <p role="status">
                  {zh
                    ? '这是完整 LaTeX 文档，需要 TeX 编译器生成 PDF；此处保留源码查看与编辑。'
                    : 'This is a full LaTeX document. Compile it with a TeX engine to PDF; source viewing and editing remain available.'}
                </p>
                <pre>{result.text}</pre>
              </>
            ) : (
              <>
                <p className="inspection-note">
                  {zh
                    ? 'LaTeX 数学片段预览（KaTeX），不执行 TeX 命令或读取外部文件。'
                    : 'LaTeX math preview (KaTeX); no TeX commands or external files are executed.'}
                </p>
                <Markdown
                  text={
                    '$$\n' +
                    result.text
                      .trim()
                      .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
                      .replace(/^\\\[([\s\S]*)\\\]$/, '$1') +
                    '\n$$'
                  }
                />
              </>
            )
          ) : !source && markdown ? (
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
  const [dirty, setDirty] = useState(false);
  const canLeave = () =>
    !dirty || window.confirm(zh ? '放弃未保存的文件修改？' : 'Discard unsaved file changes?');
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
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
        if (!canLeave()) return;
        setDirty(false);
        setFile(f);
        setMode('file');
      }}
    >
      <div className="workbench-shell">
        <button
          className="workbench-toggle"
          onClick={() => {
            if (canLeave()) {
              setDirty(false);
              setMode(mode === 'operations' ? null : 'operations');
            }
          }}
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
                <button
                  aria-label={zh ? '关闭面板' : 'Close panel'}
                  onClick={() => {
                    if (canLeave()) {
                      setDirty(false);
                      setMode(null);
                    }
                  }}
                >
                  <X size={17} />
                </button>
              </header>
              <div className="workbench-body">
                {mode === 'file' && file ? (
                  <FileView
                    key={file.id}
                    file={file}
                    zh={zh}
                    onDirty={setDirty}
                    onSaved={setFile}
                  />
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
