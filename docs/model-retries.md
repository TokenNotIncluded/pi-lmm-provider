# Model request retries

The relay makes at most six attempts: the original request and five retries. Only failures before the first Pi stream event can be retried. A `start` event already closes this window, even without text. Partial text and usage are retained when a later decode/transport exception ends the response; the partial request is not replayed.

Retryable HTTP statuses are 408, 425, 429, 500, 502, 503 and 504. Network and response-body decoding failures before the first event use the same budget, whether an adapter throws or emits an error event. Authentication failures and cancellation are not retried. SDK retries remain disabled, so nested retry loops cannot multiply the attempt budget. The final error is redacted and reports exhaustion; upstream bodies, headers and credentials are not printed.

Without `Retry-After`, delays are 250, 500, 1000, 2000 and 4000 milliseconds. Valid whole-second and HTTP-date `Retry-After` values replace the backoff, including zero. Malformed values use normal backoff. If the server asks for more than 60 seconds, automatic retry stops rather than shortening that delay or keeping a long-lived timer. This also avoids timer overflow from extremely large values.

Cancellation stops pending retry waits and is propagated into in-flight fetches. A request cancelled before it starts never constructs a provider stream. Balance refresh runs once after a logical request that reached fetch, not once per attempt.

Tests use fake transports and Pi event streams, not paid model calls. `test/relay-protocols.test.ts` additionally exercises the installed OpenAI Responses and Anthropic adapters against SSE fixtures. These tests do not constitute a live-service or real-account acceptance test.
