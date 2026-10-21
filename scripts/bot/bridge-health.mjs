// A quiet chat is not evidence of disconnection. Probe platform state separately.
export class BridgeHealth {
  constructor(accountId, saved = {}) {
    this.accountId = String(accountId);
    this.baseline = saved.baseline === true;
    this.restarts = Array.isArray(saved.restarts) ? saved.restarts.filter(Number.isFinite) : [];
    this.failures = 0;
    this.started = Date.now();
    this.lastMessage = 0;
  }
  snapshot() {
    return { baseline: this.baseline, restarts: this.restarts };
  }
  observe(sample, now = Date.now()) {
    this.restarts = this.restarts.filter((t) => now - t < 3600000);
    if (String(sample.accountId) !== this.accountId || sample.online !== true) {
      this.failures = 0;
      return { state: 'login-required', restart: false };
    }
    if (!Number.isInteger(sample.friends) || sample.friends < 0) {
      this.failures = 0;
      return { state: 'probe-unavailable', restart: false };
    }
    if (sample.friends > 0) {
      this.baseline = true;
      this.failures = 0;
      return { state: 'platform-responsive', restart: false };
    }
    if (!this.baseline || now - this.started < 180000 || now - this.lastMessage < 120000) {
      this.failures = 0;
      return { state: 'warming-or-unverified', restart: false };
    }
    this.failures++;
    const allowed =
      this.failures >= 3 && this.restarts.length < 2 && now - (this.restarts.at(-1) || 0) >= 600000;
    return { state: allowed ? 'reconnect-needed' : 'platform-suspect', restart: allowed };
  }
  markRestart(now = Date.now()) {
    this.restarts.push(now);
    this.failures = 0;
    this.started = now;
  }
}
