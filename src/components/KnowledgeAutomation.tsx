import { useEffect, useState, useRef } from 'react';
import { api } from '../api';
import { LightRagProgress } from './LightRagProgress';
import { KnowledgeProgress } from './KnowledgeProgress';
export function KnowledgeAutomation({
  scope,
  zh,
  embedding,
  notify,
  profile,
  project,
  onStatus,
}: any) {
  const [value, setValue] = useState<any>(null),
    [paths, setPaths] = useState(''),
    [busy, setBusy] = useState(false);
  const [scanInterval, setScanInterval] = useState(30);
  const [coverage, setCoverage] = useState<any>(null);
  const picker = useRef<AbortController | null>(null);
  const [picking, setPicking] = useState(false);
  const addPaths = (added: string[]) =>
    setPaths((old) =>
      [
        ...new Set([
          ...old
            .split('\n')
            .map((p) => p.trim())
            .filter(Boolean),
          ...added,
        ]),
      ].join('\n'),
    );
  useEffect(() => () => picker.current?.abort(), [scope]);
  const browse = async () => {
    const controller = new AbortController();
    picker.current = controller;
    setPicking(true);
    try {
      const result = await api('/pick-folder', {}, 'POST', {}, controller.signal);
      if (!controller.signal.aborted) addPaths(result.paths || (result.path ? [result.path] : []));
    } catch (e: any) {
      if (!controller.signal.aborted) notify(e.message);
    } finally {
      if (picker.current === controller) {
        picker.current = null;
        setPicking(false);
      }
    }
  };
  const [graph, setGraph] = useState(false);
  const [loadError, setLoadError] = useState('');
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const mutation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false,
      statsLoading = false,
      initialized = false;
    setPicking(false);
    setValue(null);
    setCoverage(null);
    setPaths('');
    setLoadError('');
    const load = async () => {
      if (!scope || loading || controller.signal.aborted || (initialized && document.hidden))
        return;
      loading = true;
      const revision = mutation.current;
      try {
        const v = await api(
          '/knowledge/maintenance?scope=' + encodeURIComponent(scope),
          undefined,
          undefined,
          {},
          controller.signal,
        );
        if (controller.signal.aborted || revision !== mutation.current) return;
        setValue(v);
        setLoadError('');
        if (!initialized) {
          setPaths(v.paths.join('\n'));
          setGraph(!!v.graphProfileId);
          setScanInterval(v.scanIntervalSeconds ?? 30);
          initialized = true;
        }
      } catch (e: any) {
        if (!controller.signal.aborted) setLoadError(e.message);
      } finally {
        loading = false;
      }
    };
    const stats = async () => {
      if (!scope || statsLoading || controller.signal.aborted || document.hidden) return;
      statsLoading = true;
      try {
        const v = await api(
          '/knowledge/index-status?scope=' + encodeURIComponent(scope),
          undefined,
          undefined,
          {},
          controller.signal,
        );
        if (!controller.signal.aborted) {
          statusCallback.current?.(v);
          const entries = Object.values(v) as any[];
          setCoverage({
            documents: entries.length,
            indexed: entries.filter((s) => s.status === 'indexed').length,
            chunks: entries.reduce((n, s) => n + s.total, 0),
            vectors: entries.reduce((n, s) => n + s.completed, 0),
            at: Date.now(),
          });
        }
      } catch {
        /* Progress remains usable when optional vector statistics are unavailable. */
      } finally {
        statsLoading = false;
      }
    };
    const visible = () => {
      if (!document.hidden) {
        void load();
        void stats();
      }
    };
    document.addEventListener('visibilitychange', visible);
    void load();
    void stats();
    const timer = setInterval(load, 1000),
      statTimer = setInterval(stats, 10000);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', visible);
      clearInterval(timer);
      clearInterval(statTimer);
    };
  }, [scope]);
  const save = async (enabled: boolean) => {
    mutation.current++;
    const previous = value;
    setValue({ ...value, enabled });
    setBusy(true);
    try {
      setValue(
        await api('/knowledge/maintenance', {
          scope,
          enabled,
          scanIntervalSeconds: scanInterval,
          graphProfileId: graph ? profile?.id : undefined,
          paths: paths
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      );
    } catch (e: any) {
      setValue(previous);
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dirty =
    !!value &&
    (scanInterval !== (value.scanIntervalSeconds ?? 30) ||
      graph !== !!value.graphProfileId ||
      JSON.stringify(
        [
          ...new Set(
            paths
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ].sort(),
      ) !== JSON.stringify([...value.paths].sort()));
  const runAction = async (action: 'sync' | 'retry') => {
    mutation.current++;
    setBusy(true);
    try {
      setValue(await api('/knowledge/maintenance/action', { scope, action }));
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!scope) return null;
  if (!value)
    return (
      <section className="panel" aria-busy="true">
        <h3>{zh ? '文件夹导入与自动维护' : 'Folder import and automatic maintenance'}</h3>
        <p role="status">
          {loadError || (zh ? '正在读取维护状态…' : 'Loading maintenance status…')}
        </p>
      </section>
    );
  return (
    <section className="panel">
      <h3>{zh ? '文件夹导入与自动维护' : 'Folder import and automatic maintenance'}</h3>
      <p className="muted">
        {embedding.backend === 'local'
          ? zh
            ? '本地多语言 E5 · 中文 / English；首次下载模型，文档不上传。'
            : 'Local multilingual E5 · model download on first use; no document upload.'
          : (zh
              ? '开启即允许将本范围文档发送到：'
              : 'Enabling authorizes embedding documents in this scope at: ') + embedding.baseUrl}
      </p>
      {(scope.startsWith('project:') || scope === 'general') && (
        <label>
          {scope === 'general'
            ? zh
              ? '共享资料文件夹 · 每行一个绝对路径'
              : 'Shared source folders · one absolute path per line'
            : zh
              ? '登记资料文件或文件夹，每行一个项目内绝对路径'
              : 'Source files/folders: one absolute path within this project per line'}
          <textarea
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder={
              zh
                ? '留空只维护已导入文档；不扫描整个项目'
                : 'Leave blank to index imported documents only'
            }
          />
        </label>
      )}
      {(scope.startsWith('project:') || scope === 'general') && (
        <div className="row wrap">
          <button disabled={busy || picking} onClick={() => void browse()}>
            {zh ? '选择资料文件夹…' : 'Choose source folders…'}
          </button>
          {picking && (
            <button
              onClick={() => {
                picker.current?.abort();
                setPicking(false);
              }}
            >
              {zh ? '取消选择' : 'Cancel selection'}
            </button>
          )}
          {!!project?.folders?.length && (
            <button disabled={busy} onClick={() => addPaths(project.folders)}>
              {zh ? '添加此项目的文件夹' : 'Add project folders'}
            </button>
          )}
          <small>
            {scope === 'general'
              ? zh
                ? '仅所选文件夹进入普通对话共享知识库，不授予聊天命令访问权；项目对话不读取此范围。'
                : 'Only chosen folders enter the shared general-chat library. This grants no command access; project chats exclude this scope.'
              : zh
                ? '递归包含子文件夹；可填写多个路径（最多 12 个）。项目外资料请先在管理项目中添加其文件夹。保存并开启后后台导入。'
                : 'Includes subfolders recursively; up to 12 source paths. Add external folders to the project first. Save and enable to import in the background.'}
          </small>
        </div>
      )}
      {scope.startsWith('session:') && (
        <p className="muted">
          {zh
            ? '当前为单个对话知识库。导入文件夹请先在上方选择项目；本对话上传的文档仍可自动索引。'
            : 'This is a conversation library. Select a project above to import folders; uploaded conversation documents can still be indexed automatically.'}
        </p>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={graph}
          disabled={!profile || busy}
          onChange={(e) => setGraph(e.target.checked)}
        />
        {zh
          ? '自动提取文档实体关系（发送正文片段到：'
          : 'Extract document relations (send excerpts to: '}
        {profile?.baseUrl || '—'}
        {')'}
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={busy}
          onChange={(e) => void save(e.target.checked)}
        />
        {zh ? '开启自动更新与索引' : 'Automatically update and index'}
      </label>
      <label>
        {zh ? '自动扫描间隔（秒，30–86400）' : 'Automatic scan interval (seconds, 30–86400)'}
        <input
          type="number"
          min={30}
          max={86400}
          step={1}
          value={scanInterval}
          disabled={busy}
          onChange={(e) => setScanInterval(Number(e.target.value))}
        />
        <small>
          {zh
            ? '保存后生效；到期后由后台调度检查，最多约 30 秒调度延迟。手动同步不受此间隔限制。'
            : 'Save to apply. Scheduling may add up to 30 seconds. Manual sync bypasses this interval.'}
        </small>
      </label>
      <div className="row wrap">
        <button disabled={busy || !dirty} onClick={() => void save(value.enabled)}>
          {zh ? '保存范围' : 'Save sources'}
        </button>
        <button disabled={busy || dirty || !value.enabled} onClick={() => void runAction('sync')}>
          {zh ? '立即增量同步' : 'Sync changes now'}
        </button>
        {(value.error || value.issues?.length > 0) && (
          <button
            disabled={busy || dirty || !value.enabled}
            onClick={() => void runAction('retry')}
          >
            {zh ? '重试失败项' : 'Retry failed items'}
          </button>
        )}
      </div>
      <p className="muted">
        {dirty
          ? zh
            ? '范围有未保存的修改。保存后按自动维护开关增量处理。'
            : 'Unsaved source changes. Save to apply automatic incremental maintenance.'
          : zh
            ? '新增文件夹保存后自动增量处理；未变化文件跳过解析；已完成的向量不读取、不重算、不写回。保存不会重置失败项。'
            : 'Added folders are processed incrementally when enabled; unchanged files reuse parsing and indexes. Saving does not reset failed items.'}
      </p>
      <p role="status">
        {zh ? '状态：' : 'Status: '}
        {value.status === 'partial' ? (zh ? '部分完成' : 'Partially completed') : value.status}
        {value.updatedAt ? ' · ' + new Date(value.updatedAt).toLocaleString() : ''}
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      <h4>{zh ? '1 · 文件扫描与解析（文件数）' : '1 · Source scan and parsing (files)'}</h4>
      <KnowledgeProgress value={value} zh={zh} />
      <p className="muted">
        {zh
          ? '新增文件夹仅解析新增或变化的文件；已有文件仍会校验内容哈希，同一模型的已完成索引保持不动。'
          : 'Adding folders parses only new or changed files. Existing sources are hash-checked and completed indexes for the same model remain untouched.'}
      </p>
      {value.scan && (
        <p className="muted">
          {zh ? '上次完成的扫描：' : 'Last completed scan: '}
          {value.scan.completedAt ? new Date(value.scan.completedAt).toLocaleString() + ' · ' : ''}
          {value.scan.files} {zh ? '个支持文件；新增或更新 ' : 'supported files; imported/updated '}
          {value.scan.updated} · {zh ? '未变化 ' : 'unchanged '}
          {value.scan.unchanged}
        </p>
      )}
      {value.skipped && (
        <p className="muted">
          {zh
            ? '上次完成扫描跳过：隐藏或构建目录 '
            : 'Last completed scan skipped: hidden/build entries '}
          {value.skipped.excluded}
          {' · '}
          {zh ? '链接 ' : 'links '}
          {value.skipped.links}
          {' · '}
          {zh ? '不支持格式 ' : 'unsupported formats '}
          {value.skipped.unsupported}
        </p>
      )}
      {value.error && <p role="alert">{value.error}</p>}
      {value.status === 'processing' && (
        <details open>
          <summary>
            {zh ? '本次扫描问题（实时）' : 'Current scan issues (live)'} ·{' '}
            {value.progress?.failed || 0}
          </summary>
          {(value.currentIssues || []).map((x: any, i: number) => (
            <p key={i}>
              <strong>{x.path}</strong> · {x.stage} · {x.error}
            </p>
          ))}
          {(value.progress?.failed || 0) > (value.currentIssues?.length || 0) && (
            <p>
              {zh
                ? '此运行尚未记录完整错误详情；后续扫描将逐项实时记录。'
                : 'Details are incomplete for this run; subsequent scans persist each issue live.'}
            </p>
          )}
        </details>
      )}
      {!!value.issues?.length && (
        <details open>
          <summary>
            {zh
              ? '已记录的问题（含历史待重试项）'
              : 'Recorded issues (including prior unresolved items)'}{' '}
            · {value.issues.length}
          </summary>
          <ul>
            {value.issues.map((x: any, i: number) => (
              <li key={i}>
                <strong>{x.path}</strong> · {x.stage} · {x.error}
              </li>
            ))}
          </ul>
          <p>
            {zh
              ? '点击“重试失败项”重新处理失败项；保存范围不会重置失败次数。未变化的成功文件不会重复导入或写回向量。'
              : 'Use Retry failed items to reset failures; saving sources preserves failure counts. Unchanged successful files are skipped without rewriting vectors.'}
          </p>
        </details>
      )}
      <small>
        {zh
          ? '按所设间隔检查；无固定文件数量或目录项上限，无固定单文件大小上限；逐文件独立解析，页面／OCR 分块无进展时限 120 秒（PDF 每次最多 30 分钟，大页面分块识别，重试复用已完成页和分块）、V8 堆上限 768 MB、提取文本最多 500 万字符。支持 TXT、Markdown、CSV、JSON、DOCX、XLSX、文本 PDF 等；跳过隐藏文件与构建目录；图片与扫描 PDF 使用本机 Windows OCR。临时网络故障退避重试；配置错误 3 次后暂停，移除源文件会使当前版本退出检索。'
          : 'Checks at the configured interval; no fixed file-count, entry-count or per-file byte limit. Parsing is isolated per file: 120 seconds without page/tile progress (30-minute PDF attempt budget; tiled OCR and resumable pages/tiles), 768 MB V8 heap, 5 million extracted characters. Text, Markdown, CSV, JSON, DOCX, XLSX and text PDFs. Hidden/build folders excluded; Windows OCR handles images/scanned PDFs. Transient network errors retry with backoff; configuration errors pause after three attempts; removed files leave current retrieval.'}
      </small>
      <fieldset style={{ marginTop: 20, padding: 16 }}>
        <legend>{zh ? '2 · 向量索引' : '2 · Vector index'}</legend>
        <p role="status">
          {coverage
            ? (zh ? '当前范围：' : 'Current scope: ') +
              coverage.indexed +
              '/' +
              coverage.documents +
              (zh ? ' 份文档向量已齐全；' : ' documents fully indexed; ') +
              coverage.vectors.toLocaleString() +
              '/' +
              coverage.chunks.toLocaleString() +
              (zh ? ' 个分块具有当前模型的有效向量' : ' chunks have compatible vectors')
            : zh
              ? '正在读取当前范围覆盖情况…'
              : 'Loading current scope coverage…'}
        </p>
        <small className="muted">
          {zh
            ? '自动导入与手动补齐使用同一套索引。下面的操作检查当前文档，已有有效向量不会重算。'
            : 'Automatic import and manual backfill use the same index. This checks current documents without recomputing valid vectors.'}
        </small>

        <button
          disabled={busy || ['pending', 'running'].includes(value.batch?.status)}
          onClick={async () => {
            setBusy(true);
            try {
              const batch = await api('/knowledge/batch-index', { scope });
              setValue({ ...value, batch });
            } catch (e: any) {
              notify(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {zh ? '检查并补齐缺失向量' : 'Check and fill missing vectors'}
        </button>
        <small style={{ display: 'block' }}>
          {zh
            ? '使用上方已配置的 embedding 服务；仅处理当前范围，复用已有向量。外部 API 会接收待索引正文分块。'
            : 'Uses the configured embedding service for this scope only; existing vectors are reused. External APIs receive unindexed text chunks.'}
        </small>
        {value.batch && (
          <p role="status">
            {zh ? '最近一次手动补齐任务（文档数）：' : 'Latest manual backfill (documents): '}
            {(
              {
                completed: zh ? '已完成' : 'Completed',
                running: zh ? '处理中' : 'Running',
                pending: zh ? '待处理' : 'Pending',
              } as Record<string, string>
            )[value.batch.status] || value.batch.status}{' '}
            · {value.batch.completed}/{value.batch.documents.length}
            {value.batch.currentFile && ' · ' + value.batch.currentFile}
            {value.batch.failed > 0 && ' · ' + value.batch.failed + (zh ? ' 项失败' : ' failed')}
            {value.batch.error && ' · ' + value.batch.error}
            {value.batch.skipped !== undefined && (
              <span>
                {' · '}
                {zh ? '已齐全跳过 ' : 'Already indexed '}
                {value.batch.skipped}
                {' · '}
                {zh ? '实际补齐文档 ' : 'Documents filled '}
                {value.batch.filledDocuments || 0}
                {' · '}
                {zh ? '补齐分块 ' : 'Chunks filled '}
                {value.batch.filledChunks || 0}
                {zh ? ' · 实际向量计算分块 ' : ' · Encoded chunks '}
                {value.batch.encodedChunks ?? '—'}
                {value.batch.elapsedMs !== undefined && (
                  <>
                    {zh ? ' · 检查及补齐 ' : ' · Check/fill '}
                    {(value.batch.elapsedMs / 1000).toFixed(1)}s
                    {zh ? ' · 向量计算 ' : ' · Encoding '}
                    {(value.batch.encodingMs / 1000).toFixed(1)}s
                  </>
                )}
              </span>
            )}
          </p>
        )}
        <small className="muted">
          {zh
            ? '这里是手动补齐任务的历史记录，不是全库向量覆盖率，也不是 LightRAG 建图进度。文件自动导入产生的向量不计入这次任务。'
            : 'This is a historical manual backfill, not total vector coverage or LightRAG progress. Automatic ingestion is not counted in this task.'}
        </small>
      </fieldset>
      <LightRagProgress key={scope} value={value.lightRag} zh={zh} scope={scope} />
    </section>
  );
}
