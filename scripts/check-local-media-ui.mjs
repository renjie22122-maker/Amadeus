import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../build/server/http/app.js';
import { Runtime } from '../build/server/core/runtime.js';
import { Store } from '../build/server/storage/store.js';
import { Configuration } from '../build/server/services/settings.js';
const dir = await mkdtemp(join(tmpdir(), 'amadeus-ui-'));
let app, browser;
try {
  const store = new Store(join(dir, 'test.sqlite')),
    config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...config.get(),
    profiles: [
      {
        id: 'test',
        name: 'Test',
        transport: 'openai-chat',
        baseUrl: 'https://example.com',
        model: 'test',
      },
    ],
    defaultProfileId: 'test',
  });
  store.put('conversation', {
    id: 'chat',
    title: 'UI fixture',
    projectId: null,
    profileId: 'test',
    reasoning: 'auto',
    permission: 'ask',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    parentId: null,
    forkEvent: null,
    skillIds: [],
    knowledge: false,
    memory: false,
  });
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(16000, 40);
  await writeFile(join(dir, 'tone.wav'), wav);
  store.put('attachment', {
    id: 'audio',
    conversationId: 'chat',
    messageEventId: 1,
    name: 'tone.wav',
    mime: 'audio/wav',
    size: wav.length,
    path: join(dir, 'tone.wav'),
    text: 'Audio',
    createdAt: 1,
  });
  store.put('attachment', {
    id: 'video',
    conversationId: 'chat',
    messageEventId: 1,
    name: 'clip.mp4',
    mime: 'video/mp4',
    size: 0,
    path: join(dir, 'missing.mp4'),
    text: 'Video',
    createdAt: 1,
  });
  store.event('chat', null, 'user.message', {
    text: 'Review these files',
    attachments: [
      { id: 'audio', name: 'tone.wav', mime: 'audio/wav' },
      { id: 'video', name: 'clip.mp4', mime: 'video/mp4' },
    ],
  });
  const runtime = new Runtime(store, config, dir, () => ({
    complete: async () => ({
      message: { role: 'assistant', content: 'Received.' },
      usage: { input: 1, output: 1, cached: 0, measured: true },
    }),
  }));
  ({ app } = await createApp({ directory: dir, dist: resolve('dist'), runtime }));
  await runtime.media.importLocal(wav, 'workspace.wav', 'chat', 'run-local');
  await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('agentdemo.chat', 'chat');
    localStorage.setItem('agentdemo.language', 'en');
  });
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.locator('audio').first().waitFor();
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.equal(
    await page
      .locator('audio')
      .first()
      .evaluate((e) => e.duration),
    1,
  );
  assert.equal(
    await page
      .locator('audio')
      .first()
      .evaluate((e) => e.muted),
    false,
  );
  assert.equal(await page.locator('video').getAttribute('controls'), '');
  assert.equal(await page.locator('audio').count(), 2);
  assert.equal(await page.locator('.attachment-chips').count(), 0);
  await page.getByTitle('Hide sidebar').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  if (process.env.MEDIA_SCREENSHOT)
    await page.screenshot({ path: process.env.MEDIA_SCREENSHOT, fullPage: true });
  console.log(
    'Local attachment browser checks passed: WAV decodes, controls, unmuted, responsive.',
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
