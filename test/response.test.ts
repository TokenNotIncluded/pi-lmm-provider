import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import type { Admission } from '../src/catalog.ts';
import { LmmHttp } from '../src/http.ts';
import { createRelay } from '../src/stream.ts';
import { inspectResponse, diagnosticsReport, type DiagnosticMessage, type RelayDiagnostics } from '../src/response.ts';
import type { LmmApi } from '../src/protocol.ts';

const diagnostics = (): RelayDiagnostics => ({ requestedModel: 'gpt-6.1-sol', api: 'openai-completions', reportedModels: [], recoveredThinking: false });
const chunk = (content: string, extra: Record<string, unknown> = {}) => ({ model: 'gpt-6.1-sol', choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function response(raw: string, byteWidth = 1): Response {
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + byteWidth)); offset += byteWidth;
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
async function decode(raw: string, value = diagnostics(), byteWidth = 1) {
  const text = await inspectResponse(response(raw, byteWidth), value).text();
  const data = text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
  const deltas = data.flatMap((item) => item.choices ?? []).map((choice: { delta: Record<string, string> }) => choice.delta);
  return { value, text, data, answer: deltas.map((delta: Record<string, string>) => delta.content ?? '').join(''), thinking: deltas.map((delta: Record<string, string>) => delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text ?? '').join('') };
}

test('leading wrapper survives every opening/closing tag and UTF-8 network split', async () => {
  const text = '<thinking>查找题目</thinking>正文';
  for (let split = 0; split <= text.length; split++) {
    const result = await decode(frame(chunk(text.slice(0, split))) + frame(chunk(text.slice(split))) + 'data: [DONE]\n\n');
    assert.equal(result.answer, '正文');
    assert.equal(result.thinking, '查找题目');
    assert.equal(result.value.recoveredThinking, true);
  }
});

test('native reasoning coexists with recovered reasoning', async () => {
  const result = await decode(frame(chunk('<thinking>recovered</thinking>answer', { reasoning: 'native:' })) + 'data: [DONE]\n\n');
  assert.equal(result.thinking, 'native:recovered');
  assert.equal(result.answer, 'answer');
});

test('code fences, inline examples and nonmatching prefixes remain literal', async () => {
  for (const literal of ['```xml\n<thinking>example</thinking>\n```', 'Example: <thinking>x</thinking>', '<think>literal</think>', '<thought>literal</thought>', '<thi']) {
    const result = await decode([...literal].map((char) => frame(chunk(char))).join('') + 'data: [DONE]\n\n');
    assert.equal(result.answer, literal);
    assert.equal(result.thinking, '');
    assert.equal(result.value.recoveredThinking, false);
  }
});

test('unclosed thinking and partial closing tags are retained on clean EOF', async () => {
  const result = await decode(frame(chunk('<thinking>unfinished</thi')));
  assert.equal(result.thinking, 'unfinished</thi');
  assert.equal(result.answer, '');
});

test('tool-call transition flushes prefix and preserves tool arguments and usage', async () => {
  const tool = { index: 0, id: 'call1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } };
  const result = await decode(frame(chunk('<thi')) + frame({ choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 7 } }) + 'data: [DONE]\n\n');
  assert.equal(result.answer, '<thi');
  assert.deepEqual(result.data[1].choices[0].delta.tool_calls, [tool]);
  assert.deepEqual(result.data[1].usage, { total_tokens: 7 });
});

test('empty tool-call arrays do not finalize a split thinking wrapper', async () => {
  const result = await decode(frame(chunk('<thi', { tool_calls: [] })) + frame(chunk('nking>x</thi', { tool_calls: [] })) + frame(chunk('nking>answer', { tool_calls: [] })) + 'data: [DONE]\n\n');
  assert.equal(result.answer, 'answer');
  assert.equal(result.thinking, 'x');
  assert.equal(result.value.recoveredThinking, true);
  assert.ok(result.data.every((item) => item.choices.every((choice: { delta: Record<string, unknown> }) => Array.isArray(choice.delta.tool_calls))));
});

test('records declared names for all supported protocols without changing native text', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    const value = { ...diagnostics(), api };
    const raw = frame({ model: 'gpt-6.1-sol-snapshot', response: { model: 'response-model' }, message: { model: 'message-model' } });
    const result = await decode(raw, value);
    assert.equal(result.text, raw);
    assert.deepEqual(value.reportedModels, ['gpt-6.1-sol-snapshot', 'response-model', 'message-model']);
  }
});

test('missing names and bounded identifiers are explicit in diagnostics', async () => {
  const value = diagnostics();
  await decode(Array.from({ length: 12 }, (_, index) => frame({ model: `model-${index}` })).join('') + frame({ model: 'invalid\nname' }), value);
  assert.equal(value.reportedModels.length, 8);
  assert.match(diagnosticsReport(diagnostics()), /not reported/);
  assert.match(diagnosticsReport({ ...value, reasoningEffort: 'max' }), /Sent reasoning_effort: max/);
});

