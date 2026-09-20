import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Api, Credential, CredentialStore, Model, ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CACHE_HELP, cacheAdvice, cacheFlags, mergeCacheCompat } from '../src/cache.ts';
import { LmmIntegration } from '../src/provider.ts';

const issuer = 'https://api.lmm.best';
const group = '国产[Kimi/Deepseek/GLM]';
const groupId = Buffer.from(group).toString('base64url');
const primary = `${group} / deepseek-v4-pro`;
const secondary = `${group} / deepseek-v4-flash`;
const token = 'lmm_at_cache_fixture';
const flags = (enabled: boolean) => ({ supportsLongCacheRetention: enabled, sendSessionAffinityHeaders: enabled });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const scope = `catalog:read balance:read usage:read models:invoke group:${groupId}`;
const credential = {
  type: 'oauth' as const, access: token, refresh: 'cache-test-refresh', expires: Date.now() + 3_600_000,
  lmm_issuer: issuer, lmm_resource: `${issuer}/api/oauth2`, lmm_session: 'cache-test', scope,
};
const catalog = {
  schema_version: 1, resource: `${issuer}/api/oauth2`, updated_at: 1,
  groups: [{ id: groupId, name: group, scope: `group:${groupId}`, multiplier: 1 }],
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'].map((name) => ({
    id: `lmm:${groupId}:${Buffer.from(name).toString('base64url')}`, group_id: groupId, group,
    upstream_model: name, name, apis: ['openai-completions'], native_cost: cost,
    pricing: {
      currency: 'USD', unit: 'million_tokens', price_basis: 'configured_base_rates',
      group_multiplier: 1, trust_multiplier: 1, input: 1, output: 2, cache_read: 0, cache_write: 0,
      request: null, final_cost_depends_on_usage: true, updated_at: 1,
    },
  })),
};

