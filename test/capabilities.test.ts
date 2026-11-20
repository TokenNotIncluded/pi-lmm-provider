import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { createCapabilityResolver } from '../src/capabilities.ts';
import { admitCatalog, type Catalog, type CatalogEntry } from '../src/catalog.ts';
import { ModelsDevCatalog, parseModelsDev } from '../src/models-dev-cache.ts';
import { SUPPORTED_APIS } from '../src/protocol.ts';

function entry(model: string, apis: CatalogEntry['apis'] = ['openai-completions']): CatalogEntry {
  return {
    id: 'lmm:ZGVmYXVsdA:' + Buffer.from(model).toString('base64url'),
    group_id: 'ZGVmYXVsdA', group: 'default', upstream_model: model, name: model, apis, native_cost: null,
    pricing: { currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates',
      group_multiplier: 1, input: null, output: null, cache_read: null, cache_write: null,
      request: null, final_cost_depends_on_usage: true, updated_at: 1 },
  };
}
const metadata = (overrides: Record<string, unknown> = {}) => parseModelsDev({ fixture: { models: {
  'future-model-4.1-8b': { id: 'future-model-4.1-8b', name: 'Future Model 4.1 8B',
    canonical_model_id: 'fixture/future-model-4.1-8b', reasoning: true, tool_call: true,
    limit: { context: 100_000, input: 80_000, output: 20_000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    cost: { input: 2, output: 8, cache_read: 0.2 }, ...overrides },
} } });

test('authorized unknown models remain selectable for every supported advertised protocol', () => {
  const resolve = createCapabilityResolver(new ModelsDevCatalog());
  for (const api of SUPPORTED_APIS) {
    const item = entry('brand-new-model-42', [api]);
    const capability = resolve(item);
    assert.ok(capability);
    assert.equal(capability.api, api);
    assert.equal(capability.contextWindow, 32768);
    assert.equal(capability.maxTokens, 4096);
    assert.deepEqual(capability.unknownCostFields, ['input', 'output', 'cache_read', 'cache_write']);
    const [admission] = admitCatalog({ models: [item] } as Catalog, 'https://fixture.invalid', resolve);
    assert.ok(admission?.model);
    assert.match(admission.model.name, /cost estimate incomplete/);
    assert.equal(admission.entry.upstream_model, 'brand-new-model-42');
  }
  assert.equal(resolve(entry('new-model', [])), undefined);
});

test('fuzzy reference lookup enriches aliases without changing the original account model identity', () => {
  const resolve = createCapabilityResolver(metadata());
  const item = entry('Fixture/FUTURE_MODEL_4.1_8B-20261117');
  const result = resolve(item);
  assert.ok(result);
  assert.equal(result.contextWindow, 80_000);
  assert.equal(result.maxTokens, 20_000);
  assert.deepEqual(result.input, ['text', 'image']);
  assert.equal(result.reasoning, true);
  assert.equal(result.thinkingLevelMap?.high, 'high');
  assert.equal(result.thinkingLevelMap?.max, null);
  const [admission] = admitCatalog({ models: [item] } as Catalog, 'https://fixture.invalid', resolve);
  assert.equal(admission?.model?.id, 'default / Fixture/FUTURE_MODEL_4.1_8B-20261117');
  assert.equal(item.upstream_model, 'Fixture/FUTURE_MODEL_4.1_8B-20261117');
  assert.equal(resolve(entry('future-model-4.2-8b'))?.contextWindow, 32768, 'different generation has unknown metadata but stays available');
});

test('explicit server limits, modalities and false reasoning override public reference metadata', () => {
  const item = entry('future-model-4.1-8b');
  item.metadata = { context_window: 5000, max_input_tokens: 4000, max_output_tokens: 2000,
    input_modalities: ['text'], output_modalities: ['text'], reasoning: false, tool_call: false, source: 'server' };
  const result = createCapabilityResolver(metadata())(item);
  assert.ok(result);
  assert.equal(result.contextWindow, 4000);
  assert.equal(result.maxTokens, 2000);
  assert.deepEqual(result.input, ['text']);
  assert.equal(result.reasoning, false);
  assert.equal(result.thinkingLevelMap, undefined);
  assert.equal(Reflect.get(result.compat, 'supportsReasoningEffort'), false);
  assert.equal(result.provenance, 'server');
});

test('text-capable multimodal models remain available; explicit non-text and specialized models are excluded', () => {
  const item = entry('future-model-4.1-8b');
  assert.ok(createCapabilityResolver(metadata({ modalities: { input: ['text'], output: ['text', 'audio'] } }))(item));
  assert.ok(createCapabilityResolver(metadata({ tool_call: false }))(item));
  for (const modalities of [{ input: ['text'], output: ['image'] }, { input: ['audio'], output: ['text'] }]) {
    assert.equal(createCapabilityResolver(metadata({ modalities }))(item), undefined);
  }
  assert.equal(createCapabilityResolver(metadata({ type: 'decision' }))(item), undefined);
});

test('reasoning_content compatibility is metadata-driven and independent of account group names', () => {
  const resolve = createCapabilityResolver(metadata({ interleaved: { field: 'reasoning_content' } }));
  for (const group of ['default', 'new custom group']) {
    const result = resolve({ ...entry('future-model-4.1-8b'), group });
    assert.ok(result);
    assert.equal(Reflect.get(result.compat, 'thinkingFormat'), 'deepseek');
    assert.equal(Reflect.get(result.compat, 'requiresReasoningContentOnAssistantMessages'), true);
    assert.equal(Reflect.get(result.compat, 'sendSessionAffinityHeaders'), true);
    assert.notEqual(Reflect.get(result.compat, 'supportsLongCacheRetention'), true);
  }
});

test('server rates take priority and missing cache rates remain explicitly unknown', () => {
  const item = entry('future-model-4.1-8b');
  item.pricing.input = 3;
  const result = createCapabilityResolver(metadata())(item);
  assert.ok(result);
  assert.equal(result.referenceCost?.input, 3);
  assert.equal(result.referenceCost?.output, 8);
  assert.equal(result.referenceCost?.cacheRead, 0.2);
  assert.deepEqual(result.unknownCostFields, ['cache_write']);
});

test('installed host reasoning maps survive translation to the advertised gateway protocol', () => {
  const host = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider))
    .find(model => model.reasoning && model.thinkingLevelMap && model.api === 'openai-responses');
  assert.ok(host);
  const result = createCapabilityResolver(new ModelsDevCatalog())(entry(host.id));
  assert.ok(result);
  assert.equal(result.api, 'openai-completions');
  assert.equal(result.reasoning, true);
  assert.ok(result.thinkingLevelMap);
  assert.equal('allowedFallbackModels' in result.compat, false);
});

test('thousands of new authorized names are not capped by a plugin model list', () => {
  const models = Array.from({ length: 5000 }, (_, i) => entry('fresh-model-' + i));
  const admissions = admitCatalog({ models } as Catalog, 'https://fixture.invalid', createCapabilityResolver(new ModelsDevCatalog()));
  assert.equal(admissions.filter(item => item.model).length, 5000);
  assert.equal(admissions.at(-1)?.model?.id, 'default / fresh-model-4999');
});


test('zero public capacities are unknown and cannot poison a complete account catalog', () => {
  const resolve = createCapabilityResolver(metadata({ limit: { context: 0, output: 0 } }));
  const result = resolve(entry('future-model-4.1-8b'));
  assert.equal(result?.contextWindow, 32768);
  assert.equal(result?.maxTokens, 4096);
  const rows = [entry('future-model-4.1-8b'), entry('another-new-model')];
  assert.equal(admitCatalog({ models: rows } as Catalog, 'https://fixture.invalid', resolve).filter(row => row.model).length, 2);
});
