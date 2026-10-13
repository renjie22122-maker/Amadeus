import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Configuration } from '../../server/services/settings.js';
const dir = resolve(process.argv[2]),
  python = process.argv[3],
  p = new Configuration('.data/settings.json').profile();
const maxOutputTokens = Number(process.argv[4] || 4096),
  maxSteps = Number(process.argv[5] || 8),
  completeCatalog = process.argv[6] === 'complete-catalog';
const data = JSON.parse(await readFile(join(dir, 'cases.json'), 'utf8'));
await writeFile(
  join(dir, 'manifest.json'),
  JSON.stringify(
    {
      kind: data.kind,
      selection: data.selection,
      model: p.model,
      reasoning: p.reasoning,
      endpoint: p.baseUrl,
      smolagents: '1.26.0',
      runtimeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      maxSteps,
      maxOutputTokens,
      completeCatalog,
      timeoutSeconds: 600,
      tools: ['web_search', 'fetch_url'],
      sampling: 'provider default',
      prices: p.prices,
      limitations: [
        'No attachments, code execution or interactive browser in this subset',
        'GAIA historical websites may have changed',
        'Amadeus web usage in event log; smolagents auxiliary usage separately recorded',
        'Provider ToolChoice auto in both arms; smolagents native final_answer retained',
      ],
    },
    null,
    2,
  ),
);
for (const [i, c] of data.cases.entries())
  for (const arm of i % 2 ? ['smolagents', 'amadeus'] : ['amadeus', 'smolagents']) {
    const directory = join(dir, c.id + '-' + arm);
    await mkdir(directory, { recursive: true });
    try {
      await access(join(directory, 'started.json'));
      console.log('SKIP', c.id, arm);
      continue;
    } catch {}
    await writeFile(
      join(directory, 'job.json'),
      JSON.stringify({
        ...c,
        maxOutputTokens,
        maxSteps,
        completeCatalog,
        arm,
        directory,
        settings: resolve('.data/settings.json'),
        profileId: p.id,
        python,
      }),
    );
    await writeFile(
      join(directory, 'started.json'),
      JSON.stringify({ at: new Date().toISOString() }),
    );
    const at = Date.now();
    await new Promise<void>((done) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'evals/public-qa/worker.ts', join(directory, 'job.json')],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 4000)));
      const timer = setTimeout(() => child.kill(), 630000);
      child.on('close', async (code) => {
        clearTimeout(timer);
        await writeFile(join(directory, 'process.json'), JSON.stringify({ code, stderr }));
        console.log(c.id, arm, code, Math.round((Date.now() - at) / 1000) + 's');
        done();
      });
    });
  }
