import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAssistantMessageEventStream,
  type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream,
  type Model, type ProviderStreamOptions, type ProviderStreams,
} from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { Admission } from '../src/catalog.ts';
import { LmmHttp } from '../src/http.ts';
import { createRelay } from '../src/stream.ts';
import type { LmmApi } from '../src/protocol.ts';

const issuer = 'https://api.lmm.best';
const endpoint = `${issuer}/v1/chat/completions`;
const cost = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 };
const model: Model<LmmApi> = {
  id: 'default / retry-fixture', name: 'retry-fixture', provider: 'lmm', api: 'openai-completions',
  baseUrl: `${issuer}/v1`, reasoning: false, input: ['text'], cost, contextWindow: 4096, maxTokens: 1024,
};
const admission: Admission = {
  model,
  entry: {
    id: 'fixture', group_id: 'ZGVmYXVsdA', group: 'default', upstream_model: 'retry-fixture', name: 'retry-fixture',
    apis: ['openai-completions'], native_cost: cost,
    pricing: {
      currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates',
      group_multiplier: 1, trust_multiplier: 1, input: 1, output: 2, cache_read: 0.25, cache_write: 1.25,
      request: null, final_cost_depends_on_usage: true, updated_at: 1,
    },
  },
};

function message(stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: 'wire-provider', model: 'retry-fixture',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, errorMessage, timestamp: 1,
  };
}

function success(): AssistantMessageEventStream {
  const source = createAssistantMessageEventStream();
  source.push({ type: 'done', reason: 'stop', message: message() });
  return source;
}

type Factory = (attempt: number, options: ProviderStreamOptions) => AssistantMessageEventStream;
function harness(factory: Factory, requestFetch: typeof fetch = async () => new Response(null)) {
  let attempts = 0;
  let finishes = 0;
  let resolveFinish!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinish = resolve; });
  const dispatch: ProviderStreams['stream'] = (_model, _context, options) => {
    attempts += 1;
    assert.equal(options?.maxRetries, 0, 'SDK retries must not multiply relay attempts');
    return factory(attempts, { ...options });
  };
  const adapter: ProviderStreams = { stream: dispatch, streamSimple: dispatch };
  const relay = createRelay(new LmmHttp({ fetch: requestFetch }), {
    lookup: () => admission,
    onFinish: async () => { finishes += 1; resolveFinish(); },
  }, { 'openai-completions': adapter, 'openai-responses': adapter, 'anthropic-messages': adapter });
  return { relay, finished, get attempts() { return attempts; }, get finishes() { return finishes; } };
}

async function collect(h: ReturnType<typeof harness>, signal?: AbortSignal, simple = true) {
  const output = (simple ? h.relay.streamSimple : h.relay.stream)(model, normalizeContext({ messages: [] }), {
    headers: { authorization: 'Bearer lmm_at_retry_fixture' }, signal,
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of output) events.push(event);
  return { events, result: await output.result() };
}

/** Deliberately discard HTTP metadata as SDK error events sometimes do. */
const fromHttp: Factory = (_attempt, options) => {
  const source = createAssistantMessageEventStream();
  void (async () => {
    try {
      const response = await options.fetch!(endpoint, { signal: options.signal });
      await response.body?.cancel();
      if (response.ok) source.push({ type: 'done', reason: 'stop', message: message() });
      else source.push({ type: 'error', reason: 'error', error: message('error', 'provider secret lmm_at_DO_NOT_PRINT') });
    } catch (error) {
      source.push({ type: 'error', reason: 'error', error: message('error', String(error)) });
    }
  })();
  return source;
};

for (const simple of [false, true]) {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    test(`${simple ? 'simple' : 'full'} relay does not replay HTTP ${status}`, { timeout: 2000 }, async () => {
      let calls = 0;
      const h = harness(fromHttp, async () => new Response(null, {
        status: (++calls, status), headers: { 'retry-after': '0' },
      }));
      const { result, events } = await collect(h, undefined, simple);
      assert.equal(result.stopReason, 'error');
      assert.equal(calls, 1);
      assert.equal(h.attempts, 1);
      assert.deepEqual(events.map((event) => event.type), ['error']);
      await h.finished;
      assert.equal(h.finishes, 1, 'balance refresh runs once for the whole logical request');
    });
  }
}

test('a failed HTTP request is reported once and redacted', { timeout: 2000 }, async () => {
  const h = harness(fromHttp, async () => new Response(null, { status: 503, headers: { 'retry-after': '0' } }));
  const { result, events } = await collect(h);
  assert.equal(h.attempts, 1);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /HTTP 503/);
  assert.doesNotMatch(JSON.stringify(events), /DO_NOT_PRINT/);
});

