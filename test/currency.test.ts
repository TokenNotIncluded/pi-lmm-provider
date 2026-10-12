import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurrencySettings, currencyCommand, parseCurrencyPreference } from '../src/currency.ts';
import { balanceStatus, parseBalance } from '../src/balance.ts';

const wallet = { schema_version: 2, currency: 'USD', balance: 1.4, quota: 700000,
  quota_per_unit: 500000, public_credit_balance: '700000', credit_unit: 1,
  credits_per_usd: '500000', updated_at: 1789240000, authorization_limit: null };

function temporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'pi-currency-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('currency defaults, atomic persistence, switching and reload in a private agent directory', () => temporary((directory) => {
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const path = join(directory, 'lmm-currency.json');
  const settings = new CurrencySettings(path);
  assert.deepEqual(settings.get(), { unit: 'credits' });
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(settings.set('USD'), { unit: 'usd' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(new CurrencySettings(path).get(), { unit: 'usd' });
  assert.deepEqual(settings.set('cny 6.5'), { unit: 'cny', usdToCny: 6.5 });
  settings.set('credits');
  const reloaded = new CurrencySettings(path);
  assert.deepEqual(reloaded.set('cny'), { unit: 'cny', usdToCny: 6.5 });
  const snapshot = reloaded.get();
  snapshot.unit = 'usd';
  assert.equal(reloaded.get().unit, 'cny');
  assert.deepEqual(readdirSync(directory), ['lmm-currency.json']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, unit: 'cny', usdToCny: 6.5 });
}));

test('invalid input, missing rate, oversized and nonfinite rates preserve saved preferences', () => temporary((directory) => {
  const settings = new CurrencySettings(join(directory, 'lmm-currency.json'));
  for (const args of ['cny', 'eur', '', 'usd 6.5', 'credits extra', 'cny 0', 'cny -1', 'cny Infinity',
    'cny NaN', 'cny 1000001', 'cny 1e309', 'cny 1e-999', 'cny 0x10', 'cny 1 extra']) {
    assert.throws(() => settings.set(args), args);
    assert.deepEqual(settings.get(), { unit: 'credits' });
  }
  settings.set('cny 6.5');
  const saved = readFileSync(settings.path, 'utf8');
  assert.throws(() => settings.set('cny -2'));
  assert.deepEqual(settings.get(), { unit: 'cny', usdToCny: 6.5 });
  assert.equal(readFileSync(settings.path, 'utf8'), saved);
  assert.deepEqual(currencyCommand('cny 1e-3', { unit: 'credits' }), { unit: 'cny', usdToCny: 0.001 });
}));

test('failed persistence leaves in-memory preference unchanged and removes temporary files', () => temporary((directory) => {
  const path = join(directory, 'lmm-currency.json');
  const settings = new CurrencySettings(path);
  mkdirSync(path); // deterministic rename failure even when tests run as root
  assert.throws(() => settings.set('usd'));
  assert.deepEqual(settings.get(), { unit: 'credits' });
  assert.deepEqual(readdirSync(directory), ['lmm-currency.json']);
}));

test('corrupt, unsupported and unsafe configuration safely falls back without overwriting', () => temporary((directory) => {
  const path = join(directory, 'lmm-currency.json');
  for (const content of ['{', 'null', '[]', 'x'.repeat(4097), ...[
    { version: 2, unit: 'usd' }, { version: 1, unit: 'EUR' }, { version: 1, unit: ['usd'] }, { version: 1, unit: 'cny' },
    { version: 1, unit: 'credits', usdToCny: 0 }, { version: 1, unit: 'usd', usdToCny: -1 },
    { version: 1, unit: 'cny', usdToCny: '6.5' }, { version: 1, unit: 'cny', usdToCny: 1e300 },
  ].map((row) => JSON.stringify(row))]) {
    writeFileSync(path, content);
    const settings = new CurrencySettings(path);
    assert.deepEqual(settings.get(), { unit: 'credits' });
    assert.match(settings.loadWarning!, /using credits/);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
  for (const rate of [Infinity, NaN, -Infinity]) assert.throws(() => parseCurrencyPreference({ version: 1, unit: 'cny', usdToCny: rate }));
  const recovered = new CurrencySettings(path);
  recovered.set('usd');
  assert.equal(recovered.loadWarning, undefined);
  assert.deepEqual(new CurrencySettings(path).get(), { unit: 'usd' });
}));

test('USD and estimated CNY use only the verified v2 USD basis, retaining default credits', () => {
  const balance = parseBalance(wallet);
  assert.equal(balance.usdRemaining, 1.4);
  assert.equal(balanceStatus(balance), 'LMM 700,000 platform credits · wallet only');
  assert.equal(balanceStatus(balance, false, { unit: 'usd' }), 'LMM 1.4 USD · wallet only');
  assert.equal(balanceStatus(balance, true, { unit: 'cny', usdToCny: 6.5 }), 'LMM 9.1 CNY · estimated, manual rate 6.5 CNY/USD · stale · wallet only');
  const legacy = parseBalance({ ...wallet, schema_version: 1 });
  assert.equal(legacy.usdRemaining, undefined);
  for (const unit of ['usd', 'cny'] as const) {
    assert.match(balanceStatus(legacy, true, { unit, usdToCny: 6.5 }), /balance unavailable \(no verified USD basis\).*stale/);
  }
  assert.match(balanceStatus(balance, false, { unit: 'cny' }), /manual rate required/);
  assert.match(balanceStatus(undefined, true, { unit: 'usd' }), /unavailable · stale/);
});

test('negative, zero and tiny amounts retain meaning; unsafe conversion is not zero', () => {
  for (const [quota, usd, expected] of [[0, 0, '0'], [-700000, -1.4, '-9.1']] as const) {
    const balance = parseBalance({ ...wallet, quota, balance: usd, public_credit_balance: String(quota) });
    assert.match(balanceStatus(balance, false, { unit: 'cny', usdToCny: 6.5 }), new RegExp(`LMM ${expected} CNY`));
  }
  const large = parseBalance({ ...wallet, balance: Number.MAX_SAFE_INTEGER, quota: Number.MAX_SAFE_INTEGER,
    public_credit_balance: String(Number.MAX_SAFE_INTEGER), quota_per_unit: 1, credits_per_usd: '1' });
  assert.match(balanceStatus(large, false, { unit: 'cny', usdToCny: 6.5 }), /conversion out of range/);
  const tiny = parseBalance({ ...wallet, balance: 1e-79, quota: 1, public_credit_balance: '1', quota_per_unit: 1e79,
    credits_per_usd: '1' + '0'.repeat(79) });
  assert.doesNotMatch(balanceStatus(tiny, false, { unit: 'usd' }), /LMM 0 USD/);
  assert.match(balanceStatus(tiny, false, { unit: 'cny', usdToCny: Number.MIN_VALUE }), /conversion out of range/);
  for (const usdToCny of [Infinity, NaN, 0, -1, 1e300]) {
    assert.match(balanceStatus(tiny, false, { unit: 'cny', usdToCny }), /manual rate required/);
  }
  assert.match(balanceStatus({ ...large, usdRemaining: Infinity }, false, { unit: 'usd' }), /no verified USD basis/);
});
