import snapshot from './models-dev.json' with { type: 'json' };
import type { LmmApi } from './protocol.ts';

/** Reviewed SDK adapters, not model-name or family guesses. Unknown adapters stay gated. */
export function parseMetadataTransport(npm: unknown): LmmApi | undefined {
  switch (npm) {
    case '@ai-sdk/openai': return 'openai-responses';
    case '@ai-sdk/openai-compatible': return 'openai-completions';
    case '@ai-sdk/anthropic': return 'anthropic-messages';
    default: return undefined;
  }
}

export function resolveMetadataTransport(provider: string, id: string): LmmApi | undefined {
  const records = (snapshot as { transports?: Record<string, Record<string, LmmApi>> }).transports;
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
export const metadataProviders = ['openai', 'anthropic', 'deepseek', 'xai', 'moonshotai', 'minimax', 'google', 'zai'] as const;

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

export function resolveModelMetadata(provider: string, id: string): ModelMetadata | undefined {
  const records = snapshot.providers as Record<string, Record<string, ModelMetadata>>;
  const metadata = Object.hasOwn(records, provider) && Object.hasOwn(records[provider]!, id) ? records[provider]![id] : undefined;
  return metadata ? structuredClone(metadata) : undefined;
}

/** A rejected exact vendor entry must not reappear through an Azure/Vertex alias. */
export function isExcludedModelMetadata(provider: string, id: string): boolean {
  const excluded = (snapshot as { excluded?: Record<string, string[]> }).excluded;
  return !!excluded && Object.hasOwn(excluded, provider) && excluded[provider]!.includes(id);
}

export const metadataProvenance = `models.dev (${snapshot.fetchedAt})`;