test('diagnostics omit obvious credential declarations while retaining model aliases', async () => {
  const value = diagnostics();
  const credentials = ['lmm_at_fixture_secret', 'lmm_rt_fixture_secret', 'sk-fixture_secret', 'sk_fixture_secret', 'Bearer lmm_at_fixture_secret', 'Authorization: Bearer fixture_secret', 'provider/sk-fixture_secret'];
  const aliases = ['gpt-6.1-sol-snapshot', 'anthropic/claude-opus-4-20260819', 'provider:model alias'];
  await decode([...credentials, ...aliases].map((model) => frame({ model, response: { model }, message: { model } })).join(''), value);
  assert.deepEqual(value.reportedModels, aliases);
  assert.doesNotMatch(diagnosticsReport(value), /fixture_secret/);
});

test('CRLF and multi-line SSE data preserve event metadata', async () => {
  const raw = 'event: chunk\r\nid: 1\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"<thinking>x</thinking>y"}}]}\r\n\r\n';
  const result = await decode(raw);
  assert.equal(result.answer, 'y');
  assert.equal(result.thinking, 'x');
  assert.match(result.text, /event: chunk\nid: 1/);
});

test('stream cancellation reaches the upstream reader', async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode(frame(chunk('hello')))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const reader = inspectResponse(upstream, diagnostics()).body!.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('real Pi adapter emits thinking events and persists actual request/declared response metadata', async () => {
  const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const model: Model<LmmApi> = { id: 'GPT-Pro / gpt-6.1-sol', name: 'test', provider: 'lmm', api: 'openai-completions', baseUrl: 'https://api.lmm.best/v1', reasoning: true, thinkingLevelMap: { max: 'max' }, compat: { supportsReasoningEffort: true }, input: ['text'], cost, contextWindow: 4096, maxTokens: 1024 };
  const admission: Admission = { model, entry: { id: 'fixture', group_id: 'ZGVmYXVsdA', group: 'GPT-Pro', upstream_model: 'gpt-6.1-sol', name: 'test', apis: ['openai-completions'], native_cost: cost, pricing: { currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates', group_multiplier: 1, trust_multiplier: 1, input: 1, output: 2, cache_read: 0, cache_write: 0, request: null, final_cost_depends_on_usage: true, updated_at: 1 } } };
  let requests = 0;
  const http = new LmmHttp({ fetch: async (_input, init) => {
    requests++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'gpt-6.1-sol');
    assert.equal(payload.reasoning_effort, 'max');
    return response([
      { model: 'gpt-6.1-sol-snapshot', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'native:' }, finish_reason: null }] },
      chunk('<thi'), chunk('nking>recovered</thin'), chunk('king>answer'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(frame).join('') + 'data: [DONE]\n\n', 17);
  } });
  const relay = createRelay(http, { lookup: () => admission, onFinish: async () => {} });
  const stream = relay.streamSimple(model, normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }), { headers: { authorization: 'Bearer lmm_at_fixture' }, reasoning: 'max' });
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result() as DiagnosticMessage;
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content.filter((block) => block.type === 'text').map((block) => block.text), ['answer']);
  assert.equal(result.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''), 'native:recovered');
  assert.ok(events.some((event) => event.type === 'thinking_delta'));
  assert.ok(events.some((event) => event.type === 'text_delta'));
  assert.equal(result.model, model.id);
  assert.equal(result.responseModel, 'gpt-6.1-sol-snapshot');
  assert.deepEqual(result.lmmDiagnostics, { requestedModel: 'gpt-6.1-sol', api: 'openai-completions', reasoningEffort: 'max', reportedModels: ['gpt-6.1-sol-snapshot', 'gpt-6.1-sol'], recoveredThinking: true });
  assert.equal(requests, 1);
});


test('oversized events pass through intact without unbounded buffering', async () => {
  const literal = 'a'.repeat(1_000_100);
  const raw = frame(chunk(literal));
  const result = await decode(raw, diagnostics(), 250_001);
  assert.equal(result.answer, literal);
});

test('oversized events stop recovery and preserve later answer text', async () => {
  const huge = frame(chunk('x'.repeat(1_500_100) + '</thinking>first answer'));
  const suffix = frame(chunk(' next answer <thinking>literal</thinking> 正文')) + 'data: [DONE]\n\n';
  const raw = frame(chunk('<thinking>small</thi')) + huge + suffix;
  for (const byteWidth of [100_001, new TextEncoder().encode(raw).length]) {
    const result = await decode(raw, diagnostics(), byteWidth);
    assert.equal(result.thinking, 'small</thi');
    assert.equal(result.answer, 'x'.repeat(1_500_100) + '</thinking>first answer next answer <thinking>literal</thinking> 正文');
    assert.ok(result.text.endsWith(huge + suffix));
    assert.equal(result.value.recoveredThinking, true);
  }
});

test('oversized fallback flushes an incomplete opening prefix before passing through', async () => {
  const result = await decode(frame(chunk('<thi')) + frame(chunk('nking>' + 'x'.repeat(1_500_100))) + 'data: [DONE]\n\n', diagnostics(), 100_001);
  assert.equal(result.answer, '<thinking>' + 'x'.repeat(1_500_100));
  assert.equal(result.thinking, '');
  assert.equal(result.value.recoveredThinking, false);
});

test('non-SSE responses are not consumed or replaced', () => {
  const upstream = new Response('plain response', { headers: { 'content-type': 'application/json' } });
  assert.equal(inspectResponse(upstream, diagnostics()), upstream);
  assert.equal(upstream.bodyUsed, false);
});
