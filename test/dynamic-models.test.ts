import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelsStoreEntry, RefreshModelsContext } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { LmmIntegration } from '../src/provider.ts';
import { base64url, type LmmCredential } from '../src/protocol.ts';

const issuer = 'https://api.lmm.best';
const group = 'fixture';
const groupId = base64url(group);
const upstream = 'FutureVendor/Novel_v7_2_flash';
const cost = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 };
const credential: LmmCredential = { type: 'oauth', access: 'lmm_at_fixture', refresh: 'fixture',
  expires: Date.now() + 3600000, lmm_issuer: issuer, lmm_resource: `${issuer}/api/oauth2`,
  lmm_session: 'fixture', scope: `catalog:read models:invoke group:${groupId}` };

function catalog(ids = [upstream]) {
  return { schema_version: 1, resource: `${issuer}/api/oauth2`, updated_at: 1,
    groups: [{ id: groupId, name: group, scope: `group:${groupId}`, multiplier: 1 }],
    models: ids.map((id) => ({ id: `lmm:${groupId}:${base64url(id)}`, group_id: groupId, group,
      upstream_model: id, name: id, apis: ['openai-completions'], native_cost: cost,
      pricing: { currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates',
        group_multiplier: 1, trust_multiplier: 1, input: 1, output: 2, cache_read: 0.25, cache_write: 1.25,
        request: null, final_cost_depends_on_usage: true, updated_at: 1 } })) };
}

function publicCatalog(ids = ['novel-v7.2-flash']) {
  return { futurevendor: { npm: '@ai-sdk/openai-compatible', models: Object.fromEntries(ids.map((id) => [id,
    { id, name: id.replaceAll('-', ' '), tool_call: true, reasoning: true,
      limit: { context: 160000, input: 128000, output: 16000 },
      modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 999, output: 999 } }])) } };
}

function context(allowNetwork: boolean, publish: RefreshModelsContext['publish'], stored?: ModelsStoreEntry): RefreshModelsContext {
  return { credential, allowNetwork, signal: new AbortController().signal, publish, stored };
}

test('a new normalized model appears in Pi and sends the original authorized LMM ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lmm-dynamic-'));
  let publicRequests = 0;
  let modelRequests = 0;
  const requestFetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url === 'https://models.dev/api.json') {
      publicRequests++;
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('cookie'), null);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      return Response.json(publicCatalog());
    }
    if (url === `${issuer}/api/oauth2/catalog`) return Response.json(catalog([upstream, 'unknown-model']));
    assert.equal(url, `${issuer}/v1/chat/completions`);
    modelRequests++;
    assert.equal(headers.get('authorization'), 'Bearer lmm_at_fixture');
    assert.equal(headers.get('x-lmm-group'), groupId);
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '')));
    assert.equal(body.model, upstream, 'metadata matching never rewrites the billable model ID');
    return new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  };
  const integration = new LmmIntegration({ fetch: requestFetch, metadataCacheDirectory: directory });
  try {
    let stored: ModelsStoreEntry | undefined;
    const publish: RefreshModelsContext['publish'] = async (update) => {
      update.update?.();
      if (update.persist) stored = update.persist;
      return true;
    };
    await integration.provider.refreshModels!(context(true, publish));
    const selected = integration.provider.getModels()[0]!;
    assert.equal(integration.provider.getModels().length, 1);
    assert.equal(selected.id, `${group} / ${upstream}`);
    assert.equal(selected.contextWindow, 128000);
    assert.equal(selected.maxTokens, 16000);
    assert.deepEqual(selected.cost, cost, 'models.dev prices do not replace LMM account rates');
    assert.equal(selected.reasoning, false, 'an unknown thinking protocol is not guessed');
    assert.match(integration.prices(), /1 selectable chat models, 1 read-only entries/);
    assert.match(integration.prices(), /unknown-model/);
    assert.equal(modelRequests, 0, 'discovery is free of inference requests');
    const auth = await integration.provider.auth.oauth!.toAuth(credential);
    const events = [];
    for await (const event of integration.provider.streamSimple!(selected,
      normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] }),
      { headers: auth.headers })) events.push(event);
    assert.ok(events.some((event) => event.type === 'done'));
    assert.equal(modelRequests, 1);
    await integration.provider.refreshModels!(context(true, publish));
    assert.equal(publicRequests, 1, 'normal discovery reuses fresh public metadata');
    assert.ok(stored);
    let offlineRequests = 0;
    const offline = new LmmIntegration({ metadataCacheDirectory: directory,
      fetch: async () => { offlineRequests++; throw new Error('offline'); } });
    try {
      await offline.provider.refreshModels!(context(false, async (update) => { update.update?.(); return true; }, stored));
      assert.equal(offline.provider.getModels()[0]?.id, selected.id);
      assert.equal(offlineRequests, 0, 'network-disabled restore reads only the public and account caches');
      await offline.provider.refreshModels!({ ...context(false, async (update) => { update.update?.(); return true; }, stored),
        credential: { ...credential, lmm_session: 'another-account-session' } });
      assert.equal(offline.provider.getModels().length, 0, 'public metadata cannot authorize another account');
    } finally { offline.dispose(); }
  } finally { integration.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('forced refresh discovers a newly published directory entry without reinstalling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lmm-new-model-'));
  let newer = false;
  let requests = 0;
  const integration = new LmmIntegration({ metadataCacheDirectory: directory, fetch: async (input) => {
    if (String(input) === 'https://models.dev/api.json') {
      requests++;
      return Response.json(publicCatalog(newer ? ['novel-v7.2-flash', 'novel-v8-pro'] : undefined));
    }
    assert.equal(String(input), `${issuer}/api/oauth2/catalog`);
    return Response.json(catalog([upstream, 'futurevendor/Novel V8 Pro']));
  } });
  const publish: RefreshModelsContext['publish'] = async (update) => { update.update?.(); return true; };
  try {
    await integration.provider.refreshModels!(context(true, publish));
    assert.equal(integration.provider.getModels().length, 1);
    newer = true;
    await integration.refreshMetadata();
    await integration.provider.refreshModels!(context(true, publish));
    assert.equal(integration.provider.getModels().length, 2);
    assert.equal(requests, 2);
  } finally { integration.dispose(); await rm(directory, { recursive: true, force: true }); }
});
