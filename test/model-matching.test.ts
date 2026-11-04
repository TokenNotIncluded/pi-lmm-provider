import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchModelMetadata, modelNameKey } from '../src/model-matching.ts';
import { parseMetadataCatalog } from '../src/models-dev.ts';

const model = (id: string, name = id, context = 128000) => ({ id, name, tool_call: true, reasoning: true,
  limit: { context, output: 16000 }, modalities: { input: ['text', 'image'], output: ['text'] } });
const snapshot = (catalog: unknown) => parseMetadataCatalog(catalog, '2026-11-04T00:00:00Z', '0'.repeat(64));
const data = snapshot({ 'future-vendor': { npm: '@ai-sdk/openai-compatible', models: {
  'novel-v7.2-flash': model('novel-v7.2-flash', 'Novel V7.2 Flash'),
  'novel-v7.2-pro': model('novel-v7.2-pro'),
  'novel-image': { ...model('novel-image'), type: 'image' },
} } });

test('discovers future providers and model versions without an installed model whitelist', () => {
  for (const id of ['novel-v7.2-flash', 'Novel V7.2 Flash', 'NOVEL_v7_2_FLASH', 'future-vendor/novel-v7.2-flash']) {
    const match = matchModelMetadata(id, data);
    assert.equal(match?.status, 'matched', id);
    if (match?.status === 'matched') {
      assert.equal(match.metadata.contextWindow, 128000);
      assert.equal(match.candidates[0]?.provider, 'future-vendor');
      assert.equal(match.candidates[0]?.id, 'novel-v7.2-flash');
    }
  }
});

test('normalization preserves versions, parameter sizes and meaningful variants', () => {
  assert.equal(modelNameKey('DeepSeek V4.1 Flash'), modelNameKey('deepseek-v4_1-flash'));
  assert.notEqual(modelNameKey('model-1.0'), modelNameKey('model-10'));
  for (const id of ['novel-v7-flash', 'novel-v7.3-flash', 'novel-v72-flash', 'novel-v7.2',
    'novel-v7.2-flash-lite', 'novel-v7.2-flash-20261104', 'novel-v7.2-flash-thinking',
    'another-vendor/novel-v7.2-flash', 'novel-v7.2-flash-unverified']) {
    assert.equal(matchModelMetadata(id, data), undefined, id);
  }
});

test('provider namespaces and display names are data-driven aliases', () => {
  const scoped = snapshot({ relay: { models: { 'lab/Atlas-8B': model('lab/Atlas-8B', 'Atlas 8B') } } });
  for (const id of ['lab/atlas-8b', 'Atlas 8B', 'atlas_8b', 'relay/lab/Atlas-8B']) {
    assert.equal(matchModelMetadata(id, scoped)?.status, 'matched', id);
  }
  assert.equal(matchModelMetadata('Atlas 80B', scoped), undefined);
});

test('exact IDs win over display aliases and ambiguous display names are rejected', () => {
  const ambiguous = snapshot({ vendor: { models: {
    'novel-1': model('novel-1', 'Novel'), 'novel-2': model('novel-2', 'Novel'),
    'novel-3': model('novel-3', 'novel-1'),
  } } });
  assert.equal(matchModelMetadata('Novel', ambiguous)?.status, 'ambiguous');
  const exact = matchModelMetadata('novel-1', ambiguous);
  assert.equal(exact?.status, 'matched');
  if (exact?.status === 'matched') assert.equal(exact.candidates.length, 1);
});

test('duplicate provider records use conservative limits independent of iteration order', () => {
  const catalog = { first: { models: { 'novel-1': model('novel-1') } },
    second: { models: { 'novel-1': { ...model('novel-1', 'novel-1', 64000), reasoning: false,
      modalities: { input: ['text'], output: ['text'] } } } } };
  for (const input of [catalog, Object.fromEntries(Object.entries(catalog).reverse())]) {
    const result = matchModelMetadata('NOVEL_1', snapshot(input));
    assert.equal(result?.status, 'matched');
    if (result?.status === 'matched') assert.deepEqual(result.metadata,
      { contextWindow: 64000, maxTokens: 16000, reasoning: false, input: ['text'] });
  }
});

test('non-chat exclusions also apply to normalized names and vendor-qualified IDs', () => {
  for (const id of ['novel-image', 'NOVEL Image', 'future-vendor/novel-image']) {
    assert.equal(matchModelMetadata(id, data)?.status, 'excluded');
  }
  const conflict = snapshot({ first: { models: { 'novel-1': model('novel-1') } },
    second: { models: { 'novel-1': { ...model('novel-1'), tool_call: false } } } });
  assert.equal(matchModelMetadata('novel-1', conflict)?.status, 'excluded');
});

test('malformed directories fail without requiring any fixed provider section', () => {
  assert.throws(() => snapshot({}));
  assert.throws(() => snapshot({ vendor: { models: [] } }));
  assert.throws(() => snapshot({ vendor: { models: { wrong: model('right') } } }));
  const onlyMedia = { models: { media: { ...model('media'), type: 'image' } } };
  const withMedia = snapshot({ ...{ newVendor: { models: { fresh: model('fresh') } } }, imageVendor: onlyMedia });
  assert.deepEqual(Object.keys(withMedia.providers.imageVendor!), []);
  assert.deepEqual(withMedia.excluded.imageVendor, ['media']);
  assert.equal(matchModelMetadata('__proto__', data), undefined);
  assert.equal(matchModelMetadata('constructor', data), undefined);
});
