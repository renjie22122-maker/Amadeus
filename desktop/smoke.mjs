import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';
import { Store } from '../build/server/storage/store.js';
import { Configuration } from '../build/server/services/settings.js';
import { McpHub } from '../build/server/services/mcp.js';

// Real app, real Node service, isolated data and a local durable MCP task. No model/account needed.
const directory = mkdtempSync(join(tmpdir(), 'amadeus-desktop-smoke-'));
let desktop,
  completed = false,
  submissions = 0,
  polls = 0;
const remote = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (message.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  let result;
  if (message.method === 'initialize')
    result = {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'fixture', version: '1' },
      capabilities: { tasks: { requests: { tools: { call: {} } } } },
    };
  else if (message.method === 'tasks/get') {
    polls++;
    result = {
      taskId: 'durable',
      status: completed ? 'completed' : 'working',
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttl: 600000,
      pollInterval: 1000,
    };
  } else if (message.method === 'tasks/result')
    result = { content: [{ type: 'text', text: 'completed-while-hidden' }] };
  else {
    submissions++;
    res.writeHead(500);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
try {
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const data = join(directory, 'agent');
  const config = new Configuration(join(directory, 'settings-seed.json'));
  config.save({
    ...config.get(),
    mcp: [
      {
        id: 'fixture',
        name: 'Fixture',
        enabled: true,
        transport: 'http',
        url: `http://127.0.0.1:${remote.address().port}/mcp`,
        command: '',
        args: [],
      },
    ],
  });
  const { mkdirSync, copyFileSync } = await import('node:fs');
  mkdirSync(data);
  copyFileSync(join(directory, 'settings-seed.json'), join(data, 'settings.json'));
  const store = new Store(join(data, 'agent.sqlite'));
  const run = { id: 'run', conversationId: 'chat', status: 'interrupted', checkpoints: [] };
  store.put('conversation', {
    id: 'chat',
    title: 'Desktop task fixture',
    permission: 'ask',
    createdAt: Date.now(),
  });
  store.put('run', run);
  const effectId = store.beginEffect('run', 'mcp_background', { jobId: 'job' });
  store.put('mcp-job', {
    id: 'job',
    conversationId: 'chat',
    runId: 'run',
    serverId: 'fixture',
    tool: 'fixture',
    status: 'unknown',
    effectId,
    remoteTask: { taskId: 'durable', status: 'working' },
    recovery: {
      binding: new McpHub().recoveryBinding(config.get().mcp[0]),
      protocol: '2025-11-25',
    },
  });
  store.close();
  const packaged = process.argv[2];
  const executablePath = packaged ? resolve(packaged) : createRequire(import.meta.url)('electron');
  const args = packaged ? [] : [resolve('desktop/main.mjs')];
  const env = {
    ...process.env,
    AMADEUS_NODE_BINARY: process.execPath,
    AMADEUS_DESKTOP_USER_DATA: join(directory, 'shell'),
    AGENTDEMO_DATA_DIR: data,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (packaged) delete env.AMADEUS_NODE_BINARY;
  desktop = await electron.launch({ executablePath, args, env, timeout: 90000 });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 90000 });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.desktop-titlebar').waitFor();
  await page.keyboard.press('Control+k');
  await page.waitForFunction(
    () => document.querySelector('.sidebar .search input') === document.activeElement,
  );
  await page.screenshot({ path: '.diagnostics/desktop-smoke.png' });
  await page.locator('.brand button').click();
  await page.keyboard.press('Control+k');
  await page.locator('.sidebar .search input').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.sidebar .search input') === document.activeElement,
  );
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
  await page.locator('.sidebar-bottom button').last().click();
  await page.screenshot({ path: '.diagnostics/desktop-light-compact.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 860),
  );
  await page.keyboard.press('Control+Shift+o');
  await page.locator('.chat-link.active').waitFor();
  const url = new URL(page.url()).origin;
  const bootFile = packaged
    ? join(dirname(executablePath), 'resources/app/desktop/boot.html')
    : resolve('desktop/boot.html');
  await desktop.evaluate(
    ({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].loadFile(file),
    bootFile,
  );
  await page.locator('#stage').waitFor();
  await page.waitForFunction(() => document.getElementById('elapsed').textContent.length > 0);
  await page.screenshot({ path: '.diagnostics/desktop-startup.png' });
  await desktop.evaluate(
    ({ BrowserWindow }, address) => BrowserWindow.getAllWindows()[0].loadURL(address),
    url,
  );
  await page.locator('.desktop-titlebar').waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const preferences = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  console.log('Desktop ready; checking second instance.');
  const second = spawn(executablePath, args, { env, windowsHide: true, stdio: 'ignore' });
  const secondExit = await Promise.race([
    once(second, 'exit'),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Second instance did not exit')), 20000);
      timer.unref();
    }),
  ]);
  assert.equal(secondExit[0], 0);
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  assert.equal((await fetch(url + '/api/health')).status, 200);
  console.log('Window hidden; completing task.');
  completed = true;
  const inspect = new Store(join(data, 'agent.sqlite'));
  try {
    for (let i = 0; i < 100 && inspect.get('mcp-job', 'job').status !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(inspect.get('mcp-job', 'job').status, 'completed');
    assert.equal(inspect.unknownEffects('chat').length, 0);
  } finally {
    inspect.close();
  }
  assert.ok(polls > 0);
  assert.equal(submissions, 0);
  await desktop.evaluate(({ app }) => app.emit('activate'));
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    true,
  );
  console.log('Task completed; quitting desktop.');
  await desktop.close();
  desktop = undefined;
  await assert.rejects(fetch(url + '/api/health'));
  const after = new Store(join(data, 'agent.sqlite'));
  assert.equal(after.get('mcp-job', 'job').status, 'completed');
  after.close();
  console.log(
    'Desktop passed: isolated renderer, single instance, hide/reopen, durable task completion while hidden, graceful service exit.',
  );
} finally {
  await desktop?.close();
  remote.closeAllConnections();
  await new Promise((r) => remote.close(r));
  rmSync(directory, { recursive: true, force: true });
}
