import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LmmHttp } from '../src/http.ts';

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
