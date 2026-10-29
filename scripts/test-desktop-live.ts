// Opt-in desktop integration test; creates and operates only its own disposable fixture.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { desktopAction } from '../server/services/desktop-native.js';
import { createDesktopSession } from '../server/services/desktop-session.js';
const exec = promisify(execFile),
  dir = await mkdtemp(join(tmpdir(), 'amadeus-desktop-fixture-'));
const code = `using System;using System.IO;using System.Windows.Forms;public class Fixture{[STAThread]public static void Main(string[] a){var f=new Form{Text="Amadeus isolated desktop test",Width=500,Height=300};var t=new RichTextBox{Multiline=true,AccessibleName="Test editor",Left=20,Top=20,Width=400,Height=30};var b=new Button{AccessibleName="Test button",Text="Record",Left=20,Top=65};f.Controls.Add(t);f.Controls.Add(b);t.TextChanged+=(s,e)=>File.WriteAllText(a[0],t.Text);b.Click+=(s,e)=>File.WriteAllText(a[1],"clicked");f.Shown+=(s,e)=>{f.Activate();t.Focus();};Application.Run(f);}}`;
await writeFile(join(dir, 'fixture.cs'), code);
await exec('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', [
  '/nologo',
  '/target:winexe',
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  '/out:' + join(dir, 'fixture.exe'),
  join(dir, 'fixture.cs'),
]);
const child = spawn(join(dir, 'fixture.exe'), [join(dir, 'text.txt'), join(dir, 'clicked.txt')], {
  windowsHide: false,
});
const run = createDesktopSession(desktopAction);
async function expectFile(name: string, value: string) {
  let actual;
  for (let n = 0; n < 50; n++) {
    actual = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (actual === value) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(actual, value);
}
try {
  let window: any;
  for (let n = 0; n < 20; n++) {
    window = (await run({ action: 'windows' })).windows.find((w: any) => w.processId === child.pid);
    if (window) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(window);
  const windowId = window.windowId;
  await run({ action: 'activate', windowId });
  let state = await run({ action: 'inspect', windowId });
  const edit = state.controls.find((c: any) => c.name === 'Test editor');
  assert.ok(edit);
  await run({
    action: 'click_element',
    windowId,
    observationId: state.observationId,
    elementIndex: edit.elementIndex,
  });
  await run({ action: 'type', windowId, text: 'Amadeus test 123' });
  await expectFile('text.txt', 'Amadeus test 123');
  await run({ action: 'key', windowId, key: 'CTRL+A' });
  await new Promise((r) => setTimeout(r, 150));
  await run({ action: 'type', windowId, text: 'replacement' });
  await expectFile('text.txt', 'replacement');
  state = await run({ action: 'inspect', windowId });
  const button = state.controls.find((c: any) => c.name === 'Test button');
  assert.ok(button);
  await run({
    action: 'click_element',
    windowId,
    observationId: state.observationId,
    elementIndex: button.elementIndex,
  });
  await expectFile('clicked.txt', 'clicked');
  const shot = await run({ action: 'screenshot', windowId });
  assert.ok(shot.width > 0 && Buffer.from(shot.image, 'base64').length > 1000);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'own fixture window activation',
        'UI Automation element click',
        'literal typing',
        'CTRL+A replacement',
        'button callback',
        'window screenshot',
      ],
      capture: shot.capture,
    }),
  );
} finally {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await rm(dir, { recursive: true, force: true });
}
