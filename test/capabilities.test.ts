import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { parseMetadataCatalog } from '../src/models-dev.ts';
import { resolveKnownCapabilities } from '../src/capabilities.ts';
import { admitCatalog, type Catalog, type CatalogEntry } from '../src/catalog.ts';

test('new SDK metadata fills absent Pi profiles conservatively', () => {
  for (const [suffix, npm, api] of [
    ['responses', '@ai-sdk/openai', 'openai-responses'],
    ['chat', '@ai-sdk/openai-compatible', 'openai-completions'],
    ['messages', '@ai-sdk/anthropic', 'anthropic-messages'],
  ] as const) {
    const id = `lmm-fixture-new-model-${suffix}`;
    const data = parseMetadataCatalog({ futurevendor: { npm, models: { [id]: {
      id, tool_call: true, reasoning: true, limit: { context: 128000, output: 16000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
    } } } }, '2026-11-04T00:00:00Z', '0'.repeat(64));
    const result = resolveKnownCapabilities(entry(id, [api]), data);
    assert.ok(result, id);
    assert.equal(result.api, api);
    assert.equal(result.contextWindow, 128000);
    assert.equal(result.maxTokens, 16000);
    assert.equal(result.reasoning, false);
    assert.deepEqual(result.input, ['text']);
    assert.equal(result.thinkingLevelMap, undefined);
    assert.equal(result.referenceCost, undefined, 'another provider price must not be selected');
    assert.match(result.provenance, /restricted text profile/);
    assert.equal('allowedFallbackModels' in result.compat, false);
  }
});

test('metadata keeps unknown variants and unadvertised protocols unavailable', () => {
  for (const [id, apis] of [
    ['MiniMax-M2', ['openai-responses']], ['gpt-5.6-alias', ['openai-responses']],
    ['gpt-image-2', ['openai-responses']],
  ] as const) assert.equal(resolveKnownCapabilities(entry(id, [...apis])), undefined, id);
});

test('metadata-only entries without a server cost remain read-only', () => {
  const id = 'lmm-fixture-unpriced-new-model';
  const data = parseMetadataCatalog({ futurevendor: { npm: '@ai-sdk/openai', models: { [id]: { id,
    reasoning: false, tool_call: true, limit: { context: 128000, output: 16000 },
    modalities: { input: ['text'], output: ['text'] },
  } } } }, '2026-11-04T00:00:00Z', '0'.repeat(64));
  const model = { ...entry(id, ['openai-responses']), native_cost: null };
  const admissions = admitCatalog({ models: [model] } as Catalog, 'https://issuer.invalid', (entry) => resolveKnownCapabilities(entry, data));
  assert.equal(admissions[0]?.model, undefined);
  assert.match(admissions[0]?.reason ?? '', /No native or reference cost/);
});

function entry(model: string, apis: CatalogEntry['apis'], group = 'default'): CatalogEntry {
  return { upstream_model: model, apis, group } as CatalogEntry;
}
test('exact known model and advertised protocol supply capabilities and a reference cost', () => {
  const result = resolveKnownCapabilities(entry('gpt-4o', ['openai-responses']));
  assert.ok(result);
  assert.equal(result.api, 'openai-responses');
  assert.ok(result.contextWindow > 0 && result.maxTokens > 0);
  assert.match(result.provenance, /openai\/gpt-4o; models.dev \(.+\) capacities$/);
  assert.ok(result.referenceCost && result.referenceCost.input >= 0);
});
test('unknown names, aliases and unadvertised vendor protocols remain unknown', () => {
  assert.equal(resolveKnownCapabilities(entry('gpt-4o-unverified-alias', ['openai-responses'])), undefined);
  assert.equal(resolveKnownCapabilities(entry('gpt-4o', ['anthropic-messages'])), undefined);
});
test('media models cannot bypass direct-vendor exclusions through Azure or Vertex', () => {
  for (const id of ['gpt-realtime-2.1', 'gemini-3.1-flash-lite-image', 'gpt-image-2']) {
    assert.equal(resolveKnownCapabilities(entry(id, ['openai-completions'])), undefined, id);
    assert.equal(resolveKnownCapabilities(entry(id, ['openai-responses'])), undefined, id);
  }
});

test('known input ceilings constrain selectable models without changing their vendor price', () => {
  const result = resolveKnownCapabilities(entry('gpt-6.1-sol', ['openai-completions']));
  assert.ok(result);
  assert.equal(result.contextWindow, 922000);
  assert.equal(result.maxTokens, 128000);
  const builtin = getBuiltinModels('openai').find((model) => model.id === 'gpt-6.1-sol');
  assert.equal(result.reasoning, builtin?.reasoning ?? false);
  assert.deepEqual(result.thinkingLevelMap, builtin?.thinkingLevelMap);
  assert.deepEqual(result.referenceCost, builtin?.cost);
});
test('native vendor fallbacks are removed from gateway capabilities', () => {
  const result = resolveKnownCapabilities(entry('claude-fable-5', ['anthropic-messages']));
  assert.ok(result);
  assert.equal('allowedFallbackModels' in result.compat, false);
});
test('known language models work over the gateway advertised OpenAI transport', () => {
  for (const id of ['gpt-5.6-sol', 'claude-sonnet-4-6', 'gemini-3.7-flash', 'glm-5.3']) {
    const result = resolveKnownCapabilities(entry(id, ['openai-completions']));
    assert.ok(result, id);
    assert.equal(result.api, 'openai-completions');
    assert.ok(result.contextWindow > 0 && result.maxTokens > 0);
  }
  const translated = resolveKnownCapabilities(entry('gpt-5.6-sol', ['openai-completions']))!;
  assert.equal(translated.reasoning, true);
  const translatedCompat = translated.compat as NonNullable<Model<'openai-completions'>['compat']>;
  assert.ok('supportsReasoningEffort' in translatedCompat && 'supportsStore' in translatedCompat);
  assert.equal(translatedCompat.supportsReasoningEffort, true);
  assert.equal(translatedCompat.supportsStore, false);
  assert.equal(translated.thinkingLevelMap?.medium, 'medium');
  assert.equal(resolveKnownCapabilities(entry('gpt-image-2', ['openai-completions'])), undefined);
});

test('preserves reasoning levels for OpenAI-compatible Astra gateway entries', () => {
  const result = resolveKnownCapabilities(entry('gpt-6-astra', ['openai-completions']));
  assert.ok(result);
  assert.equal(result.reasoning, true);
  assert.equal(result.api, 'openai-completions');
  const compat = result.compat as NonNullable<Model<'openai-completions'>['compat']>;
  assert.equal(compat.supportsReasoningEffort, true);
  assert.equal(result.thinkingLevelMap?.low, 'low');
  assert.equal(result.thinkingLevelMap?.medium, 'medium');
  assert.equal(result.thinkingLevelMap?.max, 'max');
});

test('preserves reasoning metadata for every supported gateway vendor protocol', () => {
  const cases = [
    { id: 'gpt-6-astra', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-4-6', levels: ['max'] },
    { id: 'gemini-3.7-flash', levels: ['low', 'medium', 'high'] },
    { id: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'o3', levels: ['low', 'medium', 'high'] },
  ] as const;

  for (const { id, levels } of cases) {
    const result = resolveKnownCapabilities(entry(id, ['openai-completions']));
    assert.ok(result, id);
    assert.equal(result.api, 'openai-completions', id);
    assert.equal(result.reasoning, true, id);
    const compat = result.compat as NonNullable<Model<'openai-completions'>['compat']>;
    assert.equal(compat.supportsReasoningEffort, true, id);
    for (const level of levels) assert.notEqual(result.thinkingLevelMap?.[level], null, `${id}:${level}`);
  }
});

test('keeps non-reasoning models disabled on the compatibility gateway', () => {
  const result = resolveKnownCapabilities(entry('gpt-5.6-sol', ['openai-completions']));
  assert.ok(result);
  assert.equal(result.reasoning, true);
  const nonReasoning = resolveKnownCapabilities(entry('gpt-4o', ['openai-completions']));
  assert.ok(nonReasoning);
  assert.equal(nonReasoning.reasoning, false);
  const nonReasoningCompat = nonReasoning.compat as NonNullable<Model<'openai-completions'>['compat']>;
  assert.equal(nonReasoningCompat.supportsReasoningEffort, false);
});
test('falls back to the complete official Pi catalog for exact model IDs', () => {
  for (const id of ['qwen3.5-plus', 'MiniMax-M2.5', 'codestral-latest', 'llama-3.3-70b-versatile']) {
    const result = resolveKnownCapabilities(entry(id, ['openai-completions']));
    assert.ok(result, id);
    assert.equal(result.api, 'openai-completions');
    assert.ok(result.contextWindow > 0 && result.maxTokens > 0);
  }
});

test('applies the reviewed DeepSeek proxy profile to GLM 5.3 in the domestic group', () => {
  const result = resolveKnownCapabilities(entry('glm-5.3-flash', ['openai-completions'], '国产[Kimi/Deepseek/GLM]'));
  assert.ok(result);
  const compat = result.compat as NonNullable<Model<'openai-completions'>['compat']>;
  assert.equal(compat.supportsLongCacheRetention, true);
  assert.equal(compat.sendSessionAffinityHeaders, true);
  assert.equal(compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(compat.thinkingFormat, 'deepseek');
});

test('enables cache retention and session affinity for domestic DeepSeek V4 gateways', () => {
  const result = resolveKnownCapabilities(entry('deepseek-v4-pro', ['openai-completions'], '国产[Kimi/Deepseek/GLM]'));
  assert.ok(result);
  const compat = result.compat as NonNullable<Model<'openai-completions'>['compat']>;
  assert.equal(compat.supportsLongCacheRetention, true);
  assert.equal(compat.sendSessionAffinityHeaders, true);
  assert.equal(compat.thinkingFormat, 'deepseek');
  assert.equal(compat.requiresReasoningContentOnAssistantMessages, true);
});

test('LMM chat gateway supplies affinity across vendor models without enabling long retention', () => {
  for (const id of ['gpt-6-astra', 'gpt-4o', 'claude-sonnet-4-6', 'gemini-3.7-flash']) {
    const result = resolveKnownCapabilities(entry(id, ['openai-completions'], 'GPT-Pro'));
    assert.ok(result, id);
    assert.equal(Reflect.get(result.compat, 'sendSessionAffinityHeaders'), true, id);
    assert.notEqual(Reflect.get(result.compat, 'supportsLongCacheRetention'), true, id);
  }
});


test('directory normalization and LMM gateway transport do not depend on a Pi model release', () => {
  for (const [id, api] of [
    ['GPT-5.6', 'openai-responses'], ['gpt-5.6', 'openai-completions'],
    ['google/gemini-4-argon', 'openai-completions'], ['OPENAI/GPT_4O', 'openai-completions'],
  ] as const) {
    const result = resolveKnownCapabilities(entry(id, [api]));
    assert.ok(result, id);
    assert.equal(result.api, api);
    assert.ok(result.contextWindow > 0 && result.maxTokens > 0);
  }
});
