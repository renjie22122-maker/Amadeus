import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../server/http/app.js';

test(
  'workspace stays idle on unchanged heartbeat; changes refresh the active library',
  { skip: process.env.AMADEUS_TEST_REFRESH !== '1', timeout: 75000 },
  async (t) => {
    const cleanup: (() => Promise<unknown>)[] = [];
    t.after(async () => {
      const errors: unknown[] = [];
      for (const close of cleanup.reverse()) {
        try {
          await close();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length) throw new AggregateError(errors);
    });
    const dir = await mkdtemp(join(tmpdir(), 'amadeus-refresh-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const { app, store, runtime } = await createApp({
      directory: dir,
      dist: resolve(process.env.AMADEUS_TEST_UI_DIST || 'dist'),
    });
    cleanup.push(async () => {
      await app.close();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    runtime.knowledge.import('general', 'Synthetic test', 'Aster verified text');
    const b = await chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      headless: true,
    });
    cleanup.push(() => b.close());
    const page = await b.newPage({ viewport: { width: 1360, height: 900 } });
    const errors: string[] = [];
    let reads = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/state') reads++;
    });
    await page.addInitScript(() => {
      const Native = window.EventSource;
      (window as any).__heartbeats = 0;
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener('heartbeat', () => {
            (window as any).__heartbeats++;
          });
        }
      };
    });
    await page.goto(`http://127.0.0.1:${(app.server.address() as any).port}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.locator('summary').filter({ hasText: 'Running service' }).click();
    await page.getByText('Notebook sweep failures', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Knowledge', exact: true }).first().click();
    const box = page.getByPlaceholder(/Test retrieval/);
    const search = async (q: string) => {
      await box.fill(q);
      await box.locator('..').getByRole('button').click();
    };
    await search('Aster');
    const details = page.locator('details.search-result');
    await details.locator('summary').click();
    assert.match(await details.innerText(), /Trace:/);
    await search('unmatchedxyz');
    await page.waitForFunction(() =>
      document.querySelector('details.search-result')?.textContent?.includes('unmatchedxyz'),
    );
    const n = reads,
      heartbeat = await page.evaluate(() => (window as any).__heartbeats);
    await page.waitForFunction((h) => (window as any).__heartbeats > h, heartbeat, {
      timeout: 18500,
    });
    assert.equal(reads, n);
    const refreshed = page.waitForResponse(
      (r) => r.url().includes('/api/state?view=full') && r.status() === 200,
      { timeout: 18500 },
    );
    store.put('document', {
      id: 'changed',
      name: 'changed',
      scope: 'general',
      createdAt: Date.now(),
      characters: 0,
    });
    assert((await (await refreshed).json()).documents.some((d: any) => d.id === 'changed'));
    assert.deepEqual(errors, []);
  },
);
