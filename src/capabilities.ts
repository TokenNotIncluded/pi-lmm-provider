import type { Api, Model } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { CapabilityResolver, VerifiedCapabilities } from './catalog.ts';
import { SUPPORTED_APIS, type LmmApi } from './protocol.ts';
import { bundledMetadata, isExcludedModelMetadata, resolveMetadataTransport, resolveModelMetadata, type MetadataSnapshot, type ModelMetadata } from './models-dev.ts';
import { matchModelMetadata, type MetadataMatch } from './model-matching.ts';

type Source = readonly [BuiltinProvider, ReadonlyMap<string, Model<Api>>];
const LANGUAGE_APIS: readonly Api[] = [
  'anthropic-messages', 'azure-openai-responses', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex',
  'mistral-conversations', 'openai-codex-responses', 'openai-completions', 'openai-responses',
];

// Bundled vendor profiles define compatibility priority, not model admission.
// Providers absent here are still discovered from the runtime public directory.
const preferredSources: readonly Source[] = getBuiltinProviders()
  .filter((provider) => Object.hasOwn(bundledMetadata.providers, provider)).map((provider) => [
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

function candidates(entry: Parameters<CapabilityResolver>[0], sources: readonly Source[], data: MetadataSnapshot, matchedMetadata?: ModelMetadata): VerifiedCapabilities[] {
  const result: VerifiedCapabilities[] = [];
  for (const [provider, models] of sources) {
    const builtin = models.get(entry.upstream_model);
    if (!builtin) continue;
    // Existing Pi profiles retain their reviewed protocol controls; fresh public
    // metadata updates their capacity without copying provider URLs or credentials.
    const metadata = resolveModelMetadata(provider, builtin.id, data) ?? matchedMetadata;
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
      provenance: `pi-ai vendor catalog: ${provider}/${model.id}${metadata ? `; models.dev (${data.fetchedAt}) capacities` : ''}${nativeProtocol ? '' : '; server-advertised OpenAI-compatible transport'}`,
    });
  }
  return result;
}

/** New directory entries use LMM's advertised transport and a portable text profile.
 * models.dev's reasoning flag alone does not describe a vendor's thinking controls.
 */
function metadataCapabilities(entry: Parameters<CapabilityResolver>[0], match: Extract<MetadataMatch, { status: 'matched' }>, data: MetadataSnapshot): VerifiedCapabilities | undefined {
  const protocols = match.candidates.map(({ provider, id }) => resolveMetadataTransport(provider, id, data));
  const api = entry.apis.find((candidate) => protocols.includes(candidate)) ??
    (entry.apis.includes('openai-completions') ? 'openai-completions' : undefined);
  if (!api) return undefined;
  const { metadata } = match;
  return {
    api, contextWindow: metadata.contextWindow, maxTokens: metadata.maxTokens,
    reasoning: false, input: ['text'],
    compat: api === 'openai-completions' ? {
      supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false,
      supportsStrictMode: false, maxTokensField: 'max_tokens', sendSessionAffinityHeaders: true,
    } : {},
    provenance: `models.dev (${data.fetchedAt}); ${match.kind} model match; server-advertised ${api}; restricted text profile (reasoning and images disabled); LMM native cost required`,
  };
}

function builtinCapabilities(entry: Parameters<CapabilityResolver>[0], data: MetadataSnapshot, metadata?: ModelMetadata): VerifiedCapabilities | undefined {
  const matches = candidates(entry, preferredSources, data, metadata);
  const knownPreferred = preferredSources.some(([, models]) => models.has(entry.upstream_model));
  const resolved = knownPreferred ? matches : candidates(entry, fallbackSources, data, metadata);
  const profile = ({ provenance: _source, referenceCost: _cost, ...rest }: VerifiedCapabilities) => JSON.stringify(rest);
  const first = resolved[0];
  return first && resolved.every((candidate) => profile(candidate) === profile(first)) ? first : undefined;
}

/** The server grants models; models.dev names supply metadata, never replacement wire IDs. */
export function resolveKnownCapabilities(entry: Parameters<CapabilityResolver>[0], data = bundledMetadata): VerifiedCapabilities | undefined {
  if (preferredSources.some(([provider]) => isExcludedModelMetadata(provider, entry.upstream_model, data))) return undefined;
  const exact = builtinCapabilities(entry, data);
  // A proxy's missing fields must not veto a reviewed direct Pi profile.
  if (exact && preferredSources.some(([, models]) => models.has(entry.upstream_model))) return exact;
  const match = matchModelMetadata(entry.upstream_model, data);
  if (match && match.status !== 'matched') return undefined;
  if (exact) return exact;
  if (!match || match.status !== 'matched') return undefined;
  // A normalized spelling can reuse the same model's installed Pi profile. A
  // different version/size/variant cannot reach this path through fuzzy guessing.
  for (const id of [...new Set(match.candidates.flatMap((candidate) =>
    candidate.canonicalId ? [candidate.id, candidate.canonicalId.split('/').at(-1)!] : [candidate.id]))].sort()) {
    if (id === entry.upstream_model) continue;
    const known = builtinCapabilities({ ...entry, upstream_model: id }, data, match.metadata);
    if (known) return { ...known, provenance: `${known.provenance}; models.dev ${match.kind} name match` };
  }
  return metadataCapabilities(entry, match, data);
}
