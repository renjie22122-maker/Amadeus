/** Tool receipts are evidence of observed outcomes, never of invented root causes. */
export function experienceOutcome(data: any): 'success' | 'failure' | undefined {
  if (['denied', 'not_started', 'unknown'].includes(data?.outcome?.status)) return;
  try {
    const output = JSON.parse(data?.output || '{}');
    if (output.timedOut || output.aborted || output.notStarted) return;
  } catch {}
  if (/TIMEOUT|TIMED_OUT|ABORT|CANCEL|DEFERRED/.test(String(data?.outcome?.code || ''))) return;
  if (data?.verification?.passed === false) return 'failure';
  if (data?.outcome?.status === 'failed')
    return data.outcome.executionStarted === true ? 'failure' : undefined;
  if (data?.verification?.passed === true) return 'success';
}
