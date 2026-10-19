import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mediaCapabilityTarget,
  migrateLegacyVoice,
  supportsReadAloud,
  speechStreamEndpoints,
} from '../shared/media-capabilities.js';
import { MediaService } from '../server/services/media.js';
import { extractionProfile } from '../server/services/rag-profile.js';
import { discoverSkills } from '../server/services/skill-semantic.js';
import { Embeddings } from '../server/services/embedding.js';
import { Configuration } from '../server/services/settings.js';
import { Store } from '../server/storage/store.js';

const mediaConnection = (): any => ({
  id: 'arbitrary-id',
  kind: 'speech',
  protocol: 'openai-speech',
  baseUrl: 'http://127.0.0.1:9876/v1',
  model: 'different-model',
  enabled: true,
  defaults: {},
  apiKey: 'fixture',
  estimatedUsd: null,
});
test('stream capability survives renaming but not model or endpoint changes', () => {
  const c = mediaConnection();
  assert.equal(supportsReadAloud(c), false);
  c.capabilities = { readAloud: { protocol: 'wav-ndjson-v1', target: mediaCapabilityTarget(c) } };
  assert.deepEqual(speechStreamEndpoints(c), {
    speech: 'http://127.0.0.1:9876/v1/audio/speech',
    health: 'http://127.0.0.1:9876/health',
  });
  assert.equal(supportsReadAloud({ ...c, id: 'renamed' }), true);
  assert.equal(supportsReadAloud({ ...c, model: 'changed' }), false);
  assert.equal(supportsReadAloud({ ...c, baseUrl: 'https://elsewhere.example/v1' }), false);
  for (const baseUrl of [
    'http://10.0.0.1/v1',
    'file:///tmp/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=x',
  ]) {
    const bad = { ...c, baseUrl };
    bad.capabilities = {
      readAloud: { protocol: 'wav-ndjson-v1', target: mediaCapabilityTarget(bad) },
    };
    assert.throws(() => speechStreamEndpoints(bad));
  }
  migrateLegacyVoice(c); // arbitrary ID cannot imply a capability
  const old = {
    ...mediaConnection(),
    id: 'amadeus-local-cosyvoice',
    model: 'cosyvoice',
    baseUrl: 'http://127.0.0.1:8812/v1',
  };
  migrateLegacyVoice(old);
  assert.equal(supportsReadAloud(old), true);
  const disabled = { ...old, capabilities: {} };
  migrateLegacyVoice(disabled);
  assert.equal(supportsReadAloud(disabled), false);
});

test('model reference limits and app budgets are separate and applied before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-limits-'));
  const store = new Store(join(root, 'db.sqlite'));
  const service = new MediaService(store, new Configuration(join(root, 'settings.json')), root);
  let reads = 0;
  service.output = (async () => {
    reads++;
    return { bytes: Buffer.from('image'), mime: 'image/png' };
  }) as any;
  try {
    const c = mediaConnection();
    c.kind = 'image';
    c.capabilities = {
      references: {
        target: mediaCapabilityTarget(c),
        maxPerField: 10,
        arrayFields: ['reference_image'],
      },
    };
    const refs = Array.from({ length: 10 }, (_, i) => 'attachment:' + i);
    const result = await service.referenceOptions('chat', {}, { reference_image: refs }, c);
    assert.equal((result.reference_image as string[]).length, 10);
    reads = 0;
    await assert.rejects(
      service.referenceOptions('chat', {}, { reference_image: [...refs, 'attachment:11'] }, c),
      /configured model limit/,
    );
    assert.equal(reads, 0);
    c.capabilities.references.maxTotal = 10;
    await assert.rejects(
      service.referenceOptions('chat', {}, { images: refs, inputs: ['attachment:x'] }, c),
      /configured model limit/,
    );
    await assert.rejects(
      service.referenceOptions('chat', {}, { images: Array(65).fill('attachment:x') }),
      /resource budget/,
    );
    await assert.rejects(
      service.referenceOptions('chat', {}, { images: refs }, { ...c, model: 'changed' }),
      /confirmed again/,
    );
    service.output = (async () => ({
      bytes: Buffer.alloc(25 * 1024 * 1024),
      mime: 'image/png',
    })) as any;
    await assert.rejects(
      service.referenceOptions('chat', {}, { images: refs.slice(0, 5) }),
      /100 MiB/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RAG extraction respects explicit and default selections without vendor preference', () => {
  const a: any = { id: 'a', transport: 'openai-chat', baseUrl: 'https://other.example/v1' };
  const b: any = { id: 'b', transport: 'openai-chat', baseUrl: 'https://api.deepseek.com' };
  const settings: any = { profiles: [b, a], defaultProfileId: 'a' };
  assert.equal(extractionProfile(settings)?.id, 'a');
  assert.equal(extractionProfile(settings, 'b')?.id, 'b');
  assert.throws(() => extractionProfile(settings, 'missing'), /Unknown/);
  assert.equal(extractionProfile({ ...settings, defaultProfileId: 'unknown' }), undefined);
  assert.equal(
    extractionProfile({ ...settings, profiles: [a], defaultProfileId: 'unknown' })?.id,
    'a',
  );
  assert.throws(
    () => extractionProfile({ ...settings, profiles: [{ ...a, transport: 'anthropic' }] }, 'a'),
    /compatible/,
  );
});

test('semantic skills discover cross-language metadata, skip disabled entries and stay local', async () => {
  const original = Embeddings.prototype.encode;
  const metadata = [
    {
      id: 'semantic-fixture-a',
      name: 'cad-layout',
      description: 'Arrange furniture and plan interiors',
      enabled: true,
    },
    { id: 'semantic-fixture-b', name: 'database-helper', description: 'Query SQL', enabled: true },
    {
      id: 'semantic-fixture-disabled',
      name: 'private',
      description: 'never encode',
      enabled: false,
    },
  ];
  let calls = 0;
  Embeddings.prototype.encode = async function (texts, _signal, purpose) {
    calls++;
    assert(!texts.some((t) => t.includes('never encode')));
    if (purpose === 'query') return [[1, 0]];
    return texts.map((t) => (t.includes('cad-layout') ? [1, 0] : [0, 1]));
  };
  const local: any = {
    backend: 'remote',
    baseUrl: 'http://127.0.0.1:8811/v1',
    model: 'skill-test',
    apiKey: '',
  };
  try {
    const result = await discoverSkills(
      metadata,
      [],
      '如何布置客厅',
      local,
      new AbortController().signal,
    );
    assert.equal(result.method, 'local-semantic-rrf');
    assert.equal(result.results[0].id, 'semantic-fixture-a');
    assert.equal(result.results.length, 1);
    const before = calls;
    const external = await discoverSkills(
      metadata,
      [],
      'SQL',
      { ...local, baseUrl: 'https://external.example/v1' },
      new AbortController().signal,
    );
    assert.equal(external.method, 'lexical');
    assert.equal(calls, before);
    Embeddings.prototype.encode = async () => {
      throw Error('unavailable');
    };
    const failed = await discoverSkills(metadata, [], 'SQL', local, new AbortController().signal);
    assert.equal(failed.results[0].id, 'semantic-fixture-b');
    assert.match(failed.semanticStatus, /fallback/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverSkills(metadata, [], 'SQL', local, controller.signal));
  } finally {
    Embeddings.prototype.encode = original;
  }
});
