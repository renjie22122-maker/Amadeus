import { useEffect, useState } from 'react';

export function KnowledgeProgress({ value, zh }: { value: any; zh: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (value.status !== 'processing') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [value.status]);
  const p = value.progress;
  if (!p) return null;
  const labels: Record<string, string> = zh
    ? {
        scanning: '扫描资料',
        checking: '检查文件变化',
        parsing: '解析文档',
        graph: '提取实体关系',
        indexing: '建立语义索引',
        evaluating: '检查检索质量',
        done: '本次扫描结束',
      }
    : {
        scanning: 'Discovering sources',
        checking: 'Checking changes',
        parsing: 'Parsing documents',
        graph: 'Extracting relationships',
        indexing: 'Indexing documents',
        evaluating: 'Checking retrieval',
        done: 'Scan finished',
      };
  const active = value.status === 'processing';
  const determinate = p.total != null && p.total > 0;
  const percent = determinate
    ? Math.min(100, Math.floor((p.completed / p.total) * 100))
    : undefined;
  const seconds = Math.max(0, Math.floor(((active ? now : p.updatedAt) - p.startedAt) / 1000));
  return (
    <div
      className="knowledge-progress"
      aria-live="polite"
      style={{
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        margin: '12px 0',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong>{labels[p.phase] || p.phase}</strong>
        <span>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </div>
      <progress
        aria-label={labels[p.phase] || p.phase}
        max={100}
        value={percent}
        style={{ width: '100%', height: 10, accentColor: 'var(--accent)', margin: '8px 0' }}
      />
      <div className="muted">
        {p.total != null
          ? `${p.completed} / ${p.total} · ${percent ?? 0}%`
          : zh
            ? `已发现 ${p.discovered} 个文件；此阶段总量待确定`
            : `${p.discovered} files discovered; stage total pending`}
        {' · '}
        {zh ? '导入 ' : 'Imported '}
        {p.imported}
        {' · '}
        {zh ? '未变化／已跳过 ' : 'Unchanged / skipped '}
        {p.reused}
        {' · '}
        {zh ? '问题 ' : 'Issues '}
        {p.failed}
      </div>
      {p.currentFile && (
        <div
          title={p.currentFile}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 6,
          }}
        >
          {p.currentFile}
        </div>
      )}
      {p.chunks && (
        <small>
          {zh ? '当前文档分块：' : 'Current document chunks: '}
          {p.chunks.completed} / {p.chunks.total}
        </small>
      )}
      <small style={{ display: 'block', marginTop: 6 }}>
        {zh
          ? '进度按当前阶段的文件数量计算，不代表剩余时间；已处理包括失败项。'
          : 'Progress counts files in the current stage, not remaining time; processed includes failures.'}
      </small>
    </div>
  );
}
