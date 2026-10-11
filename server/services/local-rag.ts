import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { writePrivate } from './private-file.js';
import { retrievalTarget } from '../../shared/retrieval.js';
import { Configuration } from './settings.js';
import { assert } from '../core/errors.js';
export function configureLocalRag(
  config: Configuration,
  root: string,
  scope: string,
  profileId: string,
  options: { embeddingModel?: string; embeddingPath?: string; rerankPath?: string } = {},
) {
  const profile = config.profile(profileId);
  assert(
    profile.transport === 'openai-chat',
    'LOCAL_RAG_PROFILE',
    'Choose an OpenAI-compatible extraction connection.',
  );
  const u = new URL(profile.baseUrl);
  assert(
    u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash,
    'LOCAL_RAG_PROFILE',
    'Extraction requires a clean HTTPS endpoint.',
  );
  const path = join(root, 'retrieval-service/config.json');
  const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  for (const path of [options.embeddingPath, options.rerankPath].filter(Boolean) as string[])
    assert(
      isAbsolute(path) && existsSync(path) && statSync(path).isDirectory(),
      'LOCAL_MODEL_PATH',
      'Choose an existing absolute model folder.',
    );
  const embeddingModel =
    options.embeddingModel || old.embeddingModel || 'intfloat/multilingual-e5-small';
  assert(
    [
      'intfloat/multilingual-e5-small',
      'intfloat/multilingual-e5-base',
      'intfloat/multilingual-e5-large',
    ].includes(embeddingModel),
    'LOCAL_EMBEDDING_MODEL',
    'Choose multilingual E5 small, base or large.',
  );
  const local = {
    ...old,
    token: old.token || randomBytes(32).toString('hex'),
    embeddingModel,
    embeddingPath:
      options.embeddingPath ||
      (embeddingModel === old.embeddingModel ? old.embeddingPath : undefined),
    rerankPath: options.rerankPath || old.rerankPath,
    rerankModel: 'BAAI/bge-reranker-v2-m3',
    extraction: { model: profile.model, baseUrl: profile.baseUrl, apiKey: profile.apiKey },
  };
  writePrivate(path, JSON.stringify(local));
  const settings = config.get();
  const vectors = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8811',
    apiKey: local.token,
    backend: 'faiss' as const,
    index: 'hnsw' as const,
  };
  const rerank = {
    enabled: true,
    baseUrl: vectors.baseUrl,
    apiKey: local.token,
    model: local.rerankModel,
    candidates: 40,
  };
  // Extraction remains disabled until the user explicitly authorizes the selected scope.
  settings.retrieval = {
    graph: true,
    vectors: { ...vectors, authorizedTarget: retrievalTarget('vectors', vectors) },
    rerank: { ...rerank, authorizedTarget: retrievalTarget('rerank', rerank) },
    lightRag: {
      enabled: false,
      baseUrl: vectors.baseUrl + '/lightrag',
      apiKey: local.token,
      scope,
      mode: 'mix',
      embeddingModel,
    },
  };
  settings.embedding = {
    backend: 'remote',
    baseUrl: vectors.baseUrl + '/v1',
    model: local.embeddingModel,
    apiKey: local.token,
  };
  config.save(settings);
  return config.public();
}
