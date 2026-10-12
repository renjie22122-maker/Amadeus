import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const runtime = new Runtime(store, config, dir, () => ({
    complete: async () => ({
      message: { role: 'assistant', content: 'Received.' },
      usage: { input: 1, output: 1, cached: 0, measured: true },
    }),
  }));
  ({ app } = await createApp({ directory: dir, dist: resolve('dist'), runtime }));
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
  let slow = false,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  let blocked = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      slow &&
      route.request().method() === 'GET' &&
      (path === '/api/state' || path === '/api/conversations/chat')
    ) {
      blocked++;
      await gate;
    }
    await route.continue();
  });
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  const input = page.locator('textarea').first();
  await input.waitFor();
  await input.fill('UI acknowledgement probe');
  slow = true;
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith('/message') && r.request().method() === 'POST',
  );
  await page.locator('.send-button').click();
  const receipt = await accepted;
  assert.equal(receipt.status(), 200);
  assert.equal((await receipt.json()).checkpoints, undefined);
  await page.waitForFunction(
    () => document.querySelector('.send-button')?.getAttribute('aria-busy') === 'false',
  );
  assert(blocked > 0, 'background GET requests must still be blocked');
  await input.fill('Next draft');
  assert.equal(await input.inputValue(), 'Next draft');
  release();
  slow = false;
  await page.getByText('Received.', { exact: true }).waitFor();
  console.log(
    'Browser passed: submission unlocks while refresh remains blocked; next draft is editable; timeline catches up. No external model calls.',
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
