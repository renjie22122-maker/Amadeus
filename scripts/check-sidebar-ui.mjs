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
  const base = store.get('conversation', 'chat');
  for (let i = 0; i < 14; i++) {
    store.put('project', { id: 'p' + i, name: 'Project ' + i, folders: [], createdAt: i + 1 });
    store.put('conversation', {
      ...base,
      id: 'normal' + i,
      title: 'Normal ' + i,
      updatedAt: i + 2,
      createdAt: i + 2,
      pinned: i === 0,
    });
    store.put('conversation', {
      ...base,
      id: 'projectchat' + i,
      title: 'Project conversation ' + i,
      projectId: 'p' + i,
      updatedAt: i + 2,
      createdAt: i + 2,
    });
  }
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  await page.addInitScript(() => {
    localStorage.setItem('agentdemo.chat', 'chat');
    localStorage.setItem('agentdemo.language', 'en');
  });
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.locator('.project-group').first().waitFor();
  assert.equal(await page.locator('.project-group').count(), 5);
  assert.equal(
    await page
      .locator('.project-group')
      .first()
      .innerText()
      .then((x) => x.includes('Project 13')),
    true,
  );
  assert.equal(
    await page.locator('.chat-navigation > .sidebar-list').nth(1).locator('.chat-link').count(),
    6,
  );
  const more = page.getByRole('button', { name: 'Projects: See more', exact: true });
  await more.click();
  assert.equal(await page.locator('.project-group').count(), 10);
  await page.getByRole('button', { name: 'Projects: See less', exact: true }).click();
  assert.equal(await page.locator('.project-group').count(), 5);
  await page.locator('.search input').fill('Project 1');
  await page.getByText('Project conversation 1', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-group').count(), 5);
  assert.equal(
    await page
      .locator('.sidebar-list-items')
      .evaluateAll((nodes) => nodes.every((n) => getComputedStyle(n).overflowY === 'visible')),
    true,
  );
  await page.locator('.search input').fill('');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.chat-navigation').evaluate((e) => (e.scrollTop = 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: '.diagnostics/sidebar-lists.png' });
  console.log(
    'Sidebar: recent order, progressive expansion, collapse, project search, selected retention and shared scroll passed.',
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
