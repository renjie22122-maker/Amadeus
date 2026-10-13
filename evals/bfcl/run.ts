import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { Configuration } from '../../server/services/settings.js';
const dir = resolve(process.argv[2]);
const python = process.argv[3];
if (!dir || !python) throw Error('Usage: run.ts OUT PYTHON [limit]');
const cases = JSON.parse(await readFile(join(dir, 'cases.json'), 'utf8'));
const p = new Configuration('.data/settings.json').profile();
const manifest = {
  kind:
    cases.kind ||
    'BFCL-v4 first-decision diagnostic, not official leaderboard or end-to-end agent evaluation',
  model: p.model,
  transport: p.transport,
  endpoint: p.baseUrl,
  reasoning: p.reasoning,
  reasoningFormat: p.reasoningFormat,
  maxOutputTokens: 4096,
  providerToolChoice: 'auto (both arms)',
  prices: p.prices,
  datasetHash: createHash('sha256')
    .update(await readFile(join(dir, 'cases.json')))
    .digest('hex'),
  runtimeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  smolagents: '1.26.0',
  selection: cases.selection,
  createdAt: new Date().toISOString(),
  grading: cases.kind
    ? 'LongMemEval rubric; separate reviewer required'
    : 'upstream Python AST checker with model-config-only shim',
  limitations: [
    'Single response only; no execution, retries or multi-step reasoning loop tested',
    'smolagents native prompt plus final_answer; BFCL tool schemas normalized identically',
    'No memory, internet, private conversations, or answer labels in requests',
    'Provider default sampling, no temperature override; one sample per item',
    'No provider token prices configured: cost unknown',
  ],
};
try {
  await access(join(dir, 'manifest.json'));
} catch {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
for (const [i, c] of cases.cases.slice(0, Number(process.argv[4] || 20)).entries()) {
  for (const arm of i % 2 ? ['smolagents', 'amadeus'] : ['amadeus', 'smolagents']) {
    const directory = join(dir, c.id + '-' + arm);
    await mkdir(directory, { recursive: true });
    try {
      await access(join(directory, 'started.json'));
      console.log('SKIP existing', c.id, arm);
      continue;
    } catch {}
    const job = {
      case: c,
      arm,
      directory,
      settings: resolve('.data/settings.json'),
      profileId: p.id,
      python,
    };
    await writeFile(join(directory, 'job.json'), JSON.stringify(job));
    await writeFile(
      join(directory, 'started.json'),
      JSON.stringify({ at: new Date().toISOString() }),
    );
    const started = Date.now();
    const outcome = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'evals/bfcl/worker.ts', join(directory, 'job.json')],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 5000)));
      const timer = setTimeout(() => child.kill(), 180000);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, stderr });
      });
    });
    await writeFile(join(directory, 'process.json'), JSON.stringify(outcome, null, 2));
    console.log(c.id, arm, 'exit', outcome.code, Math.round((Date.now() - started) / 1000) + 's');
  }
}
