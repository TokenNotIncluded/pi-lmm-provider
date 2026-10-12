import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DisplayCurrency = 'credits' | 'usd' | 'cny';
export interface CurrencyPreference {
  unit: DisplayCurrency;
  /** Explicit user estimate: CNY per USD, never a billing or authorization input. */
  usdToCny?: number;
}
export const MAX_MANUAL_RATE = 1_000_000;
export const CURRENCY_USAGE = '/lmm-currency [credits|usd|cny [USD-to-CNY-rate]]';

export function validManualRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= Number.MIN_VALUE && value <= MAX_MANUAL_RATE;
}

export function parseCurrencyPreference(value: unknown): CurrencyPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid currency settings.');
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.unit !== 'string' || !['credits', 'usd', 'cny'].includes(row.unit) ||
      (row.usdToCny !== undefined && !validManualRate(row.usdToCny)) ||
      (row.unit === 'cny' && row.usdToCny === undefined)) throw new Error('Invalid currency settings.');
  return { unit: row.unit as DisplayCurrency, ...(row.usdToCny !== undefined ? { usdToCny: row.usdToCny as number } : {}) };
}

export function currencyCommand(args: string, current: CurrencyPreference): CurrencyPreference {
  const parts = args.trim().toLowerCase().split(/\s+/);
  const unit = parts[0];
  if (!['credits', 'usd', 'cny'].includes(unit!) || parts.length > (unit === 'cny' ? 2 : 1)) throw new Error(`Usage: ${CURRENCY_USAGE}`);
  let usdToCny = current.usdToCny;
  if (parts.length === 2) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(parts[1]!)) throw new Error('USD-to-CNY rate must be a positive finite number.');
    usdToCny = Number(parts[1]);
    if (!validManualRate(usdToCny)) throw new Error(`USD-to-CNY rate must be positive, finite and at most ${MAX_MANUAL_RATE}.`);
  }
  if (unit === 'cny' && usdToCny === undefined) throw new Error('CNY needs an explicit manual USD-to-CNY rate; no automatic exchange-rate source is configured.');
  return { unit: unit as DisplayCurrency, ...(usdToCny !== undefined ? { usdToCny } : {}) };
}

export function currencySummary(preference: CurrencyPreference): string {
  return `LMM wallet display: ${preference.unit.toUpperCase()}.${preference.usdToCny !== undefined ? ` Manual estimate: 1 USD = ${preference.usdToCny} CNY.` : ' No manual CNY rate configured.'} Display only; ledger, billing and authorization budgets are unchanged. /lmm-prices remains server USD pricing.`;
}

/** Own external settings file, not Pi settings.json or auth.json. No wallet/account data is persisted. */
export class CurrencySettings {
  private preference: CurrencyPreference = { unit: 'credits' };
  loadWarning?: string;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      if (statSync(path).size > 4096) throw new Error('Oversized settings.');
      this.preference = parseCurrencyPreference(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadWarning = 'LMM currency settings could not be read or validated; using credits. The saved file was not changed.';
    }
  }

  get(): CurrencyPreference { return { ...this.preference }; }

  set(args: string): CurrencyPreference {
    const next = currencyCommand(args, this.preference);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: 1, ...next })}\n`);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* rename succeeded or no temporary file was created */ }
    }
    this.preference = next;
    this.loadWarning = undefined;
    return this.get();
  }
}
