import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import { applyModelMetadata } from '../src/capabilities.ts';
import { isExcludedModelMetadata, parseModelMetadata, resolveModelMetadata } from '../src/models-dev.ts';

const valid = { type: 'chat', tool_call: true, reasoning: true,
  limit: { context: 1050000, input: 922000, output: 128000 },
  modalities: { input: ['text', 'image', 'audio', 'pdf'], output: ['text'] } };

test('preserves known input ceilings and restricts inputs to Pi-supported modalities', () => {
  assert.deepEqual(parseModelMetadata(valid), { contextWindow: 922000, maxTokens: 128000,
    reasoning: true, input: ['text', 'image'] });
  assert.deepEqual(parseModelMetadata({ ...valid, type: undefined, limit: { context: 1000, output: 2000, input: 500 } }), undefined);
  assert.deepEqual(parseModelMetadata({ ...valid, limit: { context: 1000, output: 800, input: 500 } }),
    { contextWindow: 500, maxTokens: 500, reasoning: true, input: ['text', 'image'] });
  assert.equal(parseModelMetadata({ ...valid, type: undefined, limit: { context: 1000, output: 500 } })?.contextWindow, 1000);
});

test('non-chat, mixed-output, tool-less and incomplete profiles are never promoted to chat', () => {
  for (const type of ['image', 'video', 'embedding', 'reranking', 'decision', 'transcription', 'speech', 'realtime']) {
    assert.equal(parseModelMetadata({ ...valid, type }), undefined, type);
  }
  for (const output of [['image'], ['audio'], ['text', 'image'], ['text', 'audio'], []]) {
    assert.equal(parseModelMetadata({ ...valid, modalities: { ...valid.modalities, output } }), undefined);
  }
  for (const tool_call of [undefined, false, 'true']) assert.equal(parseModelMetadata({ ...valid, tool_call }), undefined);
  for (const reasoning of [undefined, 'true']) assert.equal(parseModelMetadata({ ...valid, reasoning }), undefined);
  for (const input of [null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '922000']) {
    assert.equal(parseModelMetadata({ ...valid, limit: { ...valid.limit, input } }), undefined, String(input));
  }
  assert.equal(parseModelMetadata({ ...valid, modalities: { input: ['image'], output: ['text'] } }), undefined);
});

test('metadata can narrow existing reasoning and vision but cannot add unverified transport support', () => {
  const builtin: Model<Api> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'openai',
    baseUrl: 'https://fixture.invalid', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, compat: { supportsReasoningEffort: false } };
  const metadata = parseModelMetadata(valid)!;
  const merged = applyModelMetadata(builtin, metadata);
  assert.equal(merged.reasoning, false);
  assert.deepEqual(merged.input, ['text']);
  assert.equal(merged.compat && 'supportsReasoningEffort' in merged.compat && merged.compat.supportsReasoningEffort, false);
  assert.deepEqual(merged.cost, builtin.cost);
  const disabled = applyModelMetadata({ ...builtin, reasoning: true, input: ['text', 'image'],
    thinkingLevelMap: { high: 'high' }, compat: { supportsReasoningEffort: true } },
  { ...metadata, reasoning: false, input: ['text'] });
  assert.equal(disabled.reasoning, false);
  assert.equal(disabled.thinkingLevelMap, undefined);
  assert.deepEqual(disabled.input, ['text']);
  assert.equal(disabled.compat && 'supportsReasoningEffort' in disabled.compat && disabled.compat.supportsReasoningEffort, false);
  assert.equal(builtin.contextWindow, 1000);
});

test('bundled metadata has exact provider/ID boundaries and immutable caller copies', () => {
  const metadata = resolveModelMetadata('openai', 'gpt-6.1-sol');
  assert.ok(metadata);
  metadata.contextWindow = 1;
  metadata.input.length = 0;
  assert.equal(resolveModelMetadata('openai', 'gpt-6.1-sol')?.contextWindow, 922000);
  for (const [provider, id] of [['google', 'gpt-6.1-sol'], ['openai', 'GPT-6.1-sol'],
    ['openai', 'gpt-6.1-sol-unverified'], ['__proto__', 'constructor']]) {
    assert.equal(resolveModelMetadata(provider!, id!), undefined);
  }
  assert.equal(isExcludedModelMetadata('openai', 'gpt-realtime-2.1'), true);
  assert.equal(isExcludedModelMetadata('google', 'gemini-3.1-flash-lite-image'), true);
  assert.equal(isExcludedModelMetadata('__proto__', 'constructor'), false);
});
