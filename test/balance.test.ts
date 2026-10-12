import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceStatus, parseBalance } from '../src/balance.ts';

const response = { schema_version: 1, currency: 'USD', balance: 1.4, quota: 700000, quota_per_unit: 500000, updated_at: 1789240000, authorization_limit: null };

test('consumes the backend v1 balance fields and labels platform credit truthfully', () => {
  const result = parseBalance(response);
  assert.equal(result.remaining, 1.4);
  assert.equal(balanceStatus(result), 'LMM 1.4 platform credits · wallet only');
  assert.match(balanceStatus(result, true), /stale/);
});

test('accepts the explicit platform credit currency while retaining legacy USD compatibility', () => {
  const result = parseBalance({ ...response, currency: 'platform_credit' });
  assert.equal(result.currency, 'platform_credit');
  assert.equal(balanceStatus(result), 'LMM 1.4 platform credits · wallet only');
});

test('unknown balance is not reported as zero and zero remains a valid balance', () => {
  assert.equal(balanceStatus(parseBalance({ ...response, balance: null })), 'LMM · balance unavailable');
  assert.equal(balanceStatus(parseBalance({ ...response, balance: 0, quota: 0 })), 'LMM 0 platform credits · wallet only');
});

const responseV2 = { ...response, schema_version: 2, public_credit_balance: '700000', credit_unit: 1, credits_per_usd: '500000' };
const denomination = { credit_unit_schema_version: 2, quota_unit: 'LEDGER_QUOTA', public_credit_unit: 'CREDIT',
  legacy_credit_unit: 'LEDGER_QUOTA', ledger_quota_per_usd: 500000, ledger_quota_per_usd_exact: '500000',
  public_credits_per_usd: 500000, public_credits_per_usd_exact: '500000' };

test('v2 displays public wallet credits, not the USD balance or a guessed conversion', () => {
  for (const body of [responseV2, { ...responseV2, ...denomination }]) {
    assert.equal(parseBalance(body).remaining, 700000);
    assert.equal(balanceStatus(parseBalance(body)), 'LMM 700,000 platform credits · wallet only');
  }
  assert.equal(balanceStatus(parseBalance({ ...responseV2, balance: 0, quota: 0, public_credit_balance: '0' })),
    'LMM 0 platform credits · wallet only');
});

test('v2 rejects missing, malformed, unsafe or inconsistent public amounts and units', () => {
  for (const patch of [
    { public_credit_balance: undefined }, { public_credit_balance: null }, { public_credit_balance: 700000 },
    { public_credit_balance: '1.4' }, { public_credit_balance: '700001' }, { public_credit_balance: '0700000' },
    { public_credit_balance: '7e5' }, { public_credit_balance: 'Infinity' }, { public_credit_balance: ' 700000' },
    { public_credit_balance: '9007199254740993' }, { public_credit_balance: '1'.repeat(81) },
    { credit_unit: 500000 }, { credit_unit: undefined }, { currency: 'platform_credit' },
    { credits_per_usd: undefined }, { credits_per_usd: '0' }, { credits_per_usd: 'NaN' }, { credits_per_usd: '100000' },
    { balance: null }, { balance: 700000 }, { schema_version: 3 },
    { ...denomination, public_credit_unit: 'USD' }, { ...denomination, credit_unit_schema_version: 3 },
    { ...denomination, public_credits_per_usd_exact: '100000' }, { ...denomination, ledger_quota_per_usd: 100000 },
    { credit_unit_schema_version: 2 },
  ]) assert.throws(() => parseBalance({ ...responseV2, ...patch }), JSON.stringify(patch));
});

test('rejects inconsistent amounts, wrong schema and unsupported currency', () => {
  for (const patch of [{ balance: 700000 }, { quota_per_unit: 0 }, { quota: 0.5 }, { balance: Infinity }, { schema_version: 2 }, { currency: 'CNY' }, { authorization_limit: 100 }]) {
    assert.throws(() => parseBalance({ ...response, ...patch }));
  }
});
