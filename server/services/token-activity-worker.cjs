const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
function activity(db, year, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (at) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(at)).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const days = new Map(),
    models = new Map();
  const total = {
    input: 0,
    output: 0,
    cached: 0,
    calls: 0,
    unreported: 0,
    estimatedUsd: 0,
    unpriced: 0,
  };
  const low = Date.UTC(year, 0, 1) - 86400000,
    high = Date.UTC(year + 1, 0, 1) + 86400000;
  const add = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
  const number = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
  for (const row of db
    .prepare(
      "SELECT data FROM ledger WHERE json_extract(data,'$.at')>=? AND json_extract(data,'$.at')<?",
    )
    .iterate(low, high)) {
    const entry = JSON.parse(row.data),
      date = dayOf(entry.at);
    if (!date.startsWith(year + '-')) continue;
    const day = days.get(date) || {
      date,
      input: 0,
      output: 0,
      cached: 0,
      calls: 0,
      unreported: 0,
      estimatedUsd: 0,
      unpriced: 0,
    };
    days.set(date, day);
    add(models, entry.model || 'Unknown');
    const u = entry.usage || {},
      p = entry.pricing?.prices;
    for (const target of [day, total]) {
      target.calls++;
      if (!u.measured) {
        target.unreported++;
        continue;
      }
      const input = number(u.input),
        output = number(u.output),
        cached = Math.min(input, number(u.cached));
      target.input += input;
      target.output += output;
      target.cached += cached;
      if (
        p &&
        [p.input, p.output, p.cached].every(
          (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0,
        )
      )
        target.estimatedUsd +=
          ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
      else target.unpriced++;
    }
  }
  const reasoning = new Map();
  let runs = 0;
  for (const row of db
    .prepare(
      "SELECT created_at,json_extract(data,'$.reasoning') AS reasoning FROM run_metadata WHERE created_at>=? AND created_at<?",
    )
    .iterate(low, high)) {
    if (!dayOf(row.created_at).startsWith(year + '-')) continue;
    runs++;
    add(reasoning, row.reasoning || 'unrecorded');
  }
  const skills = new Set();
  let skillReads = 0;
  for (const row of db
    .prepare(
      "SELECT json_extract(s.data,'$.skillId') AS skill,r.created_at FROM records s JOIN run_metadata r ON r.id=json_extract(s.data,'$.runId') WHERE s.kind='skill-read' AND r.created_at>=? AND r.created_at<?",
    )
    .iterate(low, high)) {
    if (dayOf(row.created_at).startsWith(year + '-')) {
      skills.add(row.skill);
      skillReads++;
    }
  }
  const plugins = new Map();
  for (const row of db
    .prepare(
      "SELECT created_at,json_extract(data,'$.arguments.serverId') AS server FROM events WHERE type='tool.started' AND json_extract(data,'$.name')='mcp_call' AND created_at>=? AND created_at<?",
    )
    .iterate(low, high)) {
    if (row.server && dayOf(row.created_at).startsWith(year + '-')) add(plugins, row.server);
  }
  const ranking = (map) =>
    [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    year,
    timeZone,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    total,
    runs,
    reasoning: ranking(reasoning),
    models: ranking(models),
    skillsExplored: skills.size,
    skillReads,
    plugins: ranking(plugins),
    generatedAt: Date.now(),
  };
}
module.exports = { activity };
if (!isMainThread) {
  let db;
  try {
    db = new DatabaseSync(workerData.path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    parentPort.postMessage({ result: activity(db, workerData.year, workerData.timeZone) });
  } catch {
    parentPort.postMessage({ error: 'Usage statistics could not be read.' });
  } finally {
    db?.close();
  }
}
