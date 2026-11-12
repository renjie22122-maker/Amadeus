/** Bounded diagnostic transitions; never retain URLs, errors, payloads or credentials. */
export class BotHealthHistory {
  constructor(saved = []) {
    this.entries = Array.isArray(saved) ? saved.filter(valid).slice(-256) : [];
  }
  observe(source, state, at = Date.now()) {
    const entry = { source, state, at };
    if (!valid(entry)) return false;
    const previous = this.entries.findLast((e) => e.source === source);
    if (previous?.state === state) return false;
    this.entries.push(entry);
    this.entries = this.entries.slice(-256);
    return true;
  }
}
function valid(e) {
  return (
    e &&
    ['login', 'bridge', 'watcher'].includes(e.source) &&
    typeof e.state === 'string' &&
    /^[a-z][a-z-]{0,63}$/.test(e.state) &&
    Number.isFinite(e.at) &&
    Object.keys(e).every((k) => ['source', 'state', 'at'].includes(k))
  );
}
