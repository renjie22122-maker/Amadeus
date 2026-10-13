import ExcelJS from 'exceljs';
import { createHash, randomInt } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const python = process.env.AMADEUS_EVAL_PYTHON;
const image = process.env.AMADEUS_TEST_ANALYSIS_IMAGE;
test(
  'both native loops execute the identical offline calculation and repair final format through the shared broker',
  { skip: !python || !image, timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'amadeus-broker-'));
    let count = 0;
    const schemas: any[] = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      schemas.push(body.tools.map((t: any) => t.function));
      const step = count++ % 3;
      const smol = body.tools.some((t: any) => t.function.name === 'final_answer');
      const tool = (name: string, args: unknown) => ({
        tool_calls: [
          {
            index: 0,
            id: 'call_' + count,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      const delta =
        step === 0
          ? tool('calculate', { code: 'print(2+2)' })
          : smol
            ? tool('final_answer', { answer: step === 1 ? '**4**' : '4' })
            : { content: step === 1 ? '**4**' : '4' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'mock',
            choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
      const settings = join(root, 'settings.json');
      await writeFile(
        settings,
        JSON.stringify({
          defaultProfileId: 'test',
          profiles: [
            {
              id: 'test',
              name: 'mock',
              transport: 'openai-chat',
              baseUrl,
              apiKey: '',
              model: 'mock',
              reasoning: 'auto',
              efforts: ['auto'],
              vision: true,
            },
          ],
        }),
      );
      for (const arm of ['amadeus', 'smolagents']) {
        count = 0;
        const directory = join(root, arm);
        await mkdir(directory);
        const job = join(root, arm + '.json');
        await writeFile(
          job,
          JSON.stringify({
            id: 'synthetic-control',
            arm,
            directory,
            settings,
            profileId: 'test',
            python,
            analysisImage: image,
            protocol: 'shared-evidence-v2',
            prompt: 'Compute 2+2 with calculate. Return one line with only the value.',
            maxSteps: 6,
            completeCatalog: true,
          }),
        );
        let logs = '';
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'evals/public-qa/worker.ts', job],
          { windowsHide: true },
        );
        child.stderr.on('data', (b) => (logs += b));
        child.stdout.on('data', () => {});
        const code = await new Promise<number | null>((r, j) => {
          child.on('error', j);
          child.on('close', r);
        });
        assert.equal(code, 0, logs);
        const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
        assert.equal(
          result.error,
          undefined,
          JSON.stringify({ error: result.error, tools: result.tools, auxiliary: result.auxiliary }),
        );
        assert.equal(result.answer, '4');
        const execution = result.tools.find((t: any) => t.name === 'calculate' && t.result);
        assert.equal(execution.result.code, 0, JSON.stringify(execution));
        assert.equal(execution.result.stdout.trim(), '4');
        assert.equal(execution.result.execution.backend, 'docker');
        assert(result.auxiliary.some((a: any) => a.kind === 'format-rejection'));
      }
      const canonical = (s: any[]) =>
        s.filter((t) => t.name !== 'final_answer').sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(canonical(schemas[0]), canonical(schemas[3]));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

const nativeImage = process.env.AMADEUS_TEST_NATIVE_IMAGE;
test(
  'three native GAIA arms read a real randomized XLSX with distinct tools',
  { skip: !python || !nativeImage, timeout: 180000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'amadeus-native-'));
    const cellValue = randomInt(1000, 9999);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data').getCell('A1').value = cellValue;
    const attachment = join(root, 'input.xlsx');
    await workbook.xlsx.writeFile(attachment);
    const sha256 = createHash('sha256')
      .update(await readFile(attachment))
      .digest('hex');
    let arm = '';
    let calls = 0;
    const catalogs: Record<string, string[]> = {};
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      catalogs[arm] = (body.tools || []).map((t: any) => t.function.name);
      const tool = (name: string, args: unknown) => ({
        tool_calls: [
          {
            index: 0,
            id: 'native_' + calls,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      let delta: any;
      if (arm === 'smolagents-code')
        delta = {
          content:
            '<code>\nfrom openpyxl import load_workbook\nw = load_workbook("/workspace/input.xlsx", data_only=True)\nfinal_answer(str(w.active["A1"].value))\n</code>',
        };
      else if (calls === 0)
        delta = tool(
          arm === 'amadeus' ? 'read_document' : 'read_task_file',
          arm === 'amadeus' ? { path: 'input.xlsx' } : { name: 'input.xlsx' },
        );
      else {
        assert(
          JSON.stringify(body.messages).includes(String(cellValue)),
          'Real attachment cell must reach the next model request',
        );
        delta =
          arm === 'amadeus'
            ? { content: String(cellValue) }
            : tool('final_answer', { answer: String(cellValue) });
      }
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const settings = join(root, 'settings.json');
      await writeFile(
        settings,
        JSON.stringify({
          defaultProfileId: 'test',
          profiles: [
            {
              id: 'test',
              name: 'mock',
              transport: 'openai-chat',
              baseUrl: 'http://127.0.0.1:' + (server.address() as any).port,
              apiKey: '',
              model: 'mock',
              reasoning: 'auto',
              efforts: ['auto'],
            },
          ],
        }),
      );
      for (arm of ['amadeus', 'smolagents', 'smolagents-code']) {
        calls = 0;
        const directory = join(root, arm);
        await mkdir(directory);
        const job = join(root, arm + '.json');
        await writeFile(
          job,
          JSON.stringify({
            id: 'synthetic-native',
            arm,
            directory,
            settings,
            python,
            analysisImage: nativeImage,
            protocol: 'native-evidence-v1',
            prompt: 'Read input.xlsx cell A1. Return only its value.',
            attachments: [{ name: 'input.xlsx', path: attachment, sha256 }],
            maxSteps: 6,
            completeCatalog: true,
          }),
        );
        let logs = '';
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'evals/public-qa/worker.ts', job],
          { windowsHide: true },
        );
        child.stdout.on('data', () => {});
        child.stderr.on('data', (b) => (logs += b));
        const code = await new Promise<number | null>((r, j) => {
          child.on('error', j);
          child.on('close', r);
        });
        assert.equal(code, 0, logs);
        const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
        assert.equal(result.error, undefined, JSON.stringify(result));
        assert.equal(result.answer, String(cellValue));
        assert(!result.auxiliary.some((a: any) => a.kind === 'format-rejection'));
      }
      assert(catalogs.amadeus.includes('run_python'));
      assert(catalogs.smolagents.includes('python_interpreter'));
      assert(!catalogs.smolagents.includes('run_python'));
      assert.equal(catalogs['smolagents-code'].length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
