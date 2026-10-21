// Only explicit protocol failures are eligible for automatic retry.
// Never persist provider messages: they may include credentials, URLs or private content.
export class ChatSendRejected extends Error {
  constructor(
    readonly code: number | undefined,
    readonly platformCode: number | undefined,
    readonly retryable: boolean,
  ) {
    super('Platform rejected send');
  }
}
export function onebotSendError(response: any): Error {
  if (
    response?.status !== 'failed' ||
    !Number.isInteger(response?.retcode) ||
    response.retcode === 0
  )
    return Error('OneBot send unconfirmed');
  const raw = typeof response.message === 'string' ? response.message.slice(0, 4096) : '';
  const match = /"result"\s*:\s*(-?\d+)/.exec(raw);
  const platformCode = match ? Number(match[1]) : undefined;
  // QQ explicitly rejected the operation because its network session was unavailable.
  // Generic bridge errors/timeouts are NOT proof that a message was not delivered.
  if (platformCode !== 1006514) return Error('OneBot send unconfirmed');
  return new ChatSendRejected(response.retcode, platformCode, true);
}
export function chatSendRetry(attempt: number): number | undefined {
  return [2000, 4000, 8000, 16000, 30000][attempt - 1];
}
