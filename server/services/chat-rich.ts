/** Platform cards and forwarded text are untrusted evidence, never chat authority. */
export function richSegments(parts: any) {
  const forwards: string[] = [],
    replies: string[] = [],
    cards: any[] = [];
  for (const p of Array.isArray(parts) ? parts.slice(0, 100) : []) {
    if (p?.type === 'forward' && forwards.length < 4 && typeof p.data?.id === 'string')
      forwards.push(p.data.id.slice(0, 256));
    if (p?.type === 'reply' && replies.length < 4)
      replies.push(String(p.data?.id ?? p.data?.message_id ?? '').slice(0, 256));
    if (!['json', 'xml'].includes(p?.type) || cards.length >= 4) continue;
    const raw = p.data?.data;
    if (typeof raw !== 'string' || raw.length > 65536) {
      cards.push({ type: p.type, status: 'invalid-or-oversized' });
      continue;
    }
    let value: any = raw;
    if (p.type === 'json') {
      try {
        value = JSON.parse(raw);
      } catch {
        cards.push({ type: p.type, status: 'invalid-json' });
        continue;
      }
    }
    const fields: { path: string; value: string }[] = [];
    let visited = 0;
    function walk(v: any, path: string, depth: number) {
      if (++visited > 200 || depth > 6 || fields.length >= 30) return;
      if (typeof v === 'string') {
        fields.push({ path, value: v.slice(0, 1000) });
        return;
      }
      if (v && typeof v === 'object')
        for (const [key, item] of Object.entries(v).slice(0, 40))
          walk(item, path ? path + '.' + key : key, depth + 1);
    }
    walk(value, '', 0);
    const links: string[] = [];
    for (const f of fields)
      for (const m of f.value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
        try {
          const u = new URL(m[0].replace(/&amp;/g, '&'));
          if (!u.username && !u.password && links.length < 10) links.push(u.href);
        } catch {}
      }
    cards.push({
      type: p.type,
      fields,
      links: [...new Set(links)],
      note: 'Card claims only; links have not been fetched or verified.',
    });
  }
  return { forwards, replies, cards };
}
export function richSummary(parts: any) {
  const rich = richSegments(parts);
  return [
    rich.forwards.length ? '[Forwarded chat; use read_chat_message to expand.]' : '',
    ...rich.cards.map((c) => '[Shared card: ' + JSON.stringify(c).slice(0, 3000) + ']'),
  ]
    .filter(Boolean)
    .join(' ');
}
export function forwardPage(raw: any, offset: number, limit: number) {
  const nodes = raw?.messages ?? raw?.message;
  if (!Array.isArray(nodes))
    throw Error('Forwarded record is unavailable or has an unsupported response shape.');
  let budget = 20000,
    visited = 0;
  const media: any[] = [];
  let truncated = false;
  function node(n: any, depth: number): any {
    if (++visited > 100 || depth > 3 || budget <= 0) {
      truncated = true;
      return { truncated: true };
    }
    const parts = n.message ?? n.content ?? n.data?.message ?? n.data?.content;
    const items = [];
    if (Array.isArray(parts) && parts.length > 80) truncated = true;
    for (const p of (Array.isArray(parts) ? parts : []).slice(0, 80)) {
      if (budget <= 0) break;
      if (p.type === 'node') {
        items.push(node(p, depth + 1));
        continue;
      }
      if (p.type === 'text') {
        const text = String(p.data?.text || '').slice(0, Math.min(4000, budget));
        if (text.length < String(p.data?.text || '').length) truncated = true;
        budget -= text.length;
        items.push({ text });
      } else if (['image', 'record', 'video', 'file'].includes(p.type)) {
        const kind =
          p.type === 'record'
            ? 'audio'
            : p.type === 'image'
              ? 'image'
              : p.type === 'video'
                ? 'video'
                : 'file';
        items.push({ media: kind, inspected: false });
        if (media.length < 10)
          media.push({
            id: p.data?.file,
            url: p.data?.url,
            name: String(p.data?.name || p.type).slice(0, 200),
            kind,
          });
      } else {
        const summary = richSummary([p]).slice(0, budget);
        budget -= summary.length;
        if (summary) items.push({ card: summary });
      }
    }
    return {
      claimedSenderId: String(n.sender?.user_id ?? n.user_id ?? n.data?.user_id ?? ''),
      claimedName: String(n.sender?.nickname ?? n.data?.nickname ?? '').slice(0, 200),
      items,
    };
  }
  return {
    messages: nodes.slice(offset, offset + limit).map((n) => node(n, 0)),
    media,
    total: nodes.length,
    nextOffset: offset + limit < nodes.length ? offset + limit : null,
    truncated: truncated || budget <= 0 || visited > 100,
  };
}
