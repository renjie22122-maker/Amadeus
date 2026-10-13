import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../server/services/process.js';
import { Configuration } from '../server/services/settings.js';
import { frameScript, pythonCommand, installWorkChains } from '../server/tools/work-chains.js';
import { FileScope } from '../server/services/paths.js';
const image = process.env.AMADEUS_TEST_ANALYSIS_IMAGE;
test(
  'prepared Docker runs calculation and publishes exact workspace artifacts without host fallback',
  { skip: !image, timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'amadeus-analysis-docker-'));
    try {
      const settings = {
        ...new Configuration(join(root, 'test-settings.json')).get(),
        commandBackend: 'docker' as const,
        dockerImage: image!,
      };
      await writeFile(join(root, 'data.csv'), 'value\n0.1\n0.2\n');
      const code = `import csv,json,pathlib
from decimal import Decimal
with open('data.csv') as f: total=sum(Decimal(r['value']) for r in csv.DictReader(f))
pathlib.Path('result.json').write_text(json.dumps({'total':str(total)}))
print(json.dumps({'total':str(total),'artifact':'result.json'}))`;
      const result = await execute(
        pythonCommand(code),
        root,
        new AbortController().signal,
        30000,
        settings,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.execution?.backend, 'docker');
      assert.equal(JSON.parse(result.stdout).total, '0.3');
      assert.equal(JSON.parse(await readFile(join(root, 'result.json'), 'utf8')).total, '0.3');
      const defs = new Map<string, any>();
      installWorkChains({ add: (d: any) => defs.set(d.name, d) } as any);
      await writeFile(join(root, 'video.mp4'), 'fixture');
      let audio = '';
      await defs.get('extract_media_audio').run(
        {
          path: 'video.mp4',
          folder: 0,
          startSeconds: 1,
          durationSeconds: 3,
          reason: 'validate template',
        },
        {
          config: { get: () => settings },
          conversation: {},
          files: new FileScope([root]),
          invokeTool: async (_name: string, a: any) => {
            audio = a.code;
            return { content: '' };
          },
        },
      );
      // Parse the actual generated scripts using real Python without pretending FFmpeg exists.
      const scripts = [audio, frameScript('video.mp4', 'frames', [0, 2])];
      const parse = `import ast,json\np=json.loads(${JSON.stringify(JSON.stringify(scripts))})\nfor s in p: ast.parse(s)\nprint('templates-valid')`;
      const syntax = await execute(
        pythonCommand(parse),
        root,
        new AbortController().signal,
        30000,
        settings,
      );
      assert.equal(syntax.code, 0, syntax.stderr);
      assert.match(syntax.stdout, /templates-valid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
