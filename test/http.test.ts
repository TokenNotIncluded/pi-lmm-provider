import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LmmHttp } from '../src/http.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const jsonTypes = [
  'application/json',
  'Application/JSON; charset=utf-8',
  'APPLICATION/JSON ; charset=UTF-8',
];

for (const contentType of jsonTypes) {
  test(`HTTP accepts case-insensitive JSON media type: ${contentType}`, async () => {
    const http = new LmmHttp({ fetch: async () => new Response('{"ok":true}', {
      headers: { 'content-type': contentType },
    }) });
    assert.deepEqual(await http.request('/fixture'), { ok: true });
  });

  test(`HTTP preserves IP-policy precedence for JSON media type: ${contentType}`, async () => {
    const http = new LmmHttp({ fetch: async () => new Response(JSON.stringify({
      error: { code: 'IP_ACCESS_ROUTE_REJECTED', message: 'private-upstream-details' },
    }), { status: 403, headers: { 'content-type': contentType } }) });
    await assert.rejects(http.request('/fixture'), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, 'ip_policy');
      assert.doesNotMatch(error.message, /private-upstream-details/);
      return true;
    });
  });
}

for (const contentType of ['text/plain', 'application/jsonp', 'application/problem+json']) {
  test(`HTTP rejects and cancels an unsupported successful response: ${contentType}`, async () => {
    let cancelled = false;
    const http = new LmmHttp({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': contentType } }) });
    await assert.rejects(http.request('/fixture'), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'invalid_response');
    assert.equal(cancelled, true, 'rejecting the media type must release the upstream body');
  });
}

test('HTTP cancels a stalled successful JSON body when the caller aborts', async () => {
  let startReading = () => {};
  const reading = new Promise<void>((resolve) => { startReading = resolve; });
  const abort = new AbortController();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    pull() { startReading(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const http = new LmmHttp({ fetch: async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }) });
  const settled = http.request('/fixture', { signal: abort.signal }).then(
    () => 'fulfilled',
    (error: unknown) => error,
  );
  await reading;
  abort.abort();
  try {
    const result = await Promise.race([settled, sleep(500).then(() => 'still waiting')]);
    assert.ok(result instanceof Error && 'code' in result, 'cancellation must settle the in-progress body read');
    assert.equal(result.code, 'aborted');
    assert.equal(cancelled, true, 'cancellation must release the upstream body');
  } finally {
    if (!cancelled) bodyController?.close();
    await settled;
  }
});

test('HTTP bounds successful JSON body reads by the request timeout', async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    cancel() { cancelled = true; },
  });
  const http = new LmmHttp({ timeoutMs: 20, fetch: async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }) });
  const settled = http.request('/fixture').then(() => 'fulfilled', (error: unknown) => error);
  try {
    const result = await Promise.race([settled, sleep(500).then(() => 'still waiting')]);
    assert.ok(result instanceof Error && 'code' in result, 'the request timeout must settle stalled successful bodies');
    assert.equal(result.code, 'aborted');
    assert.equal(cancelled, true);
  } finally {
    if (!cancelled) bodyController?.close();
    await settled;
  }
});

test('HTTP rejects a response when cancellation races the final successful read', async () => {
  const abort = new AbortController();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      } else {
        controller.close();
        abort.abort();
      }
    },
  }, { highWaterMark: 0 });
  const http = new LmmHttp({ fetch: async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }) });
  await assert.rejects(http.request('/fixture', { signal: abort.signal }), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'aborted');
});
