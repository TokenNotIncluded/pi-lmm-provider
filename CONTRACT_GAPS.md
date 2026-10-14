# Integration gates (implementation, not a release approval)

## Catalog capabilities

Model capability metadata is resolved from Pi's complete installed official provider model directory by exact upstream model ID and the API advertised by the LMM catalog. Reviewed direct-vendor entries take precedence; the remaining official entries are accepted only when every exact-ID match agrees. A bundled models.dev snapshot corrects exact vendor capacities and narrows supported inputs/reasoning; it cannot add an unverified Pi transport or reasoning control. Separate input limits conservatively cap Pi's single context limit. Explicit non-chat, mixed-media output, tool-less and incomplete profiles are excluded across alternate-provider fallbacks. No cross-model fallback is permitted. Unknown IDs remain unknown and are not admitted to `/model`; the resolver does not infer capabilities from names.

The last verified admitted models are cached for up to 24 hours using Pi's provider model store. The cache contains no bearer or refresh token, is bound to a hash of the issuer and OAuth session, is filtered against the current scopes, and is marked stale in status output. Live relay authorization remains server-side; a cached entry cannot bypass a removed group, model, or grant.

When the host exposes effective settings, a saved LMM default triggers startup discovery even if an empty/expired cache caused Pi to select another provider. Discovery preserves the current selection. Pi's public extension context does not identify an initial explicit CLI/SDK model override, so a non-LMM override with an LMM saved default can still trigger read-only discovery. A non-LMM saved default with a non-LMM current model does not. Older hosts without the settings API require `/lmm-prices` to recover that catalog.

## Non-static pricing

Pi 0.85.1 native cost fields cannot represent unknown or arbitrary expression pricing, but Pi requires finite numeric cost fields for every selectable model. Complete server-supplied USD/million-token rates remain authoritative. A variable-billing model with an exact official Pi catalog match is selectable using that catalog's public cost solely as a local UI estimate and is labelled `LMM variable billing`; LMM settlement remains authoritative. Unknown IDs and entries without either server cost or an exact reference remain inspection-only. No protected pricing endpoint, zero/NaN/infinity placeholder, cross-model price, or client budget-confirmation gate is used.

## Refresh rotation

The installed Pi 0.85.1 native `Models.getAuth` correctly double-checks expiry inside `CredentialStore.modify`; `FileAuthStorageBackend.withLockAsync` holds a proper-lockfile cross-process lock across exchange and the write. However the public `Provider.auth.oauth.refresh` callback cannot inspect/attest the host's storage or require durable commit, and the file backend writes directly with writeFileSync, not atomic replacement. Abort/lock compromise/write failure after the server rotates can preserve the spent old refresh credential; a later attempt then reuses it. Memory/custom stores are also valid implementations of the same public interface.

The package now supports normal automatic refresh through its journal. The journal stores only credential summaries, serializes refreshes and prevents replay after failed rotation. If a crash loses the replacement token after server rotation, the grant may require a fresh `/login`; no plaintext token backup is kept. `/lmm-revoke` is wired to server revocation.

Local installation, host loading, protocol streams and refresh behavior have automated coverage. Production OAuth authorization, model calls, cancellation, account switching, revocation and billing reconciliation still require live acceptance before a stable release.


## Remote-control acceptance boundary

Remote control has independent credential resolution and explicit `remote:control` consent. Local tests use the official Pi 1.2.0 CLI and SDK with the pinned `pi-ask-user` 0.16.0 development dependency and a non-LMM deterministic provider. They cover actual tool invocation/results, model switching, stop while a question is open, encryption and local disable. A test provider is not a live third-party model endpoint. Production OAuth and deployed web-to-device acceptance remain separate release checks. Remote control is not enabled merely by installing untrusted code; the account authorization and local one-time confirmation remain required.
