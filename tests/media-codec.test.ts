import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { frameScript, installWorkChains } from '../server/tools/work-chains.js';
import { FileScope } from '../server/services/paths.js';
const ffmpeg = process.env.AMADEUS_TEST_FFMPEG;
const python = process.env.AMADEUS_TEST_PYTHON;
test(
  'prepared codecs actually sample frames and extract timestamped audio; missing codec fails explicitly',
  { skip: !ffmpeg || !python, timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'amadeus-codec-test-'));
    const env = { ...process.env, PATH: dirname(ffmpeg!) + delimiter + (process.env.PATH || '') };
    try {
      const fixture = spawnSync(
        ffmpeg!,
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=160x90:rate=10',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=16000',
          '-t',
          '3',
          '-c:v',
          'mpeg4',
          '-c:a',
          'aac',
          'clip.mp4',
        ],
        { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(fixture.status, 0, fixture.stderr);
      const frames = spawnSync(python!, ['-c', frameScript('clip.mp4', 'frames', [0, 1.5])], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(frames.status, 0, frames.stderr);
      const result = JSON.parse(frames.stdout);
      assert.equal(result.frames.length, 2);
      assert.equal(result.frames[1].requestedSeconds, 1.5);
      for (const f of result.frames) {
        const bytes = await readFile(join(root, f.path.slice(3)));
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      }
      const definitions = new Map<string, any>();
      installWorkChains({ add: (d: any) => definitions.set(d.name, d) } as any);
      let code = '';
      await definitions.get('extract_media_audio').run(
        {
          path: 'clip.mp4',
          folder: 0,
          startSeconds: 1,
          durationSeconds: 1,
          reason: 'synthetic fixture',
        },
        {
          config: { get: () => ({ commandBackend: 'docker' }) },
          conversation: {},
          files: new FileScope([root]),
          invokeTool: async (_name: string, a: any) => {
            code = a.code;
            return { content: '' };
          },
        },
      );
      const audio = spawnSync(python!, ['-c', code], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(audio.status, 0, audio.stderr);
      const segment = JSON.parse(audio.stdout);
      assert.equal(segment.startSeconds, 1);
      assert(Math.abs(segment.actualDurationSeconds - 1) < 0.1);
      assert.equal(
        (await readFile(join(root, segment.path.slice(3)))).subarray(0, 4).toString(),
        'RIFF',
      );
      const missing = spawnSync(python!, ['-c', frameScript('clip.mp4', 'not-created', [0])], {
        cwd: root,
        env: { ...env, PATH: dirname(python!) },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /DEPENDENCY_MISSING/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
