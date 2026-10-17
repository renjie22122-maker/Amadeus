import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { pastedTextFilename } from '../src/composer-paste';
const require = createRequire(import.meta.url);
test('pasted text uses a bounded readable safe filename without changing content', () => {
  assert.equal(pastedTextFilename('Introduction\n# A useful title\nBody'), 'A useful title.md');
  assert.equal(pastedTextFilename('这是粘贴的内容\n第二行'), '这是粘贴的内容.md');
  assert.equal(
    pastedTextFilename('# [Example](https://example.com) **report**'),
    'Example report.md',
  );
  assert.equal(pastedTextFilename('CON'), 'Pasted text.md');
  assert.equal(pastedTextFilename('   '), 'Pasted text.md');
  assert.equal(pastedTextFilename('a'.repeat(100)), 'a'.repeat(48) + '.md');
  assert.equal(pastedTextFilename('a/b:c?d'), 'a b c d.md');
});
test('draft grows, caps, shrinks and remeasures on preview, restore and width changes', async (t) => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(edge) ? { executablePath: edge } : {}),
    });
  } catch (e) {
    t.skip('Browser unavailable: ' + e);
    return;
  }
  try {
    const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
    const bundle = await build({
      stdin: {
        contents: `
   import React,{useState,useRef} from 'react'; import {createRoot} from 'react-dom/client';
   import {useComposerHeight} from './src/use-composer-height';
   function App(){const [value,setValue]=useState(''),[hidden,setHidden]=useState(false);const ref=useRef(null);
    useComposerHeight(ref,value,hidden);window.restore=setValue;
    return <><button onClick={()=>setHidden(!hidden)}>Preview</button><div className="composer"><textarea aria-label="Draft" ref={ref} hidden={hidden} value={value} onChange={e=>setValue(e.target.value)}/></div></>;
   }createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    await page.setContent('<div id="root" style="width:100%"></div>');
    await page.addStyleTag({ content: readFileSync('src/style.css', 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const input = page.getByRole('textbox', { name: 'Draft' });
    const height = () => input.evaluate((el) => el.getBoundingClientRect().height);
    await expect.poll(height).toBe(82);
    await input.fill('one\ntwo\nthree\nfour');
    await expect.poll(height).toBeGreaterThan(120);
    await input.fill('line\n'.repeat(60));
    await expect.poll(height).toBe(320);
    assert.ok(await input.evaluate((el) => el.scrollHeight > el.clientHeight));
    await input.fill('short');
    await expect.poll(height).toBe(82);
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.evaluate(() => (window as any).restore('restored\n'.repeat(8)));
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect.poll(height).toBeGreaterThan(200);
    await input.fill('words '.repeat(80));
    const wide = await height();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(height).toBeGreaterThan(wide);
    await page.setViewportSize({ width: 360, height: 400 });
    await expect.poll(height).toBe(160);
    await page.evaluate(() => (window as any).restore(''));
    await expect.poll(height).toBe(82);
  } finally {
    await browser.close();
  }
});
