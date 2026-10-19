export function loopbackUrl(value, protocols) {
  const u = new URL(value);
  if (
    !protocols.includes(u.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error('Expected a credential-free loopback URL');
  return u;
}
export function validateConfig(c) {
  if (
    c.version !== 1 ||
    !c.database ||
    !c.accountId ||
    !c.statusFile ||
    !c.ledgerFile ||
    !c.lockFile
  )
    throw new Error('Missing offline-notice configuration');
  loopbackUrl(c.bridgeUrl, ['ws:', 'wss:']);
  loopbackUrl(c.healthUrl, ['http:', 'https:']);
  for (const [key, fallback, min, max] of [
    ['pollMs', 5000, 1000, 60000],
    ['timeoutMs', 2000, 100, 10000],
    ['failureThreshold', 3, 2, 20],
    ['cooldownMs', 120000, 30000, 3600000],
    ['globalCooldownMs', 10000, 1000, 60000],
    ['maxAgeMs', 60000, 1000, 120000],
  ]) {
    c[key] ??= fallback;
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error('Invalid ' + key);
  }
  c.notice ??=
    'Amadeus is temporarily unavailable. Please resend later. This notice does not mean your task was accepted.';
  if (typeof c.notice !== 'string' || !c.notice.trim() || c.notice.length > 500)
    throw new Error('Invalid notice');
  return c;
}
export function eligible(event, routes, config, now) {
  if (
    event.post_type !== 'message' ||
    !event.message_id ||
    !event.user_id ||
    String(event.self_id) !== String(config.accountId) ||
    String(event.user_id) === String(event.self_id)
  )
    return null;
  if (
    !Number.isFinite(event.time) ||
    Math.abs(now - event.time * 1000) > config.maxAgeMs ||
    !Array.isArray(event.message)
  )
    return null;
  const group = event.message_type === 'group';
  if (!group && event.message_type !== 'private') return null;
  const peer = String(group ? event.group_id : event.user_id),
    sender = String(event.user_id);
  return (
    routes.find((c) => {
      if (
        (!c.enabled && !(c.pauseReason === 'reauthorize' && !group && sender === c.senderId)) ||
        c.transport !== 'onebot11' ||
        String(c.accountId) !== String(config.accountId) ||
        c.endpoint?.replace(/\/$/, '') !== config.bridgeUrl.replace(/\/$/, '') ||
        (c.peerType || 'private') !== (group ? 'group' : 'private') ||
        c.peerId !== peer
      )
        return false;
      if (!(
        sender === c.senderId ||
        (group &&
          ((c.allowedSenders || []).includes(sender) ||
            (c.accessMode === 'chat' && c.allGroupMembers === true)))
      ))
        return false;
      if (!group) return true;
      const at = event.message.some(
        (p) => p.type === 'at' && String(p.data?.qq) === String(config.accountId),
      );
      const text = event.message
        .filter((p) => p.type === 'text')
        .map((p) => p.data?.text || '')
        .join('')
        .trim();
      const prefix = c.groupPrefix || '/amadeus';
      return at || text === prefix || text.startsWith(prefix + ' ');
    }) || null
  );
}
export class OfflineNotice {
  constructor(config, io, saved = {}) {
    this.config = config;
    this.io = io;
    this.failures = 0;
    this.busy = false;
    this.seen = new Map(saved.seen || []);
    this.cooldown = new Map(saved.cooldown || []);
    this.lastGlobal = saved.lastGlobal || 0;
  }
  async poll() {
    this.failures = (await this.io.healthy()) ? 0 : Math.min(100, this.failures + 1);
  }
  prune(now) {
    for (const [k, t] of this.seen) if (now - t > this.config.maxAgeMs * 2) this.seen.delete(k);
    for (const [k, t] of this.cooldown)
      if (now - t > this.config.cooldownMs) this.cooldown.delete(k);
    for (const m of [this.seen, this.cooldown])
      while (m.size > 1000) m.delete(m.keys().next().value);
  }
  async receive(event) {
    if (this.busy) return false;
    this.busy = true;
    try {
      const now = this.io.now();
      this.prune(now);
      const route = eligible(event, await this.io.routes(), this.config, now);
      if (!route) return false;
      const reauthorize = !route.enabled && route.pauseReason === 'reauthorize';
      if (!reauthorize && this.failures < this.config.failureThreshold) return false;
      const key = route.id + ':' + event.message_id;
      if (
        this.seen.has(key) ||
        now - (this.cooldown.get(route.id) || 0) < this.config.cooldownMs ||
        now - this.lastGlobal < this.config.globalCooldownMs
      )
        return false;
      if (!reauthorize && (await this.io.healthy())) {
        this.failures = 0;
        return false;
      }
      const current = eligible(event, await this.io.routes(), this.config, this.io.now());
      if (
        !current ||
        current.id !== route.id ||
        (!current.enabled && current.pauseReason === 'reauthorize') !== reauthorize ||
        !this.io.connected()
      )
        return false;
      // Persist before send: uncertain delivery is never automatically retried.
      this.seen.set(key, this.io.now());
      this.cooldown.set(route.id, this.io.now());
      this.lastGlobal = this.io.now();
      await this.io.save({
        seen: [...this.seen],
        cooldown: [...this.cooldown],
        lastGlobal: this.lastGlobal,
      });
      const group = event.message_type === 'group';
      await this.io.send({
        action: group ? 'send_group_msg' : 'send_private_msg',
        params: {
          [group ? 'group_id' : 'user_id']: group ? event.group_id : event.user_id,
          message: [
            {
              type: 'text',
              data: {
                text: reauthorize
                  ? this.config.reauthorizeNotice ||
                    'This chat needs local reauthorization after a settings change. Review and enable it in Chat Connections. No task was accepted.'
                  : this.config.notice,
              },
            },
          ],
        },
        echo: 'offline-notice-' + event.message_id,
      });
      return true;
    } finally {
      this.busy = false;
    }
  }
}
