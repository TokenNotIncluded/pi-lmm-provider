/** Additive OAuth catalog metadata. Null is unknown, never zero or unlimited. */
export interface ServerMetadata {
  context_window: number | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  gateway_max_output_tokens?: number | null;
  input_modalities: string[] | null;
  output_modalities: string[] | null;
  reasoning: boolean | null;
  tool_call: boolean | null;
  source: string;
}
export function parseMetadata(value: unknown): ServerMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid LMM model metadata.');
  const row = value as Record<string, unknown>;
  const limit = (key: string): number | null => {
    const n = row[key];
    if (n === undefined || n === null) return null;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid LMM model limit.');
    return n;
  };
  const flag = (key: string): boolean | null => {
    const n = row[key];
    if (n === undefined || n === null) return null;
    if (typeof n !== 'boolean') throw new Error('Invalid LMM model capability.');
    return n;
  };
  const modalities = (key: string): string[] | null => {
    const n = row[key];
    if (n === undefined || n === null) return null;
    if (!Array.isArray(n) || !n.every(x => typeof x === 'string')) throw new Error('Invalid LMM model modalities.');
    return [...n];
  };
  if (typeof row.source !== 'string') throw new Error('Invalid LMM metadata source.');
  return {context_window: limit('context_window'), max_input_tokens: limit('max_input_tokens'),
    max_output_tokens: limit('max_output_tokens'), gateway_max_output_tokens: limit('gateway_max_output_tokens'),
    input_modalities: modalities('input_modalities'),
    output_modalities: modalities('output_modalities'), reasoning: flag('reasoning'), tool_call: flag('tool_call'), source: row.source};
}
/** A maximum-input limit can constrain a conservative host budget; never add output to it. */
export function contextBudget(m: ServerMetadata): number | undefined {
  return m.context_window === null ? m.max_input_tokens ?? undefined : Math.min(m.context_window, m.max_input_tokens ?? Infinity);
}
export function textOutput(m: ServerMetadata): boolean {
  return m.input_modalities?.includes('text') === true && m.output_modalities?.length === 1 && m.output_modalities[0] === 'text';
}
