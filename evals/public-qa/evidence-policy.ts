import type { SourcePolicy } from '../../server/services/source-policy.js';
// Experiment policy only. Product research may legitimately study evaluation datasets.
export const evaluationSources: SourcePolicy = {
  id: 'original-sources-v2',
  discardSynthesis: true,
  blockedHosts: [
    'huggingface.co',
    'hf-mirror.com',
    'huggingface.com',
    'hf.co',
    'raw.githubusercontent.com',
    'gist.githubusercontent.com',
    'gitlab.com',
    'kaggle.com',
  ],
  blockedPatterns: [
    'gaia[-_/ ]?(benchmark|dataset|text)',
    'observation[-_]masking',
    'evaluated\\.jsonl',
    'results_public',
    'ground[_-]?truth',
    'possible_answer',
    'github\\.com/.*/(gaia|benchmark|eval|dataset)',
    '[?&](url|target|redirect|q)=https?',
  ],
  contentPatterns: [
    'observation[-_]masking[-_]eval',
    'GAIA[- ]benchmark (record|answer|dataset)',
    '["\'](Final answer|ground_truth|Annotator Metadata)["\']\\s*:',
    '"correct"\\s*:\\s*(true|false)[\\s\\S]{0,200}"(qid|question)"',
  ],
};
