import { createDesktopSession } from '../server/services/desktop-session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { desktopAction } from '../server/services/desktop-native.js';
test(
  'native window capture returns covered target, not foreground pixels; minimized fails',
  {
    skip:
      process.platform !== 'win32' || process.env.AGENTDEMO_DESKTOP_TEST !== '1'
        ? 'Requires explicit desktop integration-test opt-in; skipped, not passed'
        : false,
    timeout: 60000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdemo-capture-')),
      exe = join(dir, 'fixture.exe'),
      status = join(dir, 'status.json'),
      minimize = join(dir, 'minimize');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await promisify(execFile)(
        join(
          process.env.SystemRoot || 'C:\\Windows',
          'Microsoft.NET',
          'Framework64',
          'v4.0.30319',
          'csc.exe',
        ),
        [
          '/nologo',
          '/target:winexe',
          '/out:' + exe,
          '/r:System.Windows.Forms.dll',
          '/r:System.Drawing.dll',
          '/r:System.Web.Extensions.dll',
          resolve('tests/fixtures/window-capture.cs'),
        ],
        { windowsHide: true, timeout: 30000 },
      );
      child = spawn(exe, [status, minimize], { windowsHide: false, stdio: 'ignore' });
      let state: any;
      for (let i = 0; i < 50; i++) {
        try {
          state = JSON.parse(await readFile(status, 'utf8'));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(state, 'Fixture must start');
      assert.notDeepEqual(
        state.visible,
        [220, 30, 40],
        'Target is covered; foreground pixels are not the red target',
      );
      const shot = await desktopAction({ action: 'screenshot', windowId: state.target });
      assert.equal(shot.capture, 'windows-graphics-capture');
      assert.equal(shot.contentVerified, false);
      const zoom = await createDesktopSession(desktopAction)({
        action: 'screenshot',
        windowId: state.target,
        region: { x: 40, y: 40, width: 100, height: 100 },
        scale: 2,
      });
      assert.equal(zoom.capture, 'windows-graphics-capture');
      assert.equal(zoom.width, 200);
      assert.equal(zoom.scaleX, 2);
      assert.equal(zoom.x, shot.x + 40);
      assert.equal(zoom.y, shot.y + 40);
      const pixel = await sharp(Buffer.from(shot.image, 'base64'))
        .extract({
          left: Math.floor(shot.width / 2),
          top: Math.floor(shot.height / 2),
          width: 1,
          height: 1,
        })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.deepEqual(
        [...pixel],
        [220, 30, 40],
        'Captured hidden target is red, not blue occluder',
      );
      await writeFile(minimize, 'minimize');
      for (let i = 0; i < 30; i++) {
        try {
          await readFile(minimize + '.ready');
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await assert.rejects(
        desktopAction({ action: 'screenshot', windowId: state.target }),
        /CAPTURE_MINIMIZED/,
      );
      await assert.rejects(
        desktopAction({ action: 'screenshot', windowId: '0' }),
        /CAPTURE_UNAVAILABLE/,
      );
    } finally {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((r) => child!.once('exit', () => r()));
        child.kill();
        await exited;
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
