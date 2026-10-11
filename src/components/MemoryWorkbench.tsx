import { memoryDecayPolicy, type DecayPolicy } from '../../shared/memory-decay';
import { memoryConversation } from '../../shared/memory-scope';
import { useEffect, useState } from 'react';
import { api } from '../api';
export function MemoryDetails({ memory: m, go, zh }: any) {
  const [content, setContent] = useState(m.content),
    [attribute, setAttribute] = useState(m.attribute || ''),
    [value, setValue] = useState(m.value || '');
  const [entity, setEntity] = useState(m.entityId || m.scope),
    [conditions, setConditions] = useState(m.conditions || ''),
    [kind, setKind] = useState(m.kind || 'preference');
  const [until, setUntil] = useState(
    m.validUntil ? new Date(m.validUntil).toISOString().slice(0, 16) : '',
  );
  const [decay, setDecay] = useState<DecayPolicy>(m.decayPolicy || 'auto');
  const [days, setDays] = useState(m.halfLifeDays || 30),
    [turns, setTurns] = useState(m.halfLifeTurns || 100);
  const [reach, setReach] = useState(m.recallScope || 'auto');
  const [history, setHistory] = useState<any[]>([]);
  return (
    <details>
      <summary>
        {zh ? '时间、来源与修订' : 'Time, sources & revisions'} ·{' '}
        {m.status || (m.active ? 'active' : 'candidate')}
      </summary>
      <p>
        {zh ? '有效起始' : 'Valid from'}: {new Date(m.validFrom ?? m.createdAt).toLocaleString()} ·{' '}
        {zh ? '记录时间' : 'Recorded'}: {new Date(m.recordedAt ?? m.createdAt).toLocaleString()}
      </p>
      <label>
        {zh ? '内容' : 'Content'}
        <textarea
          aria-label={zh ? '内容' : 'Content'}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <label>
        {zh ? '衰减规则' : 'Decay policy'}
        <select value={decay} onChange={(e) => setDecay(e.target.value as DecayPolicy)}>
          <option value="auto">{zh ? '自动：按记忆类型' : 'Automatic by memory kind'}</option>
          <option value="stable">{zh ? '不衰减' : 'Stable (no decay)'}</option>
          <option value="time">{zh ? '按时间' : 'By time'}</option>
          <option value="turns">{zh ? '按后续用户轮次' : 'By later user turns'}</option>
          <option value="time-and-turns">{zh ? '按时间和轮次' : 'By time and turns'}</option>
        </select>
      </label>
      {decay !== 'stable' && (
        <div className="row">
          <label>
            {zh ? '时间半衰期（天）' : 'Time half-life (days)'}
            <input
              type="number"
              min={1}
              max={36500}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          <label>
            {zh ? '轮次半衰期' : 'User-turn half-life'}
            <input
              type="number"
              min={1}
              max={100000}
              value={turns}
              onChange={(e) => setTurns(Number(e.target.value))}
            />
          </label>
        </div>
      )}
      <p className="muted">
        {zh
          ? '只降低召回排序，不自动删除、不代表真实性。自动规则：稳定偏好和项目决定不衰减；情节及普通对话决定按时间和轮次衰减。'
          : 'Ranking only, not truth or deletion. Auto: preferences/project decisions stay stable; episodes/general-chat decisions decay by time and turns.'}
        {decay === 'auto' && ' · ' + memoryDecayPolicy({ ...m, kind, decayPolicy: 'auto' })}
      </p>
      <label>
        {zh ? '召回范围' : 'Recall scope'}
        <select
          value={reach}
          onChange={(e) => setReach(e.target.value as 'conversation' | 'scope')}
        >
          <option value="auto">{zh ? '自动：按记忆类型' : 'Automatic by memory kind'}</option>
          <option value="conversation" disabled={!memoryConversation(m)}>
            {zh ? '仅原对话' : 'Original conversation only'}
          </option>
          <option value="scope">
            {zh ? '本范围共享（普通对话或当前项目）' : 'Shared within this user/project scope'}
          </option>
        </select>
      </label>
      <p className="muted">
        {zh
          ? '跨场景仍适用的偏好才共享；本次情节应限于原对话。不会跨项目。'
          : 'Share only reusable preferences; local events belong to the original conversation. Never crosses projects.'}
        {reach === 'conversation' &&
          !memoryConversation(m) &&
          (zh
            ? ' 此旧条目没有可核实的原对话，限制后不会召回。'
            : ' This legacy entry has no identifiable source conversation and will not be recalled.')}
      </p>
      <label>
        {zh ? '类型' : 'Kind'}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {['preference', 'decision', 'episode', 'experience'].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        {zh ? '实体 ID' : 'Entity ID'}
        <input value={entity} onChange={(e) => setEntity(e.target.value)} />
      </label>
      <label>
        {zh ? '事实项（例如 python_version）' : 'Attribute (e.g. python_version)'}
        <input value={attribute} onChange={(e) => setAttribute(e.target.value)} />
      </label>
      <label>
        {zh ? '值' : 'Value'}
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label>
        {zh ? '适用条件（经验必须填写）' : 'Applicability (required for experience)'}
        <textarea value={conditions} onChange={(e) => setConditions(e.target.value)} />
      </label>
      <label>
        {zh ? '失效时间（UTC）' : 'Valid until (UTC)'}
        <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <p>
        {zh
          ? '经验只有关联成功工具结果且填写适用条件才能激活；模型总结不能代替证据。'
          : 'Experiences require successful tool evidence and applicability before activation; model summaries are not evidence.'}
      </p>
      {m.evidence?.map((e: any) => (
        <code key={e.eventId}>
          {e.conversationId}#{e.eventId} {e.quote}
        </code>
      ))}
      <button
        onClick={() =>
          go(() =>
            api(
              '/memories/' + m.id,
              {
                content,
                recallScope: reach,
                decayPolicy: decay,
                halfLifeDays: days,
                halfLifeTurns: turns,
                entityId: entity,
                attribute,
                value,
                kind,
                conditions,
                validUntil: until ? Date.parse(until + 'Z') : null,
                revision: m.revision,
              },
              'PATCH',
            ),
          )
        }
      >
        {zh ? '保存修订' : 'Save revision'}
      </button>
      {!!m.conflictsWith?.length && (
        <button
          onClick={() => {
            if (
              confirm(
                zh
                  ? '用此条替代冲突条目？旧版本保留用于历史查询。'
                  : 'Replace conflicting entries? Old versions remain for historical queries.',
              )
            )
              go(() =>
                api('/memories/' + m.id + '/resolve', {
                  losers: m.conflictsWith,
                  revision: m.revision,
                }),
              );
          }}
        >
          {zh ? '确认此条，替代冲突' : 'Resolve in favor of this entry'}
        </button>
      )}
      <button
        onClick={() => go(async () => setHistory(await api('/memories/' + m.id + '/history')))}
      >
        {zh ? '查看修订历史' : 'Show revision history'}
      </button>
      {history.map((h) => (
        <div key={h.id}>
          <small>
            {new Date(h.at).toLocaleString()} · {h.reason} · {h.after.revision}
          </small>
          <p>
            {h.before?.content} → {h.after.content}
          </p>
          {h.before &&
            h.after.revision === m.revision &&
            !h.reason.startsWith('superseded') &&
            !h.reason.startsWith('conflict resolved') &&
            !h.reason.startsWith('consolidated') && (
              <button
                onClick={() => go(() => api('/memories/' + m.id + '/undo', { historyId: h.id }))}
              >
                {zh ? '撤销此次修改' : 'Undo this edit'}
              </button>
            )}
        </div>
      ))}
    </details>
  );
}
export function MemoryWorkbench({ scope, go, zh, memories = [] }: any) {
  const [entities, setEntities] = useState<any[]>([]),
    [edges, setEdges] = useState<any[]>([]);
  const [name, setName] = useState(''),
    [aliases, setAliases] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [relation, setRelation] = useState('');
  const [sourceType, setSourceType] = useState('memory'),
    [sourceId, setSourceId] = useState(''),
    [chat, setChat] = useState(''),
    [quote, setQuote] = useState('');
  const [query, setQuery] = useState(''),
    [date, setDate] = useState(''),
    [results, setResults] = useState<any>(null);
  const [issues, setIssues] = useState<any[]>([]);
  const load = async () => {
    const [a, b] = await Promise.all([
      api('/memory-entities?scope=' + encodeURIComponent(scope)),
      api('/knowledge-graph?scope=' + encodeURIComponent(scope)),
    ]);
    setEntities(a);
    setEdges(b);
  };
  useEffect(() => {
    setResults(null);
    setIssues([]);
    void go(load);
  }, [scope]);
  const [showInternal, setShowInternal] = useState(false),
    [graphQuery, setGraphQuery] = useState('');
  const [graphPage, setGraphPage] = useState(0);
  const internal = (e: any) => /^memory:/.test(e.name || '');
  const labelEntity = (key: string) => {
    if (key === scope) return zh ? '当前范围' : 'Current scope';
    const entity = entities.find((e) => e.id === key);
    if (!entity) return key;
    if (!internal(entity)) return entity.name;
    const memory = memories.find((m: any) => m.id === entity.name.slice(7));
    return (
      (zh ? '记忆来源：' : 'Memory source: ') +
      ((entity.displayName !== entity.name ? entity.displayName : memory?.content?.slice(0, 100)) ||
        (zh ? '已失效' : 'Unavailable'))
    );
  };
  const visibleEntities = entities.filter((e) => showInternal || !internal(e));
  const visibleEdges = edges.filter(
    (e) =>
      (showInternal || !entities.some((n) => internal(n) && (n.id === e.from || n.id === e.to))) &&
      [labelEntity(e.from), labelEntity(e.to), e.relation, ...e.evidence.map((x: any) => x.quote)]
        .join(' ')
        .toLowerCase()
        .includes(graphQuery.toLowerCase()),
  );
  const lastGraphPage = Math.max(0, Math.ceil(visibleEdges.length / 20) - 1);
  const currentGraphPage = Math.min(graphPage, lastGraphPage);
  const at = date ? Date.parse(date + 'Z') : undefined;
  return (
    <section className="panel">
      <details>
        <summary>
          {zh ? '实体、知识图谱与时间检索' : 'Entities, knowledge graph & temporal search'}
        </summary>
        <p className="muted">
          {zh
            ? '关系必须有同范围原文依据；候选确认后才参与最多三跳查询。路径连接不代表因果或事实推导。'
            : 'Relations need same-scope source quotes. Confirm candidates before querying up to three hops. A path does not establish causality or a new fact.'}
        </p>
        <p>
          {zh ? '实际实体' : 'Domain entities'}: {entities.filter((e) => !internal(e)).length} ·{' '}
          {zh ? '自动来源节点' : 'Automatic source nodes'}: {entities.filter(internal).length}
        </p>
        {edges.some((e) => !e.supportedNow) && (
          <p role="status">
            {zh
              ? '部分关系的来源已失效或缺失，不参与当前查询。请核实，不会自动确认。'
              : 'Some relations have missing or invalid evidence and are excluded from current queries. Review is required.'}
          </p>
        )}
        <div className="memory-graph-controls">
          <label className="memory-graph-toggle">
            <input
              type="checkbox"
              checked={showInternal}
              onChange={(e) => {
                setShowInternal(e.target.checked);
                setGraphPage(0);
              }}
            />
            <span>
              {zh
                ? '显示自动记忆来源节点（不是人物或概念）'
                : 'Show automatic memory source nodes (not domain entities)'}
            </span>
          </label>
          <input
            aria-label={zh ? '搜索关系' : 'Search relations'}
            placeholder={zh ? '搜索实体、关系或原文' : 'Search entities, relations or quotes'}
            value={graphQuery}
            onChange={(e) => {
              setGraphQuery(e.target.value);
              setGraphPage(0);
            }}
          />
        </div>
        <p className="muted">
          {zh
            ? '开启资料文件夹的实体关系自动提取后，有原文依据且无歧义的关系会自动入库。已确认实体可复用；新增别名、重名歧义和手工候选仍需确认。自动提取范围与费用沿用该资料文件夹设置。'
            : 'Folder graph extraction automatically saves unambiguous, source-backed relations. Confirmed entities are reusable; new aliases, ambiguous names and manual candidates still need confirmation. Folder settings control extraction scope and cost.'}
        </p>
        <details>
          <summary>
            {zh ? '高级：手工创建实体和关系' : 'Advanced: create entities and relations'}
          </summary>
          <label>
            {zh ? '实体名称' : 'Entity name'}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {zh ? '别名（逗号分隔，人工确认）' : 'Aliases (comma-separated, explicitly confirmed)'}
            <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
          </label>
          <button
            disabled={!name.trim()}
            onClick={() =>
              go(async () => {
                await api('/memory-entities', {
                  scope,
                  name,
                  aliases: aliases
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                });
                setName('');
                setAliases('');
                await load();
              })
            }
          >
            {zh ? '创建实体' : 'Create entity'}
          </button>
          {visibleEntities.map((e) => (
            <p key={e.id}>
              <strong>{labelEntity(e.id)}</strong> · {e.aliases.join(', ')}{' '}
              <details>
                <summary>{zh ? '技术标识' : 'Technical ID'}</summary>
                <code>{e.id}</code>
              </details>
              {e.confirmed === false && (
                <button
                  onClick={() =>
                    go(async () => {
                      await api('/memory-entities', {
                        id: e.id,
                        scope,
                        name: e.name,
                        aliases: e.aliases,
                      });
                      await load();
                    })
                  }
                >
                  {zh ? '确认实体与别名' : 'Confirm entity and aliases'}
                </button>
              )}
            </p>
          ))}
          <div className="form-grid">
            <label>
              {zh ? '起点' : 'From'}
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">—</option>
                {visibleEntities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {labelEntity(e.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {zh ? '终点' : 'To'}
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">—</option>
                {visibleEntities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {labelEntity(e.id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {zh ? '关系（例如 depends_on）' : 'Relation (e.g. depends_on)'}
            <input value={relation} onChange={(e) => setRelation(e.target.value)} />
          </label>
          <label>
            {zh ? '证据类型' : 'Evidence type'}
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {['memory', 'document', 'event'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            {zh ? '来源 ID' : 'Source ID'}
            <input value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
          </label>
          {sourceType === 'event' && (
            <label>
              {zh ? '来源对话 ID' : 'Source conversation ID'}
              <input value={chat} onChange={(e) => setChat(e.target.value)} />
            </label>
          )}
          <label>
            {zh ? '原文引用' : 'Exact source quote'}
            <textarea value={quote} onChange={(e) => setQuote(e.target.value)} />
          </label>
          <button
            disabled={!from || !to || !relation || !quote || !sourceId}
            onClick={() =>
              go(async () => {
                await api('/knowledge-graph', {
                  scope,
                  from,
                  to,
                  relation,
                  evidence: [
                    { type: sourceType, id: sourceId, conversationId: chat || undefined, quote },
                  ],
                  active: false,
                });
                await load();
              })
            }
          >
            {zh ? '添加候选关系' : 'Add candidate relation'}
          </button>
        </details>
        {!visibleEdges.length && (
          <p>
            {zh
              ? '此视图暂无关系。自动来源已单独隐藏，可勾选查看；系统不会把来源连线当作实体知识。'
              : 'No relations in this view. Automatic source links are hidden separately and do not establish domain knowledge.'}
          </p>
        )}
        {visibleEdges.slice(currentGraphPage * 20, (currentGraphPage + 1) * 20).map((e) => (
          <article className="panel" key={e.id}>
            <p>
              {labelEntity(e.from)} →{' '}
              {e.relation === 'has recorded memory' && zh ? '记忆来源关联' : e.relation} →{' '}
              {labelEntity(e.to)} ·{' '}
              {!e.supportedNow
                ? zh
                  ? '来源失效／缺失'
                  : 'Invalid/missing source'
                : e.current
                  ? zh
                    ? '当前有效'
                    : 'Currently valid'
                  : e.active
                    ? zh
                      ? '历史／过期'
                      : 'Historical/expired'
                    : zh
                      ? '未启用'
                      : 'Inactive'}
            </p>
            {e.evidence.map((x: any, i: number) => (
              <blockquote key={i}>
                {x.quote}
                <details>
                  <summary>{zh ? '来源标识' : 'Source identifier'}</summary>
                  <small>
                    {x.type}:{x.id}
                  </small>
                </details>
              </blockquote>
            ))}
            <button
              onClick={() =>
                go(async () => {
                  await api(
                    '/knowledge-graph/' + e.id,
                    { active: !e.active, revision: e.revision },
                    'PATCH',
                  );
                  await load();
                })
              }
            >
              {e.active ? (zh ? '停用' : 'Deactivate') : zh ? '确认' : 'Confirm'}
            </button>
            <button
              onClick={() =>
                go(async () => {
                  await api('/knowledge-graph/' + e.id, undefined, 'DELETE');
                  await load();
                })
              }
            >
              {zh ? '删除关系' : 'Delete relation'}
            </button>
          </article>
        ))}
        <div className="row">
          <button disabled={!currentGraphPage} onClick={() => setGraphPage(currentGraphPage - 1)}>
            {zh ? '上一页' : 'Previous'}
          </button>
          <span>
            {currentGraphPage + 1}/{lastGraphPage + 1} · {visibleEdges.length}
          </span>
          <button
            disabled={currentGraphPage >= lastGraphPage}
            onClick={() => setGraphPage(currentGraphPage + 1)}
          >
            {zh ? '下一页' : 'Next'}
          </button>
          <button onClick={() => go(load)}>{zh ? '刷新关系状态' : 'Refresh relationships'}</button>
        </div>
        <label>
          {zh ? '查询记忆或实体名称' : 'Query memories or entity names'}
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          {zh ? '历史时点（UTC，留空查当前）' : 'As of (UTC, blank for current)'}
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button
          disabled={!query}
          onClick={() =>
            go(async () => {
              const [memories, graph] = await Promise.all([
                api('/memories/search', { scope, query, asOf: at }),
                api('/knowledge-graph/search', { scope, query, asOf: at, depth: 3 }),
              ]);
              setResults({ memories, graph });
            })
          }
        >
          {zh ? '查询并查看证据' : 'Search with evidence'}
        </button>
        {results && (
          <div>
            <h4>{zh ? '召回记忆' : 'Recalled memories'}</h4>
            {results.memories.memories.map((m: any) => (
              <article className="panel" key={m.id}>
                <p>{m.content}</p>
                <small>
                  {m.source} · rev {m.revision}
                </small>
              </article>
            ))}
            <h4>{zh ? '带证据的关系路径' : 'Evidence-backed paths'}</h4>
            {results.graph.paths.map((p: any, i: number) => (
              <article className="panel" key={i}>
                <p>
                  {p.entities
                    .map(
                      (id: string) =>
                        results.graph.entities.find((e: any) => e.id === id)?.name || id,
                    )
                    .join(' → ')}
                </p>
                {p.edges.map((e: any) => (
                  <div key={e.id}>
                    <strong>{e.relation}</strong>
                    {e.evidence.map((source: any, j: number) => (
                      <blockquote key={j}>
                        {source.quote}
                        <details>
                          <summary>{zh ? '来源标识' : 'Source identifier'}</summary>
                          <small>
                            {source.type}:{source.id}
                          </small>
                        </details>
                      </blockquote>
                    ))}
                  </div>
                ))}
              </article>
            ))}
            {!results.graph.paths.length && (
              <p>
                {zh
                  ? '没有找到当前有效且有来源支持的关系路径。'
                  : 'No currently valid source-backed paths found.'}
              </p>
            )}
          </div>
        )}
        <button
          onClick={() =>
            go(async () => {
              const result = await api('/memories/consolidate', { scope });
              setIssues(result.issues);
            })
          }
        >
          {zh ? '整理完全重复的记忆' : 'Consolidate exact duplicates'}
        </button>
        <button
          onClick={() => go(async () => setIssues(await api('/memories/inspect', { scope })))}
        >
          {zh
            ? '检查重复、冲突、过期与来源缺失'
            : 'Inspect duplicates, conflicts, expiry & missing sources'}
        </button>
        {issues.map((i) => (
          <p key={i.id}>
            <code>{i.id}</code> · {JSON.stringify(i)}
          </p>
        ))}
      </details>
    </section>
  );
}
export function DocumentVersion({ document: d, go, zh }: any) {
  const [text, setText] = useState(''),
    [source, setSource] = useState(d.source || ''),
    [date, setDate] = useState('');
  return (
    <details>
      <summary>
        {zh ? '版本与引用' : 'Version & citation'} · v{d.version || 1} · <code>{d.id}</code>
      </summary>
      <p>
        {d.source || d.name} · {new Date(d.validFrom ?? d.createdAt).toLocaleString()} →{' '}
        {d.validUntil ? new Date(d.validUntil).toLocaleString() : zh ? '当前' : 'current'}
      </p>
      {!d.validUntil && (
        <>
          <label>
            {zh ? '新版来源' : 'New source'}
            <input value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <label>
            {zh ? '生效时间（UTC，默认现在）' : 'Effective from (UTC, default now)'}
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              zh
                ? '粘贴新版文档正文；保留旧版用于历史查询'
                : 'Paste new document text; the old version remains for historical queries'
            }
          />
          <button
            disabled={!text.trim()}
            onClick={() =>
              go(async () => {
                await api('/knowledge/text', {
                  scope: d.scope,
                  name: d.name,
                  text,
                  source,
                  revisionOf: d.id,
                  validFrom: date ? Date.parse(date + 'Z') : undefined,
                });
                setText('');
              })
            }
          >
            {zh ? '保存为新版本' : 'Save new version'}
          </button>
        </>
      )}
    </details>
  );
}
