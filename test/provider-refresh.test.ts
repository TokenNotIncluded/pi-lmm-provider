import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createModels, type Credential, type OAuthCredential, type RefreshModelsContext } from '@earendil-works/pi-ai';
import { LmmIntegration } from '../src/provider.ts';

const issuer = 'https://api.lmm.best';
const groupId = 'ZGVmYXVsdA';
const scope = `catalog:read balance:read usage:read models:invoke group:${groupId}`;
const modelId = `lmm:${groupId}:Z3B0LTRvLW1pbmk`;
const catalog = (resource: string) => ({ schema_version: 1, resource, updated_at: 1789240000,
  groups: [{ id: groupId, name: 'default', scope: `group:${groupId}`, multiplier: 1 }],
  models: [{ id: modelId, group_id: groupId, group: 'default', upstream_model: 'gpt-4o-mini', name: 'default / gpt-4o-mini', apis: ['openai-completions'],
    pricing: { currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates', group_multiplier: 1, trust_multiplier: 1, input: 1, output: 2, cache_read: 0, cache_write: 0, request: null, final_cost_depends_on_usage: true, updated_at: 1789240000 },
    native_cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }], });
function value(access: string, refresh: string, session = 'session'): OAuthCredential { return { type: 'oauth', access, refresh, expires: Date.now() + 60_000,
  lmm_issuer: issuer, lmm_resource: `${issuer}/api/oauth2`, lmm_session: session, scope }; }
function context(credential: Credential | undefined, allowNetwork: boolean, publish = async (p: { update?: () => void }) => { p.update?.(); return true; }): RefreshModelsContext {
  return { credential, allowNetwork, signal: new AbortController().signal, publish };
}

class MemoryCredentials {
  private current?: Credential;
  constructor(value: Credential) { this.current = value; }
  async read() { return this.current; }
  async list() { return [{ providerId: 'lmm', type: 'oauth' as const }]; }
  async modify(_id: string, fn: (value: Credential | undefined) => Promise<Credential | undefined>) { this.current = await fn(this.current); return this.current; }
  async delete() { this.current = undefined; }
}

test('refreshes, rebinds the snapshot, and keeps the model available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lmm-provider-'));
  let access = 'lmm_at_old';
  let wireHeaders: Headers | undefined;
  let wireBody: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v1/chat/completions')) {
      wireHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
      wireBody = JSON.parse(String(input instanceof Request ? await input.clone().text() : init?.body));
      const sse = [
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1789240000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1789240000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]', '',
      ].join('\n\n');
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/token')) return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'lmm_at_new', refresh_token: 'refresh-new', expires_in: 300, scope }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    void init; void access;
    throw new Error('unexpected request');
  };
  const integration = new LmmIntegration({ issuer, fetch, refreshJournalDirectory: directory,
    capabilities: () => ({ api: 'openai-completions', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'], compat: {}, provenance: 'test fixture' }) });
  try {
    await integration.provider.refreshModels!(context(value(access, 'refresh-old'), true));
    const oldModels = integration.provider.getModels();
    assert.equal(oldModels.length, 1);
    const refreshed = await integration.oauth.refresh(value(access, 'refresh-old'), new AbortController().signal);
    const auth = await integration.provider.auth.oauth!.toAuth(refreshed);
    assert.equal(auth.headers?.authorization, 'Bearer lmm_at_new');
    assert.equal(integration.provider.filterModels!(oldModels, refreshed).length, 1);
    const selected = integration.provider.getModels()[0]!;
    const events = [];
    for await (const event of integration.provider.streamSimple!(selected, normalizeContext({ messages: [{ role: 'user', content: 'say hello', timestamp: Date.now() }] }), { headers: auth.headers })) events.push(event);
    const done = events.find((event) => event.type === 'done');
    assert.ok(done && done.type === 'done', `${events.map((event) => event.type).join(',')}:${JSON.stringify(events[0])}`);
    assert.equal(done.message.stopReason, 'stop');
    assert.equal(done.message.content[0]?.type, 'text');
    assert.equal((done.message.content[0] as { text?: string }).text, 'hello');
    assert.equal(wireHeaders?.get('authorization'), 'Bearer lmm_at_new');
    assert.equal(wireHeaders?.get('x-lmm-group'), groupId);
    assert.equal(wireBody?.model, 'gpt-4o-mini');
    assert.equal(wireBody?.stream, true);
  } finally { integration.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a late old-account snapshot cannot replace a newer account', async () => {
  let releaseOld!: () => void;
  const oldPaused = new Promise<void>((resolve) => { releaseOld = resolve; });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (url.endsWith('/catalog')) { if (headers.get('authorization') === 'Bearer lmm_at_old') await oldPaused; return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } }); }
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected request');
  };
  const integration = new LmmIntegration({ issuer, fetch, refreshJournalDirectory: join(tmpdir(), 'unused-provider-journal-' + Date.now()), capabilities: () => ({ api: 'openai-completions', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'], compat: {}, provenance: 'test fixture' }) });
  try {
    const old = integration.provider.auth.oauth!.toAuth(value('lmm_at_old', 'refresh-old'));
    await integration.provider.refreshModels!(context(value('lmm_at_new', 'refresh-new'), true));
    assert.equal(integration.provider.getModels().length, 1);
    releaseOld();
    await old;
    assert.equal(integration.provider.getModels().length, 1);
  } finally { integration.dispose(); }
});

test('revoke rejects a mismatched account without contacting the server, and toAuth denies the revoked session', async () => {
  let revokeCalls = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/revoke')) { revokeCalls += 1; return new Response(null, { status: 200 }); }
    throw new Error('unexpected request');
  };
  const integration = new LmmIntegration({ issuer, fetch });
  try {
    await integration.provider.refreshModels!(context(value('lmm_at_revoke', 'refresh-revoke', 'revoke-session'), true));
    await assert.rejects(integration.revoke('lmm_at_wrong_account', new AbortController().signal), { code: 'account_changed' });
    assert.equal(revokeCalls, 0);
    await integration.revoke('lmm_at_revoke', new AbortController().signal);
    assert.equal(revokeCalls, 1);
    assert.equal(integration.provider.getModels().length, 0);
    await assert.rejects(
      integration.provider.auth.oauth!.toAuth(value('lmm_at_revoke', 'refresh-revoke', 'revoke-session')),
      { code: 'revoked' },
    );
  } finally { integration.dispose(); }
});

test('a stale revocation of a replaced account does not clear the newer session', async () => {
  let releaseRevoke!: () => void;
  const revokePaused = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/revoke')) { await revokePaused; return new Response(null, { status: 200 }); }
    throw new Error('unexpected request');
  };
  const integration = new LmmIntegration({ issuer, fetch });
  try {
    await integration.provider.refreshModels!(context(value('lmm_at_switch_old', 'refresh-switch-old', 'switch-old'), true));
    const revoking = integration.revoke('lmm_at_switch_old', new AbortController().signal);
    await integration.provider.refreshModels!(context(value('lmm_at_switch_new', 'refresh-switch-new', 'switch-new'), true));
    releaseRevoke();
    await revoking;
    assert.equal(integration.provider.getModels().length, 1);
    await assert.rejects(
      integration.provider.auth.oauth!.toAuth(value('lmm_at_switch_old', 'refresh-switch-old', 'switch-old')),
      { code: 'revoked' },
    );
  } finally { integration.dispose(); }
});

test('Models host persists refresh and streams through the rebound provider auth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lmm-models-'));
  let exchanges = 0;
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/token')) {
      exchanges++;
      return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'lmm_at_host_new', refresh_token: 'refresh-host-new', expires_in: 900, scope }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/chat/completions')) {
      requestHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
      requestBody = JSON.parse(String(input instanceof Request ? await input.clone().text() : init?.body));
      return new Response('data: {"id":"host-chat","object":"chat.completion.chunk","created":1789240000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"host-chat","object":"chat.completion.chunk","created":1789240000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected request');
  };
  const integration = new LmmIntegration({ issuer, fetch, refreshJournalDirectory: directory,
    capabilities: () => ({ api: 'openai-completions', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'], compat: {}, provenance: 'test fixture' }) });
  const stored = new MemoryCredentials({ ...value('lmm_at_host_old', 'refresh-host-old'), expires: Date.now() - 1 });
  const models = createModels({ credentials: stored });
  models.setProvider(integration.provider);
  try {
    const result = await models.refresh({ providers: ['lmm'], allowNetwork: true, signal: new AbortController().signal });
    assert.equal(result.errors.size, 0);
    const saved = await stored.read();
    assert.equal((saved as OAuthCredential).access, 'lmm_at_host_new');
    assert.equal(exchanges, 1);
    const available = await models.getAvailable('lmm');
    assert.equal(available.length, 1);
    const events = [];
    for await (const event of models.streamSimple(available[0]!, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] })) events.push(event);
    const done = events.find((event) => event.type === 'done');
    assert.ok(done && done.type === 'done', `${events.map((event) => event.type).join(',')}:${JSON.stringify(events[0])}`);
    assert.equal((done.message.content[0] as { text?: string }).text, 'hello');
    assert.equal(requestHeaders?.get('authorization'), 'Bearer lmm_at_host_new');
    assert.equal(requestHeaders?.get('x-lmm-group'), groupId);
    assert.equal(requestBody?.model, 'gpt-4o-mini');
    assert.equal(requestBody?.stream, true);
  } finally { integration.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('restores a session-bound catalog and retains it when a rotated-token refresh fails', async () => {
  const referenceCost = {
    input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 100000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 0 }],
  };
  const capabilities = () => ({
    api: 'openai-completions' as const, contextWindow: 128000, maxTokens: 4096, reasoning: false,
    input: ['text'] as ('text' | 'image')[], compat: {}, referenceCost, provenance: 'test fixture',
  });
  const variableCatalog = (resource: string) => {
    const value = catalog(resource);
    return { ...value, models: value.models.map((model) => ({
      ...model, native_cost: null,
      pricing: { ...model.pricing, unit: 'expression', price_basis: 'tiered_expression', input: null, output: null, cache_read: null, cache_write: null },
    })) };
  };
  let stored: Parameters<RefreshModelsContext['publish']>[0]['persist'];
  const source = new LmmIntegration({ issuer, capabilities, fetch: async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(variableCatalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected request');
  } });
  try {
    await source.provider.refreshModels!({
      ...context(value('lmm_at_cache_old', 'refresh-old'), true),
      publish: async (publication) => { stored = publication.persist; publication.update?.(); return true; },
    });
    assert.ok(stored && stored.models.length === 1);
    assert.equal(stored.models[0]!.cost.tiers?.[0]?.output, 12);
    assert.notEqual(stored.etag, 'session');
  } finally { source.dispose(); }

  const offline = new LmmIntegration({ issuer, capabilities, fetch: async () => { throw new Error('offline'); } });
  const rotated = value('lmm_at_cache_new', 'refresh-new');
  try {
    await offline.provider.refreshModels!({
      ...context(rotated, false), stored: stored ?? undefined,
    });
    assert.equal(offline.provider.getModels().length, 1);
    assert.equal(offline.provider.getModels()[0]!.name, stored.models[0]!.name);
    assert.equal(offline.provider.getModels()[0]!.cost.tiers?.[0]?.output, 12);
    assert.equal(offline.provider.filterModels!(offline.provider.getModels(), rotated).length, 1);
    await assert.rejects(offline.provider.refreshModels!({
      ...context(rotated, true), stored: stored ?? undefined,
    }));
    assert.equal(offline.provider.filterModels!(offline.provider.getModels(), rotated).length, 1);
  } finally { offline.dispose(); }

  const otherAccount = new LmmIntegration({ issuer, capabilities, fetch: async () => { throw new Error('offline'); } });
  try {
    await otherAccount.provider.refreshModels!({
      ...context({ ...rotated, lmm_session: 'other-session' }, false), stored: stored ?? undefined,
    });
    assert.equal(otherAccount.provider.getModels().length, 0);
  } finally { otherAccount.dispose(); }
});

test('toAuth rebinds the last verified catalog when discovery is temporarily offline', async () => {
  let online = true;
  const integration = new LmmIntegration({ issuer, fetch: async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!online) throw new Error('offline');
    if (url.endsWith('/catalog')) return new Response(JSON.stringify(catalog(`${issuer}/api/oauth2`)), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ schema_version: 1, currency: 'USD', balance: 1, quota: 1, quota_per_unit: 1, updated_at: 1789240000, authorization_limit: null }), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected request');
  } });
  const old = value('lmm_at_auth_old', 'refresh-old');
  const rotated = value('lmm_at_auth_new', 'refresh-new');
  try {
    await integration.provider.refreshModels!(context(old, true));
    online = false;
    const auth = await integration.provider.auth.oauth!.toAuth(rotated);
    assert.equal(auth.headers?.authorization, 'Bearer lmm_at_auth_new');
    assert.equal(integration.provider.filterModels!(integration.provider.getModels(), rotated).length, 1);
  } finally { integration.dispose(); }
});
