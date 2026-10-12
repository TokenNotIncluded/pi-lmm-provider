import { finite, object, requireValue, unixSeconds } from './protocol.ts';

/** V2 uses explicit public credits; v1 retains its legacy wallet-unit label. */
export interface Balance {
  currency: 'platform_credit' | 'USD';
  remaining: number | null;
  quota: number;
  quota_per_unit: number;
  updated_at: number;
  authorization_limit: null;
}

export function parseBalance(value: unknown): Balance {
  const row = object(value);
  requireValue((row.schema_version === 1 || row.schema_version === 2) && row.authorization_limit === null);
  requireValue(row.schema_version === 2 ? row.currency === 'USD' : row.currency === 'platform_credit' || row.currency === 'USD');
  const quota = finite(row.quota);
  const quotaPerUnit = finite(row.quota_per_unit);
  requireValue(Number.isSafeInteger(quota) && quotaPerUnit > 0);
  const usdOrLegacy = row.balance === null ? null : finite(row.balance);
  if (usdOrLegacy !== null) {
    consistent(usdOrLegacy, quota / quotaPerUnit);
  }
  let remaining = usdOrLegacy;
  if (row.schema_version === 2) {
    requireValue(row.credit_unit === 1 && usdOrLegacy !== null);
    requireValue(typeof row.public_credit_balance === 'string' && row.public_credit_balance.length <= 80 && /^(?:0|-?[1-9]\d*)$/.test(row.public_credit_balance));
    remaining = Number(row.public_credit_balance);
    requireValue(Number.isSafeInteger(remaining) && remaining === quota, 'LMM public credit amounts are inconsistent.');
    requireValue(decimal(row.credits_per_usd) === quotaPerUnit);
    const unitKeys = ['credit_unit_schema_version', 'quota_unit', 'public_credit_unit', 'legacy_credit_unit',
      'ledger_quota_per_usd', 'ledger_quota_per_usd_exact', 'public_credits_per_usd', 'public_credits_per_usd_exact'];
    if (unitKeys.some((key) => key in row)) {
      requireValue(row.credit_unit_schema_version === 2 && row.quota_unit === 'LEDGER_QUOTA' &&
        row.public_credit_unit === 'CREDIT' && row.legacy_credit_unit === 'LEDGER_QUOTA');
      requireValue(finite(row.ledger_quota_per_usd) === quotaPerUnit && finite(row.public_credits_per_usd) === quotaPerUnit &&
        decimal(row.ledger_quota_per_usd_exact) === quotaPerUnit && decimal(row.public_credits_per_usd_exact) === quotaPerUnit);
    }
  }
  return {
    currency: 'platform_credit', remaining, quota, quota_per_unit: quotaPerUnit,
    updated_at: unixSeconds(row.updated_at), authorization_limit: null,
  };
}

function consistent(actual: number, expected: number): void {
  requireValue(Number.isFinite(expected) && Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-12), 'LMM wallet amounts are inconsistent.');
}

function decimal(value: unknown): number {
  requireValue(typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value));
  const result = Number(value);
  requireValue(Number.isFinite(result) && result > 0);
  return result;
}

export function balanceStatus(balance: Balance | undefined, stale = false): string {
  if (!balance || balance.remaining === null) return 'LMM · balance unavailable';
  const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(balance.remaining);
  return `LMM ${amount} platform credits${stale ? ' · stale' : ''} · wallet only`;
}
