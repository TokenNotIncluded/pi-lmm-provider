import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider } from '@earendil-works/pi-ai';
import lmmExtension from '../src/index.ts';

test('native cold startup discovers a missing saved LMM catalog without replacing the fallback selection', async () => {
  for (const savedProvider of ['lmm', 'startup-fixture']) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-lmm-startup-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const originalFetch = globalThis.fetch;
    const requests = [];
    let session;
    process.env.PI_CODING_AGENT_DIR = directory;
    const issuer = 'https://api.lmm.best';
    const group = 'default';
    const groupId = Buffer.from(group).toString('base64url');
    const wireId = `lmm:${groupId}:${Buffer.from('gpt-4o').toString('base64url')}`;
    const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === `${issuer}/api/oauth2/catalog`) return Response.json({ schema_version: 1,
        resource: `${issuer}/api/oauth2`, updated_at: 1,
        groups: [{ id: groupId, name: group, scope: `group:${groupId}`, multiplier: 1 }],
        models: [{ id: wireId, group_id: groupId, group, upstream_model: 'gpt-4o', name: 'gpt-4o',
          apis: ['openai-completions'], native_cost: cost, pricing: { currency: 'USD', unit: 'million_tokens',
            price_basis: 'configured_base_rates', group_multiplier: 1, trust_multiplier: 1,
            input: 1, output: 2, cache_read: 0, cache_write: 0, request: null,
            final_cost_depends_on_usage: true, updated_at: 1 } }] });
      if (url === `${issuer}/api/oauth2/balance`) return Response.json({ schema_version: 2,
        currency: 'USD', balance: 1.4, quota: 700000, quota_per_unit: 500000,
        public_credit_balance: '700000', credit_unit: 1, credits_per_usd: '500000',
        updated_at: 1, authorization_limit: null });
      throw new Error('No model, token exchange or unrelated network requests allowed');
    };
    try {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('startup-fixture', async () => ({ type: 'api_key', key: 'local-fixture' }));
      await credentials.modify('lmm', async () => ({ type: 'oauth', access: 'lmm_at_startup_fixture',
        refresh: 'fixture-refresh', expires: Date.now() + 3600000, lmm_issuer: issuer,
        lmm_resource: `${issuer}/api/oauth2`, lmm_session: 'startup-fixture',
        scope: `catalog:read balance:read models:invoke group:${groupId}` }));
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
      // Keep the real host and target extension, while excluding unrelated
      // ambient vendor keys/ADC profiles from this private fixture runtime.
      for (const provider of runtime.getProviders()) runtime.registerNativeProvider({ ...provider,
        auth: { apiKey: { name: 'Disabled in startup fixture', resolve: async () => undefined } },
        getModels: () => [], getAllModels: () => [], refreshModels: undefined });
      const fallback = fauxProvider({ provider: 'startup-fixture', models: [{ id: 'fallback' }] });
      runtime.registerNativeProvider(fallback.provider);
      await runtime.refresh({ allowNetwork: false });
      assert.deepEqual(runtime.getAvailableSnapshot().map((model) => model.provider), ['startup-fixture']);
      const settings = SettingsManager.inMemory({ defaultProvider: savedProvider,
        defaultModel: savedProvider === 'lmm' ? 'default / gpt-4o' : 'fallback' });
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
        noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [lmmExtension] });
      await loader.reload();
      const result = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
        settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), noTools: true });
      assert.deepEqual(result.extensionsResult.errors, []);
      session = result.session;
      const initialModel = session.model;
      assert.ok(initialModel);
      assert.equal(initialModel.provider, 'startup-fixture', 'actual SDK falls back to the isolated authorized model');
      assert.ok(runtime.getModel(initialModel.provider, initialModel.id), 'fallback is a currently registered model');
      const errors = [];
      await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
      assert.deepEqual(errors, []);
      assert.equal(session.model?.provider, initialModel.provider, 'discovery does not override the current provider');
      assert.equal(session.model?.id, initialModel.id, 'discovery does not override the current model');
      if (savedProvider === 'lmm') {
        assert.ok(runtime.getModel('lmm', 'default / gpt-4o'));
        assert.deepEqual(requests.sort(), [`${issuer}/api/oauth2/balance`, `${issuer}/api/oauth2/catalog`].sort());
      } else {
        assert.deepEqual(requests, [], 'a non-LMM default stays independent of LMM model discovery');
      }
      assert.equal(fallback.state.callCount, 0, 'no paid or synthetic assistant prompt is made');
    } finally {
      session?.dispose();
      globalThis.fetch = originalFetch;
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
});