async function fixture(config: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'lmm-cache-'));
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const integration = new LmmIntegration({
    issuer, refreshJournalDirectory: join(directory, 'journal'),
    capabilities: () => ({ api: 'openai-completions', contextWindow: 4096, maxTokens: 512,
      reasoning: false, input: ['text'], compat: { ...flags(false), supportsDeveloperRole: false }, provenance: 'test fixture' }),
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/catalog')) return json(catalog);
      if (url.endsWith('/balance')) return json({ schema_version: 1, currency: 'platform_credit', balance: 1,
        quota: 1, quota_per_unit: 1, updated_at: 1, authorization_limit: null });
      assert.equal(url, `${issuer}/v1/chat/completions`);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '')));
      requests.push({ headers, body });
      return new Response('data: {"id":"cache-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"cache-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    const modelsPath = join(directory, 'models.json');
    await writeFile(modelsPath, JSON.stringify(config));
    const auth = await integration.provider.auth.oauth!.toAuth(credential);
    // The host may refresh after native registration. Keep that work in memory
    // and supply the same fake credential, rather than racing file cleanup or
    // accidentally testing a logged-out provider that clears its catalog.
    let stored: Credential | undefined = structuredClone(credential);
    const credentials: CredentialStore = {
      async read(id) { return id === 'lmm' ? stored : undefined; },
      async list() { return stored ? [{ providerId: 'lmm', type: stored.type }] : []; },
      async modify(id, update) {
        assert.equal(id, 'lmm');
        stored = await update(stored);
        return stored;
      },
      async delete(id) { if (id === 'lmm') stored = undefined; },
    };
    const entries = new Map<string, ModelsStoreEntry>();
    const modelsStore: ModelsStore = {
      async read(id) { return entries.get(id); },
      async write(id, entry) { entries.set(id, structuredClone(entry)); },
      async delete(id) { entries.delete(id); },
    };
    const runtime = await ModelRuntime.create({ modelsPath, credentials, modelsStore, allowModelNetwork: false });
    runtime.registerNativeProvider(integration.provider);
    const refreshed = await runtime.refresh({ providers: ['lmm'], allowNetwork: false });
    assert.equal(refreshed.errors.size, 0);
    assert.equal(runtime.getError(), undefined);
    return { integration, runtime, auth, requests, async dispose() { integration.dispose(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { integration.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}

async function invoke(f: Awaited<ReturnType<typeof fixture>>, model: Model<Api>) {
  const output = f.integration.provider.streamSimple!(model, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, {
    headers: f.auth.headers, cacheRetention: 'long', sessionId: 'cache-session',
  });
  for await (const _event of output) { /* Drain the actual installed Pi adapter. */ }
  assert.equal((await output.result()).stopReason, 'stop');
  return f.requests.at(-1)!;
}

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
test('README contains two credential-free cache configuration examples', () => {
  assert.equal(examples.length, 2);
  for (const example of examples) assert.doesNotMatch(JSON.stringify(example), /apiKey|authorization|access_token|refresh_token|baseUrl|"models"/i);
});

const cases = [
  { name: 'README per-model override', config: examples[0], primary: true, secondary: false },
  { name: 'README provider defaults with per-model override', config: examples[1], primary: true, secondary: false },
  { name: 'provider-level true', config: { providers: { lmm: { compat: flags(true) } } }, primary: true, secondary: true },
  { name: 'explicit model-level false overrides provider true', config: { providers: { lmm: {
    compat: flags(true), modelOverrides: { [primary]: { compat: flags(false) } },
  } } }, primary: false, secondary: true },
];
for (const scenario of cases) {
  test(`${scenario.name} reaches the relay without replacing OAuth`, { timeout: 10_000 }, async () => {
    const f = await fixture(scenario.config);
    try {
      for (const [id, enabled] of [[primary, scenario.primary], [secondary, scenario.secondary]] as const) {
        const selected = f.runtime.getModel('lmm', id);
        assert.ok(selected);
        assert.deepEqual(cacheFlags(selected.compat), flags(enabled));
        const request = await invoke(f, selected);
        assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
        assert.equal(request.headers.get('x-api-key'), null);
        assert.equal(request.headers.get('x-lmm-group'), groupId);
        assert.equal(request.headers.get('x-session-affinity'), enabled ? 'cache-session' : null);
        assert.equal(request.body.model, id.endsWith('pro') ? 'deepseek-v4-pro' : 'deepseek-v4-flash');
        assert.equal(request.body.stream, true);
      }
      assert.equal(f.integration.provider.auth.apiKey, undefined);
      assert.ok(f.integration.provider.auth.oauth);
    } finally { await f.dispose(); }
  });
}

test('cache overrides cannot change the admitted endpoint or output limit', { timeout: 10_000 }, async () => {
  const f = await fixture(examples[0]);
  try {
    const selected = f.runtime.getModel('lmm', primary)!;
    const request = await invoke(f, { ...selected, baseUrl: 'https://untrusted.invalid/v1', maxTokens: 999_999,
      headers: { authorization: 'Bearer wrong', 'x-api-key': 'wrong' } });
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(request.headers.get('x-api-key'), null);
    assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 512);
  } finally { await f.dispose(); }
});

test('only cache booleans are copied and neither model is mutated', () => {
  const verified = { ...flags(true), supportsDeveloperRole: false };
  const selected = { ...flags(false), supportsDeveloperRole: true };
  assert.deepEqual(mergeCacheCompat(verified, selected), { ...flags(false), supportsDeveloperRole: false });
  assert.deepEqual(verified, { ...flags(true), supportsDeveloperRole: false });
  assert.deepEqual(selected, { ...flags(false), supportsDeveloperRole: true });
  const malformed = JSON.parse('{"supportsLongCacheRetention":"false","sendSessionAffinityHeaders":1}');
  assert.deepEqual(mergeCacheCompat(verified, malformed), verified);
});

test('cache help distinguishes advisory from failure and never prints credentials', () => {
  assert.match(cacheAdvice(), /Select an LMM model/);
  const model = { provider: 'lmm', compat: flags(false), headers: { authorization: token } };
  const advice = cacheAdvice(model);
  assert.match(advice, /supportsLongCacheRetention: false/);
  assert.match(advice, /not an OAuth or model-request failure/);
  assert.ok(advice.includes(CACHE_HELP));
  assert.doesNotMatch(advice, /lmm_at_/);
});
