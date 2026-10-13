import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from '../src/http.ts';
import { RemoteClient } from '../src/remote-client.ts';
import { registerRemoteControl } from '../src/remote-control.ts';
import { readRemoteStream, REMOTE_FRAME_BYTES, REMOTE_STREAM_WATCHDOG_MS } from '../src/remote-stream.ts';
import { deriveRemoteKey, encryptRemote, remoteAad, remoteId } from '../src/remote-wire.ts';
import { remoteFixture, until } from './remote-fixture.mjs';

const frame = (name, data) => `event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const clientFor = (fixture, extra = {}) => new RemoteClient({
  http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true }),
  getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({}), onCommand: () => {}, ...extra,
});
async function envelope(client, sequence, input = {}) {
  const key = await deriveRemoteKey(client.pin, client.sessionId);
  return { sequence, sender: 'controller', created_at: Math.floor(Date.now() / 1000),
    ...await encryptRemote(key, { type: 'command', version: 1, id: remoteId(), issued_at: Date.now(), action: 'abort', ...input },
      remoteAad(client.sessionId, 'message', 'controller')) };
}

test('SSE first ready carries race-free backlog, UTF-8/CRLF chunking and bounded bursts ignore foreign/malformed entries', async () => {
  const fixture = await remoteFixture({ neverReady: true });
  const received = [];
  const client = clientFor(fixture, { onCommand: (value) => received.push(value) });
  const starting = client.start().catch((error) => error);
  try {
    await until(() => fixture.streams.size === 1);
    assert.equal(client.isConnected, false, 'HTTP headers and PUT do not imply readiness');
    const generation = fixture.sessions.get(client.sessionId).generation;
    const valid = await envelope(client, 1, { action: 'prompt', content: '汉字 😀' });
    const bytes = Buffer.from(frame('ready', { generation, messages: [valid] }));
    fixture.raw(client.sessionId, [...bytes].map((byte) => Buffer.from([byte])));
    assert.equal(await starting, undefined);
    assert.equal(received[0].content, '汉字 😀');
    const later = await envelope(client, 2);
    fixture.emit(client.sessionId, 'messages', { generation, messages: [
      { sequence: Number.MAX_SAFE_INTEGER, sender: 'controller', nonce: '!', ciphertext: '!' },
      { sequence: 900, sender: 'foreign' }, null, { sequence: '3' }, later,
    ] });
    await until(() => received.length === 2);
    const burst = await Promise.all(Array.from({ length: 30 }, (_, index) => envelope(client, index + 3)));
    fixture.emit(client.sessionId, 'messages', { generation, messages: burst });
    await until(() => received.length === 32);
    fixture.emit(client.sessionId, 'messages', { generation, messages: [later, ...burst] });
    await delay(50); assert.equal(received.length, 32);
    assert.equal(fixture.requests.filter((request) => request.path.endsWith('/messages') && request.method === 'GET').length, 0);
  } finally { await client.stop(); await fixture.close(); }
});

test('lease reconnect refreshes credentials and uses cursor/generation; generation reset preserves replay IDs', async () => {
  const fixture = await remoteFixture({ leaseMs: 200 });
  let authReads = 0;
  const received = [];
  const client = clientFor(fixture, { heartbeatMs: 80, getAccessToken: async () => { authReads++; return 'lmm_at_fixture'; }, onCommand: (value) => received.push(value) });
  try {
    await client.start();
    const first = await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await until(() => received.length === 1);
    await until(() => fixture.requests.filter((request) => request.path.endsWith('/events')).length === 2);
    const reconnect = fixture.requests.filter((request) => request.path.endsWith('/events'))[1];
    assert.match(reconnect.query, /after=1/); assert.ok(authReads >= 3);
    const beforeGeneration = fixture.sessions.get(client.sessionId).generation;
    fixture.restart();
    await until(() => fixture.sessions.has(client.sessionId));
    await until(() => fixture.streams.size === 1);
    assert.notEqual(fixture.sessions.get(client.sessionId).generation, beforeGeneration);
    await fixture.command(client.sessionId, client.pin, first);
    await fixture.command(client.sessionId, client.pin, { action: 'prompt', content: 'new generation' });
    await until(() => received.length === 2);
    assert.equal(received[1].content, 'new generation');
    assert.equal(client.isConnected, true);
  } finally { await client.stop(); await fixture.close(); }
});

for (const status of [404, 405, 501, 200]) {
  test(`unsupported event endpoint ${status} stops once with a clear local warning`, async () => {
    const states = []; const methods = [];
    const http = new LmmHttp({ fetch: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'GET') return new Response('legacy', { status, headers: { 'content-type': 'application/json' } });
      return Response.json({ success: true });
    } });
    const client = new RemoteClient({ http, getAccessToken: async () => 'fixture-token', metadata: () => ({}), onCommand: () => {}, onStatus: (...args) => states.push(args) });
    await assert.rejects(client.start());
    assert.equal(client.active, false); assert.equal(client.isConnected, false);
    assert.equal(states.some(([state]) => state === 'connected'), false);
    assert.match(states.find(([state]) => state === 'stopped')[1], /event-stream relay.*polling fallback is disabled/);
    await Promise.all([client.stop(), client.stop()]);
    assert.equal(methods.filter((method) => method === 'GET').length, 1);
    assert.equal(methods.filter((method) => method === 'DELETE').length, 1);
  });
}

for (const limited of [false, true]) {
  test(`bounded startup rejects ${limited ? '429 without early retry' : 'headers without ready'} and suppresses late callbacks`, async () => {
    const fixture = await remoteFixture({ neverReady: true });
    if (limited) fixture.setEventStatus(429);
    const states = [];
    const client = clientFor(fixture, { http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true, timeoutMs: 300 }), onStatus: (...args) => states.push(args) });
    try {
      await assert.rejects(client.start());
      assert.equal(client.active, false);
      const count = states.length;
      fixture.emit(client.sessionId, 'ready', { generation: 'late', messages: [] });
      await client.stop(); await delay(50);
      assert.equal(states.length, count); assert.equal(client.isConnected, false);
      assert.equal(fixture.requests.filter((request) => request.path.endsWith('/events')).length, 1);
    } finally { await client.stop(); await fixture.close(); }
  });
}

test('incoming failures do not block reporting; stopping cancels the reader and rejects pending auth without late callbacks', async () => {
  const fixture = await remoteFixture();
  const states = []; let blockAuth = false;
  const client = clientFor(fixture, { getAccessToken: () => blockAuth ? new Promise(() => {}) : Promise.resolve('lmm_at_fixture'), onStatus: (...args) => states.push(args) });
  try {
    await client.start(); fixture.endStreams();
    client.publish({ type: 'assistant', content: 'outbound independent' });
    await until(async () => (await fixture.events(client.sessionId, client.pin)).some((event) => event.content === 'outbound independent'));
    blockAuth = true;
    await delay(1_200); // Reconnect is now awaiting auth, not blocking the outbound loop.
    const stopping = client.stop();
    await Promise.race([stopping, delay(1_000).then(() => { throw new Error('stop did not cancel pending auth'); })]);
    const count = states.length; await delay(50); assert.equal(states.length, count);
    assert.equal(client.pendingCount, 0); assert.equal(client.active, false);
  } finally { await client.stop(); await fixture.close(); }
});

for (const fresh of ['new-token', 'old-token', undefined, 'account-changed']) {
  test(`stream unauthorized permits one different same-account token only: ${fresh}`, async () => {
    const tokens = []; let expired = false; let refreshReads = 0;
    let controller;
    const http = new LmmHttp({ fetch: async (url, init) => {
      if (init.method !== 'GET') return Response.json({ success: true });
      const token = init.headers.authorization; tokens.push(token);
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
      assert.ok(!url.includes('token') && !url.includes('Bearer'));
      if (token === 'Bearer old-token' && expired) return new Response(null, { status: 401 });
      return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(Buffer.from(frame('ready', { generation: 'same-generation', messages: [] }))); } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const client = new RemoteClient({ http, getAccessToken: async () => {
      if (!expired) return 'old-token';
      refreshReads++;
      if (fresh === 'account-changed') throw new Error('fixture account binding rejected');
      return fresh;
    }, metadata: () => ({}), onCommand: () => {} });
    try {
      await client.start(); expired = true;
      controller.enqueue(Buffer.from(frame('error', { code: 'unauthorized' })));
      if (fresh === 'new-token') {
        await until(() => tokens.length === 2);
        assert.deepEqual(tokens, ['Bearer old-token', 'Bearer new-token']);
        assert.equal(client.active, true); assert.equal(client.isConnected, true);
        // Revocation of the refreshed grant must not spin even with the same token.
        controller.enqueue(Buffer.from(frame('error', { code: 'unauthorized' })));
        await until(() => !client.active); assert.equal(tokens.length, 2);
      } else { await until(() => !client.active); assert.equal(tokens.length, 1); }
      assert.ok(refreshReads <= 2);
    } finally { await client.stop(); }
  });
}

test('SSE parser bounds frames/lines and rejects malformed UTF-8 while cancelling readers', async () => {
  for (const bytes of [Buffer.alloc(REMOTE_FRAME_BYTES + 1, 65), Buffer.from('data:\n'.repeat(4097)), Buffer.from([0xff])]) {
    let cancelled = false;
    const http = new LmmHttp({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
    await assert.rejects(readRemoteStream(http, '/fixture/events', 'fixture-token', new AbortController().signal, async () => false));
    assert.equal(cancelled, true);
  }
});

test('HTTP JSON error bodies are bounded and cancelled without losing unauthorized/rate-limit classification', async () => {
  for (const status of [401, 429, 503]) {
    let cancelled = false;
    const http = new LmmHttp({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(64_001, 65)); }, cancel() { cancelled = true; } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '45' } }) });
    await assert.rejects(http.request('/fixture'), (error) => error.code === (status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'upstream_unavailable'));
    assert.equal(cancelled, true);
  }
});

test('stream HTTP 401 retries exactly once with freshly resolved different access', async () => {
  let reads = 0; const used = [];
  const http = new LmmHttp({ fetch: async (_url, init) => {
    if (init.method !== 'GET') return Response.json({ success: true });
    used.push(init.headers.authorization);
    if (used.length === 1) return new Response(null, { status: 401 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame('ready', { generation: 'fresh', messages: [] }))); } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const client = new RemoteClient({ http, getAccessToken: async () => ++reads <= 2 ? 'expired' : 'fresh', metadata: () => ({}), onCommand: () => {} });
  try {
    await client.start();
    assert.deepEqual(used, ['Bearer expired', 'Bearer fresh']);
    assert.equal(client.isConnected, true);
  } finally { await client.stop(); }
});

test('ready disarms the HTTP handshake timeout but a silent body hits the independent keepalive watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let accepted; const ready = new Promise((resolve) => { accepted = resolve; });
  let cancelled = false;
  const http = new LmmHttp({ timeoutMs: 100, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(frame('ready', { generation: 'watchdog', messages: [] }))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = readRemoteStream(http, '/fixture/events', 'fixture-token', new AbortController().signal, async () => { accepted(); return true; }).catch((error) => error);
  await ready;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(101); await Promise.resolve();
  assert.equal(cancelled, false, 'stream lifetime is not the ordinary HTTP timeout');
  t.mock.timers.tick(REMOTE_STREAM_WATCHDOG_MS);
  assert.ok(await pending instanceof Error); assert.equal(cancelled, true);
});

test('callback promises never block command receive; local exceptions cannot leak credentials or break delivery', async () => {
  const fixture = await remoteFixture(); const received = [];
  const client = clientFor(fixture, { onCommand: (command) => {
    received.push(command);
    if (command.action === 'prompt') return new Promise(() => {});
    throw new Error('private-local-error');
  }, onStatus: () => Promise.reject(new Error('private-status-error')) });
  try {
    await client.start();
    await fixture.command(client.sessionId, client.pin, { action: 'prompt', content: 'pending model turn' });
    await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await fixture.command(client.sessionId, client.pin, { action: 'ui_response', request_id: remoteId(), value: true });
    await until(() => received.length === 3, 1_000);
    assert.deepEqual(received.map((command) => command.action), ['prompt', 'abort', 'ui_response']);
    assert.equal(client.isConnected, true);
  } finally { await client.stop(); await fixture.close(); }
});

test('Pi proactive callbacks coalesce trailing message updates and flush final output without a session scan', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'pi-sse-callback-'));
  const fixture = await remoteFixture(); const handlers = new Map(); const notices = [];
  const integration = { http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true }),
    resolveRemoteAuth: async () => ({ session: 'same-owner', value: { auth: { headers: { authorization: 'Bearer lmm_at_fixture' } } } }) };
  const pi = { on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, sendUserMessage() {} };
  const ctx = { hasUI: true, cwd: '/local-fixture', model: { provider: 'non-lmm', id: 'fixture', input: ['text'] },
    modelRegistry: { getProviderAuth() {} }, ui: { notify(message) { notices.push(message); }, setStatus() {} },
    sessionManager: new Proxy({}, { get() { throw new Error('session manager must not be scanned'); } }), abort() {}, isIdle: () => true };
  try {
    const path = join(temp, 'settings.json'); await writeFile(path, '{"enabled":true}');
    registerRemoteControl(pi, integration, path);
    assert.equal(fixture.requests.length, 0, 'factory starts no transport resources');
    await handlers.get('session_start')({}, ctx);
    const pin = notices.find((notice) => notice.includes('PIN:')).match(/PIN: (\S+)/)[1];
    const id = [...fixture.sessions.keys()][0];
    handlers.get('message_start')({});
    handlers.get('message_update')({ message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } });
    handlers.get('message_update')({ message: { role: 'assistant', content: [{ type: 'text', text: 'latest trailing' }] } });
    await until(async () => (await fixture.events(id, pin)).some((event) => event.content === 'latest trailing'), 1_000);
    handlers.get('message_update')({ message: { role: 'assistant', content: [{ type: 'text', text: 'not final' }] } });
    const start = Date.now();
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'final now' }] } });
    await until(async () => (await fixture.events(id, pin)).some((event) => event.content === 'final now'), 1_000);
    assert.ok(Date.now() - start < 500);
    await handlers.get('session_shutdown')({});
    const count = fixture.requests.length; await delay(300);
    assert.equal(fixture.requests.length, count, 'shutdown cancels trailing callbacks');
  } finally {
    await handlers.get('session_shutdown')?.({}); await fixture.close(); await rm(temp, { recursive: true, force: true });
  }
});
