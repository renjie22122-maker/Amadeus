import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const build = resolve(process.argv[2] ?? join(import.meta.dirname, '../build'));
const { createApp } = await import(pathToFileURL(join(build, 'server/http/app.js')).href);
const { extractIsolated } = await import(
  pathToFileURL(join(build, 'server/services/document-parser.js')).href
);
import sharp from 'sharp';
const directory = await mkdtemp(join(tmpdir(), 'amadeus-build-'));
let app;
try {
  ({ app } = await createApp({ directory }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  const bootstrap = await app.inject('/api/bootstrap');
  const cookie = bootstrap.headers['set-cookie'].split(';')[0];
  const operational = await app.inject({ url: '/api/runtime/status', headers: { cookie } });
  assert.equal(operational.statusCode, 200);
  const status = operational.json();
  assert.equal(status.schedulerActive, true);
  assert.equal(status.build.version, bootstrap.json().version);
  assert(Number.isFinite(Date.parse(status.build.builtAt)));
  assert.notEqual((await app.inject('/api/runtime/status')).statusCode, 200);
  const doc = join(directory, 'unicode.txt');
  await writeFile(doc, '你好 🌍');
  assert.equal(await extractIsolated(doc, 10000), '你好 🌍');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  assert.equal((await sharp(png).metadata()).width, 2);
  const require = createRequire(import.meta.url);
  const transformerRequire = createRequire(require.resolve('@huggingface/transformers'));
  const ort = transformerRequire('onnxruntime-node');
  assert.equal(typeof ort.InferenceSession.create, 'function');
  console.log(
    'Compiled HTTP service, isolated document worker, image codec and ONNX module load passed. No model download/inference or OS sandbox certification.',
  );
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
