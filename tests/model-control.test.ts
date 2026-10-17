import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const require = createRequire(import.meta.url);
test('composer model menu switches main profile, saves child APIs and locks active runs', async (t) => {
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
      import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ModelControl} from './src/components/ModelControl';
      const profiles=[{id:'a',name:'Fast API',model:'fast',transport:'openai-chat',baseUrl:'https://one.example/v1',hasKey:true},{id:'b',name:'Pro API',model:'pro',transport:'anthropic',baseUrl:'https://two.example/v1',hasKey:true},{id:'c',name:'Local API',model:'local',transport:'openai-chat',baseUrl:'http://localhost:9999',hasKey:false}];
      function App(){const [id,setId]=useState('a'),[policy,setPolicy]=useState(null),[locked,setLocked]=useState(false),[fail,setFail]=useState(false);
       window.refreshPolicy=()=>setPolicy(p=>p?{...p}:p); return <><button onClick={()=>setLocked(!locked)}>Toggle running</button><button onClick={()=>setFail(!fail)}>Toggle failure</button><ModelControl profiles={profiles} profileId={id} policy={policy} locked={locked} zh={false} onBusy={()=>{}} onConfigure={()=>{window.configured=true;}} onSave={async patch=>{if(fail)throw Error('Save failed');window.saved=patch;if(patch.profileId)setId(patch.profileId);if('subagentModels' in patch)setPolicy(patch.subagentModels);}}/></>;}
      createRoot(document.getElementById('root')).render(<App/>);
    `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
    await page.setContent('<div id="root" style="position:absolute;bottom:20px"></div>');
    await page.addStyleTag({ content: readFileSync('src/style.css', 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', { name: 'Fast API', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search models' }).fill('pro');
    await page.getByRole('button', { name: /Pro API.*pro/ }).click();
    assert.equal(((await page.evaluate('window.saved')) as any).profileId, 'b');
    await page.getByRole('tab', { name: 'Subagents', exact: true }).click();
    await page.getByRole('combobox', { name: 'Default subagent model' }).selectOption('a');
    await page.getByRole('checkbox', { name: /Local API/ }).check();
    await page.getByRole('button', { name: 'Save subagent settings' }).click();
    const saved: any = await page.evaluate('window.saved');
    assert.deepEqual(saved.subagentModels, { defaultProfileId: 'a', allowedProfileIds: ['c'] });
    await page.getByRole('combobox', { name: 'Default subagent model' }).selectOption('c');
    await page.evaluate('window.refreshPolicy()');
    assert.equal(
      await page.getByRole('combobox', { name: 'Default subagent model' }).inputValue(),
      'c',
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle running', exact: true }).click();
    await page.getByRole('button', { name: 'Pro API', exact: true }).click();
    assert.equal(
      await page.getByRole('combobox', { name: 'Default subagent model' }).isDisabled(),
      true,
    );
    await page.getByRole('tab', { name: 'Main chat', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /Pro API.*pro/ }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle running', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle failure', exact: true }).click();
    await page.getByRole('button', { name: 'Pro API', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search models' }).fill('fast');
    await page.getByRole('button', { name: /Fast API.*fast/ }).click();
    await page.getByRole('alert').getByText('Save failed').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pro API', exact: true }).count(), 1);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.getByRole('button', { name: 'Pro API', exact: true }).click();
    const bounds = await page.locator('.control-popover').boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await page.getByRole('button', { name: 'Manage API connections' }).click();
    assert.equal(await page.evaluate('window.configured'), true);
  } finally {
    await browser.close();
  }
});
