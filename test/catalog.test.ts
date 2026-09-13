import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitCatalog, nativeModelId, parseCatalog, priceReport } from '../src/catalog.ts';
import type { Catalog, CatalogEntry, Group, Pricing } from '../src/catalog.ts';

const group: Group = { id: 'ZGVmYXVsdA', name: 'default', scope: 'group:ZGVmYXVsdA', multiplier: 2 };
const pricing: Pricing = {
  currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates',
  group_multiplier: 2, trust_multiplier: 0.5, input: 1, output: 2, cache_read: 0.1, cache_write: 0.2,
  request: null, final_cost_depends_on_usage: true, updated_at: 1789240000,
};
const model: CatalogEntry = {
  id: 'lmm:ZGVmYXVsdA:Z3B0LXRlc3Q', group_id: 'ZGVmYXVsdA', group: 'default',
  upstream_model: 'gpt-test', name: 'default / gpt-test', apis: ['openai-completions'], pricing,
  native_cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
};
const catalog: Catalog = { schema_version: 1, resource: 'https://lmm.test/api/oauth2', updated_at: 1789240000, groups: [group], models: [model] };

test('native selector displays readable group and model while retaining the wire identity', () => {
  const parsed = parseCatalog(catalog, catalog.resource, 'group:ZGVmYXVsdA');
  const admitted = admitCatalog(parsed, 'https://lmm.test', () => ({
    api: 'openai-completions', contextWindow: 1000, maxTokens: 100, reasoning: false,
    input: ['text'], compat: {}, provenance: 'test fixture',
  }));
  assert.equal(admitted[0]!.model!.id, 'default / gpt-test');
  assert.equal(admitted[0]!.entry.id, model.id);
  assert.ok(!priceReport(admitted).includes(model.id));
  assert.equal(nativeModelId({ group: '国产[Kimi/Deepseek/GLM]', upstream_model: 'deepseek-v4-flash' }),
    '国产[Kimi/Deepseek/GLM] / deepseek-v4-flash');
  assert.notEqual(nativeModelId({ group: 'a / b', upstream_model: 'c' }), nativeModelId({ group: 'a', upstream_model: 'b / c' }));
  assert.notEqual(nativeModelId({ group: 'a%20%2F%20b', upstream_model: 'c' }), nativeModelId({ group: 'a / b', upstream_model: 'c' }));
});

test('accepts matching native cost under configured base rates', () => {
  assert.equal(parseCatalog(catalog, catalog.resource, 'catalog:read balance:read models:invoke group:ZGVmYXVsdA').models[0]!.native_cost?.output, 2);
});

test('rejects a mismatched native cost and does not treat missing cache as zero', () => {
  assert.throws(() => parseCatalog({ ...catalog, models: [{ ...model, native_cost: { ...model.native_cost, output: 3 } }] }, catalog.resource, 'group:ZGVmYXVsdA'));
  const missingCache = { ...model, native_cost: null, pricing: { ...pricing, cache_read: null, cache_write: null } };
  assert.equal(parseCatalog({ ...catalog, models: [missingCache] }, catalog.resource, 'group:ZGVmYXVsdA').models[0]!.native_cost, null);
});

test('admits variable-billing models with a clearly labelled Pi reference cost', () => {
  const variable: CatalogEntry = { ...model, native_cost: null, pricing: { ...pricing, unit: 'expression', price_basis: 'tiered_expression', input: null, output: null, cache_read: null, cache_write: null } };
  const [admission] = admitCatalog({ ...catalog, models: [variable] }, 'https://lmm.test', () => ({
    api: 'openai-completions', contextWindow: 128000, maxTokens: 4096, reasoning: true, input: ['text'], compat: {},
    referenceCost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0, tiers: [{ inputTokensAbove: 100000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 0 }] }, provenance: 'fixture',
  }));
  assert.ok(admission?.model);
  assert.match(admission.model.name, /LMM variable billing/);
  assert.equal(admission.model.cost.input, 2);
  assert.equal(admission.model.cost.tiers?.[0]?.output, 12);
});

test('accepts a dynamic estimate as native cost while retaining its estimate basis', () => {
  const result = parseCatalog({ ...catalog, models: [{ ...model, pricing: { ...pricing, price_basis: 'dynamic_estimate' } }] }, catalog.resource, 'group:ZGVmYXVsdA');
  assert.equal(result.models[0]!.pricing.price_basis, 'dynamic_estimate');
  assert.equal(result.models[0]!.native_cost?.input, 1);
});
