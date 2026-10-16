import { createHash } from 'node:crypto';
import type { Skill } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
const aliases: Record<string, string> = {
  图片: 'image',
  生图: 'image',
  视频: 'video',
  影视: 'screen video',
  漫画: 'comic',
  改编: 'adaptation novel',
  参考图: 'reference image',
  编辑: 'edit',
  文档: 'document',
  报告: 'document report',
  论文: 'research paper',
  写作: 'writing',
  表格: 'spreadsheet xlsx',
  幻灯片: 'presentation pptx',
  浏览器: 'browser',
  测试: 'test',
  部署: 'deploy',
  安全: 'security',
};
export function rankSkills(
  skills: Pick<Skill, 'id' | 'name' | 'description' | 'enabled'>[],
  selected: string[],
  query: string,
) {
  let expanded = query.toLowerCase();
  for (const [key, value] of Object.entries(aliases))
    if (expanded.includes(key)) expanded += ' ' + value;
  const words = [
    ...new Set(
      [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(expanded)]
        .filter((x) => x.isWordLike)
        .map((x) => x.segment)
        .filter(
          (x) =>
            x.length > 1 &&
            ![
              'the',
              'and',
              'this',
              'that',
              'with',
              'please',
              '一个',
              '什么',
              '可以',
              '我们',
              '这个',
              '一下',
            ].includes(x),
        ),
    ),
  ];
  return skills
    .filter((s) => s.enabled)
    .map((s) => {
      const name = s.name.toLowerCase(),
        description = s.description.toLowerCase();
      const matched = words.filter((w) => name.includes(w) || description.includes(w));
      const score =
        matched.reduce((n, w) => n + (name.includes(w) ? 3 : 1), 0) +
        (query.toLowerCase().includes(name) ? 20 : 0);
      return { ...s, selected: selected.includes(s.id), score, matched };
    })
    .filter((s) => !query.trim() || s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || Number(b.selected) - Number(a.selected) || a.id.localeCompare(b.id),
    );
}
export function taskSkills(
  store: Store,
  runId: string,
  conversationId: string,
  selected: string[],
  query: string,
) {
  const enabled = store.db
    .prepare(
      "SELECT json_extract(data,'$.id') AS id, json_extract(data,'$.name') AS name, json_extract(data,'$.description') AS description, 1 AS enabled FROM records WHERE kind='skill' AND json_extract(data,'$.enabled')=1",
    )
    .all() as unknown as Pick<Skill, 'id' | 'name' | 'description' | 'enabled'>[];
  const ranked = rankSkills(enabled, selected, query.slice(-12000));
  const recommended = ranked.slice(0, 12).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description.slice(0, 600),
    selected: s.selected,
    matched: s.matched.slice(0, 12),
  }));
  // Discovery supplies metadata only. A lexical match is not an instruction to run a skill.
  const loaded: { id: string; name: string; content: string; sha256: string }[] = [];
  const signature = createHash('sha256')
    .update(JSON.stringify({ recommended, loaded }))
    .digest('hex');
  const previous = store.maybe<any>('skill-activation', runId);
  if (previous?.signature === signature) return undefined;
  store.put('skill-activation', { id: runId, conversationId, signature });
  store.event(conversationId, runId, 'skills.recommended', {
    recommended: recommended.map((s) => s.id),
    loaded: loaded.map(({ id, sha256 }) => ({ id, sha256 })),
    enabledCount: enabled.length,
    method: 'task-ranked-local',
  });
  return {
    enabledCount: enabled.length,
    recommended,
    loaded,
    guidance:
      'Task-ranked metadata only, not instructions or permission grants. Decide applicability, then read_skill before using it. Read supporting reference files before mode-specific actions; inspect_skill_readiness checks read coverage, not semantic correctness. For omitted/large skills or missing matches use find_skills/read_skill. No match does not prove no applicable skill. Do not force a skill onto unrelated tasks.',
  };
}
