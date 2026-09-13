# LMM provider for Pi

Alpha development preview for Pi 0.85.1. This package is not published to npm, and production acceptance is not complete.

The extension registers LMM in Pi's native provider interface. It uses browser OAuth with a loopback callback and PKCE; it does not ask users to copy an API key. `/lmm-prices` refreshes the account-scoped catalog and shows pricing. Wallet status is labelled as platform credit, not spendable US dollars.

Selectable models come from the account-scoped LMM catalog and exact capability matches in Pi's complete built-in model directory. The last verified model list is cached for up to 24 hours, bound to the OAuth login session, and visibly marked as cached when a catalog refresh is temporarily unavailable. The relay still validates every request against the live server-side account, group, and model policy.

## Install and use with Pi

This package is not published to npm. Install the current development preview directly from GitHub:

```sh
pi install git:github.com/TokenNotIncluded/pi-lmm-provider
```

For a local checkout:

```sh
pi install /absolute/path/to/pi-lmm-provider
```

Then use `/login` and choose LMM in the native provider selector. Choose an admitted model with `/model`; `/lmm-prices` refreshes the account catalog and displays current pricing. `/lmm-revoke` requires interactive confirmation and revokes the server authorization. `/logout` clears the local Pi login.

Models billed by a server-side expression remain selectable when Pi has an exact official model match. Their names include `LMM variable billing`; Pi's local cost display is only a public reference estimate, while LMM wallet settlement remains authoritative. The extension does not call the API-key-protected pricing endpoint.

A successful package load or browser login alone is not a successful model-call test. Live OAuth, model invocation, refresh, cancellation, account switching, revocation and billing reconciliation still require acceptance.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run pack:check
```

See [CONTRACT_GAPS.md](CONTRACT_GAPS.md) and the [OAuth profile](https://github.com/TokenNotIncluded/api.lmm.best/blob/main/apps/api-go/service/oauth_contract.md).
