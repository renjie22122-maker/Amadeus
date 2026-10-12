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
  const charts = [
    {
      type: 'flow',
      title: 'Execution flow',
      steps: [
        { title: 'Plan', detail: 'Define acceptance' },
        { title: 'Execute', detail: 'Collect observations' },
        { title: 'Verify', detail: 'Check evidence' },
      ],
    },
    {
      type: 'bar',
      title: 'Measured latency',
      unit: ' ms',
      data: [
        { label: 'Baseline', value: 120 },
        { label: 'Updated', value: 75 },
      ],
    },
    {
      type: 'line',
      title: 'Measured samples',
      data: [
        { label: 'First', value: 3 },
        { label: 'Second', value: 7 },
        { label: 'Third', value: 4 },
      ],
    },
    {
      type: 'table',
      title: 'Comparison',
      columns: ['Variant', 'Result'],
      rows: [
        ['A', 'Passed'],
        ['B', 'Pending'],
      ],
    },
  ];
  const fence = String.fromCharCode(96).repeat(3);
  store.event('chat', null, 'assistant.message', {
    text: charts.map((c) => fence + 'chart\n' + JSON.stringify(c) + '\n' + fence).join('\n\n'),
    messageId: 'charts',
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
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.locator('iframe').nth(3).waitFor();
  for (let i = 0; i < 4; i++) await page.frameLocator('iframe').nth(i).locator('h2').waitFor();
  assert.equal(await page.frameLocator('iframe').nth(0).locator('.flow li').count(), 3);
  assert.equal(await page.frameLocator('iframe').nth(1).locator('.bar-row').count(), 2);
  assert.equal(await page.frameLocator('iframe').nth(2).locator('polyline').count(), 1);
  assert.equal(await page.frameLocator('iframe').nth(3).locator('tbody tr').count(), 2);
  const first = page.locator('.inline-preview').first();
  await first.getByRole('button', { name: 'Code', exact: true }).click();
  assert(await first.locator('.preview-code').isVisible());
  await first.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByTitle('Hide sidebar').click();
  assert.equal(
    await page.getByText('Reload Amadeus in the local browser.', { exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  if (process.env.CHART_SCREENSHOT)
    await page.screenshot({ path: process.env.CHART_SCREENSHOT, fullPage: true });
  console.log(
    'Chart browser checks passed: flow, bar, line, table, source switch, mobile viewport.',
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
