import { useState } from 'react';
import { api } from '../api';
export function LightRagProgress({
  value,
  zh,
  scope,
}: {
  value: any;
  zh: boolean;
  scope?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [control, setControl] = useState<{ paused: boolean; autoContinue: boolean } | null>(null);
  const paused = control?.paused ?? value?.paused ?? false;
  const autoContinue = control?.autoContinue ?? value?.autoContinue ?? true;
  const act = async (action: 'pause' | 'continue' | 'configure', automatic?: boolean) => {
    if (!scope) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/knowledge/lightrag-control', {
        scope,
        action,
        autoContinue: automatic,
      });
      setControl({ paused: result.paused, autoContinue: result.autoContinue });
      setMessage(
        action === 'pause'
          ? zh
            ? '已暂停后续批次；当前已提交批次会安全完成，已建图内容与检索保持可用。'
            : 'Future batches paused; the submitted batch finishes safely. Existing graph remains searchable.'
          : action === 'continue'
            ? zh
              ? '已请求继续，正在核对原批次；状态将自动刷新。'
              : 'Resume requested; reconciling the original batch. Status refreshes automatically.'
            : zh
              ? '自动继续设置已保存；不改变资料访问授权。'
              : 'Automatic continuation saved without changing source authorization.',
      );
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  if (!value || value.status === 'disabled') return null;
  const labels: Record<string, [string, string]> = {
    ready: ['等待继续下一批', 'Awaiting next batch'],
    paused: ['已暂停后续批次', 'Future batches paused'],
    pausing: ['暂停中：等待当前批次结束', 'Pausing after the current batch'],
    pending: ['等待首次同步', 'Awaiting first synchronization'],
    queued: ['排队中', 'Queued'],
    processing: ['建图中', 'Building graph'],
    synced: ['已同步', 'Synchronized'],
    unknown: ['需要检查并恢复', 'Inspection and recovery required'],
    unavailable: ['无法更新状态', 'Status update unavailable'],
    unauthorized: ['等待服务授权', 'Service authorization required'],
  };
  const known = Number.isFinite(value.total) && Number.isFinite(value.completed);
  const total = Math.max(0, value.total || 0);
  const completed = Math.min(total, Math.max(0, value.completed || 0));
  return (
    <fieldset
      style={{ marginTop: 20, padding: 16 }}
      aria-label={zh ? 'LightRAG 建图进度' : 'LightRAG graph progress'}
    >
      <legend>{zh ? '3 · LightRAG 知识图谱' : '3 · LightRAG knowledge graph'}</legend>
      <p role="status">
        LightRAG ·{' '}
        {labels[paused ? (value.jobId ? 'pausing' : 'paused') : value.status]?.[zh ? 0 : 1] ||
          value.status}
        {known &&
          ` · ${completed.toLocaleString()} / ${total.toLocaleString()} ${zh ? '正文分块' : 'source chunks'}`}
        {known &&
          total > 0 &&
          ` · ${completed > 0 && completed / total < 0.001 ? '<0.1' : ((completed / total) * 100).toFixed(1)}%`}
      </p>
      {known && total > 0 && (
        <progress
          aria-label={zh ? '已确认建图分块' : 'Confirmed graph chunks'}
          value={completed}
          max={total}
          style={{ width: '100%', height: 8, accentColor: 'var(--accent)' }}
        />
      )}
      {known && (
        <p className="muted">
          {zh ? '当前批次：处理中 ' : 'Current batch: processing '}
          {value.processing || 0} · {zh ? '待处理 ' : 'pending '}
          {value.pending || 0} · {zh ? '失败 ' : 'failed '}
          {value.failed || 0}
        </p>
      )}
      {scope && (
        <div>
          <div className="row wrap">
            <button
              disabled={busy || (!paused && ['queued', 'processing'].includes(value.status))}
              onClick={() => void act('continue')}
            >
              {busy
                ? zh
                  ? '处理中…'
                  : 'Working…'
                : completed === 0 && value.status === 'pending'
                  ? zh
                    ? '开始建图'
                    : 'Start building'
                  : zh
                    ? '继续／恢复建图'
                    : 'Continue / recover'}
            </button>
            <button
              disabled={busy || paused || value.status === 'synced'}
              onClick={() => void act('pause')}
            >
              {zh ? '暂停后续批次' : 'Pause future batches'}
            </button>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoContinue}
              disabled={busy}
              onChange={(e) => void act('configure', e.target.checked)}
            />
            {zh
              ? '自动继续后续批次（重启后保留）'
              : 'Automatically continue subsequent batches (persists across restart)'}
          </label>
          <small className="muted">
            {zh
              ? '暂停不会强杀正在写图的批次。关闭自动继续后，点击继续只推进一个批次；已完成分块不会重建。'
              : 'Pause does not interrupt graph writes. With automatic continuation off, Continue advances one batch. Completed chunks are retained.'}
          </small>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <small className="muted">
        {zh
          ? '按已确认完成的正文分块计数，每几秒按分块刷新，失败不扣除已完成进度；不是文件数、向量数或实体数。'
          : 'Counts confirmed source chunks, refreshed every few seconds per chunk; failures retain completed progress; not files, vectors or entities.'}
        {value.observedAt &&
          ` ${zh ? '状态更新：' : 'Status checked: '}${new Date(value.observedAt).toLocaleString()}`}
      </small>
    </fieldset>
  );
}
