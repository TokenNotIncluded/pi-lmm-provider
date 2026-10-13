import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from '../src/http.ts';
import { RemoteClient } from '../src/remote-client.ts';

test('remote loop respects a long Retry-After and can stop during cooldown', async () => {
  const methods = [];
  let limited = false;
  const http = new LmmHttp({ fetch: async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'GET') {
      limited = true;
      return new Response(null, { status: 429, headers: { 'retry-after': '45' } });
    }
    return Response.json({ success: true, data: { generation: 'fixture' } });
  } });
  const client = new RemoteClient({ http, getAccessToken: async () => 'lmm_at_fixture',
    metadata: () => ({}), onCommand: () => {}, pollMs: 10 });
  try {
    await client.start();
    for (let i = 0; i < 100 && !limited; i++) await delay(10);
    assert.equal(limited, true);
    await delay(1_200);
    assert.deepEqual(methods, ['PUT', 'GET'], 'no requests or extra heartbeat during cooldown');
    const start = Date.now();
    await client.stop();
    assert.ok(Date.now() - start < 1_000, 'stop interrupts the cooldown');
    assert.equal(client.active, false);
  } finally { await client.stop(); }
});

test('default polling does not issue a second GET every second', async () => {
  let polls = 0;
  const http = new LmmHttp({ fetch: async (_url, init) => {
    if (init.method === 'GET') polls++;
    return Response.json({ success: true, data: { generation: 'fixture', messages: [] } });
  } });
  const client = new RemoteClient({ http, getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({}), onCommand: () => {} });
  try {
    await client.start();
    await delay(1_200);
    assert.equal(polls, 1);
  } finally { await client.stop(); }
});
