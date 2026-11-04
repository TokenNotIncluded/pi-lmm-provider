import { bundledMetadata, type MetadataSnapshot, type ModelMetadata } from './models-dev.ts';

/** Ignore presentation differences, retaining every version, size and variant token. */
export function modelNameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().split('/').map((part) =>
    (part.match(/[\p{L}]+|[\p{N}]+/gu) ?? []).join('-')).join('/');
}

export interface MetadataCandidate {
  provider: string;
  id: string;
  canonicalId?: string;
  metadata?: ModelMetadata;
}

export type MetadataMatch =
  | { status: 'matched'; kind: 'exact' | 'normalized'; candidates: MetadataCandidate[]; metadata: ModelMetadata }
  | { status: 'excluded' | 'ambiguous' };

type Index = Map<string, MetadataCandidate[]>;
const indexes = new WeakMap<MetadataSnapshot, { exact: Index; normalized: Index; aliases: Index }>();

function add(index: Index, key: string, row: MetadataCandidate): void {
  if (!key) return;
  const entries = index.get(key);
  if (!entries) index.set(key, [row]);
  else if (!entries.includes(row)) entries.push(row);
}

function directory(data: MetadataSnapshot) {
  const cached = indexes.get(data);
  if (cached) return cached;
  const exact: Index = new Map();
  const normalized: Index = new Map();
  const aliases: Index = new Map();
  for (const [provider, models] of Object.entries(data.providers)) {
    const excluded = Object.hasOwn(data.excluded, provider) ? data.excluded[provider]! : [];
    const canonical = data.canonicalIds && Object.hasOwn(data.canonicalIds, provider) ? data.canonicalIds[provider] : undefined;
    for (const id of new Set([...Object.keys(models), ...excluded])) {
      const canonicalId = canonical && Object.hasOwn(canonical, id) ? canonical[id] : undefined;
      const row: MetadataCandidate = { provider, id, canonicalId, metadata: Object.hasOwn(models, id) ? models[id] : undefined };
      for (const key of [id, `${provider}/${id}`]) {
        add(exact, key, row);
        add(normalized, modelNameKey(key), row);
      }
      add(aliases, modelNameKey(id.split('/').at(-1)!), row);
      if (canonicalId) {
        add(aliases, modelNameKey(canonicalId), row);
        add(aliases, modelNameKey(canonicalId.split('/').at(-1)!), row);
      }
      const names = data.names && Object.hasOwn(data.names, provider) ? data.names[provider] : undefined;
      const name = names && Object.hasOwn(names, id) ? names[id] : undefined;
      if (name) {
        add(aliases, modelNameKey(name), row);
        add(aliases, modelNameKey(`${provider}/${name}`), row);
      }
    }
  }
  const result = { exact, normalized, aliases };
  indexes.set(data, result);
  return result;
}

/** Match metadata only. The selected LMM model ID is never replaced or routed elsewhere. */
export function matchModelMetadata(id: string, data = bundledMetadata): MetadataMatch | undefined {
  const index = directory(data);
  const exact = index.exact.get(id);
  let candidates = exact ?? index.normalized.get(modelNameKey(id)) ?? index.aliases.get(modelNameKey(id));
  if (!candidates) return undefined;
  const canonical = candidates.filter((row) => row.canonicalId);
  const identities = new Set((canonical.length ? canonical : candidates).map((row) =>
    modelNameKey(row.canonicalId ?? `${row.provider}/${row.id}`)));
  if (identities.size !== 1) return { status: 'ambiguous' };
  if (canonical.length) {
    // Prefer the canonical lab's own entry over incomplete proxy offerings.
    const direct = canonical.filter((row) => modelNameKey(row.provider) === modelNameKey(row.canonicalId!.split('/')[0]!));
    candidates = direct.length ? direct : canonical.filter((row) => row.metadata);
  }
  if (!candidates.length || candidates.some((row) => !row.metadata)) return { status: 'excluded' };
  // Providers can impose different limits on the same model. Use their intersection,
  // never whichever record happened to appear first in a remote JSON object.
  const metadata = candidates.map((row) => row.metadata!);
  const contextWindow = Math.min(...metadata.map((row) => row.contextWindow));
  return {
    status: 'matched', kind: exact ? 'exact' : 'normalized', candidates,
    metadata: {
      contextWindow, maxTokens: Math.min(contextWindow, ...metadata.map((row) => row.maxTokens)),
      reasoning: metadata.every((row) => row.reasoning),
      input: metadata.every((row) => row.input.includes('image')) ? ['text', 'image'] : ['text'],
    },
  };
}
