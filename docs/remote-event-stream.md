# Pi remote event-stream contract

This client requires a separately deployed public OAuth event endpoint. The Go
internal SSE foundation is not sufficient: it is not registered publicly and
has no public OAuth adapter. Nothing here claims production support or changes
OAuth consent, model credentials, billing, the UI codec or backend registration.

## Backend obligations

- `GET /api/remote-control/v1/pi/sessions/{session_id}/events?after=N&generation=G`
  authenticates `Authorization: Bearer …` for the existing `remote:control`
  permission, account and grant. Never accept tokens or PINs in query parameters.
  Reply `Content-Type: text/event-stream`; redirects are not followed.
- Emit `event: ready` with JSON `data: {"generation":"…","messages":[…]}`.
  Subscription and initial backlog must be race-free. With the requested current
  generation, return history after the supplied sequence cursor. With a generation
  mismatch (including the first empty generation), return the current generation
  and history after zero. No command may fall between backlog capture and stream
  subscription. Each batch has at most 128 envelopes.
- Emit `event: messages` with the same `{generation,messages}` structure and
  generation. Existing v1 opaque envelopes retain `sequence`, `sender`,
  `created_at`, canonical base64url `nonce` and `ciphertext`; encryption AAD and
  command validation are unchanged. Sequence numbers are positive safe integers,
  monotonic within a generation. `ready` must precede `messages`, once per stream.
- Emit generic `event: error` JSON `{"code":"unauthorized"}` or
  `{"code":"remote_unavailable"}` and close when authorization/service fails.
  No credential, PIN or private upstream error belongs in event data or logs.
  HTTP 401/403 and 429 with Retry-After are also supported before stream acceptance.
- Lease each stream for 60 seconds. Reauthorize freshly before every message batch
  and every keepalive, with comment keepalives no more than 15 seconds apart.
  Revocation/account/grant changes must invalidate the stream promptly. Comments
  do **not** extend the two-minute session TTL; only authenticated PUT heartbeat
  registration does. Keep existing encrypted POST, PUT and DELETE semantics.
- Deploy public OAuth routing/authorization and the matching relay independently;
  unsupported servers stop this client, not fall back to legacy GET polling.

## Client constraints

Resources start only on explicit remote enablement/session lifecycle, never in
the extension factory. Start registers with PUT, then runs independent inbound
and outbound loops and waits for validated first readiness. Registration and
startup are bounded by ordinary HTTP timeouts. An accepted body instead has a
20-second inactivity watchdog and a 75-second local safety lease (the server
should close at 60 seconds). EOF, timeout and transient failures reconnect with
fresh access resolution and exponential 1–30 second backoff; Retry-After is a
hard minimum, not interrupted by publication or heartbeat.

The bearer token is header-only, under the trusted LmmHttp origin; redirects
error, credentials are omitted and responses are not cached. The SSE parser
supports CR/LF/CRLF and split UTF-8 chunks, rejects malformed Unicode, caps each
frame at 12 MiB and 4096 lines, and cancels its reader on any exit. Unknown event
names are ignored within the same bounds. Only named `ready`, `messages`, and
`error` are interpreted; malformed batch structures force reconnect. JSON HTTP
error bodies are separately bounded to 64,000 bytes and cancelled, with generic
status classification preserved.

Generation reset is authoritative only at stream `ready`; PUT never resets a
cursor or signals connection. The replay-ID guard survives generation changes
(2048 live IDs, five-minute retention, refusal rather than live-ID eviction).
Foreign or undecryptable envelopes do not advance the command cursor; a bounded
batch is sorted by sequence so malformed high sequences cannot hide valid later
entries. Successful decryption still uses the existing strict command parser.

Outgoing events are bounded to 128 queued entries and 48 KiB plaintext each;
snapshot IDs coalesce. Publication wakes the scheduler immediately, with eight
POSTs per pass and a yield for fairness. Empty queues wait for heartbeat or a
publisher, not periodic flush scans. Outbound failures cannot block abort/UI
receive, and stream reads cannot block reports. Heartbeats publish fresh state.
Assistant callbacks coalesce at 250 ms with a trailing latest value; message-end
flushes immediately. No SessionManager polling is involved.

An unauthorized old stream can retry **once** with a different freshly resolved
access token if the existing owner-session binding passes. Same/absent/revoked or
account-changed credentials terminate both loops, clear key/queue and report a
generic local warning. No new OAuth flow or API-key fallback is implemented.
Stop is idempotent, cancels the reader/timers/waits, awaits both loops and pending
startup, suppresses late command/UI callbacks and attempts DELETE at most once
with a three-second timeout. User PIN and key remain in client memory; local PIN
notifications are deliberately not session/model messages.

## Local validation and prior work attribution

Base HEAD: `08976856ebe1b60e21acebcc42d8f3227b0a4345`. Before this task,
`src/remote-client.ts` and `test/remote-rate-limit.test.mjs` were already dirty
(47 and 46 changed lines respectively). The task snapshot is kept locally at
`/tmp/pi-lmm-sse-work/initial.diff` and `initial.sha256`, not staged or transmitted.
Initial SHA-256 values:

- `src/remote-client.ts`: `8f8247676428f2f5898df3d36ab7c674fa2f6316b9a5b2011be2634ae86ec10e`
- `test/remote-rate-limit.test.mjs`: `eae4f8dd0643017dafc5a42b49e7da92d467e555655252a4e2fc743ddb39b35b`

The prior outbound wake, queue coalescing and hard rate-limit cooldown protections
are retained. Its polling/idle-backoff cadence is deliberately superseded by SSE;
rate tests now prove one open idle stream and zero GET messages, while retaining
cooldown/stop and immediate-publication assertions. The original encrypted SDK,
image, account-auth and local-dialog assertions remain in place. No commit,
publish, Pi reload or production API call is part of this task.
