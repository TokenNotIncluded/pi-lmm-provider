import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from '../src/http.ts';
import { RemoteClient } from '../src/remote-client.ts';
import { readRemoteStream } from '../src/remote-stream.ts';
import { remoteFixture, until } from './remote-fixture.mjs';

const frame = (generation, messages = []) => `event: ready\ndata: ${JSON.stringify({ generation, messages })}\n\n`;
const clientFor = (fixture, extra = {}) => new RemoteClient({
  http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true }),
  getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({}), onCommand: () => {}, ...extra,
});

test('default 30-second heartbeat renews registration before restart reconnect and preserves replay IDs', async () => {
  const fixture = await remoteFixture();
  const received = []; const states = []; let puts = 0; let first;
  const http = new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (init.method === 'PUT' && ++puts === 2) {
      await fixture.command(client.sessionId, client.pin, first);
      await fixture.command(client.sessionId, client.pin, { action: 'prompt', content: 'new generation backlog' });
    }
    return response;
  } });
  const client = clientFor(fixture, { http, onCommand: (value) => received.push(value), onStatus: (...args) => states.push(args) });
  try {
    await client.start();
    first = await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await until(() => received.length === 1);
    const oldGeneration = fixture.sessions.get(client.sessionId).generation;
    fixture.restart();
    // Catch-up exists before the new GET, rather than being pushed to an already open stream.
    await until(() => fixture.sessions.has(client.sessionId), 4_000);
    const session = fixture.sessions.get(client.sessionId);
    assert.notEqual(session.generation, oldGeneration);
    await until(() => received.length === 2 && client.isConnected, 4_000);
    assert.equal(received[1].content, 'new generation backlog');
    const transport = fixture.requests.filter((request) => request.method === 'PUT' || request.path.endsWith('/events'));
    assert.deepEqual(transport.map((request) => request.method), ['PUT', 'GET', 'PUT', 'GET']);
    assert.match(transport[3].query, /after=1/);
    assert.ok(!states.some(([state]) => state === 'stopped'));
    assert.equal(fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/messages')).length, 0);
    await delay(100);
    assert.equal(fixture.requests.filter((request) => request.method === 'PUT').length, 2, 'no heartbeat storm');
  } finally { await client.stop(); await fixture.close(); }
});

for (const stopDuringCooldown of [false, true]) {
  test(`registration renewal respects outbound hard cooldown and ${stopDuringCooldown ? 'abort stops the barrier' : 'completion priority/FIFO'}`, async () => {
    const fixture = await remoteFixture();
    const attempts = []; let posts = 0;
    const http = new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true, fetch: async (url, init) => {
      attempts.push({ method: init.method, url, time: Date.now() });
      if (init.method === 'POST' && ++posts === 1) return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
      return fetch(url, init);
    } });
    const client = clientFor(fixture, { http });
    try {
      await client.start();
      client.publish({ type: 'assistant', content: 'first FIFO' });
      await until(() => posts === 1);
      const limitedAt = attempts.find((entry) => entry.method === 'POST').time;
      fixture.restart();
      client.publish({ type: 'assistant', content: 'second FIFO' });
      client.publish({ type: 'state', state: 'complete' });
      await delay(1_250); // Receive is now waiting on registration, send remains in cooldown.
      assert.deepEqual(attempts.map((entry) => entry.method), ['PUT', 'GET', 'POST']);
      if (stopDuringCooldown) {
        await Promise.race([client.stop(), delay(500).then(() => { throw new Error('registration barrier blocked stop'); })]);
        const count = attempts.length;
        await delay(850);
        assert.equal(attempts.length, count, 'no late renewal/reconnect after abort');
        assert.equal(client.pendingCount, 0);
      } else {
        await until(() => client.isConnected && client.pendingCount === 0, 3_000);
        const renewal = attempts.filter((entry) => entry.method === 'PUT');
        assert.equal(renewal.length, 2);
        assert.ok(renewal[1].time - limitedAt >= 1_950, 'publish and reconnect cannot shorten Retry-After');
        const transport = attempts.filter((entry) => entry.method === 'PUT' || entry.method === 'GET');
        assert.deepEqual(transport.map((entry) => entry.method), ['PUT', 'GET', 'PUT', 'GET']);
        assert.deepEqual((await fixture.events(client.sessionId, client.pin)).map((event) => event.state ?? event.content), ['complete', 'first FIFO', 'second FIFO']);
        assert.equal(attempts.filter((entry) => entry.method === 'GET' && new URL(entry.url).pathname.endsWith('/messages')).length, 0);
      }
    } finally { await client.stop(); await fixture.close(); }
  });
}

