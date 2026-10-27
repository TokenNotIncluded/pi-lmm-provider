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

test('price report distinguishes expression billing and Pi reference costs from server quotes', () => {
  const variable = { ...model, native_cost: null, pricing: { ...pricing, unit: 'expression', price_basis: 'tiered_expression',
    input: null, output: null, cache_read: null, cache_write: null } };
  const admitted = admitCatalog({ ...catalog, models: [variable] }, 'https://lmm.test', () => ({
    api: 'openai-completions', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'], compat: {},
    referenceCost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, provenance: 'fixture',
  }));
  const report = priceReport(admitted);
  assert.match(report, /1 selectable chat models, 0 read-only entries/);
  assert.match(report, /Server expression billing; fixed per-token rates are not provided/);
  assert.match(report, /vendor reference rates, not an LMM quote/);
  assert.ok(!report.includes('input unknown, output unknown'));
  assert.match(report, /Unknown is not free/);
  assert.equal(admitted[0]!.model!.cost.output, 2, 'display formatting does not modify native costs');
});

test('selectable models precede read-only entries even beyond the original 40-entry window', () => {
  const [admission] = admitCatalog(catalog, 'https://lmm.test', () => ({
    api: 'openai-completions', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'], compat: {}, provenance: 'fixture',
  }));
  const unavailable = Array.from({ length: 45 }, (_, i) => ({ entry: { ...model, upstream_model: `unavailable-${i}` },
    reason: 'Capability metadata unavailable; not registered in /model.' }));
  const report = priceReport([...unavailable, admission!]);
  assert.match(report, /1 selectable chat models, 45 read-only entries/);
  assert.ok(report.indexOf('default / gpt-test') < report.indexOf('default / unavailable-0'));
  assert.match(report, /default \/ unavailable-44/);
  assert.doesNotMatch(report, /Showing 40/);
  assert.match(priceReport(unavailable, 'unavailable-44'), /0 selectable chat models, 1 read-only entries/);
  assert.match(priceReport(unavailable, 'absent'), /No catalog entries match/);
});

test('all authorized groups are visible, including empty groups, with unknown values preserved', () => {
  const empty: Group = { id: 'ZW1wdHk', name: 'empty', scope: 'group:ZW1wdHk', multiplier: null };
  const report = priceReport([{ entry: model, reason: 'Capability metadata unavailable; not registered in /model.' }], '', [group, empty]);
  assert.match(report, /Authorized groups \(2\)/);
  assert.match(report, /empty · group ×unknown · 0 matching catalog entries/);
  assert.match(report, /default · group ×2 · 1 matching catalog entries/);
  assert.match(report, /Capability metadata unavailable/);
  assert.match(priceReport([], 'empty', [group, empty]), /Authorized groups \(1\)/);
});

test('report rounds binary display artifacts without changing pricing or inventing a request price', () => {
  const original = { ...model, pricing: { ...pricing, output: 4.050000000000001 } };
  const report = priceReport([{ entry: original }]);
  assert.match(report, /output 4.05, cache read/);
  assert.match(report, /request unknown/);
  assert.match(report, /Read-only; not registered/);
  assert.ok(!report.includes('Select using native /model'));
  assert.equal(original.pricing.output, 4.050000000000001);
  const request = priceReport([{ entry: { ...model, pricing: { ...pricing, unit: 'request', request: 0.324 } } }]);
  assert.match(request, /request 0.324; token rates are not provided/);
});

test('accepts a dynamic estimate as native cost while retaining its estimate basis', () => {
  const result = parseCatalog({ ...catalog, models: [{ ...model, pricing: { ...pricing, price_basis: 'dynamic_estimate' } }] }, catalog.resource, 'group:ZGVmYXVsdA');
  assert.equal(result.models[0]!.pricing.price_basis, 'dynamic_estimate');
  assert.equal(result.models[0]!.native_cost?.input, 1);
});
