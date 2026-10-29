import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { desktopAction } from '../server/services/desktop-native.js';
test(
  'WGC captures updated WPF compositor frames behind an occluder',
  {
    skip: process.platform !== 'win32' || process.env.AGENTDEMO_DESKTOP_TEST !== '1',
    timeout: 60000,
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'wgc-render-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const framework = join(
        process.env.SystemRoot || 'C:/Windows',
        'Microsoft.NET/Framework64/v4.0.30319',
      );
      await promisify(execFile)(
        join(framework, 'csc.exe'),
        [
          '/nologo',
          '/target:winexe',
          '/out:' + join(dir, 'fixture.exe'),
          '/r:System.Web.Extensions.dll',
          ...['WindowsBase', 'PresentationCore', 'PresentationFramework', 'System.Xaml'].map(
            (n) => '/r:' + join(framework, n === 'System.Xaml' ? '' : 'WPF', n + '.dll'),
          ),
          resolve('tests/fixtures/wgc-render.cs'),
        ],
        { windowsHide: true },
      );
      child = spawn(join(dir, 'fixture.exe'), [join(dir, 'state.json'), join(dir, 'change')], {
        windowsHide: false,
        stdio: 'ignore',
      });
      let state: any;
      for (let n = 0; n < 50; n++) {
        try {
          state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(state);
      t.diagnostic('WPF rendering tier: ' + state.tier);
      async function pixel() {
        const shot = await desktopAction({ action: 'screenshot', windowId: state.target });
        assert.equal(shot.capture, 'windows-graphics-capture');
        return {
          shot,
          pixel: [
            ...(await sharp(Buffer.from(shot.image, 'base64'))
              .extract({
                left: Math.floor(shot.width / 2),
                top: Math.floor(shot.height / 2),
                width: 1,
                height: 1,
              })
              .removeAlpha()
              .raw()
              .toBuffer()),
          ],
        };
      }
      const first = await pixel();
      assert.deepEqual(first.pixel, [220, 30, 40]);
      await writeFile(join(dir, 'change'), 'change');
      await new Promise((r) => setTimeout(r, 400));
      const second = await pixel();
      assert.deepEqual(second.pixel, [20, 200, 60]);
      assert.ok(second.shot.frameTimestampTicks > first.shot.frameTimestampTicks);
    } finally {
      if (child && child.exitCode === null) {
        const exited = new Promise((r) => child!.once('exit', r));
        child.kill();
        await exited;
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