test('failed renewal PUT waits through Retry-After before reopening events', async () => {
  const fixture = await remoteFixture(); const attempts = []; let puts = 0;
  const http = new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true, fetch: async (url, init) => {
    attempts.push({ method: init.method, time: Date.now() });
    if (init.method === 'PUT' && ++puts === 2) return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
    return fetch(url, init);
  } });
  const client = clientFor(fixture, { http });
  try {
    await client.start(); fixture.restart();
    await until(() => puts === 2, 2_000);
    client.publish({ type: 'assistant', content: 'waiting for renewed registration' });
    await delay(1_100);
    assert.deepEqual(attempts.map((entry) => entry.method), ['PUT', 'GET', 'PUT']);
    await until(() => client.isConnected && client.pendingCount === 0, 3_000);
    const renewals = attempts.filter((entry) => entry.method === 'PUT');
    assert.equal(renewals.length, 3);
    assert.ok(renewals[2].time - renewals[1].time >= 1_950);
    assert.deepEqual(attempts.filter((entry) => entry.method !== 'POST').map((entry) => entry.method), ['PUT', 'GET', 'PUT', 'PUT', 'GET']);
  } finally { await client.stop(); await fixture.close(); }
});

test('SSE 403 IP policy keeps existing HTTP classification without credential refresh or relogin', async () => {
  const states = []; let authReads = 0; let gets = 0;
  const http = new LmmHttp({ timeoutMs: 350, fetch: async (_url, init) => {
    if (init.method !== 'GET') return Response.json({ success: true });
    gets++;
    return Response.json({ error: { code: 'IP_ACCESS_ROUTE_REJECTED', message: 'private-token-secret' } }, { status: 403 });
  } });
  await assert.rejects(readRemoteStream(http, '/fixture/events', 'secret-token', new AbortController().signal, async () => false),
    (error) => error.code === 'ip_policy' && !/secret|login/i.test(error.message));
  gets = 0;
  const client = new RemoteClient({ http, getAccessToken: async () => { authReads++; return 'same-token'; }, metadata: () => ({}), onCommand: () => {}, onStatus: (...args) => states.push(args) });
  try {
    const starting = client.start().catch((error) => error);
    await until(() => gets === 1, 1_000);
    await delay(50);
    assert.equal(client.active, true, 'policy rejection is not a false auth terminal');
    assert.equal(authReads, 2, 'initial PUT and GET only, no credential refresh');
    assert.ok(!states.some(([, message]) => /login/i.test(message ?? '')));
    await client.stop(); await starting;
  } finally { await client.stop(); }
});

