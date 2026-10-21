import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/http/app.js';
import { mediaCapabilityTarget } from '../shared/media-capabilities.js';

test(
  'browser voice waits for consent, supports assistant-first and releases microphone',
  { skip: process.env.AMADEUS_TEST_CHAT_VOICE !== '1', timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-voice-ui-'));
    const { app } = await createApp({ directory: dir, dist: resolve('dist') });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      browser = await chromium.launch({
        channel: 'msedge',
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
      });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        (window as any).__name = (value: unknown) => value;
        localStorage.setItem('agentdemo.language', 'en');
        (window as any).micStarts = 0;
        (window as any).micStops = 0;
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          value: async () => {
            (window as any).micStarts++;
            return {
              getTracks: () => [
                {
                  stop: () => {
                    (window as any).micStops++;
                  },
                },
              ],
            };
          },
        });
        (window as any).MediaRecorder = class {
          static isTypeSupported() {
            return true;
          }
          state = 'inactive';
          mimeType = 'audio/webm';
          onstop: any;
          ondataavailable: any;
          timer: any;
          start() {
            this.state = 'recording';
            this.timer = setInterval(
              () => this.ondataavailable?.({ data: new Blob(['fixture']) }),
              500,
            );
          }
          stop() {
            clearInterval(this.timer);
            this.state = 'inactive';
            this.ondataavailable?.({ data: new Blob(['fixture']) });
            this.onstop?.();
          }
        };
      });
      const connection = {
        id: 'voice-route',
        name: 'Voice fixture',
        conversationId: 'voice-chat',
        enabled: true,
        transport: 'onebot11',
        peerType: 'private',
        accessMode: 'chat',
        status: { status: 'connected' },
        deliveries: [],
        queued: 0,
        senderId: 'test',
        peerId: 'test',
      };
      const service: any = {
        id: 'speech',
        kind: 'speech',
        protocol: 'openai-speech',
        model: 'test',
        baseUrl: 'http://127.0.0.1:9999/v1',
      };
      service.capabilities = {
        readAloud: { protocol: 'wav-ndjson-v1', target: mediaCapabilityTarget(service) },
      };
      const stt: any = {
        id: 'stt',
        kind: 'transcription',
        protocol: 'openai-transcription',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'whisper',
        name: 'Whisper',
      };
      stt.capabilities = {
        transcriptionPreview: { protocol: 'audio-snapshot-v1', target: mediaCapabilityTarget(stt) },
      };
      const sent: string[] = [];
      const wav = Buffer.alloc(44 + 1600);
      wav.write('RIFF');
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(1600, 40);
      await page.route('**/api/chat-connections', (r) =>
        r.fulfill({ json: { connections: [connection], mediaServices: [] } }),
      );
      await page.route('**/api/chat-connections/voice-route/voice-turn', (r) => {
        sent.push(r.request().postDataJSON().text);
        return r.fulfill({ json: { runId: 'voice-run' } });
      });
      await page.route('**/api/chat-connections/voice-route/voice-turn/voice-run', (r) =>
        r.fulfill({ json: { status: 'completed', text: 'A normal reply.' } }),
      );
      await page.route('**/api/media/services', (r) => r.fulfill({ json: [service, stt] }));
      await page.route('**/api/conversations/voice-chat/transcribe', (r) =>
        r.fulfill({ json: { id: 'stt' } }),
      );
      await page.route('**/api/conversations/voice-chat/media', (r) =>
        r.fulfill({ json: [{ id: 'stt', status: 'completed', text: 'Hello from microphone.' }] }),
      );
      await page.route('**/api/conversations/voice-chat/read-aloud', (r) =>
        r.fulfill({
          contentType: 'application/x-ndjson',
          body:
            JSON.stringify({ type: 'audio', sequence: 0, audio: wav.toString('base64') }) +
            '\n' +
            JSON.stringify({ type: 'done', chunks: 1 }) +
            '\n',
        }),
      );
      await page.route('**/api/conversations/voice-chat/transcription-preview?*', (r) => {
        const sequence = Number(new URL(r.request().url()).searchParams.get('sequence'));
        return r.fulfill({
          json: {
            sequence,
            text: sequence === 10000 ? 'Final corrected sentence.' : 'Temporary words',
            hasSpeech: true,
            audioSeconds: 2,
            speechEnd: 2,
            elapsedMs: 50,
          },
        });
      });
      await page.goto('http://127.0.0.1:' + (app.server.address() as any).port);
      await page.getByRole('button', { name: 'Chat connections', exact: true }).click();
      await page.getByRole('button', { name: 'Browser voice', exact: true }).click();
      assert.equal(await page.evaluate(() => (window as any).micStarts), 0);
      await page.getByRole('button', { name: 'Assistant speaks first', exact: true }).click();
      await page.getByText('Ready', { exact: true }).waitFor();
      assert.equal(sent.length, 1);
      assert.equal(await page.evaluate(() => (window as any).micStarts), 0);
      await page.getByRole('button', { name: 'Speak', exact: true }).click();
      await page.waitForTimeout(500);
      assert.equal(
        await page.getByRole('alert').count(),
        0,
        JSON.stringify(errors) + ' ' + (await page.locator('body').innerText()),
      );
      await page.getByRole('button', { name: 'Finish speaking', exact: true }).click();
      await page.getByText('Ready', { exact: true }).waitFor();
      assert.equal(sent[1], 'Hello from microphone.');
      assert((await page.evaluate(() => (window as any).micStops)) >= 1);
      await page.getByRole('combobox').last().selectOption('stt');
      await page.getByRole('button', { name: 'Speak', exact: true }).click();
      await page.getByLabel('Provisional transcript', { exact: true }).waitFor();
      assert.equal(sent.length, 2, 'a preview must not dispatch a model turn');
      await page.getByRole('button', { name: 'Finish speaking', exact: true }).click();
      await page.getByText('Ready', { exact: true }).waitFor();
      assert.equal(sent[2], 'Final corrected sentence.');
      await page.getByRole('button', { name: 'Hang up', exact: true }).click();
      assert.equal(
        await page.getByRole('region', { name: 'Browser voice chat', exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
