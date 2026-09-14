import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { resolveKnownCapabilities } from '../src/capabilities.ts';
import type { CatalogEntry } from '../src/catalog.ts';

function entry(model: string, apis: CatalogEntry['apis'], group = 'default'): CatalogEntry {
  return { upstream_model: model, apis, group } as CatalogEntry;
}
test('exact known model and advertised protocol supply capabilities and a reference cost', () => {
  const result = resolveKnownCapabilities(entry('gpt-4o', ['openai-responses']));
  assert.ok(result);
  assert.equal(result.api, 'openai-responses');
  assert.ok(result.contextWindow > 0 && result.maxTokens > 0);
  assert.match(result.provenance, /openai\/gpt-4o$/);
  assert.ok(result.referenceCost && result.referenceCost.input >= 0);
});
test('unknown names, aliases and unadvertised vendor protocols remain unknown', () => {
  assert.equal(resolveKnownCapabilities(entry('gpt-4o-unverified-alias', ['openai-responses'])), undefined);
  assert.equal(resolveKnownCapabilities(entry('gpt-4o', ['anthropic-messages'])), undefined);
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
    { id: 'gemini-3.7-flash', levels: ['minimal', 'low', 'medium', 'high'] },
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
