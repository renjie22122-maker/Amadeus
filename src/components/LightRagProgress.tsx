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
  if (!value || value.status === 'disabled') return null;
  const labels: Record<string, [string, string]> = {
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
    <section aria-label={zh ? 'LightRAG 建图进度' : 'LightRAG graph progress'}>
      <p role="status">
        LightRAG · {labels[value.status]?.[zh ? 0 : 1] || value.status}
        {known && ` · ${completed.toLocaleString()} / ${total.toLocaleString()}`}
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
      {scope && ['unknown', 'unavailable', 'pending'].includes(value.status) && (
        <div>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMessage('');
              try {
                const result = await api('/knowledge/lightrag-resume', { scope });
                setMessage(
                  ['queued', 'processing', 'synced', 'completed'].includes(result.status)
                    ? zh
                      ? '已接续建图，已完成内容保留；进度会自动刷新。'
                      : 'Graph synchronization resumed; completed content retained. Progress refreshes automatically.'
                    : zh
                      ? '尚未恢复，请检查服务状态。'
                      : 'Not resumed; check service status.',
                );
              } catch (error: any) {
                setMessage(error.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? zh
                ? '正在核对并恢复…'
                : 'Checking and resuming…'
              : zh
                ? '恢复建图'
                : 'Resume graph building'}
          </button>
          <small>
            {zh
              ? '核对原批次，只接续未完成内容，不清空图或重建全库。'
              : 'Reconciles the original batch and resumes incomplete content without clearing the graph.'}
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
    </section>
  );
}