for (const transport of ['http', 'sse']) {
  test(`${transport} shares bounded error classification and cancels malformed, oversized and slow bodies`, async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [503, 'upstream_unavailable']]) {
      for (const bodyKind of ['credential', 'malformed', 'oversized', 'slow']) {
        let cancelled = false; let body;
        const http = new LmmHttp({ timeoutMs: 60, fetch: async () => {
          body = new ReadableStream({ start(controller) {
            if (bodyKind === 'credential') {
              controller.enqueue(Buffer.from(JSON.stringify({ error: { code: 'invalid_token', message: 'private-token-secret' } })));
              controller.close();
            } else if (bodyKind === 'malformed') controller.enqueue(Buffer.from('private-token-secret{not-json'));
            else if (bodyKind === 'oversized') controller.enqueue(Buffer.alloc(64_001, 65));
            // Slow includes headers but no body bytes, even when custom fetch ignores signal.
            if (bodyKind === 'malformed') controller.close();
          }, cancel() { cancelled = true; } });
          return new Response(body, { status, headers: { 'content-type': 'application/json', 'retry-after': '45' } });
        } });
        const began = Date.now();
        const pending = transport === 'http' ? http.request('/fixture') : readRemoteStream(http, '/fixture/events', 'secret-token', new AbortController().signal, async () => false);
        await assert.rejects(Promise.race([pending, delay(500).then(() => { throw new Error('unbounded error-body read'); })]),
          (error) => error.code === code && !/private|secret/.test(error.message) && (code !== 'rate_limited' || error.retryAfterMs === 45_000));
        assert.ok(Date.now() - began < 500);
        assert.equal(body.locked, false, 'error reader released');
        if (bodyKind === 'oversized' || bodyKind === 'slow') assert.equal(cancelled, true, 'pending reader cancelled');
      }
    }
  });
  test(`${transport} preserves nested and top-level IP policy precedence`, async () => {
    for (const payload of [{ error: { code: 'IP_ACCESS_ROUTE_REJECTED', message: 'private-token-secret' } }, { code: 'IP_ACCESS_ROUTE_REJECTED' }]) {
      const http = new LmmHttp({ fetch: async () => Response.json(payload, { status: 403 }) });
      await assert.rejects(transport === 'http' ? http.request('/fixture') : readRemoteStream(http, '/fixture/events', 'secret-token', new AbortController().signal, async () => false),
        (error) => error.code === 'ip_policy' && !/secret|private|login/i.test(error.message));
    }
  });
}

test('external abort cancels a pending failed SSE body and releases its reader', async () => {
  const abort = new AbortController(); let body; let cancelled = false;
  const http = new LmmHttp({ timeoutMs: 10_000, fetch: async () => {
    body = new ReadableStream({ cancel() { cancelled = true; } });
    return new Response(body, { status: 503, headers: { 'content-type': 'application/json' } });
  } });
  const pending = readRemoteStream(http, '/fixture/events', 'secret-token', abort.signal, async () => false);
  await until(() => body?.locked, 500);
  abort.abort();
  await assert.rejects(Promise.race([pending, delay(500).then(() => { throw new Error('abort did not cancel error read'); })]),
    (error) => error.code === 'upstream_unavailable');
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});

for (const status of [404, 405, 501]) {
  test(`unsupported HTTP ${status} after successful reconnect registration is still terminal`, async () => {
    let gets = 0; let puts = 0; let controller; const states = [];
    const http = new LmmHttp({ fetch: async (_url, init) => {
      if (init.method === 'PUT') { puts++; return Response.json({ success: true }); }
      if (init.method !== 'GET') return Response.json({ success: true });
      if (++gets > 1) return Response.json({ error: { code: 'fixture_unsupported' } }, { status });
      return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(Buffer.from(frame('initial'))); } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const client = new RemoteClient({ http, getAccessToken: async () => 'same-token', metadata: () => ({}), onCommand: () => {}, onStatus: (...args) => states.push(args) });
    try {
      await client.start(); controller.close();
      await until(() => !client.active, 2_500);
      assert.equal(puts, 2); assert.equal(gets, 2);
      assert.match(states.find(([state]) => state === 'stopped')[1], /event-stream relay.*polling fallback is disabled/);
      await delay(150); assert.equal(gets, 2, 'unsupported is not retried forever');
    } finally { await client.stop(); }
  });
}

for (const status of [401, 403]) {
  test(`actual credential HTTP ${status} remains terminal without different refreshed access`, async () => {
    const states = []; let gets = 0; let authReads = 0;
    const http = new LmmHttp({ fetch: async (_url, init) => {
      if (init.method !== 'GET') return Response.json({ success: true });
      gets++;
      return Response.json({ error: { code: 'invalid_token', message: 'private-token-secret' } }, { status });
    } });
    const client = new RemoteClient({ http, getAccessToken: async () => { authReads++; return 'same-token'; }, metadata: () => ({}), onCommand: () => {}, onStatus: (...args) => states.push(args) });
    try {
      await assert.rejects(client.start(), (error) => error.code === 'unauthorized');
      assert.equal(client.active, false); assert.equal(gets, 1); assert.equal(authReads, 3);
      assert.match(states.find(([state]) => state === 'stopped')[1], /login/);
      assert.ok(!states.some(([, message]) => /private|secret/i.test(message ?? '')));
    } finally { await client.stop(); }
  });
}
