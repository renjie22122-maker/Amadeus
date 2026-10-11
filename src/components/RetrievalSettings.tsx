import { useState } from 'react';
import { retrievalTarget } from '../../shared/retrieval';
import { api } from '../api';
export function RetrievalSettings({ value, setValue, zh }: any) {
  const r = value.retrieval || {};
  const [message, setMessage] = useState('');
  const [scope, setScope] = useState(r.lightRag?.scope || 'general');
  const [embeddingModel, setEmbeddingModel] = useState(
    value.embedding?.model?.startsWith('intfloat/multilingual-e5-')
      ? value.embedding.model
      : 'intfloat/multilingual-e5-small',
  );
  const [embeddingPath, setEmbeddingPath] = useState('');
  const [rerankPath, setRerankPath] = useState('');
  const [profileId, setProfileId] = useState(value.defaultProfileId);
  const update = (key: string, patch: any) =>
    setValue({ ...value, retrieval: { ...r, [key]: { ...r[key], ...patch } } });
  const text = (en: string, cn: string) => (zh ? cn : en);
  const presets: any = {
    vectors: { enabled: false, baseUrl: 'http://127.0.0.1:8811', backend: 'faiss', index: 'hnsw' },
    rerank: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:8811',
      model: 'BAAI/bge-reranker-v2-m3',
      candidates: 40,
    },
    lightRag: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:8811/lightrag',
      scope: 'general',
      mode: 'mix',
    },
  };
  return (
    <section className="panel">
      <h2>{text('Retrieval and local RAG', '检索与本地 RAG')}</h2>
      <p className="muted">
        {text(
          'Optional local service: run Setup-Local-RAG.cmd once, then Start-Local-RAG.cmd. Downloads models; CUDA is used when available. LightRAG extraction sends selected-scope text to the chosen model; graph, embeddings and reranking stay local.',
          '可选本地服务：先运行 Setup-Local-RAG.cmd，再运行 Start-Local-RAG.cmd。首次下载模型，有 CUDA 时使用 GPU。LightRAG 抽取会将所选范围正文发送到指定模型；图、向量与重排留在本机。',
        )}
      </p>
      <div className="form-grid">
        <label>
          {text('Local embedding model', '本地向量模型')}
          <select value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)}>
            <option value="intfloat/multilingual-e5-small">E5 small · 384</option>
            <option value="intfloat/multilingual-e5-base">E5 base · 768</option>
            <option value="intfloat/multilingual-e5-large">E5 large · 1024</option>
          </select>
        </label>
        <label>
          {text('Offline embedding folder (optional)', '离线 embedding 目录（可选）')}
          <input value={embeddingPath} onChange={(e) => setEmbeddingPath(e.target.value)} />
        </label>
        <label>
          {text('Offline BGE reranker folder (optional)', '离线 BGE 重排模型目录（可选）')}
          <input value={rerankPath} onChange={(e) => setRerankPath(e.target.value)} />
        </label>

        <label>
          {text('LightRAG scope ID', 'LightRAG 范围 ID')}
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="general / project:ID / session:ID"
          />
        </label>
        <label>
          {text('Extraction model connection', '实体抽取模型连接')}
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {value.profiles
              .filter((p: any) => p.transport === 'openai-chat')
              .map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <button
        onClick={async () => {
          try {
            const next = await api('/retrieval/local', {
              scope,
              profileId,
              embeddingModel,
              embeddingPath: embeddingPath || undefined,
              rerankPath: rerankPath || undefined,
            });
            setValue(next);
            setMessage(
              text(
                'Saved local connections; restart the local sidecar after model changes. Enable and authorize LightRAG below to start scoped ingestion.',
                '本地连接已保存；模型变化后请重启本地服务。下方启用并授权 LightRAG 后开始范围内增量入库。',
              ),
            );
          } catch (e) {
            setMessage(String(e));
          }
        }}
      >
        {text(
          'Save local connections (save other edits first)',
          '配置本地连接（请先保存其他修改）',
        )}
      </button>
      <p role="status">{message}</p>
      <label>
        <input
          type="checkbox"
          checked={r.graph !== false}
          onChange={(e) => setValue({ ...value, retrieval: { ...r, graph: e.target.checked } })}
        />
        {text(
          'Supplement retrieval with source-backed document graph',
          '使用带原文证据的文档图补充检索',
        )}
      </label>
      {(['vectors', 'rerank', 'lightRag'] as const).map((key) => {
        const c = r[key];
        return (
          <details key={key} open={!!c?.enabled}>
            <summary>
              {
                {
                  vectors: text('Vector backend', '向量检索后端'),
                  rerank: text('Cross-encoder reranker', '语义重排'),
                  lightRag: 'LightRAG',
                }[key]
              }
            </summary>
            {!c ? (
              <button onClick={() => update(key, presets[key])}>{text('Configure', '配置')}</button>
            ) : (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={!!c.enabled}
                    onChange={(e) => update(key, { enabled: e.target.checked })}
                  />
                  {text('Enabled', '启用')}
                </label>
                <div className="form-grid">
                  <label>
                    URL
                    <input
                      value={c.baseUrl}
                      onChange={(e) => update(key, { baseUrl: e.target.value })}
                    />
                  </label>
                  <label>
                    {text('Service token', '服务令牌')}
                    <input
                      type="password"
                      value={c.apiKey || ''}
                      placeholder={
                        c.hasKey ? text('Saved; leave blank to retain', '已保存，留空保留') : ''
                      }
                      onChange={(e) => update(key, { apiKey: e.target.value })}
                    />
                  </label>
                  {key === 'vectors' && (
                    <>
                      <label>
                        Backend
                        <select
                          value={c.backend}
                          onChange={(e) =>
                            update(key, {
                              backend: e.target.value,
                              index: e.target.value === 'qdrant' ? 'hnsw' : c.index,
                            })
                          }
                        >
                          {['faiss', 'qdrant', 'milvus'].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Index
                        <select
                          value={c.index}
                          onChange={(e) => update(key, { index: e.target.value })}
                        >
                          {(c.backend === 'qdrant'
                            ? ['hnsw']
                            : ['flat', 'hnsw', 'ivf-flat', 'ivf-pq']
                          ).map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  {key === 'rerank' && (
                    <>
                      <label>
                        Model
                        <input
                          value={c.model}
                          onChange={(e) => update(key, { model: e.target.value })}
                        />
                      </label>
                      <label>
                        {text('Candidates (1–30)', '候选数（1–30）')}
                        <input
                          type="number"
                          min="1"
                          max="30"
                          value={c.candidates ?? 40}
                          onChange={(e) => update(key, { candidates: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        {text(
                          'Optional score threshold; calibrate on your corpus',
                          '可选分数阈值，需用实际语料校准',
                        )}
                        <input
                          type="number"
                          step="0.01"
                          value={c.minScore ?? ''}
                          onChange={(e) =>
                            update(key, {
                              minScore: e.target.value === '' ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  {key === 'lightRag' && (
                    <>
                      <label>
                        Scope
                        <input
                          value={c.scope}
                          onChange={(e) => update(key, { scope: e.target.value })}
                        />
                      </label>
                      <label>
                        Mode
                        <select
                          value={c.mode}
                          onChange={(e) => update(key, { mode: e.target.value })}
                        >
                          {['local', 'global', 'hybrid', 'mix'].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={c.authorizedTarget === retrievalTarget(key, c)}
                    onChange={(e) =>
                      update(key, {
                        authorizedTarget: e.target.checked ? retrievalTarget(key, c) : undefined,
                      })
                    }
                  />
                  {text(
                    'Authorize this exact connection and data scope; changed targets require authorization again.',
                    '授权此连接与数据范围；目标变化后需要重新授权。',
                  )}
                  {key === 'lightRag' &&
                    text(
                      ' Text is sent to the configured extraction model and may incur API costs.',
                      ' 正文会发送到所配置的抽取模型，可能产生 API 费用。',
                    )}
                </label>
                {key === 'lightRag' && (
                  <button
                    onClick={async () => {
                      try {
                        setMessage(JSON.stringify(await api('/knowledge/lightrag-sync', {})));
                      } catch (e) {
                        setMessage(String(e));
                      }
                    }}
                  >
                    {text(
                      'Check synchronization (uses saved settings)',
                      '查看同步状态（使用已保存设置）',
                    )}
                  </button>
                )}
              </>
            )}
          </details>
        );
      })}
    </section>
  );
}
