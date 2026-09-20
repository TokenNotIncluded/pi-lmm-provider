import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model,
  type ProviderHeaders, type ProviderStreamOptions, type ProviderStreams, type StreamOptions,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from '@earendil-works/pi-ai/compat';
import type { Admission } from './catalog.ts';
import { mergeCacheCompat } from './cache.ts';
import type { LmmHttp } from './http.ts';
import { PROVIDER_ID, LmmError, accessToken, object, requireValue, type LmmApi } from './protocol.ts';
import { MAX_MODEL_REQUEST_RETRIES, parseRetryAfter, retryDelay, waitForRetry } from './retry.ts';

export { MAX_MODEL_REQUEST_RETRIES } from './retry.ts';

const streams: Record<LmmApi, ProviderStreams> = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'errorMessage' in error && typeof error.errorMessage === 'string') return error.errorMessage;
  return '';
}

function errorStatus(error: unknown, message = errorText(error)): number | undefined {
  if (error && typeof error === 'object') {
    for (const key of ['status', 'statusCode']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) return value;
    }
  }
  // SDK error messages start with a status or explicitly label it as HTTP.
  // An unrelated number in a response body must not decide retry eligibility.
  const match = message.match(/^(?:HTTP\s+)?([45]\d{2})\b|\bHTTP\s+([45]\d{2})\b/i);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

function isAborted(error: unknown): boolean {
  if (error && typeof error === 'object') {
    if ('name' in error && error.name === 'AbortError') return true;
    if ('stopReason' in error && error.stopReason === 'aborted') return true;
  }
  return /\babort(?:ed|ing)\b|cancel(?:led|ed)/i.test(errorText(error));
}

function isTransportFailure(error: unknown): boolean {
  if (isAborted(error)) return false;
  const message = errorText(error);
  const status = errorStatus(error, message);
  if (status !== undefined) return [408, 425, 429, 500, 502, 503, 504].includes(status);
  return /network|transport|disconnect|decod(?:e|ing)|response body|fetch failed|socket|timed out|stream ended before/i.test(message);
}

function publicErrorMessage(error: unknown, retries = 0, outputStarted = false): string {
  if (isAborted(error)) return 'LMM request cancelled.';
  const status = errorStatus(error);
  const exhausted = retries >= MAX_MODEL_REQUEST_RETRIES ? ` All ${MAX_MODEL_REQUEST_RETRIES} retries were exhausted.` : '';
  if (status === 401) return 'LMM authorization expired or was revoked. Run /login again.';
  if (status === 403) return 'This LMM account is not allowed to use the selected model. Run /login again or choose another model.';
  if (status === 429) return `LMM rate limit reached. Wait a moment and retry.${exhausted}`;
  if (status !== undefined && status >= 500) return `LMM upstream is temporarily unavailable (HTTP ${status}). Try again shortly.${exhausted}`;
  if (isTransportFailure(error)) {
    if (outputStarted) return 'LMM stream disconnected after output started. The partial request was not replayed to avoid duplicate billing; try again.';
    return retries >= MAX_MODEL_REQUEST_RETRIES
      ? `LMM stream disconnected before completion after ${MAX_MODEL_REQUEST_RETRIES} retries. Try again later.`
      : 'LMM stream disconnected before completion. Retrying may succeed.';
  }
  return 'LMM model request failed. Check authorization, account access, and server availability.';
}

export function bearerFromHeaders(headers: ProviderHeaders | undefined): string {
  const values = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === 'authorization').map(([, value]) => value);
  requireValue(values.length === 1 && typeof values[0] === 'string' && values[0].startsWith('Bearer '), 'LMM model requests require native OAuth authorization.');
  return accessToken(values[0].slice(7));
}

function errorMessage(model: Model<Api>, aborted: boolean, error?: unknown, retries = 0, outputStarted = false): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: PROVIDER_ID, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: aborted ? 'LMM request cancelled.' : publicErrorMessage(error, retries, outputStarted),
    timestamp: Date.now(),
  };
}

function rebind(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  const result = { ...message, provider: PROVIDER_ID, model: model.id, api: model.api };
  // Upstream errors can echo headers / credentials. Never print raw provider errors.
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    result.errorMessage = result.stopReason === 'aborted' ? 'LMM request cancelled.' : publicErrorMessage(result.errorMessage);
  }
  return result;
}

function rebindEvent(event: AssistantMessageEvent, model: Model<Api>): AssistantMessageEvent {
  if (event.type === 'done') return { ...event, message: rebind(event.message, model) };
  if (event.type === 'error') return { ...event, error: rebind(event.error, model) };
  if ('partial' in event) return { ...event, partial: rebind(event.partial, model) };
  return event;
}

export interface RelayHooks {
  lookup(modelId: string, access: string): Admission | undefined;
  onFinish(access: string): Promise<void>;
}

