import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OAuthCredential, RefreshModelsContext } from '@earendil-works/pi-ai';
import { LmmIntegration } from '../src/provider.ts';

const issuer = 'https://api.lmm.best';
const first: OAuthCredential = { type: 'oauth', access: 'lmm_at_currency_a', refresh: 'fixture',
  expires: Date.now() + 60000, lmm_issuer: issuer, lmm_resource: `${issuer}/api/oauth2`,
  lmm_session: 'currency-a', scope: 'catalog:read balance:read models:invoke' };
const second = { ...first, access: 'lmm_at_currency_b', lmm_session: 'currency-b' };
const wallet = { schema_version: 2, currency: 'USD', balance: 1.4, quota: 700000,
  quota_per_unit: 500000, public_credit_balance: '700000', credit_unit: 1,
  credits_per_usd: '500000', updated_at: 1789240000, authorization_limit: null };
const context = (credential: OAuthCredential, allowNetwork = true): RefreshModelsContext => ({
  credential, allowNetwork, signal: new AbortController().signal,
  publish: async ({ update }) => { update?.(); return true; },
});

for (const path of ['refreshModels', 'toAuth'] as const) {
  test(`currency display never reuses another account after failed ${path} discovery`, async () => {
    const statuses: (string | undefined)[] = [];
    let fail = false;
    let reads = 0;
    const integration = new LmmIntegration({ currencyPreference: { unit: 'usd' }, onStatus: (value) => statuses.push(value),
      fetch: async (input) => {
        reads++;
        if (fail) throw new Error('fixture unavailable');
        if (String(input).endsWith('/catalog')) return Response.json({ schema_version: 1, resource: `${issuer}/api/oauth2`,
          updated_at: 1789240000, groups: [], models: [] });
        assert.ok(String(input).endsWith('/balance'));
        return Response.json(wallet);
      } });
    try {
      await integration.provider.refreshModels!(context(first));
      assert.match(statuses.at(-1)!, /1.4 USD/);
      fail = true;
      if (path === 'refreshModels') await assert.rejects(integration.provider.refreshModels!(context(second)));
      else await integration.provider.auth!.oauth!.toAuth(second);
      integration.setCurrencyPreference({ unit: 'cny', usdToCny: 6.5 });
      assert.equal(statuses.at(-1), undefined);
      const before = reads;
      await integration.refreshBalance(first.access);
      assert.equal(reads, before, 'old access cannot refresh or expose its wallet');
      await integration.provider.refreshModels!(context(second, false));
      assert.equal(statuses.at(-1), undefined, 'offline cache has no wallet from account A');
      fail = false;
      await integration.provider.refreshModels!(context(second));
      assert.match(statuses.at(-1)!, /9.1 CNY.*manual rate/);
    } finally { integration.dispose(); }
  });
}

test('a late old-account balance response cannot populate a new account wallet', async () => {
  const statuses: (string | undefined)[] = [];
  let release: ((response: Response) => void) | undefined;
  let delay = false;
  const integration = new LmmIntegration({ onStatus: (value) => statuses.push(value), fetch: async (input) => {
    if (String(input).endsWith('/catalog')) return Response.json({ schema_version: 1, resource: `${issuer}/api/oauth2`,
      updated_at: 1789240000, groups: [], models: [] });
    assert.ok(String(input).endsWith('/balance'));
    if (delay) return new Promise<Response>((resolve) => { release = resolve; });
    return Response.json(wallet);
  } });
  try {
    await integration.provider.refreshModels!(context(first));
    delay = true;
    const pending = integration.refreshBalance(first.access);
    await integration.provider.refreshModels!(context(second, false));
    integration.setCurrencyPreference({ unit: 'usd' });
    assert.equal(statuses.at(-1), undefined);
    release!(Response.json(wallet));
    await pending;
    assert.equal(statuses.at(-1), undefined);
  } finally { integration.dispose(); }
});
