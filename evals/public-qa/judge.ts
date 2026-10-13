import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Configuration } from '../../server/services/settings.js';
import { providerFor } from '../../server/providers/registry.js';
const dir = process.argv[2],
  jobs = JSON.parse(await readFile(join(dir, 'judge-prompts.json'), 'utf8'));
const profile = {
  ...new Configuration(process.argv[4] || '.data/settings.json').profile(process.argv[5]),
  reasoning: 'none' as const,
  maxOutputTokens: 256,
  timeoutMs: 60000,
};
for (const job of process.argv[3] === undefined ? jobs : [jobs[Number(process.argv[3])]]) {
  const path = join(dir, job.id + '-' + job.arm, 'judge.json');
  try {
    await access(path);
    continue;
  } catch {}
  if (job.sourceError || !job.hypothesis?.trim()) {
    await writeFile(
      path,
      JSON.stringify(
        {
          validationError: job.sourceError || 'EMPTY_SUBMISSION',
          passed: false,
          modelCalled: false,
        },
        null,
        2,
      ),
    );
    continue;
  }
  let result: any;
  try {
    const r = await providerFor(profile).complete({
      profile,
      messages: [{ role: 'user', content: job.prompt }],
      tools: [],
      signal: AbortSignal.timeout(65000),
      onText: () => {},
    });
    const vote = r.message.content.trim().toLowerCase().replace(/[.!]$/, '');
    result = {
      model: profile.model,
      rubric: 'upstream LongMemEval; substituted judge, not official GPT-4o score',
      vote,
      passed: ['yes', 'no'].includes(vote) ? vote === 'yes' : null,
      validVote: ['yes', 'no'].includes(vote),
      usage: r.usage,
    };
  } catch (e: any) {
    result = { error: e.code || e.name, passed: null };
  }
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(job.id, job.arm, result.passed);
}
