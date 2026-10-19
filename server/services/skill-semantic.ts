import { createHash } from 'node:crypto';
import { Embeddings, cosine } from './embedding.js';
import { rankSkills } from './skill-discovery.js';
import type { Skill, Settings } from '../../shared/types.js';

type Metadata = Pick<Skill, 'id' | 'name' | 'description' | 'enabled'>;
const cache = new Map<string, number[]>();
// Metadata stays local. Remote HTTPS embedding requires a separate disclosure policy.
export function localSkillEmbedding(settings: Settings['embedding']) {
  if (settings.backend === 'local') return true;
  try {
    const u = new URL(settings.baseUrl);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      ['127.0.0.1', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
export async function discoverSkills(
  skills: Metadata[],
  selected: string[],
  query: string,
  settings: Settings['embedding'],
  signal: AbortSignal,
  budgetMs = 8000,
) {
  const lexical = rankSkills(skills, selected, query);
  const fallback = (semanticStatus: string) => ({
    results: lexical,
    method: 'lexical',
    semanticStatus,
  });
  signal.throwIfAborted();
  if (!query.trim()) return fallback('empty query');
  if (!skills.some((s) => s.enabled)) return fallback('no enabled skills');
  if (!localSkillEmbedding(settings))
    return fallback('local embedding not configured; metadata was not sent externally');
  const encoder = new Embeddings(() => settings);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
  const enabled = skills.filter((s) => s.enabled).sort((a, b) => a.id.localeCompare(b.id));
  const texts = enabled.map((s) => (s.name + '\n' + s.description).slice(0, 4000));
  const keys = texts.map((text) =>
    createHash('sha256')
      .update(encoder.fingerprint() + text)
      .digest('hex'),
  );
  try {
    const [q] = await encoder.encode([query.slice(-4000)], deadline, 'query');
    let semantic: { s: Metadata; similarity: number }[] = [];
    // Retain only a bounded cache and the best 30 results, not a whole-catalog matrix.
    for (let start = 0; start < enabled.length; start += 16) {
      deadline.throwIfAborted();
      const indexes = Array.from(
        { length: Math.min(16, enabled.length - start) },
        (_, j) => start + j,
      );
      const missing = indexes.filter((i) => !cache.has(keys[i]));
      const fresh = missing.length
        ? await encoder.encode(
            missing.map((i) => texts[i]),
            deadline,
          )
        : [];
      const batch = new Map(missing.map((i, j) => [i, fresh[j]]));
      for (const i of indexes) {
        const vector = batch.get(i) || cache.get(keys[i])!;
        if (vector.length !== q.length) {
          cache.delete(keys[i]);
          throw Error('Embedding dimensions changed');
        }
        cache.delete(keys[i]);
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(keys[i], vector);
        const similarity = cosine(q, vector);
        if (Number.isFinite(similarity) && similarity > 0)
          semantic.push({ s: enabled[i], similarity });
      }
      semantic.sort((a, b) => b.similarity - a.similarity || a.s.id.localeCompare(b.s.id));
      semantic = semantic.slice(0, 30);
    }
    deadline.throwIfAborted();
    const scores = new Map<string, number>();
    lexical.forEach((s, i) => scores.set(s.id, 1 / (61 + i)));
    semantic.forEach((x, i) => scores.set(x.s.id, (scores.get(x.s.id) || 0) + 1 / (61 + i)));
    const results = enabled
      .filter((s) => scores.has(s.id))
      .map((s) => ({
        ...s,
        selected: selected.includes(s.id),
        score: scores.get(s.id)!,
        matched: lexical.find((x) => x.id === s.id)?.matched || [],
        semanticSimilarity: semantic.find((x) => x.s.id === s.id)?.similarity ?? null,
      }))
      .sort(
        (a, b) =>
          b.score - a.score || Number(b.selected) - Number(a.selected) || a.id.localeCompare(b.id),
      );
    return {
      results,
      method: 'local-semantic-rrf',
      semanticStatus: 'available; ranking is not proof of applicability',
    };
  } catch {
    signal.throwIfAborted();
    return fallback('local semantic discovery unavailable or timed out; lexical fallback used');
  }
}
