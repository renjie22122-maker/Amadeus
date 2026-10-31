import { KnowledgeReuse } from '../components/KnowledgeReuse';
import { conversationMemoryScope } from '../../shared/memory-scope';
import { DocumentBrowser } from '../components/DocumentBrowser';
import { MemoryCreate } from '../components/MemoryCreate';
import { MemoryList } from '../components/MemoryList';
import { SkillPackagesPanel } from '../components/SkillPackagesPanel';
import { KnowledgeScopePicker } from '../components/KnowledgeScopePicker';
import { libraryConversations } from '../library-scopes';
import { MemoryDefaults } from '../components/MemoryDefaults';
import { KnowledgeAutomation } from '../components/KnowledgeAutomation';
import { MemoryWorkbench } from '../components/MemoryWorkbench';
import { SkillClassificationPanel } from '../components/SkillClassificationPanel';
import { SkillPicker } from '../components/SkillPicker';
import { Plus, Search, Upload } from 'lucide-react';
import { useRef, useState, useEffect } from 'react';
import { api } from '../api';
export function Library({ page, state, selected, t, refresh, notify }: any) {
  const selectable = libraryConversations(state.conversations, state.runs);
  const current = selectable.find((c: any) => c.id === selected);
  const [scope, setScope] = useState(
    page === 'memories' || page === 'memory'
      ? conversationMemoryScope(current || { projectId: null })
      : current
        ? current.projectId
          ? 'project:' + current.projectId
          : 'general'
        : 'general',
  );
  const [text, setText] = useState(''),
    [name, setName] = useState(''),
    [results, setResults] = useState<any[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setResults([]);
  }, [scope]);
  const [knowledgeDate, setKnowledgeDate] = useState('');
  const [indexStatuses, setIndexStatuses] = useState<any>({});
  const file = useRef<HTMLInputElement>(null);
  const go = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div className="eyebrow">{t('YOUR CONTEXT')}</div>
        <h1>{t(page)}</h1>
        <p>{t(page + 'Help')}</p>
      </div>
      {page === 'skills' ? (
        <>
          <section className="panel">
            <label>
              {t('Skill folder')}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="D:\\Skills"
              />
            </label>
            <button
              className="primary"
              disabled={busy || !name}
              onClick={() =>
                go(async () => {
                  const added = await api('/skills/import', { path: name });
                  notify('Imported ' + added.length + ' skills');
                })
              }
            >
              <Plus size={16} />
              {t('import')}
            </button>
          </section>
          <SkillPackagesPanel zh={t('settings') !== 'Settings'} refresh={refresh} notify={notify} />
          <SkillClassificationPanel
            state={state}
            refresh={refresh}
            notify={notify}
            zh={t('settings') !== 'Settings'}
          />
          <SkillPicker
            skills={state.skills}
            selected={[]}
            zh={t('settings') !== 'Settings'}
            disabled={busy}
            onDelete={(id) => void go(() => api('/skills/' + id, undefined, 'DELETE'))}
          />
        </>
      ) : page === 'knowledge' ? (
        <>
          <section className="panel">
            <KnowledgeScopePicker
              scope={scope}
              onChange={setScope}
              projects={state.projects}
              conversations={selectable}
              zh={t('settings') !== 'Settings'}
            />
            <div className="row wrap">
              <button disabled={!scope || busy} onClick={() => file.current?.click()}>
                <Upload size={16} />
                {t('import')} · PDF, DOCX, XLSX, CSV, text
              </button>
              <input
                ref={file}
                hidden
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void go(async () => {
                      const form = new FormData();
                      form.append('file', f);
                      await api('/upload?scope=' + encodeURIComponent(scope), form);
                      notify('Document indexed');
                    });
                  e.target.value = '';
                }}
              />
            </div>
            {scope.startsWith('project:') && (
              <KnowledgeReuse
                key={scope}
                scope={scope}
                documents={state.documents || []}
                projects={state.projects}
                conversations={selectable}
                zh={t('settings') !== 'Settings'}
                refresh={refresh}
                notify={notify}
              />
            )}
            <KnowledgeAutomation
              key={scope}
              onStatus={setIndexStatuses}
              scope={scope}
              project={state.projects.find((p: any) => scope === 'project:' + p.id)}
              embedding={state.settings.embedding}
              profile={state.settings.profiles.find(
                (p: any) => p.id === state.settings.defaultProfileId,
              )}
              zh={t('settings') !== 'Settings'}
              notify={notify}
            />
            <details>
              <summary>{t('Paste a document')}</summary>
              <input
                placeholder={t('Document name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('Document text…')}
              />
              <button
                disabled={!scope || !text || !name || busy}
                onClick={() =>
                  go(async () => {
                    await api('/knowledge/text', { scope, name, text });
                    setText('');
                  })
                }
              >
                {t('import')}
              </button>
            </details>
            <div className="row">
              <input
                placeholder={t('Test retrieval…')}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                disabled={!scope || !text}
                onClick={() =>
                  go(async () =>
                    setResults(
                      await api('/knowledge/search', {
                        scope,
                        query: text,
                        asOf: knowledgeDate ? Date.parse(knowledgeDate + 'Z') : undefined,
                      }),
                    ),
                  )
                }
              >
                <Search size={16} />
              </button>
            </div>
            <label>
              {t('settings') === 'Settings'
                ? 'As of (UTC, blank for current)'
                : '历史时点（UTC，留空查当前）'}
              <input
                type="datetime-local"
                value={knowledgeDate}
                onChange={(e) => setKnowledgeDate(e.target.value)}
              />
            </label>
            {results.map((r) => (
              <div className="search-result" key={r.id}>
                <strong>
                  {r.name} · v{r.version || 1} · chunk {r.ordinal}
                </strong>
                <p>{r.text}</p>
                <small>
                  {r.source} · {r.documentId} · {r.id}
                </small>
              </div>
            ))}
          </section>
          <DocumentBrowser
            key={scope}
            documents={state.documents.filter((d: any) => !scope || d.scope === scope)}
            statuses={indexStatuses}
            query={results.length ? text : ''}
            scope={scope}
            zh={t('settings') !== 'Settings'}
            go={go}
          />
        </>
      ) : (
        <>
          <section className="panel">
            <div className="form-grid">
              <label>
                {t('settings') === 'Settings' ? 'Storage scope' : '存储范围'}
                <select
                  value={scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user'}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="user">
                    {t('settings') === 'Settings' ? 'General conversations' : '普通对话'}
                  </option>
                  {state.projects.map((p: any) => (
                    <option key={p.id} value={'project:' + p.id}>
                      {p.name}
                    </option>
                  ))}
                  {selectable
                    .filter((c: any) => c.remoteChatOnly || c.remoteMemoryOnly)
                    .map((c: any) => (
                      <option key={c.id} value={'chat:' + c.id}>
                        {t('settings') === 'Settings' ? 'External chat · ' : '接入聊天 · '}
                        {c.title}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {scope.startsWith('chat:') && (
              <p>
                {t('settings') === 'Settings'
                  ? 'Automatic memory stays in this chat. No sharing with local chats, projects, other private peers or groups.'
                  : '自动记忆仅供这个私聊或群聊使用，与本地普通对话、项目及其他私聊和群双向隔离。'}
              </p>
            )}
            <MemoryCreate
              key={scope}
              scope={scope}
              conversations={selectable}
              currentConversationId={selected}
              zh={t('settings') !== 'Settings'}
              go={go}
            />
          </section>
          <MemoryDefaults
            scope={scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user'}
            state={state}
            zh={t('settings') !== 'Settings'}
            notify={notify}
          />
          <button
            disabled={busy}
            onClick={() =>
              go(() =>
                api('/memories/index', {
                  scope: scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user',
                }),
              )
            }
          >
            {state.settings.embedding.backend === 'local'
              ? t('settings') !== 'Settings'
                ? '本地索引当前范围的有效记忆'
                : 'Index active memories locally'
              : t('settings') !== 'Settings'
                ? '为当前范围的有效记忆建立索引（发送到已配置的 embedding 服务）'
                : 'Index active memories with the configured embedding API'}
          </button>
          <p className="muted">
            {t('settings') === 'Settings'
              ? 'Enable Automatic memory management in conversation details. Sourced facts are maintained automatically; uncertain conflicts are quarantined. Local embedding indexes learned active memories automatically. Documents belong in Knowledge.'
              : '在对话详情开启“自动管理记忆”，后台整理有来源的事实，不确定冲突自动隔离。本地 embedding 会自动索引新学习的有效记忆；原始文档请放入知识库。'}
          </p>
          <details>
            <summary>
              {t('settings') === 'Settings' ? 'Background memory activity' : '后台记忆处理记录'}
            </summary>
            {(state.memoryLearning || [])
              .filter(
                (j: any) =>
                  j.scope ===
                  (scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user'),
              )
              .map((j: any) => (
                <p key={j.id}>
                  {j.at ? new Date(j.at).toLocaleString() : '—'} ·{' '}
                  {j.stage === 'relations'
                    ? t('settings') === 'Settings'
                      ? 'Relations'
                      : '实体关系'
                    : j.stage === 'index'
                      ? t('settings') === 'Settings'
                        ? 'Vector index'
                        : '向量索引'
                      : t('settings') === 'Settings'
                        ? 'Memory extraction'
                        : '记忆提取'}{' '}
                  · {j.status} · {j.stage === 'index' ? j.indexed || 0 : j.added || 0}{' '}
                  {j.stage === 'index'
                    ? t('settings') === 'Settings'
                      ? 'indexed'
                      : '已索引'
                    : t('settings') === 'Settings'
                      ? 'added'
                      : '新增'}{' '}
                  · {j.stage === 'relations' ? j.deferred || 0 : j.candidates || 0}{' '}
                  {j.stage === 'relations'
                    ? t('settings') === 'Settings'
                      ? 'not adopted'
                      : '未采纳'
                    : t('settings') === 'Settings'
                      ? 'candidates'
                      : '待确认'}{' '}
                  {j.updated
                    ? ` · ${j.updated} ${t('settings') === 'Settings' ? 'updated' : '修订'}`
                    : ''}
                  {j.reinforced
                    ? ` · ${j.reinforced} ${t('settings') === 'Settings' ? 'reinforced' : '增强'}`
                    : ''}
                  {j.reason || ''} {j.attempts ? ` · ${j.attempts}/5` : ''}{' '}
                  {j.nextAttemptAt && j.status !== 'completed'
                    ? ` · ${t('settings') === 'Settings' ? 'Next retry' : '下次重试'} ${new Date(j.nextAttemptAt).toLocaleString()}`
                    : ''}
                </p>
              ))}
          </details>
          <MemoryWorkbench
            memories={state.memories}
            conversations={state.conversations}
            key={scope}
            scope={scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user'}
            go={go}
            zh={t('settings') !== 'Settings'}
          />
          <MemoryList
            currentConversationId={selected}
            key={scope}
            memories={state.memories}
            conversations={state.conversations}
            scope={scope.startsWith('project:') || scope.startsWith('chat:') ? scope : 'user'}
            zh={t('settings') !== 'Settings'}
            go={go}
          />
        </>
      )}
    </div>
  );
}
