import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { diagramCopySource, diagramDirection } from '../src/diagram-source';
const example = `flowchart TD
 A[任务输入] --> B[组装上下文<br/>历史+记忆+检索]
 B --> C[调用模型]
 C --> D{输出类型?}
 D -->|工具调用| E[校验参数<br/>权限/幂等/预算]
 E --> F[执行工具]
 F --> G[结果裁剪<br/>标注为不可信数据]
 G --> H[写回上下文]
 H --> I{预算/终止检查}
 D -->|最终答案| J[结构化校验]
 J --> K{通过?}
 K -->|否| B
 K -->|是| L[交付]
 I -->|继续| B
 I -->|耗尽| M[降级:交还部分结果+未完成说明]`;
test('copy transport repair is bounded and does not rewrite relationships', () => {
  const escaped = example.replaceAll('\n', '\\\n').replaceAll('<', '\\<').replaceAll('>', '\\>');
  assert.equal(diagramCopySource(escaped), example);
  assert.equal(diagramDirection(example, 'LR').split('\n')[0], 'flowchart LR');
  assert.equal(
    diagramDirection('sequenceDiagram\n A->>B: Hi', 'LR'),
    'sequenceDiagram\n A->>B: Hi',
  );
});
test(
  'real browser renders multilingual diagram families, concurrent jobs and recovers after errors',
  { timeout: 90000 },
  async (t) => {
    let browser;
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
      const bundle = await build({
        stdin: {
          contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CodePreview} from './src/components/CodePreview'; import {renderDiagram} from './src/diagram-renderer'; window.renderDiagram=renderDiagram; const root=createRoot(document.body.appendChild(document.createElement('div'))); window.mount=(source)=>root.render(React.createElement(CodePreview,{source,language:'mermaid'}));`,
          resolveDir: process.cwd(),
        },
        jsx: 'automatic',
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
      });
      const page = await browser.newPage();
      await page.route('http://127.0.0.1/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
      );
      await page.goto('http://127.0.0.1/diagram-test');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const families = [
        example,
        'sequenceDiagram\n Alice->>Bob: 你好\n Bob-->>Alice: Hello',
        'classDiagram\n Animal <|-- Cat',
        'erDiagram\n CUSTOMER ||--o{ ORDER : places',
        'stateDiagram-v2\n [*] --> Ready\n Ready --> [*]',
        'mindmap\n root((计划))\n  设计\n  验证',
        'gantt\n title 计划\n dateFormat YYYY-MM-DD\n section 工作\n 开发 :2026-10-23, 2d',
        'pie title 比例\n "A" : 30\n "B" : 70',
      ];
      const results = await page.evaluate(
        async (sources) =>
          Promise.all(
            sources.map(async (source) => {
              try {
                const r = await (window as any).renderDiagram(source);
                const doc = new DOMParser().parseFromString(r.svg, 'image/svg+xml');
                return {
                  ok: true,
                  foreign: doc.querySelectorAll('foreignObject').length,
                  text: doc.documentElement.textContent,
                };
              } catch (e) {
                return { ok: false, error: String(e) };
              }
            }),
          ),
        families,
      );
      for (let i = 0; i < results.length; i++)
        assert.equal(results[i].ok, true, families[i] + ' ' + JSON.stringify(results[i]));
      assert.equal(results[0].foreign, 0);
      assert.match(results[0].text!, /任务输入/);
      const escaped = example.replaceAll('\n', '\\\n').replaceAll('<', '\\<');
      const repaired = await page.evaluate(
        async (source) => (await (window as any).renderDiagram(source)).repaired,
        escaped,
      );
      assert.equal(repaired, true);
      const after = await page.evaluate(async () => {
        let failed = false;
        try {
          await (window as any).renderDiagram('flowchart TD\n A[');
        } catch {
          failed = true;
        }
        return { failed, ok: !!(await (window as any).renderDiagram('flowchart LR\n A-->B')).svg };
      });
      assert.deepEqual(after, { failed: true, ok: true });
      await page.addStyleTag({ content: readFileSync('src/style.css', 'utf8') });
      await page.evaluate((source) => (window as any).mount(source), example);
      await page.waitForSelector('img.diagram-image');
      assert.equal(
        await page
          .locator('img.diagram-image')
          .evaluate((img: any) => img.complete && img.naturalWidth > 0),
        true,
      );
      await page.getByLabel('Diagram zoom').selectOption('150');
      assert.equal(
        await page
          .locator('img.diagram-image')
          .evaluate((img) => img.getBoundingClientRect().width > img.parentElement!.clientWidth),
        true,
      );
      await page.getByLabel('Diagram zoom').selectOption('100');
      await page.getByRole('button', { name: 'Code', exact: true }).click();
      assert.equal(await page.locator('.preview-code code').textContent(), example);
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      assert.equal(
        await page.getByRole('link', { name: 'Download SVG' }).getAttribute('download'),
        'diagram.svg',
      );
      if (process.env.AMADEUS_DIAGRAM_SCREENSHOT)
        await page.screenshot({ path: process.env.AMADEUS_DIAGRAM_SCREENSHOT, fullPage: true });
    } finally {
      await browser.close();
    }
  },
);
