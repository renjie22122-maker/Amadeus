/** Standalone for embedding in a locally maintained bridge; never reset credentials. */
export function createLoginRecovery({
  isOnline,
  onOffline,
  onRecovered,
  restart,
  report = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  kickedDelayMs = 3500,
  selfOfflineDelayMs = 60000,
  retryDelayMs = 15000,
  maxAttempts = 5,
}) {
  let timer,
    busy = false,
    pending = false,
    forced = false,
    attempts = 0,
    reason;
  const emit = (state) => {
    try {
      report({ state, attempt: attempts });
    } catch {}
  };
  const run = async () => {
    timer = undefined;
    if (isOnline()) {
      pending = false;
      attempts = 0;
      forced = false;
      onRecovered();
      emit('recovered');
      return;
    }
    busy = true;
    attempts++;
    emit('restart-requested');
    let accepted = false;
    try {
      accepted = await restart(reason);
    } catch {}
    busy = false;
    if (accepted) emit('restart-accepted');
    if (attempts >= maxAttempts) {
      emit('recovery-exhausted');
      return;
    }
    emit('retry-wait');
    timer = schedule(run, retryDelayMs * attempts);
  };
  return (message, transient) => {
    if (pending) {
      // Duplicate events must not reset the attempt limit or postpone a forced recovery.
      if (!transient && !forced && !busy && timer !== undefined && attempts === 0) {
        forced = true;
        reason = message;
        cancel(timer);
        timer = schedule(run, kickedDelayMs);
      }
      return;
    }
    reason = message;
    pending = true;
    forced = !transient;
    onOffline(message);
    emit(transient ? 'transport-offline' : 'session-invalidated');
    timer = schedule(run, transient ? selfOfflineDelayMs : kickedDelayMs);
  };
}

/** Strictly retain known numeric/boolean diagnostic fields, never arbitrary event values. */
export function safeLoginReason(event) {
  const result = {};
  for (const key of [
    'code',
    'errCode',
    'errorCode',
    'reason',
    'reasonCode',
    'type',
    'errType',
    'kickType',
    'offlineType',
    'isRecoverable',
  ]) {
    const value = event?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value)))
      result[key] = value;
  }
  return result;
}
