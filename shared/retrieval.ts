export interface RetrievalConnection {
  enabled?: boolean;
  baseUrl: string;
  apiKey?: string;
  authorizedTarget?: string;
}
export interface RetrievalSettings {
  graph?: boolean;
  vectors?: RetrievalConnection & {
    backend: 'faiss' | 'milvus' | 'qdrant';
    index: 'flat' | 'hnsw' | 'ivf-flat' | 'ivf-pq';
  };
  rerank?: RetrievalConnection & { model: string; minScore?: number; candidates?: number };
  lightRag?: RetrievalConnection & {
    scope: string;
    embeddingModel?: string;
    mode: 'local' | 'global' | 'hybrid' | 'mix';
  };
}
export function retrievalTarget(kind: 'vectors' | 'rerank' | 'lightRag', value: any) {
  return JSON.stringify([
    kind,
    value.baseUrl?.replace(/\/$/, ''),
    value.backend || value.model || value.scope || '',
    value.index || value.mode || '',
    value.embeddingModel || '',
  ]);
}
