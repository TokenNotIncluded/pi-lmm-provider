# LMM provider for Pi

Use [LMM](https://api.lmm.best) models from Pi's native provider and model selector. Authentication runs through browser OAuth with a loopback callback and PKCE, so the extension never asks you to paste an API key into Pi.

This is an alpha release for Pi 0.85.1. See [Preview status](#preview-status) before relying on it for production work.

## Requirements

- Pi 0.85.1
- Node.js 22.18.0 or newer
- An LMM account

## Install

Install the npm alpha release:

```sh
pi install npm:@tokennotincluded/pi-lmm-provider@alpha
```

You can also install the latest development version from GitHub:

```sh
pi install git:github.com/TokenNotIncluded/pi-lmm-provider
```

To update an existing installation:

```sh
pi update npm:@tokennotincluded/pi-lmm-provider
```

For local development, install a checkout directly:

```sh
pi install /absolute/path/to/pi-lmm-provider
```

## Use

1. Run `/login` and choose LMM.
2. Complete authentication in the browser.
3. Run `/model` and select an available LMM model.

The extension also provides these commands:

- `/lmm-prices` refreshes the account-specific model catalog and displays current pricing.
- `/lmm-revoke` revokes the server authorization after interactive confirmation.
- `/logout` removes the local Pi login.

Selectable models come from the account-specific LMM catalog and exact capability matches in Pi's built-in model directory. The last verified model list is cached for up to 24 hours and bound to the OAuth login session. The relay still validates every request against the live server-side account, group, and model policy.

Models using server-side variable billing remain selectable when Pi has an exact official model match. Their names include `LMM variable billing`. Pi shows a public reference estimate, while the LMM wallet settlement is authoritative. Wallet values are platform credit, not spendable US dollars.

## Preview status

Package loading, host integration, protocol streaming and token refresh have automated coverage. Live OAuth, model calls, cancellation, account switching, revocation and billing reconciliation still require production acceptance before a stable release.

A successful installation or browser login alone does not prove that model calls and billing work end to end. See [CONTRACT_GAPS.md](CONTRACT_GAPS.md) for the remaining integration constraints.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

The server-side OAuth contract is documented in the [LMM API repository](https://github.com/TokenNotIncluded/api.lmm.best/blob/main/apps/api-go/service/oauth_contract.md).
