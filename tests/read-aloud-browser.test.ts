import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from 'playwright';

test(
  'real browser decodes ordinary WAV frames, schedules in order and captures timings',
  {
    skip: process.env.AMADEUS_TEST_SPEECH_BROWSER !== '1',
    timeout: 30000,
  },
  async () => {
    const source = ['src/api.ts', 'src/read-aloud-diagnostics.ts', 'src/read-aloud-stream.ts']
      .map((path) =>
        readFileSync(path, 'utf8')
          .replace(/^import .*;$/gm, '')
          .replace(/^export /gm, ''),
      )
      .join('\n');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const html = `<script type="module">
      ${compiled}
      window.runSpeech = async () => {
        const context = new AudioContext(); await context.resume();
        const trace = new ReadAloudDiagnostics();
        const wav = frequency => {
          const buffer = new ArrayBuffer(44+1600*2), v = new DataView(buffer);
          const text = (at,s) => [...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
          text(0,'RIFF');v.setUint32(4,buffer.byteLength-8,true);text(8,'WAVEfmt ');
          v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
          v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
          text(36,'data');v.setUint32(40,3200,true);
          for(let i=0;i<1600;i++)v.setInt16(44+i*2,Math.round(8000*Math.sin(2*Math.PI*frequency*i/8000)),true);
          return btoa(String.fromCharCode(...new Uint8Array(buffer)));
        };
        const originalFetch = window.fetch;
        window.fetch = async () => new Response(new ReadableStream({start(controller) {
          const send = frame => controller.enqueue(new TextEncoder().encode(JSON.stringify(frame)+'\\n'));
          send({type:'audio', sequence:0, audio:wav(440)});
          setTimeout(()=>{send({type:'audio', sequence:1, audio:wav(880)});send({type:'done',chunks:2});controller.close();},400);
        }}),{headers:{'content-type':'application/x-ndjson'}});
        try { await playLocalSpeech({conversationId:'test',serviceId:'test',text:'Ordinary test.',signal:new AbortController().signal,context,rate:1,onAudio(){},diagnostics:trace}); return trace.snapshot(); }
        finally { window.fetch=originalFetch; await context.close(); }
      };
    </script>`;
    const browser = await chromium.launch({
      timeout: 15000,
      channel: 'msedge',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:9876/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://127.0.0.1:9876/speech-fixture');
      await page.waitForFunction(() => typeof (window as any).runSpeech === 'function', undefined, {
        timeout: 10000,
      });
      const trace = await page.evaluate(() => (window as any).runSpeech());
      const scheduled = trace.events.filter((e: any) => e.type === 'scheduled');
      assert.deepEqual(
        scheduled.map((e: any) => e.sequence),
        [0, 1],
      );
      assert.equal(scheduled[1].gapSeconds, 0);
      assert.equal(scheduled[1].scheduledStart, scheduled[0].scheduledEnd);
      assert.equal(trace.events.filter((e: any) => e.type === 'ended_callback').length, 2);
      assert.equal(trace.events.filter((e: any) => e.type === 'audio_received').length, 2);
    } finally {
      await browser.close();
    }
  },
);
