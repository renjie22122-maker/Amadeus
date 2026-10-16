import { Activity, FolderOpen, ChevronRight } from 'lucide-react';
import type { Project } from '../../shared/types';
import { useInspectionResource } from './InspectorPanels';
const compact = (n: number) =>
  n >= 1000000
    ? (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
    : n >= 1000
      ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      : String(n);
export function ConversationStatus({
  id,
  live,
  status,
  project,
  isolated,
  zh,
  open,
}: {
  id: string;
  live: boolean;
  status: string;
  project?: Project;
  isolated: boolean;
  zh: boolean;
  open: (tab: 'context' | 'files') => void;
}) {
  const { data, error } = useInspectionResource(
    '/conversations/' + id + '/context?summary=1',
    live,
  );
  const measured = data?.budget?.method === 'measured',
    value = data?.budget?.tokens || 0,
    capacity = data?.capacity || 0;
  const percent = capacity ? Math.round((value / capacity) * 100) : 0;
  const labels: Record<string, string> = {
    running: '执行中',
    queued: '排队中',
    waiting_user: '等待回答',
    waiting_approval: '等待批准',
    waiting_children: '等待子任务',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    ready: '就绪',
  };
  const title =
    error ||
    (zh
      ? (measured ? '最近一次主任务请求的 API 实测输入：' : '当前上下文估算（有实测时校准）：') +
        value.toLocaleString() +
        ' / ' +
        capacity.toLocaleString() +
        ' tokens；压缩 ' +
        (data?.compactionCount ?? data?.compactions.length ?? 0) +
        ' 次；当前压缩触发阈值为 ' +
        (data?.compressionThresholdTokens?.toLocaleString() || '—') +
        ' tokens。'
      : (measured
          ? 'Latest task request: measured API input '
          : 'Rough character-based estimate, not tokenizer measurement: ') +
        value.toLocaleString() +
        ' / ' +
        capacity.toLocaleString() +
        ' tokens; ' +
        (data?.compactionCount ?? data?.compactions.length ?? 0) +
        ' compactions. Compression uses the same token estimate.');
  return (
    <div className="conversation-status">
      <span className={'status-label ' + (live ? 'active' : '')}>
        <i />
        {zh ? labels[status] || status : status.replaceAll('_', ' ')}
      </span>
      <button
        className="context-chip"
        onClick={() => open('context')}
        title={title}
        aria-label={zh ? '查看上下文' : 'View context'}
      >
        <Activity size={14} />
        <span>{zh ? '上下文' : 'Context'}</span>
        <b>{data && !error ? (measured ? '' : '≈') + percent + '%' : '—'}</b>
        <span className="context-amount">
          {data && !error
            ? (measured ? '' : '≈') + compact(value) + ' / ' + compact(capacity)
            : '—'}
        </span>
        <span className="context-mini-meter">
          <i style={{ width: Math.min(100, percent) + '%' }} />
        </span>
        <ChevronRight size={12} />
      </button>
      <button
        className="workspace-chip"
        onClick={() => open('files')}
        title={
          project?.folders.join('\n') ||
          (zh ? '仅当前会话的产物，未绑定项目' : 'Conversation artifacts; no project')
        }
        aria-label={zh ? '查看工作区' : 'View workspace'}
      >
        <FolderOpen size={14} />
        <span>
          {isolated
            ? zh
              ? '子任务副本'
              : 'Child copy'
            : project
              ? (zh ? '工作区 ' : 'Workspace ') + project.name
              : zh
                ? '会话产物'
                : 'Chat files'}
        </span>
        <ChevronRight size={12} />
      </button>
    </div>
  );
}
