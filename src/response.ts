import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { LmmApi } from './protocol.ts';

export interface RelayDiagnostics {
  requestedModel: string;
  api: LmmApi;
  reasoningEffort?: string;
  reportedModels: string[];
  recoveredThinking: boolean;
}
export type DiagnosticMessage = AssistantMessage & { lmmDiagnostics?: RelayDiagnostics };

/** Recognize only an exact leading wrapper, never tags inside prose or fences. */
class LeadingThinking {
  private mode: 'prefix' | 'thinking' | 'text' = 'prefix';
  private pending = '';
  recovered = false;

  push(value: string, final = false): { text: string; thinking: string } {
    let text = '', thinking = '';
    this.pending += value;
    if (this.mode === 'prefix') {
      const trimmed = this.pending.trimStart();
      if (trimmed.startsWith('<thinking>')) {
        this.pending = trimmed.slice('<thinking>'.length);
        this.mode = 'thinking';
        this.recovered = true;
      } else if (final || this.pending.length > 128 || !'<thinking>'.startsWith(trimmed)) {
        this.mode = 'text';
      } else return { text, thinking };
    }
    if (this.mode === 'thinking') {
      const closing = '</thinking>';
      const end = this.pending.indexOf(closing);
      if (end >= 0) {
        thinking = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + closing.length);
        this.mode = 'text';
      } else {
        let hold = 0;
        if (!final) {
          for (let length = 1; length < closing.length; length++) {
            if (this.pending.endsWith(closing.slice(0, length))) hold = length;
          }
        }
        thinking = this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
      }
    }
    if (this.mode === 'text') {
      text = this.pending;
      this.pending = '';
    }
    return { text, thinking };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function reportedModel(value: unknown): value is string {
  // Only a bounded model identifier is retained; no raw SSE, headers or payloads.
  return typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(value)
    && !/(?:\bBearer\s+|\bAuthorization\b|lmm_at_|lmm_rt_|(?:^|[\s:/])sk[-_])/i.test(value);
}

/** Pass SSE through while repairing leading thinking wrappers before Pi parses it. */
export function inspectResponse(response: Response, diagnostics: RelayDiagnostics): Response {
  if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let passthrough = false;
  const choices = new Map<number, LeadingThinking>();
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, value: string) => controller.enqueue(encoder.encode(value));
  const remember = (value: unknown) => {
    if (reportedModel(value) && !diagnostics.reportedModels.includes(value) && diagnostics.reportedModels.length < 8) diagnostics.reportedModels.push(value);
  };
  const apply = (delta: Record<string, unknown>, result: { text: string; thinking: string }) => {
    delta.content = result.text;
    if (result.thinking) {
      const field = ['reasoning_content', 'reasoning', 'reasoning_text'].find((key) => typeof delta[key] === 'string' && delta[key]) ?? 'reasoning_content';
      delta[field] = String(delta[field] ?? '') + result.thinking;
    }
  };
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const [index, state] of choices) {
      const result = state.push('', true);
      if (result.text || result.thinking) {
        const delta = {};
        apply(delta, result);
        emit(controller, `data: ${JSON.stringify({ choices: [{ index, delta, finish_reason: null }] })}\n\n`);
      }
    }
  };
  const frame = (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = raw.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (data === '[DONE]') {
      finish(controller);
      emit(controller, raw + '\n\n');
      return;
    }
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(data)); } catch { /* Preserve malformed/provider-specific frames for Pi to handle. */ }
    if (!body) { emit(controller, raw + '\n\n'); return; }
    remember(body.model);
    remember(record(body.response)?.model);
    remember(record(body.message)?.model);
    let changed = false;
    if (diagnostics.api === 'openai-completions' && Array.isArray(body.choices)) {
      for (const item of body.choices) {
        const choice = record(item), delta = record(choice?.delta);
        if (!choice || !delta) continue;
        const index = typeof choice.index === 'number' ? choice.index : 0;
        let state = choices.get(index);
        if (!state) { state = new LeadingThinking(); choices.set(index, state); }
        const final = choice.finish_reason != null || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
        if (typeof delta.content === 'string' || final) {
          apply(delta, state.push(typeof delta.content === 'string' ? delta.content : '', final));
          diagnostics.recoveredThinking ||= state.recovered;
          changed = true;
        }
      }
    }
    if (changed) {
      const other = lines.filter((line) => !line.startsWith('data:'));
      emit(controller, [...other, `data: ${JSON.stringify(body)}`].join('\n') + '\n\n');
    } else emit(controller, raw + '\n\n');
  };
  const abandonRepair = (controller: TransformStreamDefaultController<Uint8Array>) => {
    // An uninspected event may close a wrapper. Flush previously held characters
    // before passing it through, then stop recovery for the rest of this stream
    // rather than guess the state of later assistant text.
    finish(controller);
    choices.clear();
    emit(controller, pending);
    pending = '';
    passthrough = true;
  };
  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final = false) => {
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      if (match.index > 1_000_000) { abandonRepair(controller); return; }
      const raw = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      frame(raw, controller);
    }
    // Bound malformed/huge events without disrupting transport. Subsequent
    // events must also pass through because wrapper state is now unknown.
    if (pending.length > 1_000_000) {
      abandonRepair(controller);
      return;
    }
    if (final) {
      if (pending) frame(pending, controller);
      pending = '';
      finish(controller);
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const value = decoder.decode(chunk, { stream: true });
      if (passthrough) emit(controller, value);
      else { pending += value; drain(controller); }
    },
    flush(controller) {
      const value = decoder.decode();
      if (passthrough) emit(controller, value);
      else { pending += value; drain(controller, true); }
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function diagnosticsReport(value: RelayDiagnostics): string {
  return [
    `Requested model: ${value.requestedModel}`,
    `Protocol: ${value.api}`,
    `Sent reasoning_effort: ${value.reasoningEffort ?? 'not sent (another protocol may use a different thinking parameter)'}`,
    `Gateway-reported model: ${value.reportedModels.join(', ') || 'not reported'}`,
    `Leading thinking wrapper recovered: ${value.recoveredThinking ? 'yes' : 'no'}`,
    'Gateway model names are declarations, not proof of the backing model. Different names may be aliases or snapshots.',
  ].join('\n');
}
