import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { LmmIntegration } from '../src/provider.ts';

const issuer = 'https://api.lmm.best';
const wallet = { schema_version: 2, currency: 'USD', balance: 1.4, quota: 700000,
  quota_per_unit: 500000, public_credit_balance: '700000', credit_unit: 1,
  credits_per_usd: '500000', updated_at: 1789240000, authorization_limit: null };
const credential: OAuthCredential = { type: 'oauth', access: 'lmm_at_balance_fixture', refresh: 'fixture',
  expires: Date.now() + 60000, lmm_issuer: issuer, lmm_resource: `${issuer}/api/oauth2`,
  lmm_session: 'balance-fixture', scope: 'catalog:read balance:read models:invoke' };

test('provider publishes v2 credits and preserves only a stale known balance on read failure', async () => {
  const statuses: (string | undefined)[] = [];
  let body: unknown = wallet;
  let balanceReads = 0;
  const integration = new LmmIntegration({ onStatus: (status) => statuses.push(status),
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/catalog')) return Response.json({ schema_version: 1, resource: `${issuer}/api/oauth2`,
        updated_at: 1789240000, groups: [], models: [] });
      assert.ok(url.endsWith('/balance'), 'no model invocation or other endpoint is allowed');
      balanceReads++;
      return Response.json(body);
    } });
  try {
    await integration.provider.refreshModels!({ credential, allowNetwork: true, signal: new AbortController().signal,
      publish: async ({ update }) => { update?.(); return true; } });
    assert.equal(statuses.at(-1), 'LMM 700,000 platform credits · wallet only · models gated');
    integration.setCurrencyPreference({ unit: 'usd' });
    assert.equal(statuses.at(-1), 'LMM 1.4 USD · wallet only · models gated');
    assert.equal(balanceReads, 1, 'display switching is local');
    integration.setCurrencyPreference({ unit: 'cny', usdToCny: 6.5 });
    assert.match(statuses.at(-1)!, /LMM 9.1 CNY · estimated, manual rate 6.5 CNY\/USD/);
    body = { ...wallet, public_credit_balance: '1.4' };
    await integration.refreshBalance(credential.access);
    assert.match(statuses.at(-1)!, /LMM 9.1 CNY.*stale/);
    integration.setCurrencyPreference({ unit: 'credits' });
    assert.equal(statuses.at(-1), 'LMM 700,000 platform credits · stale · wallet only · models gated');
    integration.setCurrencyPreference({ unit: 'usd' });
    body = { ...wallet, quota: 0, balance: 0, public_credit_balance: '0' };
    await integration.refreshBalance(credential.access);
    assert.equal(statuses.at(-1), 'LMM 0 USD · wallet only · models gated');
    assert.equal(balanceReads, 3);
  } finally { integration.dispose(); }
  assert.equal(statuses.at(-1), undefined);
});
