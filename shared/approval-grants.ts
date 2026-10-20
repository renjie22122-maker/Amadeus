export function approvalGrantMode(p: Record<string, any>): 'service' | 'exact' | undefined {
  if (p.forceManual || p.action === 'resolve-effect') return;
  if (p.backend === 'media-service') {
    if (
      ['media-generation', 'media-transcription'].includes(p.repeatable?.kind) &&
      typeof p.repeatable.serviceId === 'string' &&
      /^[a-f0-9]{64}$/.test(p.repeatable.fingerprint || '') &&
      Number.isFinite(p.estimatedUsd) &&
      p.estimatedUsd >= 0
    )
      return 'service';
    return;
  }
  // Missing execution identity (e.g. an extension name alone) cannot define a reusable scope.
  if (
    typeof p.backend === 'string' &&
    p.backend &&
    typeof p.command === 'string' &&
    p.command &&
    (p.estimatedUsd === undefined || (Number.isFinite(p.estimatedUsd) && p.estimatedUsd >= 0))
  )
    return 'exact';
}
export const canRememberApproval = (p: Record<string, any>) => !!approvalGrantMode(p);
export function rememberedApprovalScope(p: Record<string, any>) {
  return (
    (approvalGrantMode(p) === 'service'
      ? '本会话内同一媒体服务配置；正文、音色、参数和有权访问的参考附件可变；单次估算费用不增加。'
      : '本会话内完全相同的审批参数、命令、执行后端和目标；不按相似文字匹配。') +
    '有效 24 小时、最多 100 次，可随时撤销。'
  );
}
