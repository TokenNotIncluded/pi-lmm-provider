# Dynamic OAuth model catalog

The account-specific `GET /api/oauth2/catalog` response determines authorized group/model identities. Its supported `apis` entries determine available transports. Every supported text-capable route remains selectable even when public metadata or a cost estimate is missing; no bundled model or provider allowlist is consulted.

The plugin automatically fetches `https://models.dev/api.json?type=all`, caches the complete public response for 24 hours, revalidates with ETag, and atomically replaces successful downloads. Concurrent loads share one request. Failed refreshes preserve the last valid cache and apply a short retry cooldown. These public requests contain no LMM credentials or account data. `LMM_MODELS_DEV_CACHE` selects the cache file, `LMM_MODELS_DEV_TTL_MS` sets its lifetime, and `npm run metadata:update` warms the same cache.

Lookup tolerates case, punctuation, provider prefixes, token order, date suffixes and small spelling differences. Numeric generations and sizes remain distinct, and ambiguous matches remain unknown. The original `upstream_model`, account `id`, group scopes and outbound model value are unchanged.

Explicit server limits and flags take priority. Missing values use public metadata, then an installed host profile. Unknown budgets use 32,768 context tokens and 4,096 output tokens, capped by all available ceilings. Nonpositive public limits are unknown and cannot invalidate the whole catalog. Public reasoning options and installed transport profiles determine reasoning controls. Explicit specialized types or non-text input/output remain in `/lmm-prices` but are not registered as chat models. Text-capable models with additional audio/image output remain eligible for their advertised text transport.

Complete account prices take priority over public reference estimates. Pi requires numeric cost fields, so missing estimates use host placeholders and the picker explicitly says `cost estimate incomplete (server billed)`. The price report retains unknown server rates. Group and trust multipliers are already included and are never applied twice; settlement remains server-authoritative.

Catalog refresh performs no paid model invocation. Up to 20,000 records fit within the catalog's 32 MiB response bound; other HTTP responses retain smaller bounds. Successful empty catalogs remove models and account-discovery failures remain errors. `LMM_ISSUER` selects a trusted HTTPS origin subject to normal validation. DSH consumes this implementation through its pinned Pi submodule.
