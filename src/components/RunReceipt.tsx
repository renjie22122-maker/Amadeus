import { useEffect, useState } from 'react';
import { api } from '../api';
import type { runReceipt } from '../../server/services/run-receipt';
type Receipt = ReturnType<typeof runReceipt>;
export function RunReceipt({
  conversationId,
  runId,
  dot = false,
  zh,
}: {
  conversationId: string;
  runId: string;
  dot?: boolean;
  zh: boolean;
}) {
  const label = (en: string, cn: string) => (zh ? cn : en);
  const [open, setOpen] = useState(false),
    [tick, refresh] = useState(0),
    [data, setData] = useState<Receipt>(),
    [error, setError] = useState(false);
  const path =
    (dot ? '/personal/dot/' : '/conversations/') +
    encodeURIComponent(conversationId) +
    '/runs/' +
    encodeURIComponent(runId) +
    '/receipt';
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setData(undefined);
    setError(false);
    void api<Receipt>(path, undefined, 'GET', {}, ctrl.signal)
      .then((value) => {
        if (!ctrl.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      });
    return () => ctrl.abort();
  }, [open, path, tick]);
  const ms = (v: unknown) => (typeof v === 'number' ? `${v} ms` : '—');
  const states: Record<string, string> = {
    pending: '排队',
    sending: '发送中',
    sent: '通道已发送',
    failed: '失败',
    uncertain: '结果未知',
    'uncertain-closed': '结果未知（已关闭）',
    cancelled: '已取消',
  };
  return (
    <details className="run-receipt" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label('Run receipt', '本轮执行回执')}</summary>
      {open && (
        <>
          <button type="button" onClick={() => refresh((n) => n + 1)}>
            {label('Refresh', '刷新')}
          </button>
          {error ? (
            <p>{label('Unable to read this receipt.', '暂时无法读取回执。')}</p>
          ) : !data ? (
            <p>{label('Loading…', '加载中…')}</p>
          ) : (
            <>
              <p>
                {label('Run', '运行')} <code>{data.runId}</code> · {data.status}
              </p>
              <p>
                {label('Model calls in this run', '本运行模型调用')}：{data.localModelCalls} ·{' '}
                {label('recent requests shown', '最近显示')} {data.modelRequests.length}/
                {data.requestLimit}
              </p>
              {data.modelRequests.map((r) => (
                <p key={String(r.requestId)} title={String(r.requestId)}>
                  {r.outcome === 'failed'
                    ? label('Failed', '失败')
                    : r.outcome === 'returned'
                      ? label('Returned', '已返回')
                      : label('No timing record', '无计时记录')}{' '}
                  · {label('First text', '首段正文')} {ms(r.firstTextMs)} ·{' '}
                  {label('First reasoning signal', '首个推理信号')} {ms(r.firstThinkingMs)} ·{' '}
                  {label('Total', '总计')} {ms(r.elapsedMs)} ·{' '}
                  {r.measured === 1
                    ? label('Usage reported', '用量已报')
                    : label('Usage unreported', '用量未报')}
                </p>
              ))}
              {data.settledTools.length > 0 && (
                <details>
                  <summary>
                    {label('Recent settled tools', '最近结束的工具调用')} ·{' '}
                    {data.settledTools.length}
                  </summary>
                  <ul>
                    {data.settledTools.map((t, i) => (
                      <li key={i}>
                        {String(t.name)} · {ms(t.elapsedMs)} · {String(t.status || '—')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p>
                {label('Latest memory recall', '最近一次记忆召回')}：
                {data.recall
                  ? `${data.recall.count} · ${data.recall.method} · ${ms(data.recall.elapsedMs)}`
                  : '—'}
              </p>
              <p>
                {label('Linked outgoing replies', '有记录的对外回复')}：
                {data.delivery.length
                  ? data.delivery
                      .map(
                        (d) =>
                          `${zh ? states[String(d.state)] || d.state : d.state} × ${d.count} (${label('platform IDs', '有平台消息编号')} ${d.platformReceipts}${typeof d.maxAckMs === 'number' ? ', ' + label('max queue to ack', '最长入队至回执') + ' ' + ms(d.maxAckMs) : ''})`,
                      )
                      .join(' / ')
                  : data.deliveryAvailable
                    ? label('No linked records', '无关联记录')
                    : label('Chat adapter unavailable', '外部聊天投递不可用')}
              </p>
              <small>
                {label(
                  'A platform ID is not a read receipt. Missing measurements and legacy records stay unknown.',
                  '平台消息编号不代表对方已读。未测量项和旧记录保持未知。',
                )}
              </small>
            </>
          )}
        </>
      )}
    </details>
  );
}
