import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from '../src/http.ts';
import { RemoteClient } from '../src/remote-client.ts';
import { remoteFixture, until } from './remote-fixture.mjs';

// These retain the initial dirty-worktree cooldown/wake protections, replacing
// obsolete polling cadence assertions with the event-stream contract.
test('remote stream respects a long Retry-After and can stop during pending startup cooldown', async () => {
  const methods = [];
  const http = new LmmHttp({ fetch: async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'GET') return new Response(null, { status: 429, headers: { 'retry-after': '45' } });
    return Response.json({ success: true, data: { generation: 'fixture' } });
  } });
  const client = new RemoteClient({ http, getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({}), onCommand: () => {} });
  const starting = client.start().catch((error) => error);
  try {
    await until(() => methods.includes('GET'));
    await delay(1_200);
    assert.deepEqual(methods, ['PUT', 'GET'], 'no requests or extra heartbeat during stream cooldown');
    const start = Date.now();
    await Promise.all([client.stop(), client.stop()]);
    assert.ok(Date.now() - start < 1_000, 'stop interrupts startup and cooldown');
    assert.ok(await starting instanceof Error);
    assert.equal(methods.filter((method) => method === 'DELETE').length, 1);
    assert.equal(client.active, false);
  } finally { await client.stop(); }
});

const makeClient = (fixture, extra = {}) => new RemoteClient({
  http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true }),
  getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({}), onCommand: () => {}, ...extra,
});
const legacyPolls = (fixture) => fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/messages'));
const opens = (fixture) => fixture.requests.filter((request) => request.path.endsWith('/events'));

test('idle remote session uses one open stream and zero GET messages', async () => {
  const fixture = await remoteFixture();
  const client = makeClient(fixture);
  try {
    await client.start();
    await delay(1_200);
    assert.equal(opens(fixture).length, 1);
    assert.equal(fixture.streams.size, 1);
    assert.equal(legacyPolls(fixture).length, 0);
  } finally { await client.stop(); await fixture.close(); }
});

test('outbound publication wakes immediate encrypted delivery without adding inbound requests', async () => {
  const fixture = await remoteFixture();
  const client = makeClient(fixture);
  try {
    await client.start();
    const start = Date.now();
    client.publish({ type: 'state', id: 'remote-state', busy: true });
    await until(() => fixture.requests.some((request) => request.method === 'POST'), 1_000);
    assert.ok(Date.now() - start < 500, 'publication does not wait for a three-second flush timer');
    for (let i = 0; i < 6; i++) {
      client.publish({ type: 'state', id: 'remote-state', busy: false }); await delay(30);
    }
    assert.equal(opens(fixture).length, 1);
    assert.equal(legacyPolls(fixture).length, 0);
    assert.ok((await fixture.events(client.sessionId, client.pin)).some((event) => event.busy === false));
  } finally { await client.stop(); await fixture.close(); }
});

test('heartbeats and plugin echoes cannot reopen an idle stream; commands arrive immediately', async () => {
  const fixture = await remoteFixture();
  const received = [];
  const client = makeClient(fixture, { heartbeatMs: 80, onCommand: (value) => received.push(value) });
  try {
    await client.start();
    client.publish({ type: 'state', id: 'remote-state', busy: true });
    await delay(1_400);
    assert.equal(opens(fixture).length, 1);
    assert.equal(legacyPolls(fixture).length, 0);
    assert.ok(fixture.requests.filter((request) => request.method === 'PUT').length > 5);
    await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await until(() => received.length === 1, 1_000);
    assert.equal(received[0].action, 'abort');
    assert.equal(opens(fixture).length, 1);
  } finally { await client.stop(); await fixture.close(); }
});

test('outbound 429 cooldown cannot be woken by publishers or heartbeats and does not block abort receive', async () => {
  const fixture = await remoteFixture();
  const received = [];
  const client = makeClient(fixture, { heartbeatMs: 80, onCommand: (value) => received.push(value) });
  try {
    await client.start(); fixture.setPostStatus(429);
    client.publish({ type: 'assistant', content: 'pending output' });
    await until(() => fixture.requests.some((request) => request.method === 'POST'));
    const puts = fixture.requests.filter((request) => request.method === 'PUT').length;
    for (let i = 0; i < 12; i++) { client.publish({ type: 'state', id: 'remote-state', busy: true }); await delay(20); }
    // Inject a real encrypted controller command without the POST failure policy.
    fixture.setPostStatus(200);
    await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await until(() => received.length === 1);
    await delay(1_200);
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 2, 'one rejected plugin POST plus the controller command, no cooldown retry');
    assert.equal(fixture.requests.filter((request) => request.method === 'PUT').length, puts);
    assert.equal(received[0].action, 'abort');
    assert.equal(legacyPolls(fixture).length, 0);
  } finally { await client.stop(); await fixture.close(); }
});
