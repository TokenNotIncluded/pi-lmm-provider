import type { Api, Model } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { CapabilityResolver, VerifiedCapabilities } from './catalog.ts';
import { SUPPORTED_APIS, type LmmApi } from './protocol.ts';
import { isExcludedModelMetadata, metadataProvenance, resolveModelMetadata, type ModelMetadata } from './models-dev.ts';

type Source = readonly [BuiltinProvider, ReadonlyMap<string, Model<Api>>];
const LANGUAGE_APIS: readonly Api[] = [
  'anthropic-messages', 'azure-openai-responses', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex',
  'mistral-conversations', 'openai-codex-responses', 'openai-completions', 'openai-responses',
];

const preferredSources: readonly Source[] = (
  ['openai', 'anthropic', 'deepseek', 'xai', 'moonshotai', 'minimax', 'google', 'zai'] as const
).map((provider) => [
  provider, new Map(getBuiltinModels(provider).map((model) => [model.id, model])),
]);
const preferredProviders = new Set(preferredSources.map(([provider]) => provider));
const fallbackSources: readonly Source[] = getBuiltinProviders()
  .filter((provider) => !preferredProviders.has(provider))
  .map((provider) => [provider, new Map(getBuiltinModels(provider).map((model) => [model.id, model]))]);

function gatewayCompat(entry: Parameters<CapabilityResolver>[0], api: LmmApi, compat: NonNullable<Model<Api>['compat']>) {
  // Affinity belongs to LMM's proxy transport, not the upstream vendor catalog.
  // The relay keeps these session headers; explicit models.json false wins later.
  if (api === 'openai-completions') compat = { ...compat, sendSessionAffinityHeaders: true };
  const domesticGroup = entry.group === '国产[Kimi/Deepseek/GLM]';
  const deepSeekV4 = /^deepseek-v4-(?:flash|pro)(?:-.+)?$/.test(entry.upstream_model);
  if (domesticGroup && (deepSeekV4 || entry.upstream_model === 'glm-5.3' || entry.upstream_model === 'glm-5.3-flash')) {
    return {
      ...compat,
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: true,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek' as const,
    };
  }
  return compat;
}

/** A catalog boolean cannot add a reasoning protocol or a vision transport. */
export function applyModelMetadata(builtin: Model<Api>, metadata: ModelMetadata | undefined): Model<Api> {
  if (!metadata) return builtin;
  const reasoning = builtin.reasoning && metadata.reasoning;
  const compat = structuredClone(builtin.compat ?? {});
  if (!reasoning && 'supportsReasoningEffort' in compat) compat.supportsReasoningEffort = false;
  return {
    ...builtin, contextWindow: metadata.contextWindow, maxTokens: metadata.maxTokens,
    reasoning, input: builtin.input.filter((input) => metadata.input.includes(input)), compat,
    thinkingLevelMap: reasoning ? builtin.thinkingLevelMap : undefined,
  };
}

function candidates(entry: Parameters<CapabilityResolver>[0], sources: readonly Source[]): VerifiedCapabilities[] {
  const result: VerifiedCapabilities[] = [];
  for (const [provider, models] of sources) {
    const builtin = models.get(entry.upstream_model);
    if (!builtin) continue;
    // Capacity corrections require BOTH a verified Pi transport profile and an
    // exact models.dev vendor/ID match. Unknown aliases remain gated.
    const metadata = resolveModelMetadata(provider, builtin.id);
    const model = applyModelMetadata(builtin, metadata);
    if (!model.input.includes('text')) continue;
    const nativeProtocol = SUPPORTED_APIS.includes(model.api as LmmApi) && entry.apis.includes(model.api as LmmApi);
    // The server explicitly advertises the gateway transport. Capacity metadata
    // still requires an exact Pi catalog model, never a name-based approximation.
    if (!nativeProtocol && (!entry.apis.includes('openai-completions') ||
      !LANGUAGE_APIS.includes(model.api))) continue;
    // LMM's OpenAI-compatible gateway translates the request to the vendor
    // protocol upstream. Preserve the vendor's reasoning metadata even when
    // the wire protocol differs; otherwise Pi hides every thinking level and
    // never sends reasoning_effort for models such as GPT-6 Astra.
    const compat = gatewayCompat(entry, nativeProtocol ? model.api as LmmApi : 'openai-completions', nativeProtocol ? structuredClone(model.compat ?? {}) : {
      supportsDeveloperRole: false, supportsStore: false,
      supportsReasoningEffort: model.reasoning,
      maxTokensField: provider === 'openai' ? 'max_completion_tokens' as const : 'max_tokens' as const,
    });
    // A vendor fallback may use a different model and price not authorized by this catalog entry.
    if ('allowedFallbackModels' in compat) delete compat.allowedFallbackModels;
    result.push({
      api: nativeProtocol ? model.api as LmmApi : 'openai-completions', contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      reasoning: model.reasoning, input: [...model.input], compat, referenceCost: structuredClone(model.cost),
      thinkingLevelMap: model.thinkingLevelMap ? structuredClone(model.thinkingLevelMap) : undefined,
      provenance: `pi-ai vendor catalog: ${provider}/${model.id}${metadata ? `; ${metadataProvenance} capacities` : ''}${nativeProtocol ? '' : '; server-advertised OpenAI-compatible transport'}`,
    });
  }
  return result;
}

/** Exact vendor catalog matches only. LMM account pricing always comes from its server. */
export const resolveKnownCapabilities: CapabilityResolver = (entry) => {
  // models.dev explicitly rules out media/non-chat/unknown tool profiles. Do not
  // let another catalog's exact ID, such as Azure/Vertex, bypass that decision.
  if (preferredSources.some(([provider]) => isExcludedModelMetadata(provider, entry.upstream_model))) return undefined;
  // Preserve the reviewed direct-vendor behavior. Only consult the rest of
  // Pi's official catalog when none of those sources knows the exact ID.
  const matches = candidates(entry, preferredSources);
  const knownPreferred = preferredSources.some(([, models]) => models.has(entry.upstream_model));
  const resolved = knownPreferred ? matches : candidates(entry, fallbackSources);
  if (!resolved.length) return undefined;
  const profile = ({ provenance: _source, referenceCost: _cost, ...rest }: VerifiedCapabilities) => JSON.stringify(rest);
  const first = resolved[0]!;
  // Ambiguous aliases are not resolved by guessing which upstream is behind the gateway.
  return resolved.every((candidate) => profile(candidate) === profile(first)) ? first : undefined;
};
