# LMM provider for Pi

Use [LMM](https://api.lmm.best) models from Pi's native provider and model selector. Authentication runs through browser OAuth with a loopback callback and PKCE, so the extension never asks you to paste an API key into Pi.

This is an alpha release last tested with Pi 0.86.1, 0.87.1, 0.99.2 and 1.0.4. Newer releases are not blocked by a version ceiling. See [Preview status](#preview-status) before relying on it for production work.

## Requirements

- Pi 0.86.1 or newer; the latest official release is tested in CI
- Node.js 22.19.0 or newer
- An LMM account

## Install

Install the current GitHub provider with the source-switching installer (the npm package supplies only the installer):

```sh
npm exec --yes --package=@tokennotincluded/pi-lmm-provider@alpha -- lmm-pi-provider git:github.com/TokenNotIncluded/pi-lmm-provider
```

To use the separately published npm alpha instead (which may lag behind GitHub fixes):

```sh
npm exec --yes --package=@tokennotincluded/pi-lmm-provider@alpha -- lmm-pi-provider npm:@tokennotincluded/pi-lmm-provider@alpha
```

For a local checkout:

```sh
npm exec --yes --package=@tokennotincluded/pi-lmm-provider@alpha -- lmm-pi-provider /absolute/path/to/pi-lmm-provider
```

Add `--local` at the end to install for the current project. The installer first installs the chosen source, then removes other configured copies of this exact package from the user and current-project scopes. If the new install fails, it leaves the old copies configured. It does not remove unrelated packages. Restart Pi after switching sources. Direct `pi install` commands do not perform this cleanup; if you used one, run the source-switching command above once to reconcile the copies.

To update one already-selected source without switching it:

```sh
pi update npm:@tokennotincluded/pi-lmm-provider
```

## Use

1. Run `/login` and choose LMM.
2. Complete authentication in the browser.
3. Run `/model` and select an available LMM model.

The extension also provides these commands:

- `/lmm-prices` refreshes the account-specific model catalog and displays current pricing.
- `/lmm-diagnostics` displays the latest request model, sent `reasoning_effort`, gateway-reported model names, and whether a leading thinking wrapper was repaired. It makes no network requests.
- `/lmm-cache` displays the selected model's cache settings and help without making network requests.
- `/lmm-revoke` revokes the server authorization after interactive confirmation.
- `/logout` removes the local Pi login.

Current alpha releases request the LMM application scopes `catalog:read balance:read usage:read models:invoke` plus the built-in `mcp:bounties` and `mcp:drawing` scopes. Older alpha installations may have an authorization created before one or more of those scopes existed. The server preserves those historical grants without silently adding permissions the installed client did not request. After updating the provider, run `/login` again if you need a newly introduced protected resource such as usage activity or a built-in MCP endpoint.

Selectable models come from the account-specific LMM catalog and exact capability matches in Pi's built-in model directory. The last verified model list is cached for up to 24 hours and bound to the OAuth login session. The relay still validates every request against the live server-side account, group, and model policy.

For models advertised by LMM as `openai-completions`, the plugin still uses the exact Pi catalog entry for the upstream model. This is important for models whose native Pi adapter is different, such as Astra (Responses), Claude (Anthropic), or Gemini (Google): their `reasoning`, supported thinking levels, context window, and output limit are preserved while LMM translates the OpenAI-compatible request upstream. Non-thinking models remain non-thinking. The model's map may intentionally remove levels that the upstream does not support, so Pi can clamp the global default to the nearest valid level.

After upgrading from an older alpha, restart Pi and run `/model` or `/lmm-prices` once. The provider rebuilds the session-bound cache from the current Pi catalog; it does not trust stale `reasoning:false` metadata from an older plugin.

For the domestic DeepSeek V4 and reviewed GLM 5.3 entries, the provider also enables long prompt-cache retention and session-affinity headers. These request cache-friendly behavior from the gateway; they do not guarantee a particular worker, retention duration, cache hit, or lower charge. See [Cache compatibility](#cache-compatibility) for overrides and the `pi-cache-optimizer` advisory.

Models using server-side variable billing remain selectable when Pi has an exact official model match. Their names include `LMM variable billing`. Pi shows a public reference estimate, while the LMM wallet settlement is authoritative. Wallet values are platform credit, not spendable US dollars.

## Thinking display and model diagnostics

For Chat Completions streams, a leading `<thinking>...</thinking>` wrapper in assistant text is recovered into Pi's thinking field as it arrives, including tags split across SSE frames. Existing reasoning fields are preserved. Tags inside ordinary prose or Markdown code fences remain literal. An unclosed leading wrapper is treated as thinking until the response ends; partial closing tags are retained rather than discarded. Only an exact leading wrapper is recognized, so a literal leading wrapper example should be fenced as code.

If an SSE event exceeds the one-million-character inspection limit, any previously held text is flushed and that event plus the rest of the stream passes through without further thinking recovery or model-name inspection. Earlier recovered thinking remains intact. This keeps buffering bounded and avoids guessing the wrapper state after an uninspected event.

Every LMM response stores `lmmDiagnostics` with the requested model, protocol, sent `reasoning_effort` when present, up to eight gateway-reported model identifiers, and whether thinking recovery occurred. Diagnostics do not copy request headers, prompts, or raw response bodies. Reported names are limited in length and characters, and obvious credential prefixes or authorization expressions are rejected; these checks cannot identify every possible secret mislabeled by a gateway as a model name. `/lmm-diagnostics` shows the latest request captured during the current session. A different gateway name produces an advisory; aliases and dated model snapshots can legitimately differ. Gateway model names are declarations, not proof of the backing model. Missing names are shown as not reported. The existing Pi `responseModel` field is preserved.

The relay continues to send the selected catalog model and never switches models during retries. Diagnostics do not change routing or authorize fallback models.

## Cache compatibility

A `pi-cache-optimizer` warning about missing `supportsLongCacheRetention` or `sendSessionAffinityHeaders` is a cache advisory, not evidence that OAuth or a model request failed. Run `/lmm-cache` to inspect the selected model's merged flags and open this help. That command does not read credentials, contact LMM, or trigger an assistant turn. The warning originates in the separate optimizer extension; LMM does not suppress its messages.

LMM's OpenAI Chat Completions gateway enables `sendSessionAffinityHeaders` by default for every admitted model, including `GPT-Pro / gpt-6-astra`. This is a gateway routing setting independent of the vendor model metadata. The reviewed domestic DeepSeek V4 and GLM 5.3 profiles also enable long cache retention. After an upgrade, restart Pi, open `/model`, select the model again, and inspect `/lmm-cache` before adding an override. Do not reauthorize solely because of this cache warning. An actual 401/403 or request error needs separate diagnosis.

For another route, set `supportsLongCacheRetention` to `true` only when the gateway and backing model accept the adapter's long-retention fields. Use `sendSessionAffinityHeaders: false` to opt out for a route that should not send session headers. Model names alone do not prove support. These flags request behavior; they neither enable caching on an unsupported server nor guarantee savings. Session-affinity headers identify a session, not an OAuth credential.

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

## Native Pi file tools

The LMM extension reminds the selected LMM model to use Pi's active `write` and `edit` tools and their current schemas. `apply_patch` is a tool name in some other hosts; it is not automatically an executable in Pi's `bash` environment. If a file write fails, the model should recover and verify the file before opening a preview. This instruction reduces host confusion but cannot guarantee a model follows it. No shell executable is installed and disabled file tools remain disabled.

On Pi hosts exposing effective shell settings, for LMM models using Pi's local built-in `bash`, a `tool_call` guard also checks direct `apply_patch` commands before execution. If the command is unavailable in that shell, the call is blocked with guidance to use the active native file tools. An existing command is allowed. A standalone `xdg-open` with a literal missing local file is also blocked until the file exists. These are narrow checks, not a general shell parser: custom/remote bash tools, shell prefixes that can change filesystem visibility, and compound preview commands retain prompt guidance only.


## Remote control with any model

The extension also connects Pi to the LMM remote-control page. You do **not** need to select an LMM model. Keep your existing provider/model selected.

1. Update the extension and use `/login lmm`. Approve the new remote-control permission. Existing logins must approve it again; old grants do not gain control permission automatically.
2. Run `/lmm-remote on` on the machine running Pi and confirm. The plugin displays a new session PIN locally. This setting enables automatic connection for future interactive Pi sessions.
3. Open `https://api.lmm.best/remote-control`, sign in to the same account and enter the PIN. Send tasks, add instructions, stop work and answer plugin questions there.

`/lmm-remote status` displays the current connection and PIN locally. `/lmm-remote off` disables future automatic connections and removes the active relay session. Locking the web page only drops that page's key and messages; it does not stop Pi.

Standard select/confirm/input prompts work directly. Custom terminal components keep their original behavior and receive restricted keyboard or text input; `pi-ask-user` is covered by the SDK integration test. Large terminal views are bounded and not pixel-perfect. Arbitrary mouse, clipboard and upload widgets are not promised. Remote responses must match an active question. A local answer or completed question invalidates older remote responses.

The model catalog, model balance and selected provider do not gate remote credential resolution. Remote transport never calls an LMM model. Normal model-provider charges still apply to tasks you send. The relay is memory-only and requires matching backend/frontend changes; this branch is not a statement that production has been deployed.

Tests: `npm test`, `npm run typecheck`, `npm run test:pi`. For the real Pi 1.0.4 + published ask_user integration, install `pi-ask-user@0.16.0` without lifecycle scripts and run `npm run test:remote`. This uses Pi's deterministic non-LMM test provider, a local encrypted relay and fixture credentials; no production account or paid model request is used.