for (const status of [400, 401, 403, 404, 409, 422, 501]) {
  test(`nontransient HTTP ${status} is not retried`, async () => {
    const h = harness(fromHttp, async () => new Response(null, { status, headers: { 'retry-after': '0' } }));
    assert.equal((await collect(h)).result.stopReason, 'error');
    assert.equal(h.attempts, 1);
  });
}

test('a long Retry-After is not shortened into an early request', { timeout: 1000 }, async () => {
  const h = harness(fromHttp, async () => new Response(null, { status: 503, headers: { 'retry-after': '61' } }));
  assert.equal((await collect(h)).result.stopReason, 'error');
  assert.equal(h.attempts, 1);
});

test('response-body decode exceptions before the first event are not replayed', { timeout: 2000 }, async () => {
  const h = harness((_attempt, options) => {
    const source = createAssistantMessageEventStream();
    source[Symbol.asyncIterator] = async function* () {
      const response = await options.fetch!(endpoint);
      await response.body?.cancel();
      // Yield nothing: fetch succeeded, but body decoding failed before start.
      throw new TypeError('Transport error: error decoding response body');
    };
    return source;
  }, async () => new Response(null, { headers: { 'retry-after': '0' } }));
  assert.equal((await collect(h)).result.stopReason, 'error');
  assert.equal(h.attempts, 1);
});

test('synchronous adapter failures are not replayed', { timeout: 2000 }, async () => {
  const h = harness(() => { throw new TypeError('fetch failed'); });
  assert.equal((await collect(h)).result.stopReason, 'error');
  assert.equal(h.attempts, 1);
});

for (const kind of ['start', 'text_delta'] as const) {
  for (const thrown of [false, true]) {
    test(`${kind} prevents replay after a ${thrown ? 'thrown' : 'provider-event'} failure and preserves partial output`, async () => {
      const partial = message();
      partial.content = [{ type: 'text', text: 'already billed' }];
      partial.usage.output = 2;
      const first: AssistantMessageEvent = kind === 'start'
        ? { type: 'start', partial }
        : { type: 'text_delta', contentIndex: 0, delta: 'already billed', partial };
      const h = harness(() => {
        const source = createAssistantMessageEventStream();
        if (thrown) {
          source[Symbol.asyncIterator] = async function* () {
            yield first;
            throw new TypeError('error decoding response body');
          };
        } else {
          source.push(first);
          source.push({ type: 'error', reason: 'error', error: { ...partial, stopReason: 'error', errorMessage: 'network disconnected' } });
        }
        return source;
      });
      const { result } = await collect(h);
      assert.equal(h.attempts, 1);
      assert.equal(result.stopReason, 'error');
      assert.deepEqual(result.content, partial.content);
      assert.equal(result.usage.output, 2);
      assert.match(result.errorMessage!, /not replayed/);
    });
  }
}

test('an already cancelled request never constructs a provider stream', async () => {
  const h = harness(() => success());
  const { result } = await collect(h, AbortSignal.abort());
  assert.equal(h.attempts, 0);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(h.finishes, 0);
});

test('an aborted provider error is not retried even if its text looks transient', async () => {
  const h = harness(() => {
    const source = createAssistantMessageEventStream();
    source.push({ type: 'error', reason: 'aborted', error: message('error', '503 network disconnected') });
    return source;
  });
  const { result } = await collect(h);
  assert.equal(h.attempts, 1);
  assert.equal(result.stopReason, 'aborted');
});

test('a Retry-After response is not replayed when automatic retries are disabled', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const h = harness(fromHttp, async () => new Response(null, { status: 503, headers: { 'retry-after': '60' } }));
  assert.equal((await collect(h, controller.signal)).result.stopReason, 'error');
  assert.equal(h.attempts, 1);
  await h.finished;
  assert.equal(h.finishes, 1);
});

test('cancellation is propagated to an in-flight fetch', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  const h = harness(fromHttp, async (_input, init) => {
    observedSignal = init?.signal;
    assert.ok(observedSignal);
    return await new Promise<Response>((_resolve, reject) => {
      observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), { once: true });
      controller.abort();
    });
  });
  assert.equal((await collect(h, controller.signal)).result.stopReason, 'aborted');
  assert.equal(observedSignal?.aborted, true);
  assert.equal(h.attempts, 1);
});
