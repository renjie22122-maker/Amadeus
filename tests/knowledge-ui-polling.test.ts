import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
const require = createRequire(import.meta.url);
test('knowledge panel renders immediately and polls while vector stats are delayed', async (t) => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(edge) ? { executablePath: edge } : {}),
    });
  } catch (e) {
    t.skip('Browser unavailable: ' + String(e));
    return;
  }
  try {
    const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
    const bundle = await build({
      stdin: {
        contents: `
 import React from 'react';
 import {createRoot} from 'react-dom/client';
 import {KnowledgeAutomation} from './src/components/KnowledgeAutomation';
 createRoot(document.getElementById('root')).render(<KnowledgeAutomation scope="general" zh={false} embedding={{backend:'local'}} notify={()=>{}} />);
 `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const page = await browser.newPage();
    let polls = 0;
    await page.route('http://fixture.test/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/knowledge/maintenance')) {
        polls++;
        await new Promise((r) => setTimeout(r, 500));
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            enabled: true,
            paths: ['source-root'],
            status: 'processing',
            progress: {
              phase: 'parsing',
              startedAt: Date.now(),
              updatedAt: Date.now(),
              total: 10,
              completed: polls,
              discovered: 10,
              imported: polls,
              reused: 0,
              failed: 0,
              currentFile: 'file-' + polls,
            },
          }),
        });
        return;
      }
      if (url.includes('/api/knowledge/index-status')) {
        await new Promise((r) => setTimeout(r, 8000));
        await route.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {});
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://fixture.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByText('Loading maintenance status…').waitFor();
    await page.getByText('file-1', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Save sources', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Sync changes now', exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Retry failed items', exact: true }).count(),
      0,
    );
    const draft = page.locator('textarea').first();
    await draft.fill('unsaved-new-folder');
    await page.getByText('file-2', { exact: true }).waitFor({ timeout: 5000 });
    assert.ok(polls >= 2);
    assert.equal(await draft.inputValue(), 'unsaved-new-folder');
    assert.equal(
      await page.getByRole('button', { name: 'Save sources', exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Sync changes now', exact: true }).isDisabled(),
      true,
    );
    await page.close();
  } finally {
    await browser.close();
  }
});
