# Integration gates (implementation, not a release approval)

## Catalog capabilities

The account catalog determines authorized model/group identities. Server metadata takes priority; an automatically cached models.dev catalog and the installed Pi provider directory supply optional facts. Formatting aliases and small typos can match metadata while generations and sizes remain distinct. Unknown metadata never removes an otherwise supported account model. Explicit specialized types and non-text input/output stay in the read-only report. Wire model IDs and group bindings remain unchanged; no cross-model request fallback is enabled.

The last verified admitted models are cached for up to 24 hours using Pi's provider model store. The cache contains no bearer or refresh token, is bound to a hash of the issuer and OAuth session, is filtered against the current scopes, and is marked stale in status output. Live relay authorization remains server-side; a cached entry cannot bypass a removed group, model, or grant.

When the host exposes effective settings, a saved LMM default triggers startup discovery even if an empty/expired cache caused Pi to select another provider. Discovery preserves the current selection. Pi's public extension context does not identify an initial explicit CLI/SDK model override, so a non-LMM override with an LMM saved default can still trigger read-only discovery. A non-LMM saved default with a non-LMM current model does not. Older hosts without the settings API require `/lmm-prices` to recover that catalog.

## Non-static pricing

Pi requires finite numeric cost fields and cannot express arbitrary billing or an unknown rate. Complete account rates take priority; known public and installed-host rates provide reference estimates. Missing estimates use required numeric host placeholders and are explicitly labelled incomplete in the picker. The price report retains unknown server rates, and LMM settlement remains authoritative. Missing public prices no longer exclude new account models.

## Refresh rotation

The installed Pi 0.85.1 native `Models.getAuth` correctly double-checks expiry inside `CredentialStore.modify`; `FileAuthStorageBackend.withLockAsync` holds a proper-lockfile cross-process lock across exchange and the write. However the public `Provider.auth.oauth.refresh` callback cannot inspect/attest the host's storage or require durable commit, and the file backend writes directly with writeFileSync, not atomic replacement. Abort/lock compromise/write failure after the server rotates can preserve the spent old refresh credential; a later attempt then reuses it. Memory/custom stores are also valid implementations of the same public interface.

The package now supports normal automatic refresh through its journal. The journal stores only credential summaries, serializes refreshes and prevents replay after failed rotation. If a crash loses the replacement token after server rotation, the grant may require a fresh `/login`; no plaintext token backup is kept. `/lmm-revoke` is wired to server revocation.

Local installation, host loading, protocol streams and refresh behavior have automated coverage. Production OAuth authorization, model calls, cancellation, account switching, revocation and billing reconciliation still require live acceptance before a stable release.


## Remote-control acceptance boundary

Remote control has independent credential resolution and explicit `remote:control` consent. Local tests use the official Pi 1.2.0 CLI and SDK with the pinned `pi-ask-user` 0.16.0 development dependency and a non-LMM deterministic provider. They cover actual tool invocation/results, model switching, stop while a question is open, encryption and local disable. A test provider is not a live third-party model endpoint. Production OAuth and deployed web-to-device acceptance remain separate release checks. Remote control is not enabled merely by installing untrusted code; the account authorization and local one-time confirmation remain required.
