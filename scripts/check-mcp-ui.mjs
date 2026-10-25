import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../build/server/http/app.js';
import { Runtime } from '../build/server/core/runtime.js';
import { Store } from '../build/server/storage/store.js';
import { Configuration } from '../build/server/services/settings.js';
const dir = await mkdtemp(join(tmpdir(), 'amadeus-mcp-ui-'));
let app, browser;
try {
  const store = new Store(join(dir, 'db.sqlite')),
    config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...config.get(),
    mcp: [
      {
        id: 'sentry',
        name: 'Sentry',
        command: '',
        args: [],
        enabled: false,
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        oauth: { enabled: true },
      },
    ],
  });
  store.put('mcp-job', {
    id: 'receipt',
    conversationId: 'fixture',
    runId: 'run',
    serverId: 'server',
    tool: 'fixture-tool',
    status: 'completed',
    result: { content: [{ type: 'text', text: 'durable-result' }] },
  });
  const runtime = new Runtime(store, config, dir);
  ({ app } = await createApp({ directory: dir, dist: resolve('dist'), runtime }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('agentdemo.language', 'en'));
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page
    .locator('.sidebar-tools')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
  await page.getByText(/Signed out · Callback:/).waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: 'Use OAuth browser sign-in' }).isChecked(),
    true,
  );
  await page.getByLabel('Official MCP configuration examples').selectOption('7');
  await page.getByRole('button', { name: 'Add configuration', exact: true }).click();
  assert.equal(
    await page
      .locator('input')
      .filter({ visible: true })
      .evaluateAll((nodes) => nodes.some((n) => n.value === 'Fetch')),
    true,
  );
  await page
    .locator('.sidebar-tools')
    .getByRole('button', { name: /Background/ })
    .click();
  await page.getByText('fixture-tool · completed').click();
  await page.getByRole('button', { name: 'Inspect result', exact: true }).click();
  await page.getByText(/durable-result/).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'MCP settings, OAuth status, example import and background result UI passed. No third-party account login was performed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(dir, { recursive: true, force: true });
}