export function createRelay(http: LmmHttp, hooks: RelayHooks, adapters: Readonly<Record<LmmApi, ProviderStreams>> = streams): ProviderStreams {
  const run = (simple: boolean, selected: Model<Api>, context: Context, options: StreamOptions = {}) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let access: string | undefined;
      let sent = false;
      let attempt = 0;
      let streamStarted = false;
      let providerAborted = false;
      let partial: AssistantMessage | undefined;
      let responseStatus: number | undefined;
      let responseRetryAfter: number | undefined;
      try {
        options.signal?.throwIfAborted();
        requireValue(options.apiKey === undefined, 'An API key must not be combined with LMM OAuth.');
        access = bearerFromHeaders(options.headers);
        const admission = hooks.lookup(selected.id, access);
        requireValue(admission?.model, 'This LMM model is no longer admitted by the current account catalog.');
        const { entry, model } = admission;
        requireValue(model && selected.provider === PROVIDER_ID && selected.api === model.api);
        if (options.maxTokens !== undefined) {
          requireValue(Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 && options.maxTokens <= model.maxTokens,
            'Requested output exceeds the verified LMM model capability.');
        }
        const api = model.api;
        const wire: Model<Api> = { ...structuredClone(model), id: entry.upstream_model, headers: undefined };
        wire.compat = mergeCacheCompat(wire.compat, selected.compat);
        const path = api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
        const headers: ProviderHeaders = {
          authorization: `Bearer ${access}`, 'X-LMM-Group': entry.group_id,
          // Pi's Anthropic adapter passes apiKey:null when a Bearer header is used.
          // Null additionally deletes the SDK default instead of sending a conflicting key.
          'x-api-key': null,
        };
        const authorizedAccess = access;
        const guardedFetch: typeof fetch = async (input, init) => {
          options.signal?.throwIfAborted();
          const target = input instanceof Request ? input.url : String(input);
          const endpoint = `${http.issuer}${path}`;
          // The Anthropic SDK adds this transport flag to its beta endpoint.
          // LMM carries beta features in headers and rejects relay query strings.
          const sdkBeta = api === 'anthropic-messages' && target === `${endpoint}?beta=true`;
          requireValue(target === endpoint || sdkBeta, 'LMM relay destination does not match its advertised protocol.');
          const actual = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          for (const name of ['x-api-key', 'api-key', 'proxy-authorization', 'cookie']) actual.delete(name);
          actual.set('authorization', `Bearer ${authorizedAccess}`);
          actual.set('x-lmm-group', entry.group_id);
          sent = true;
          const destination = sdkBeta ? (input instanceof Request ? new Request(endpoint, input) : endpoint) : input;
          const transportSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          const signal = options.signal && transportSignal ? AbortSignal.any([options.signal, transportSignal]) : options.signal ?? transportSignal;
          const response = await http.fetch(destination, { ...init, signal, headers: actual, redirect: 'error', credentials: 'omit' });
          // SDK error events often discard headers/status. Retain only safe
          // retry metadata here; never retain or log the upstream error body.
          responseStatus = response.ok ? undefined : response.status;
          responseRetryAfter = parseRetryAfter(response.headers.get('retry-after'));
          return response;
        };
        const originalOnPayload = options.onPayload;
        const wireOptions: ProviderStreamOptions = {
          ...options, apiKey: undefined, headers, env: {}, fetch: guardedFetch,
          maxTokens: options.maxTokens ?? model.maxTokens,
          // The relay owns retries so the SDK cannot replay a billable request.
          maxRetries: 0,
          onPayload: async (payload, payloadModel) => {
            const replacement = await originalOnPayload?.(payload, payloadModel);
            return { ...object(replacement ?? payload), model: entry.upstream_model, stream: true };
          },
        };
        const wireContext: Context = {
          ...context,
          messages: context.messages.map((message) => message.role === 'assistant' && message.provider === PROVIDER_ID && message.model === selected.id
            ? { ...message, model: entry.upstream_model } : message),
        };
        while (true) {
          options.signal?.throwIfAborted();
          responseStatus = undefined;
          responseRetryAfter = undefined;
          partial = undefined;
          try {
            // Creation, iteration and result decoding all belong to the same
            // attempt. Some adapters throw before returning an event stream.
            const source = simple ? adapters[api].streamSimple(wire, wireContext, wireOptions) : adapters[api].stream(wire, wireContext, wireOptions);
            for await (const event of source) {
              options.signal?.throwIfAborted();
              if (event.type === 'error') {
                if (event.error.content.length || !partial) partial = event.error;
                providerAborted = event.reason === 'aborted' || event.error.stopReason === 'aborted';
                // Use the same decision for SDK error events and thrown errors.
                throw event.error;
              }
              // Even `start` (and terminal-only output) permanently forbids a replay.
              streamStarted = true;
              if ('partial' in event) partial = event.partial;
              output.push(rebindEvent(event, selected));
            }
            const result = await source.result();
            if (result.stopReason === 'error' || result.stopReason === 'aborted') throw result;
            output.end(rebind(result, selected));
            break;
          } catch (error) {
            if (options.signal?.aborted || providerAborted || isAborted(error)) {
              providerAborted = true;
              throw error;
            }
            const failure = responseStatus === undefined || error instanceof LmmError
              ? error : { status: responseStatus, errorMessage: errorText(error) };
            const delay = !streamStarted && isTransportFailure(failure) ? retryDelay(attempt, responseRetryAfter) : undefined;
            if (delay === undefined) throw failure;
            attempt += 1;
            // A rejected wait escapes to the outer cancellation handler; it is
            // never mistaken for another failed model attempt.
            await waitForRetry(delay, options.signal);
          }
        }
      } catch (error) {
        const aborted = options.signal?.aborted === true || providerAborted || isAborted(error);
        const message = errorMessage(selected, aborted, error, attempt, streamStarted);
        if (partial) {
          message.content = partial.content;
          message.usage = partial.usage;
        }
        if (!aborted && error instanceof LmmError) message.errorMessage = error.message;
        output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
        output.end(message);
      } finally {
        if (sent && access) await hooks.onFinish(access).catch(() => {});
      }
    })();
    return output;
  };
  return {
    stream: (model, context, options) => run(false, model, context, options),
    streamSimple: (model, context, options) => run(true, model, context, options),
  };
}
