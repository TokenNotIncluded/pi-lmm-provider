import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model,
  type ProviderHeaders, type ProviderStreamOptions, type ProviderStreams, type StreamOptions,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from '@earendil-works/pi-ai/compat';
import type { Admission } from './catalog.ts';
import type { LmmHttp } from './http.ts';
import { PROVIDER_ID, LmmError, accessToken, object, requireValue, type LmmApi } from './protocol.ts';

const streams: Record<LmmApi, ProviderStreams> = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
};

/** Billable model requests are never replayed automatically. */
export const MAX_MODEL_REQUEST_RETRIES = 0;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;

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
      if (typeof value === 'number' && Number.isInteger(value)) return value;
    }
  }
  const match = message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function isTransportFailure(error: unknown): boolean {
  const message = errorText(error);
  const status = errorStatus(error, message);
  if (status !== undefined) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return /network|transport|disconnect|decod(?:e|ing)|response body|fetch failed|socket|timed out|stream ended before/i.test(message);
}

function publicErrorMessage(error: unknown, _retries = 0, outputStarted = false): string {
  const message = errorText(error);
  if (/\babort(?:ed|ing)\b|cancel(?:led|ed)|request aborted/i.test(message)) return 'LMM request cancelled.';
  if (/IP_ACCESS_ROUTE_REJECTED|IP access policy/i.test(message)) return 'LMM request was blocked by the current IP access policy. Change network or ask the administrator to allow this IP.';
  const status = errorStatus(error, message);
  if (status === 401) return 'LMM authorization expired or was revoked. Run /login again.';
  if (status === 403) return 'This LMM account is not allowed to use the selected model. Run /login again or choose another model.';
  if (status === 429) return 'LMM rate limit reached. Wait a moment and retry.';
  if (status !== undefined && status >= 500) return `LMM upstream is temporarily unavailable (HTTP ${status}). Try again shortly.`;
  if (isTransportFailure(error)) {
    if (outputStarted) return 'LMM stream disconnected after output started. The partial request was not replayed to avoid duplicate billing; try again.';
    return 'LMM stream disconnected before completion. The request was not replayed to avoid duplicate billing; try again manually.';
  }
  return 'LMM model request failed. Check authorization, account access, and server availability.';
}

async function waitForRetry(delay: number, signal: AbortSignal | undefined): Promise<void> {
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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

export function createRelay(http: LmmHttp, hooks: RelayHooks): ProviderStreams {
  const run = (simple: boolean, selected: Model<Api>, context: Context, options: StreamOptions = {}) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let access: string | undefined;
      let sent = false;
      let attempt = 0;
      let streamStarted = false;
      try {
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
        const path = api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
        const headers: ProviderHeaders = {
          authorization: `Bearer ${access}`, 'X-LMM-Group': entry.group_id,
          // Pi's Anthropic adapter passes apiKey:null when a Bearer header is used.
          // Null additionally deletes the SDK default instead of sending a conflicting key.
          'x-api-key': null,
        };
        const authorizedAccess = access;
        const guardedFetch: typeof fetch = async (input, init) => {
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
          return http.fetch(destination, { ...init, headers: actual, redirect: 'error', credentials: 'omit' });
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
        // A provider stream can fail after fetch() has returned, while its
        // response body is being decoded. Retry only if Pi has not received a
        // generation-start event yet; replaying after that point can duplicate
        // billable output. The source emits request failures as an `error`
        // event, so inspect it here instead of relying on a thrown exception.
        while (true) {
          const source = simple ? streams[api].streamSimple(wire, wireContext, wireOptions) : streams[api].stream(wire, wireContext, wireOptions);
          let retry = false;
          try {
            for await (const event of source) {
              if (event.type === 'start' || (event.type !== 'error' && event.type !== 'done')) streamStarted = true;
              if (event.type === 'error') {
                // Classify the provider's original error before rebind() removes
                // its raw message from the user-visible event.
                const shouldRetry = !streamStarted && isTransportFailure(event.error) && attempt < MAX_MODEL_REQUEST_RETRIES;
                const error = rebind(event.error, selected);
                if (shouldRetry) {
                  attempt += 1;
                  await waitForRetry(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)), options.signal);
                  retry = true;
                  break;
                }
                error.errorMessage = publicErrorMessage(event.error, attempt, streamStarted);
                output.push({ ...event, error });
                output.end(error);
                return;
              }
              output.push(rebindEvent(event, selected));
            }
          } catch (error) {
            if (!streamStarted && isTransportFailure(error) && attempt < MAX_MODEL_REQUEST_RETRIES) {
              attempt += 1;
              await waitForRetry(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)), options.signal);
              retry = true;
            } else {
              throw error;
            }
          }
          if (retry) continue;
          output.end(rebind(await source.result(), selected));
          break;
        }
      } catch (error) {
        const message = errorMessage(selected, options.signal?.aborted === true, error, attempt, streamStarted);
        if (error instanceof LmmError) message.errorMessage = error.message;
        output.push({ type: 'error', reason: options.signal?.aborted ? 'aborted' : 'error', error: message });
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
