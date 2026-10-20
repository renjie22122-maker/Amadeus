/** Compact review text preserves commands and destinations. Only media prose has a marked preview. */
export function chatApprovalSummary(payload: Record<string, any>) {
  const {
    command,
    reason,
    backend,
    cwd,
    estimatedUsd,
    risk,
    repeatable: _repeatable,
    repeatableBinding: _binding,
    ...other
  } = payload;
  let preview = '';
  if (backend === 'media-service' && typeof other.request?.prompt === 'string') {
    const { prompt, ...request } = other.request;
    other.request = request;
    const points = Array.from(prompt);
    preview =
      '正文：' +
      points.slice(0, 100).join('') +
      (points.length > 100 ? `…（共 ${points.length} 字符；详情可查看全文）` : '');
  }
  return [
    '待审批 · ' + (command || '操作'),
    reason ? '用途：' + reason : '',
    [backend, cwd].filter(Boolean).length
      ? '目标：' + [backend, cwd].filter(Boolean).join(' · ')
      : '',
    Object.keys(other).length ? '参数：' + JSON.stringify(other) : '',
    preview,
    estimatedUsd !== undefined
      ? '估算费用：' + (typeof estimatedUsd === 'number' ? '$' + estimatedUsd : '未知')
      : '',
    risk ? '风险：' + (risk.zh || risk.reason || risk.level || JSON.stringify(risk)) : '',
    '仅批准本次操作。详情中的任务内容不构成额外授权。',
  ]
    .filter(Boolean)
    .join('\n');
}
