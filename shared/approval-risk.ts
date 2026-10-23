export function approvalRisk(payload: Record<string, any>) {
  const command = typeof payload.command === 'string' ? payload.command.trim() : '';
  if (payload.forceHuman || payload.forceManual)
    return {
      level: 'high',
      reason: 'Explicit human approval required',
      zh: '此操作要求人工确认',
      automatic: false,
    };
  if (
    /\b(format|diskpart|shutdown|reg\s+(add|delete)|remove-item|rm\s+-|del\s|rmdir|git\s+push)\b/i.test(
      command,
    )
  )
    return {
      level: 'high',
      reason: 'Deletion, system changes or publishing detected',
      zh: '涉及删除、系统修改或发布，请核对范围',
      automatic: false,
    };
  if (/^cd$/i.test(command))
    return {
      level: 'low',
      reason: 'Exact built-in environment query; no arguments',
      zh: '无参数的内置环境查询',
      automatic: true,
    };
  if (/\b(install|download|curl|wget|pip|npm|npx)\b/i.test(command) || payload.serviceId)
    return {
      level: 'medium',
      reason: 'Network, dependency or paid-service operation',
      zh: '可能涉及网络、安装依赖或付费服务',
      automatic: false,
    };
  return {
    level: 'unknown',
    reason: 'Effects require inspection; unknown is not low risk',
    zh: '影响尚不明确；未知不等于低风险',
    automatic: false,
  };
}
