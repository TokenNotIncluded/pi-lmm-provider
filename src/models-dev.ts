import snapshot from './models-dev.json' with { type: 'json' };
import type { LmmApi } from './protocol.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface MetadataSnapshot {
  source: string;
  fetchedAt: string;
  sourceSha256: string;
  license: string;
  providers: Record<string, Record<string, ModelMetadata>>;
  excluded: Record<string, string[]>;
  transports?: Record<string, Record<string, LmmApi>>;
  names?: Record<string, Record<string, string>>;
  canonicalIds?: Record<string, Record<string, string>>;
}

export const bundledMetadata = snapshot as MetadataSnapshot;

/** Reviewed SDK adapters, not model-name or family guesses. Unknown adapters stay gated. */
export function parseMetadataTransport(npm: unknown): LmmApi | undefined {
  switch (npm) {
    case '@ai-sdk/openai': return 'openai-responses';
    case '@ai-sdk/openai-compatible': return 'openai-completions';
    case '@ai-sdk/anthropic': return 'anthropic-messages';
    default: return undefined;
  }
}

export function resolveMetadataTransport(provider: string, id: string, data = bundledMetadata): LmmApi | undefined {
  const records = data.transports;
  return records && Object.hasOwn(records, provider) && Object.hasOwn(records[provider]!, id)
    ? records[provider]![id] : undefined;
}

/** models.dev supplies conservative capacities, not transport flags or account prices. */
export interface ModelMetadata {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
}

/** Reject partial/non-chat records instead of inventing limits or capabilities. */
export function parseModelMetadata(value: unknown): ModelMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const limit = record.limit as Record<string, unknown> | undefined;
  const modalities = record.modalities as Record<string, unknown> | undefined;
  if (!limit || !modalities || (record.type !== undefined && record.type !== 'chat') ||
      record.tool_call !== true || typeof record.reasoning !== 'boolean' ||
      !Array.isArray(modalities.output) || modalities.output.length !== 1 || modalities.output[0] !== 'text' ||
      !Array.isArray(modalities.input) || !modalities.input.includes('text') ||
      !Number.isSafeInteger(limit.context) || (limit.context as number) <= 0 ||
      !Number.isSafeInteger(limit.output) || (limit.output as number) <= 0 ||
      (limit.output as number) > (limit.context as number) ||
      (limit.input !== undefined && (!Number.isSafeInteger(limit.input) || (limit.input as number) <= 0))) return undefined;
  // Pi has one context limit, not a separate maximum-input-token field. Cap it
  // conservatively so compaction cannot permit input beyond a known input limit.
  const contextWindow = Math.min(limit.context as number, limit.input === undefined ? Infinity : limit.input as number);
  return {
    contextWindow, maxTokens: Math.min(limit.output as number, contextWindow),
    reasoning: record.reasoning,
    // Pi chat accepts text and images, not models.dev's audio/video/PDF types.
    input: modalities.input.includes('image') ? ['text', 'image'] : ['text'],
  };
}

export function resolveModelMetadata(provider: string, id: string, data = bundledMetadata): ModelMetadata | undefined {
  const records = data.providers;
  const metadata = Object.hasOwn(records, provider) && Object.hasOwn(records[provider]!, id) ? records[provider]![id] : undefined;
  return metadata ? structuredClone(metadata) : undefined;
}

/** A rejected exact vendor entry must not reappear through an Azure/Vertex alias. */
export function isExcludedModelMetadata(provider: string, id: string, data = bundledMetadata): boolean {
  const excluded = data.excluded;
  return !!excluded && Object.hasOwn(excluded, provider) && excluded[provider]!.includes(id);
}


function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/** The public directory supplies providers and models; there is no vendor allowlist. */
export function parseMetadataCatalog(value: unknown, fetchedAt: string, sourceSha256: string): MetadataSnapshot {
  if (!record(value) || !Object.keys(value).length || !Number.isFinite(Date.parse(fetchedAt)) ||
      !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Invalid models.dev catalog');
  const providers: MetadataSnapshot['providers'] = Object.create(null);
  const excluded: MetadataSnapshot['excluded'] = Object.create(null);
  const transports: NonNullable<MetadataSnapshot['transports']> = Object.create(null);
  const names: NonNullable<MetadataSnapshot['names']> = Object.create(null);
  const canonicalIds: NonNullable<MetadataSnapshot['canonicalIds']> = Object.create(null);
  let accepted = 0;
  for (const [provider, section] of Object.entries(value)) {
    if (!identifier(provider) || !record(section) || !record(section.models)) throw new Error('Invalid models.dev provider');
    const records: Record<string, ModelMetadata> = Object.create(null);
    const protocols: Record<string, LmmApi> = Object.create(null);
    const labels: Record<string, string> = Object.create(null);
    const identities: Record<string, string> = Object.create(null);
    const rejected: string[] = [];
    for (const [id, model] of Object.entries(section.models)) {
      if (!identifier(id) || !record(model) || model.id !== id) throw new Error('Invalid models.dev model ID');
      if (typeof model.name === 'string' && identifier(model.name)) labels[id] = model.name;
      if (typeof model.canonical_model_id === 'string' && identifier(model.canonical_model_id)) {
        identities[id] = model.canonical_model_id;
      }
      const metadata = parseModelMetadata(model);
      if (!metadata) { rejected.push(id); continue; }
      records[id] = metadata;
      accepted++;
      // An explicit unknown model adapter must not inherit a provider adapter.
      const npm = record(model.provider) && Object.hasOwn(model.provider, 'npm') ? model.provider.npm : section.npm;
      const transport = parseMetadataTransport(npm);
      if (transport) protocols[id] = transport;
    }
    providers[provider] = records;
    excluded[provider] = rejected;
    transports[provider] = protocols;
    names[provider] = labels;
    canonicalIds[provider] = identities;
  }
  if (!accepted) throw new Error('No valid models.dev chat metadata');
  return { source: MODELS_DEV_URL, fetchedAt, sourceSha256, license: 'MIT; see models-dev.LICENSE',
    providers, excluded, transports, names, canonicalIds };
}
