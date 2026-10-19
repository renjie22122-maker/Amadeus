import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { createApp } from '../server/http/app.ts';
import { deliverFile } from '../server/services/file-delivery.ts';

test(
  'one process disclosure per run preserves all progress and external user steering',
  { skip: process.env.AMADEUS_TEST_WORKBENCH !== '1' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-ui-'));
    let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined,
      browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const created = await createApp({
        directory,
        dist: resolve(process.env.AMADEUS_TEST_UI_DIST || 'dist'),
      });
      app = created.app;
      const c = {
        id: 'workbench',
        title: 'Workbench check',
        projectId: null,
        profileId: created.config.get().defaultProfileId,
        permission: 'ask',
        reasoning: 'auto',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
        archived: false,
        parentId: null,
        forkEvent: null,
        skillIds: [],
        knowledge: false,
        memory: false,
      };
      created.store.put('conversation', c);
      created.store.put('run', {
        id: 'r',
        conversationId: c.id,
        status: 'completed',
        parentRunId: null,
        depth: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
        checkpoints: [],
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelCalls: 1,
        estimatedUsd: 0,
        maxSteps: 10,
        profileId: c.profileId,
        reasoning: 'auto',
      });
      created.store.event(c.id, 'r', 'user.message', { text: 'Create a report' });
      created.store.event(c.id, 'r', 'assistant.message', {
        text: 'Intermediate progress hidden until expanded',
        final: false,
      });
      created.store.event(c.id, 'r', 'tool.started', {
        name: 'mcp_call',
        arguments: { tool: 'screenshot', serverId: 'browser' },
      });
      const image = await sharp({
        create: { width: 640, height: 360, channels: 3, background: '#345678' },
      })
        .png()
        .toBuffer();
      await deliverFile(created.store, c.id, 'r', 'capture.png', [image], undefined, {
        event: 'interaction.frame',
        adapter: 'Fixture browser',
        capability: 'browser',
        tool: 'screenshot',
      });
      await deliverFile(created.store, c.id, 'r', 'report.md', [
        Buffer.from(
          '# Report preview\n\n**Verified** content.\n\n<script>window.pwned=true</script>',
        ),
      ]);
      created.store.event(c.id, 'r', 'user.message', {
        text: 'Keep my follow-up outside',
        steering: true,
      });
      for (let i = 0; i < 20; i++) {
        created.store.event(c.id, 'r', 'effect.started', { id: 'effect-' + i });
        created.store.event(c.id, 'r', 'model.started', { model: 'fixture' });
        created.store.event(c.id, 'r', 'usage.updated', { inputTokens: i });
      }
      created.store.event(c.id, 'r', 'assistant.message', {
        text: 'Second progress after steering',
        final: false,
      });
      created.store.event(c.id, 'r', 'assistant.message', {
        text: 'Final report ready',
        final: true,
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('agentdemo.language', 'en');
        localStorage.setItem('agentdemo.chat', 'workbench');
      });
      await page.goto('http://127.0.0.1:' + (app.server.address() as { port: number }).port);
      await page.getByText('Final report ready', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByText('Intermediate progress hidden until expanded', { exact: true })
          .count(),
        0,
      );
      assert.equal(await page.locator('.completed-process').count(), 1);
      assert.equal(await page.locator('.completed-process .message.user').count(), 0);
      await page.getByText('Keep my follow-up outside', { exact: true }).waitFor();
      await page.locator('.completed-process summary').first().click();
      await page
        .getByText('Intermediate progress hidden until expanded', { exact: true })
        .waitFor();
      await page.getByText('Second progress after steering', { exact: true }).waitFor();
      assert.equal(await page.locator('.completed-process .activity').count(), 0);
      assert.ok((await page.locator('.completed-process .process-event').count()) > 0);
      assert.equal(await page.locator('.completed-process .message.user').count(), 0);
      await page.locator('.completed-process summary').first().click();
      await page.getByRole('button', { name: '打开 / Open · report.md', exact: true }).click();
      await page.getByRole('heading', { name: 'Report preview', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      assert.ok(
        (await page.locator('.workbench-body pre').textContent())?.includes('# Report preview'),
      );
      await page.getByRole('button', { name: 'Operations', exact: true }).click();
      await page.getByAltText('Captured tool frame').waitFor();
      await page.waitForFunction(
        () => (document.querySelector('.workbench-image') as HTMLImageElement)?.naturalWidth > 0,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Close panel', exact: true }).click();
      assert.equal(await page.locator('.workbench').count(), 0);
      assert.deepEqual(errors, []);
      console.log(
        'PASS workbench collapse/expand, Markdown/source, safe HTML, capture view, mobile close; synthetic screenshot only.',
      );
    } finally {
      if (browser) await browser.close();
      if (app) await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
