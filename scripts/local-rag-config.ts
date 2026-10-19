import { extractionProfile } from '../server/services/rag-profile.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Configuration } from '../server/services/settings.js';
import { writePrivate } from '../server/services/private-file.js';
const root = resolve(import.meta.dirname, '..');
const dataRoot = resolve(process.env.AGENTDEMO_DATA_DIR || join(root, '.data'));
const path = join(dataRoot, 'retrieval-service/config.json');
const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const option = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i >= 0 && (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')))
    throw Error('Missing value for ' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const embeddingModel =
  option('--embedding-model') || old.embeddingModel || 'intfloat/multilingual-e5-small';
if (
  ![
    'intfloat/multilingual-e5-small',
    'intfloat/multilingual-e5-base',
    'intfloat/multilingual-e5-large',
  ].includes(embeddingModel)
)
  throw Error('Unsupported E5 model');
const settings = new Configuration(join(dataRoot, 'settings.json')).get();
const explicit = option('--profile');
const profile = extractionProfile(settings, explicit);
writePrivate(
  path,
  JSON.stringify({
    ...old,
    token: old.token || randomBytes(32).toString('hex'),
    embeddingModel,
    embeddingPath:
      option('--embedding-path') ||
      (embeddingModel === old.embeddingModel ? old.embeddingPath : undefined),
    rerankPath: option('--rerank-path') || old.rerankPath,
    rerankModel: 'BAAI/bge-reranker-v2-m3',
    extraction:
      (explicit === undefined ? old.extraction : undefined) ||
      (profile
        ? { model: profile.model, baseUrl: profile.baseUrl, apiKey: profile.apiKey }
        : undefined),
  }),
);
console.log(
  'Private local RAG configuration prepared. No application settings or corpus were changed.',
);

if (!profile && !old.extraction)
  console.log(
    'No unambiguous compatible extraction connection. Set --profile explicitly to enable extraction; local embedding/reranking remain available.',
  );
