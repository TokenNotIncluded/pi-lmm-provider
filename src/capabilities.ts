import type { Api, Model, ModelCost, ThinkingLevel } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { CapabilityResolver, VerifiedCapabilities } from './catalog.ts';
import { SUPPORTED_APIS, type LmmApi } from './protocol.ts';
import { peekModelsDev, type ModelsDevCatalog } from './models-dev-cache.ts';

// Keep Pi protocol keys local: the native loader does not expose model-schema.
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[];

// Host profiles supply protocol details; account discovery never depends on a model allowlist.
const sources = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider).map(model => ({ provider, model })));
const validRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const budget = (...values: Array<number | null | undefined>): number =>
  values.find(value => Number.isSafeInteger(value) && value! > 0)!;

export function createCapabilityResolver(catalog: ModelsDevCatalog = peekModelsDev()): CapabilityResolver {
  return entry => {
    const reference = catalog.resolve(entry.upstream_model);
    const server = entry.metadata;
    const inputs = server?.input_modalities ?? reference?.modalities.input;
    const outputs = server?.output_modalities ?? reference?.modalities.output;
    if ((inputs && !inputs.includes('text')) || (outputs && !outputs.includes('text')) ||
        (reference?.type && reference.type !== 'chat')) return undefined;
    const ids = new Set([entry.upstream_model, reference?.id, reference?.canonical_model_id,
      reference?.canonical_model_id?.split('/').slice(1).join('/')]);
    const candidates = sources.filter(({ model }) => ids.has(model.id));
    const host = (candidates.find(({ provider }) => provider === reference?.provider) ?? candidates[0])?.model;
    const nativeApi = host?.api as LmmApi | undefined;
    const api = nativeApi && SUPPORTED_APIS.includes(nativeApi) && entry.apis.includes(nativeApi)
      ? nativeApi : entry.apis.find(api => SUPPORTED_APIS.includes(api));
    if (!api) return undefined;
    const context = budget(server?.context_window, server?.max_input_tokens, reference?.limit.context, host?.contextWindow, 32768);
    const inputLimit = budget(server?.max_input_tokens, reference?.limit.input, context);
    const contextWindow = Math.min(context, inputLimit);
    const maxTokens = Math.min(contextWindow, budget(server?.max_output_tokens, reference?.limit.output, host?.maxTokens, 4096));
    const reasoning = server?.reasoning ?? reference?.reasoning ?? host?.reasoning ?? false;
    const nativeProfile = host?.api === api;
    const compat: NonNullable<Model<Api>['compat']> = nativeProfile ? structuredClone(host?.compat ?? {}) : {};
    if (api === 'openai-completions') {
      Object.assign(compat, {
        supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: false,
        maxTokensField: 'max_tokens', ...compat,
        supportsReasoningEffort: reasoning, sendSessionAffinityHeaders: true,
      });
      if (reasoning && reference?.interleaved && typeof reference.interleaved === 'object' &&
          reference.interleaved.field === 'reasoning_content') {
        Object.assign(compat, { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' });
      }
    }
    if (!reasoning && 'supportsReasoningEffort' in compat) compat.supportsReasoningEffort = false;
    if ('allowedFallbackModels' in compat) delete compat.allowedFallbackModels;
    let thinkingLevelMap = reasoning && host?.thinkingLevelMap ? structuredClone(host.thinkingLevelMap) : undefined;
    const effort = reference?.reasoning_options?.flatMap(option => option.type === 'effort' ? option.values ?? [] : []);
    if (reasoning && effort?.length) {
      thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map(level => [level, effort.includes(level) ? level : null]));
    }
    const prices = entry.pricing.currency === 'USD' && entry.pricing.unit === 'million_tokens' ? entry.pricing : undefined;
    const ref = reference?.cost;
    const unknownCostFields: string[] = [];
    const rate = (field: string, actual: unknown, referenceRate: unknown): number => {
      if (validRate(actual)) return actual;
      if (validRate(referenceRate)) return referenceRate;
      unknownCostFields.push(field);
      return 0; // Required host field; labels and /lmm-prices disclose the missing estimate.
    };
    const referenceCost: ModelCost = {
      input: rate('input', prices?.input, ref?.input ?? host?.cost.input),
      output: rate('output', prices?.output, ref?.output ?? host?.cost.output),
      cacheRead: rate('cache_read', prices?.cache_read, ref?.cache_read ?? host?.cost.cacheRead),
      cacheWrite: rate('cache_write', prices?.cache_write, ref?.cache_write ?? host?.cost.cacheWrite),
    };
    return {
      api, contextWindow, maxTokens, reasoning,
      input: inputs?.includes('image') || (!inputs && host?.input.includes('image')) ? ['text', 'image'] : ['text'],
      compat, referenceCost, unknownCostFields, ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      provenance: server?.source || reference?.source || (host ? 'installed host metadata' : 'unknown; conservative generic budgets'),
    } satisfies VerifiedCapabilities;
  };
}

export const resolveKnownCapabilities: CapabilityResolver = entry => createCapabilityResolver()(entry);
