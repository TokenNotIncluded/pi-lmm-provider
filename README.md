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
- `/lmm-cache` displays the selected model's cache settings and help without making network requests.
- `/lmm-revoke` revokes the server authorization after interactive confirmation.
- `/logout` removes the local Pi login.

Current alpha releases request the LMM application scopes `catalog:read balance:read usage:read models:invoke` plus the built-in `mcp:bounties` and `mcp:drawing` scopes. Older alpha installations may have an authorization created before one or more of those scopes existed. The server preserves those historical grants without silently adding permissions the installed client did not request. After updating the provider, run `/login` again if you need a newly introduced protected resource such as usage activity or a built-in MCP endpoint.

Selectable models come from the account-specific LMM catalog and exact capability matches in Pi's built-in model directory. The last verified model list is cached for up to 24 hours and bound to the OAuth login session. The relay still validates every request against the live server-side account, group, and model policy.

For models advertised by LMM as `openai-completions`, the plugin still uses the exact Pi catalog entry for the upstream model. This is important for models whose native Pi adapter is different, such as Astra (Responses), Claude (Anthropic), or Gemini (Google): their `reasoning`, supported thinking levels, context window, and output limit are preserved while LMM translates the OpenAI-compatible request upstream. Non-thinking models remain non-thinking. The model's map may intentionally remove levels that the upstream does not support, so Pi can clamp the global default to the nearest valid level.

After upgrading from an older alpha, restart Pi and run `/model` or `/lmm-prices` once. The provider rebuilds the session-bound cache from the current Pi catalog; it does not trust stale `reasoning:false` metadata from an older plugin.

For the domestic DeepSeek V4 and reviewed GLM 5.3 entries, the provider also enables long prompt-cache retention and session-affinity headers. These request cache-friendly behavior from the gateway; they do not guarantee a particular worker, retention duration, cache hit, or lower charge. See [Cache compatibility](#cache-compatibility) for overrides and the `pi-cache-optimizer` advisory.

Models using server-side variable billing remain selectable when Pi has an exact official model match. Their names include `LMM variable billing`. Pi shows a public reference estimate, while the LMM wallet settlement is authoritative. Wallet values are platform credit, not spendable US dollars.

## Cache compatibility

A `pi-cache-optimizer` warning about missing `supportsLongCacheRetention` or `sendSessionAffinityHeaders` is a cache advisory, not evidence that OAuth or a model request failed. Run `/lmm-cache` to inspect the selected model's merged flags and open this help. That command does not read credentials, contact LMM, or trigger an assistant turn. The warning originates in the separate optimizer extension; LMM does not suppress its messages.

The reviewed domestic DeepSeek V4 and GLM 5.3 profiles already enable both flags. After an upgrade, restart Pi, open `/model`, select the model again, and inspect `/lmm-cache` before adding an override. Do not reauthorize solely because of this cache warning. An actual 401/403 or request error needs separate diagnosis.

For another route, set `supportsLongCacheRetention` to `true` only when the gateway and backing model accept the adapter's long-retention fields. Set `sendSessionAffinityHeaders` to `true` only when the gateway supports Pi's session-affinity headers. Model names alone do not prove support. These flags request behavior; they neither enable caching on an unsupported server nor guarantee savings. Session-affinity headers identify a session, not an OAuth credential.

Edit `~/.pi/agent/models.json` (or `models.json` in your configured Pi agent directory). Merge the `providers.lmm` entries below into your existing file rather than overwriting other providers. Use the exact readable ID shown under LMM in `/model`, including the group and spaces, but without the leading `lmm/` provider label. Unknown IDs do not add or authorize a model.

A model-only override affects just the reviewed route:

```json
{
  "providers": {
    "lmm": {
      "modelOverrides": {
        "国产[Kimi/Deepseek/GLM] / deepseek-v4-pro": {
          "compat": {
            "supportsLongCacheRetention": true,
            "sendSessionAffinityHeaders": true
          }
        }
      }
    }
  }
}
```

Provider-level `compat` sets defaults for all LMM models, while `modelOverrides` wins for an individual model, including explicit `false`. A conservative default with one reviewed exception is:

```json
{
  "providers": {
    "lmm": {
      "compat": {
        "supportsLongCacheRetention": false,
        "sendSessionAffinityHeaders": false
      },
      "modelOverrides": {
        "国产[Kimi/Deepseek/GLM] / deepseek-v4-pro": {
          "compat": {
            "supportsLongCacheRetention": true,
            "sendSessionAffinityHeaders": true
          }
        }
      }
    }
  }
}
```

Do not enable provider-wide `true` merely to silence a warning: it applies to every current and future LMM catalog model. Reopen `/model` after editing, then use `/lmm-cache` to verify the flags. Cache behavior also depends on the request's cache-retention setting and session ID.

Only these two boolean compatibility overrides are forwarded from the selected model by the LMM relay. Other compatibility and capability metadata remain from the verified catalog profile. The examples do not replace OAuth, add an API key, change the issuer, grant groups/models, or increase the admitted output limit. Leave credentials, headers, `baseUrl`, and custom `models` out of a cache-only configuration.

Pi's [custom-model documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#per-model-overrides) describes how provider and model overrides are merged. The automated tests load the examples above through the installed Pi host and verify the resulting OAuth/group/session-affinity request headers.

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
