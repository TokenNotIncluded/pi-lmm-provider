import type { Api, Model } from '@earendil-works/pi-ai';

const FIELDS = ['supportsLongCacheRetention', 'sendSessionAffinityHeaders'] as const;
export const CACHE_HELP = 'https://github.com/TokenNotIncluded/pi-lmm-provider#cache-compatibility';
type Compat = Model<Api>['compat'];
type CacheFlags = Partial<Record<(typeof FIELDS)[number], boolean>>;

/** Not every Pi protocol defines these fields; reject non-boolean values. */
export function cacheFlags(compat: Compat): CacheFlags {
  const result: CacheFlags = {};
  for (const key of FIELDS) {
    const value: unknown = compat ? Reflect.get(compat, key) : undefined;
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/** Pi already merged models.json. Accept only the documented cache booleans. */
export function mergeCacheCompat(verified: Compat, selected: Compat): Compat {
  return { ...verified, ...cacheFlags(selected) };
}

/** Read-only help: no catalog request, credential lookup, or model call. */
export function cacheAdvice(model?: Pick<Model<Api>, 'provider' | 'compat'>): string {
  const flags = cacheFlags(model?.compat);
  const detail = model?.provider === 'lmm'
    ? FIELDS.map((key) => `${key}: ${flags[key] ?? 'adapter default'}`).join('\n')
    : 'Select an LMM model with /model to inspect its cache settings.';
  return `${detail}\nA pi-cache-optimizer warning is a cache advisory, not an OAuth or model-request failure. Enable these flags only for a route confirmed to support them.\n${CACHE_HELP}`;
}
