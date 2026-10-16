import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import { AttachmentPreview } from '../src/components/AttachmentPreview.js';

test(
  'file card fits mobile width and downloads through its visible action',
  { skip: process.env.AMADEUS_TEST_DOCUMENT_PDF !== '1' },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 700 },
        acceptDownloads: true,
      });
      const css = await readFile('src/style.css', 'utf8');
      const name = '通用文档交付_中文文件名_非常长的名称_版本一.docx';
      const card = renderToStaticMarkup(
        createElement(AttachmentPreview, {
          attachment: {
            id: 'test-file',
            name,
            mime: 'application/octet-stream',
            bytes: 12345,
            sha256: 'a'.repeat(64),
          },
        }),
      );
      const server = createServer((req, res) => {
        if (req.url?.startsWith('/api/attachments/')) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
          });
          res.end('fixture bytes');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<!doctype html><meta charset="utf-8"><style>' +
              css +
              '</style><main style="padding:16px">' +
              card +
              '</main>',
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/');
        assert.equal(await page.locator('.file-download-card').count(), 1);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        await page.getByText('文件校验 / Checksum').click();
        const pending = page.waitForEvent('download');
        await page.locator('.file-download-card').click();
        const download = await pending;
        assert.equal(download.suggestedFilename(), name);
        assert.equal(await readFile((await download.path())!, 'utf8'), 'fixture bytes');
        if (process.env.AMADEUS_DOCUMENT_SCREENSHOT)
          await page.screenshot({ path: process.env.AMADEUS_DOCUMENT_SCREENSHOT, fullPage: true });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await browser.close();
    }
  },
);
