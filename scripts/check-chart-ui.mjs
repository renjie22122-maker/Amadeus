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
      title: 'full-v1 当前落盘（实测，正在下 longmemeval）',
      columns: ['目录', '体积', '内容'],
      rows: [
        ['sources', '1609 MB', '11 个 git 仓已全部克隆完（浅克隆）'],
        ['source-archives', '1304 MB', '11 个源码 tar 归档'],
        [
          'datasets',
          '283 MB',
          'SWE-bench_Verified 8.4 MB + SWE-bench_Lite 7.3 MB 已完成；LongMemEval 正在下（共 3.04 GB）',
        ],
        ['collection.json', '<1 MB', '清单/进度记录'],
        ['合计', '3196 MB', 'D 盘剩余 267.03 GB'],
      ],
    },
  ];
  charts.push({
    type: 'table',
    title: 'D:\\Amadeus-Benchmarks\\incoming\\full-v1 体积清单',
    columns: ['项目', '来源', '体积', '状态'],
    rows: [
      [
        '11 个 git 源码仓(浅克隆+tar)',
        'gh-proxy 镜像',
        '约 0.7 GB',
        '正在下，已落 0.29 GB+0.17 GB',
      ],
      ['SWE-bench_Verified', 'hf-mirror', '8.4 MB', '待下'],
      ['SWE-bench_Lite', 'hf-mirror', '7.3 MB', '待下'],
      ['LongMemEval 数据集', 'hf-mirror', '3.04 GB', '待下'],
      ['GAIA 数据集', 'hf-mirror', '102 MB', 'gated，需 HF token'],
      ['(替代)osworld_file_cache', 'hf-mirror', '1.02 GB', '可选'],
      ['WebArena 4 个镜像 tar', 'Google Drive / CMU 镜像', '约 15–20 GB', '未实测(两个源都受限)'],
      ['wikipedia_en_all_maxi ZIM', 'accum 镜像实测', '118.7 GB', '可下但极慢'],
      ['— 同上 nopic / mini 版', 'accum 镜像实测', '49 GB / 13.4 GB', '可选的轻量替代'],
      ['SWE-bench 全量容器镜像', '需自建', '约 200–300 GB', '未准备'],
      ['Terminal-Bench / OSWorld VM / WebArena map', '需自建', '数百 GB', '未准备'],
    ],
  });
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
  for (let i = 0; i < 5; i++) await page.frameLocator('iframe').nth(i).locator('h2').waitFor();
  assert.equal(await page.frameLocator('iframe').nth(0).locator('.flow li').count(), 3);
  assert.equal(await page.frameLocator('iframe').nth(1).locator('.bar-row').count(), 2);
  assert.equal(await page.frameLocator('iframe').nth(2).locator('polyline').count(), 1);
  assert.equal(await page.frameLocator('iframe').nth(3).locator('tbody tr').count(), 5);
  const heights = await page
    .locator('.preview-stage')
    .nth(3)
    .evaluate(async (stage) => {
      const values = [];
      for (let i = 0; i < 100; i++) {
        await new Promise(requestAnimationFrame);
        values.push(stage.getBoundingClientRect().height);
      }
      return values;
    });

  assert(
    heights.slice(-49).filter((h, i) => h !== heights.slice(-50)[i]).length <= 2,
    'Fit-content height must settle',
  );
  for (const width of [1280, 600, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const zoom of [1, 1.25]) {
      await page.evaluate((z) => {
        document.body.style.zoom = String(z);
      }, zoom);
      for (const index of [3, 4]) {
        const samples = await page
          .locator('.preview-stage')
          .nth(index)
          .evaluate(async (stage) => {
            const values = [];
            for (let i = 0; i < 80; i++) {
              await new Promise(requestAnimationFrame);
              values.push(stage.getBoundingClientRect().height);
            }
            return values.slice(-30);
          });
        assert(
          samples.slice(1).filter((h, i) => Math.abs(h - samples[i]) > 0.1).length <= 2,
          'Fit content must settle at width ' + width + ' zoom ' + zoom + ': ' + samples,
        );
      }
    }
  }
  await page.evaluate(() => {
    document.body.style.zoom = '1';
  });
  await page.setViewportSize({ width: 1280, height: 844 });
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
