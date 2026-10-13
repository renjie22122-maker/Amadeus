import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Configuration } from '../../server/services/settings.js';
const exec = promisify(execFile),
  dir = resolve(process.argv[2]),
  python = process.argv[3];
const maxOutputTokens = Number(process.argv[4] || 4096),
  completeCatalog = process.argv[5] === 'complete-catalog';
const scorerSource = process.argv[6] || resolve(dir, '../../incoming/full-v1/sources/swebench');
const task = join(dir, 'grader/pylint-dev__pylint-7277');
const image = 'swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-7277:latest';
const p = new Configuration('.data/settings.json').profile();
async function docker(args: string[], timeout = 120000) {
  return exec('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}
const info = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
await writeFile(
  join(dir, 'manifest.json'),
  JSON.stringify(
    {
      kind: 'SWE-bench Verified one-task paired pilot',
      task: 'pylint-dev__pylint-7277',
      selection: 'lowest SHA256(amadeus-swe-v1:instance_id) in downloaded Verified split',
      image,
      imageId: info.Id,
      repoDigests: info.RepoDigests,
      model: p.model,
      reasoning: p.reasoning,
      maxOutputTokens,
      completeCatalog,
      maxModelCalls: 30,
      commandTimeoutSeconds: 60,
      deadlineSeconds: 1200,
      sandbox: {
        network: 'none',
        mounts: [],
        capDrop: 'ALL',
        noNewPrivileges: true,
        memory: '4g',
        cpus: 2,
        pids: 256,
      },
      grading: 'official task eval.sh and upstream get_eval_report; pristine and gold controls',
    },
    null,
    2,
  ),
);
for (const arm of ['pristine', 'gold', 'amadeus', 'smolagents']) {
  const directory = join(dir, arm);
  await mkdir(directory, { recursive: true });
  try {
    await access(
      join(directory, ['pristine', 'gold'].includes(arm) ? 'grade.json' : 'started.json'),
    );
    console.log('SKIP', arm);
    continue;
  } catch {}
  await writeFile(
    join(directory, 'started.json'),
    JSON.stringify({ at: new Date().toISOString() }),
  );
  const container = 'amadeus-eval-swe-' + arm + '-' + Date.now();
  try {
    await docker([
      'run',
      '-d',
      '--name',
      container,
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '4g',
      '--cpus',
      '2',
      '--pids-limit',
      '256',
      image,
      'sleep',
      'infinity',
    ]);
    if (arm === 'gold') {
      await docker(['cp', join(task, 'gold.patch'), container + ':/tmp/gold.patch']);
      await docker(['exec', container, 'bash', '-lc', 'cd /testbed && git apply /tmp/gold.patch']);
    } else if (arm !== 'pristine') {
      const problem = await readFile(join(task, 'problem_statement.md'), 'utf8');
      const prompt =
        'Fix the following real repository issue in /testbed. Inspect the repository and implement a patch. Use benchmark_shell for reading, editing and tests. All commands run in an isolated offline container; do not attempt external downloads. Python environment testbed is activated. Preserve unrelated behavior. Do not search for reference solutions. Explain what you changed and tested.\n\n' +
        problem;
      await writeFile(
        join(directory, 'job.json'),
        JSON.stringify({
          maxOutputTokens,
          completeCatalog,
          kind: 'swe',
          id: 'pylint-dev__pylint-7277',
          arm,
          directory,
          container,
          prompt,
          settings: resolve('.data/settings.json'),
          profileId: p.id,
          python,
        }),
      );
      await new Promise<void>((done) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'evals/public-qa/worker.ts', join(directory, 'job.json')],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 5000)));
        const timer = setTimeout(() => child.kill(), 1230000);
        child.on('close', async (code) => {
          clearTimeout(timer);
          await writeFile(join(directory, 'process.json'), JSON.stringify({ code, stderr }));
          done();
        });
      });
    }
    const patch = await docker([
      'exec',
      container,
      'bash',
      '-lc',
      'cd /testbed && git add -N . && git diff HEAD',
    ]);
    await writeFile(join(directory, 'patch.diff'), patch.stdout);
    // The hidden tests and reference materials only enter a grading container AFTER solving.
    await docker(['cp', join(task, 'eval.sh'), container + ':/tmp/eval.sh']);
    let log = '';
    try {
      const r = await docker(
        ['exec', '-e', 'PIP_NO_INDEX=1', container, 'bash', '-lc', 'bash /tmp/eval.sh 2>&1'],
        300000,
      );
      log = r.stdout + r.stderr;
    } catch (e: any) {
      log = String(e.stdout || '') + String(e.stderr || '');
      await writeFile(
        join(directory, 'eval-exit.json'),
        JSON.stringify({ code: e.code, killed: e.killed }),
      );
    }
    await writeFile(join(directory, 'test-output.txt'), log);
    const grade = await exec(
      python,
      ['-X', 'utf8', 'evals/public-qa/grade-swe.py', scorerSource, dir, arm],
      { timeout: 30000, windowsHide: true },
    );
    console.log(grade.stdout.trim());
    if (['pristine', 'gold'].includes(arm)) {
      const g = JSON.parse(await readFile(join(directory, 'grade.json'), 'utf8'))[
        'pylint-dev__pylint-7277'
      ];
      if (g.infra_failure || g.resolved !== (arm === 'gold'))
        throw Error('SWE grading control failed: ' + arm);
    }
  } finally {
    await docker(['rm', '-f', container], 30000);
  }
}
