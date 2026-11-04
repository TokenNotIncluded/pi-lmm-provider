# Integration gates (implementation, not a release approval)

## Catalog capabilities

Model capabilities are resolved from runtime models.dev data and installed Pi profiles. The public directory supplies all providers and model IDs without an allowlist. Exact IDs take precedence over normalized spelling, provider namespace, directory display-name and canonical-ID matches. Version, size and variant tokens are retained; incompatible canonical identities are not merged. The LMM catalog alone determines account availability and the original model ID sent in every request.

Network-enabled discovery uses a 24-hour public metadata cache; `/lmm-prices` forces refresh. The five-second, size-bounded public request carries no account data. A failed or invalid refresh preserves the last valid metadata, with the bundled snapshot as a cold fallback. Network-disabled discovery makes no public metadata request. The durable public cache does not grant OAuth access or replace the separate account cache.

Existing exact Pi profiles preserve their reviewed protocol controls. New metadata-only models can use supported, server-advertised transports with conservative text capabilities and complete LMM native pricing. Reasoning/image controls are not invented from a model name or boolean. Non-chat models and unresolved capability/pricing records remain visible in `/lmm-prices` with their admission reason. Canonical sources take precedence over incomplete proxy offerings; compatible linked offerings use conservative capacity limits. No cross-model request fallback is permitted.

The last verified admitted models are cached for up to 24 hours using Pi's provider model store. The cache contains no bearer or refresh token, is bound to a hash of the issuer and OAuth session, is filtered against the current scopes, and is marked stale in status output. Live relay authorization remains server-side; a cached entry cannot bypass a removed group, model, or grant.

When the host exposes effective settings, a saved LMM default triggers startup discovery even if an empty/expired cache caused Pi to select another provider. Discovery preserves the current selection. Pi's public extension context does not identify an initial explicit CLI/SDK model override, so a non-LMM override with an LMM saved default can still trigger read-only discovery. A non-LMM saved default with a non-LMM current model does not. Older hosts without the settings API require `/lmm-prices` to recover that catalog.

## Non-static pricing

Pi 0.85.1 native cost fields cannot represent unknown or arbitrary expression pricing, but Pi requires finite numeric cost fields for every selectable model. Complete server-supplied USD/million-token rates remain authoritative. A variable-billing model with an exact official Pi catalog match is selectable using that catalog's public cost solely as a local UI estimate and is labelled `LMM variable billing`; LMM settlement remains authoritative. Entries without either complete server cost or a reference for the same verified model remain inspection-only, even if their capability metadata is known. No protected pricing endpoint, zero/NaN/infinity placeholder, cross-model price, or client budget-confirmation gate is used.

## Refresh rotation

The installed Pi 0.85.1 native `Models.getAuth` correctly double-checks expiry inside `CredentialStore.modify`; `FileAuthStorageBackend.withLockAsync` holds a proper-lockfile cross-process lock across exchange and the write. However the public `Provider.auth.oauth.refresh` callback cannot inspect/attest the host's storage or require durable commit, and the file backend writes directly with writeFileSync, not atomic replacement. Abort/lock compromise/write failure after the server rotates can preserve the spent old refresh credential; a later attempt then reuses it. Memory/custom stores are also valid implementations of the same public interface.

The package now supports normal automatic refresh through its journal. The journal stores only credential summaries, serializes refreshes and prevents replay after failed rotation. If a crash loses the replacement token after server rotation, the grant may require a fresh `/login`; no plaintext token backup is kept. `/lmm-revoke` is wired to server revocation.

Local installation, host loading, protocol streams and refresh behavior have automated coverage. Production OAuth authorization, model calls, cancellation, account switching, revocation and billing reconciliation still require live acceptance before a stable release.


## Remote-control acceptance boundary

Remote control has independent credential resolution and explicit `remote:control` consent. Local tests use the official Pi 1.2.0 CLI and SDK with the pinned `pi-ask-user` 0.16.0 development dependency and a non-LMM deterministic provider. They cover actual tool invocation/results, model switching, stop while a question is open, encryption and local disable. A test provider is not a live third-party model endpoint. Production OAuth and deployed web-to-device acceptance remain separate release checks. Remote control is not enabled merely by installing untrusted code; the account authorization and local one-time confirmation remain required.
