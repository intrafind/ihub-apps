# LLMClient — the one way to call a model

Every language-model call in the server goes through `LLMClient`
(`server/services/loop/LLMClient.js`): chat, workflow and agent nodes, the
OpenAI-compatible inference API, admin utilities (translate, model test,
`/api/completions`), title generation, OCR and the MCP app gateway. There is no
second code path that builds provider requests or parses provider responses,
and an ESLint rule (`no-restricted-imports` in `eslint.config.js`) keeps it that
way: importing `createCompletionRequest` or `convertResponseToGeneric` outside
`server/services/loop/` and `server/adapters/` is a lint error.

This page is for developers adding a caller or debugging a call. Operators find
the runtime knobs in [Server Configuration](server-config.md) and
[Environment Variables](environment-variables.md).

## What the client owns

| Concern                | Behaviour                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model lookup           | `findModel(id, { includeDisabled })`, `resolveModel({ modelId, preferredIds, includeDisabled, requireTextCapable, fallbackToDefault })` over the live catalog |
| API keys               | Resolved internally through `ApiKeyVerifier` (model key → provider key → env). Missing key → `LLMError` `AUTH_FAILED`                                        |
| Request construction   | Through the adapter registry, always awaited (some adapters auto-discover model ids)                                                                          |
| Output cap             | `options.maxTokens` defaults to the model's `maxOutputTokens`                                                                                                |
| Throttling             | Per-model concurrency / delay via `requestThrottler` (`model.concurrency`, `model.requestDelayMs`, `platform.requestConcurrency`)                             |
| Retries                | 429 and 5xx and network faults are retried with exponential backoff; `Retry-After` is honoured. Aborts are never retried                                     |
| Streaming              | Every adapter's own `parseResponseStream` (SSE, Bedrock binary EventStream, iAssistant blocks) normalized to one chunk shape                                  |
| Non-streaming          | `stream: false` sends one request and yields one complete chunk                                                                                              |
| Errors                 | Always an `LLMError` with a canonical `code` (below)                                                                                                          |
| Usage                  | Normalized to `{ promptTokens, completionTokens, totalTokens, cacheReadTokens?, reasoningTokens?, source }` from any provider spelling                        |
| Tool-call accumulation | Streamed argument fragments are merged into one call per index (`collect()`)                                                                                 |
| Ledger                 | One `request/header` event per call (plus `request/retry`, `error`) when a `runId` is given; single-shot calls open their own small run                      |
| Telemetry              | One GenAI OpenTelemetry span per call                                                                                                                         |
| Diagnostics            | `LLM_DEBUG_DUMP_ALL=1` dumps every request; non-transient 4xx failures dump request and response to `contents/data/debug/llm-failures/`                      |

## API

```js
import llmClient, {
  usageToBudget,
  usageToOpenAI,
  extractJson,
  isLLMError,
  LLM_ERROR_CODES
} from '../services/loop/LLMClient.js';

// Single shot: execute + collect.
const result = await llmClient.complete({
  modelId: 'gpt-4o', // or model: <resolved model object>
  messages: [{ role: 'user', content: 'Hello' }],
  options: { temperature: 0.2, maxTokens: 512, responseFormat: 'json', responseSchema },
  // the ledger records `responseSchema` in full when it first appears on the run and
  // whenever it changes (a hash otherwise), so the request stays reconstructable
  language: 'en', // localized error messages
  signal: abortController.signal, // optional
  timeoutMs: 60_000, // optional hard timeout → LLMError TIMEOUT
  retries: 0, // optional transient-retry budget for this call
  telemetry: { kind: 'utility', purpose: 'my-feature', user: req.user, refs: { appId } }
});

result.content; // string
result.toolCalls; // [{ index, id, type, function: { name, arguments }, metadata }]
result.usage; // { promptTokens, completionTokens, totalTokens, … } | null
result.finishReason; // 'stop' | 'length' | 'tool_calls' | 'content_filter' | provider raw
result.thinking; // reasoning deltas
result.thoughtSignatures; // Gemini 3
result.groundingMetadata; // native web search
result.requestId, result.runId, result.model, result.durationMs;

// Streaming: iterate normalized chunks, then read the accumulated view.
const stream = await llmClient.execute({ model, messages, options, telemetry: { runId, step } });
for await (const chunk of stream) {
  chunk.content; // string[] deltas
  chunk.tool_calls; // per-chunk generic tool calls
  chunk.thinking; // string[] | { name, content }[]
  chunk.usage; // normalized usage when the provider sent some
  chunk.complete; // true on the final chunk
}
const result = stream.result();
```

### Telemetry parameter

| Field                 | Meaning                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`               | The run this call belongs to (workflow execution, chat run). The call writes `request/header` into that run's ledger                                 |
| `step`                | Step / iteration counter inside the run                                                                                                              |
| `purpose`             | Free-form label (`planner`, `verifier`, `magic-prompt`, …) recorded on the header                                                                    |
| `toolExecution`       | `server` when the caller executes returned tool calls, `caller` when they are handed back (inference API), `none` when no tools are offered           |
| `kind`, `user`, `refs`| Only used when there is no `runId`: the client opens its own run of that kind (`utility`, `inference`, `diagnostic`, …) and closes it with the result |
| `autoRun: false`      | Do not open a run when no `runId` is given                                                                                                           |

## Error taxonomy

Every failure is an `LLMError` (`server/services/loop/contracts/errors.js`).
Callers branch on `err.code`, never on message text.

| Code                      | Meaning                                              | Retried | Typical HTTP mapping |
| ------------------------- | ---------------------------------------------------- | ------- | -------------------- |
| `CONTEXT_WINDOW_EXCEEDED` | Prompt too long for the model                        | no      | 400                  |
| `RATE_LIMITED`            | Provider 429                                         | yes     | 429                  |
| `CONTENT_POLICY`          | Provider refused on policy grounds                   | no      | 400                  |
| `EMPTY_RESPONSE`          | Completed without any output (raised by AgentLoop)   | no      | 502                  |
| `TIMEOUT`                 | `timeoutMs`, connect or stream-idle deadline elapsed | yes     | 504                  |
| `NETWORK`                 | DNS / connection / socket failure                    | yes     | 502                  |
| `PROVIDER_ERROR`          | Any other provider failure (5xx, in-band error frame)| 5xx yes | upstream status      |
| `AUTH_FAILED`             | Bad or missing API key (`providerCode` says which)   | no      | 401 / 500            |
| `MODEL_NOT_FOUND`         | Unknown model id, or provider 404                    | no      | 404                  |
| `INVALID_REQUEST`         | Provider 400/413/422                                 | no      | 400                  |
| `ABORTED`                 | The caller's `AbortSignal` fired                     | no      | —                    |

Useful fields: `status` (provider HTTP status), `providerCode` (the legacy
`ErrorHandler` classification such as `SERVICE_UNAVAILABLE`), `details` (raw
provider body), `retryAfterMs`, `provider`, `modelId`, `cause`. Getters:
`retryable`, `isContextWindowError`. `isAbortError(err)` recognizes both
`LLMError(ABORTED)` and raw `AbortError`s.

## Configuration

| Setting                         | Default | Effect                                                                     |
| ------------------------------- | ------- | -------------------------------------------------------------------------- |
| `LLM_TRANSIENT_RETRIES`         | `3`     | Retry budget for transient failures (`WORKFLOW_LLM_TRANSIENT_RETRIES` still works). Connect timeouts (`CONNECT_TIMEOUT`) and hostname resolution failures are not retried. |
| `DNS_LOOKUP_TIMEOUT_MS`, `DNS_NEGATIVE_CACHE_MS` | `5000`, `30000` | Outbound DNS guard limits (see below)                                |
| `UV_THREADPOOL_SIZE`            | `16`    | libuv threadpool size, set by `server/threadpool.js` when unset (environment only) |
| `LLM_DEBUG_DUMP_ALL=1`          | off     | Dump every outbound request body to `contents/data/debug/llm-request/`     |
| `model.maxOutputTokens`         | —       | Default `maxTokens` for calls that do not set one                          |
| `model.concurrency`, `requestDelayMs` | — | Per-model throttling                                                       |
| `features.runLog`               | off     | Persist the per-run ledger the client writes into (see [Run Ledger](run-ledger.md)) |

Requests to a model whose provider returns a non-transient 4xx are dumped to
`contents/data/debug/llm-failures/<timestamp>-<model>-<status>.json` with
auth headers and URL keys redacted, and a shape summary (sizes and keys, no
prompt text) is logged.

## Stream deadlines

Three separate deadlines cover one model call, because "cannot reach the
provider", "the provider is thinking" and "the provider died mid-answer" are
different failures and only the middle one deserves patience:

| Phase                                     | Deadline                       | `providerCode` on expiry |
| ----------------------------------------- | ------------------------------ | ------------------------ |
| Connect + response headers, per attempt   | 10 s                           | `CONNECT_TIMEOUT`        |
| Headers → first stream chunk              | the call's `timeoutMs` (5 min) | `TIMEOUT`                |
| Gap between two stream chunks             | 60 s                           | `STREAM_IDLE_TIMEOUT`    |

The stream-idle deadline is armed only after a chunk has been handed to the
consumer, so a reasoning model that is silent for minutes before its first
token is governed by the whole-call deadline rather than cut off. A provider
that emits part of an answer and then stops without closing the body or sending
a finish reason used to hold the turn open for the whole five minutes, which on
the client reads as a hung chat: the streamed text is on screen but no
`step/completed` or `run/ended` frame has been emitted, so the stop button
stays lit and the answer-source badge never appears. Chunks delivered before
the stall are kept; the turn ends with the `streamStalled` message.

The deadline races the read rather than only aborting the request, because a
response body that ignores its abort signal would otherwise leave the read
pending forever. The abort still fires, so the socket is released. Both
ceilings are constructor options (`connectTimeoutMs`, `streamIdleTimeoutMs`,
`<= 0` disables) rather than environment variables.

## Outbound DNS guard

Node resolves hostnames with `getaddrinfo` on the libuv threadpool, and libuv
runs at most half of that pool as such "slow I/O" work — two lookups at a time
with the default four threads, for the whole process. A lookup for a host whose
resolver does not answer (a VPN-only vLLM endpoint with the VPN down) blocks a
slot for the operating system's resolver timeout, and aborting the HTTP request
does not cancel it. One chat turn issues several such lookups (discovery, then
each connect attempt), so both slots fill and every other outbound request —
any model, any user — waits behind them. Pages and API lists keep working
because file reads are not subject to that cap, which is why only answers hung.

Every direct (non-proxied) connection made through `httpFetch` now resolves
through `server/utils/dnsGuard.js`:

- concurrent lookups of one hostname share a single `getaddrinfo` call;
- a lookup that takes longer than `DNS_LOOKUP_TIMEOUT_MS` fails the request
  with a DNS error (`EAI_TIMEOUT`, mapped to the `dnsResolutionFailed`
  message) while the OS call finishes in the background;
- a failed or overdue lookup is remembered for `DNS_NEGATIVE_CACHE_MS`, so new
  requests to that host fail immediately instead of queueing another lookup; a
  late success clears the entry.

Two related changes keep a dead endpoint from being probed repeatedly: a
connect timeout is no longer retried, and a failed model discovery is
remembered for 60 seconds. `server/threadpool.js` additionally sizes the
threadpool to 16 (8 concurrent lookups) unless `UV_THREADPOOL_SIZE` is set;
because libuv reads that variable when the pool is first used, the module is
the first import of `server.js`.

## Testing

- `server/tests/loop/llmClient.test.js` — behaviour specs (retries, abort,
  timeout, error mapping, ledger events, streaming vs collect).
- `server/tests/loop/connectTimeout.test.js`,
  `server/tests/loop/streamIdleTimeout.test.js` — the connect and stream-idle
  deadlines, including that the wait for the first chunk is left alone.
- `server/tests/dnsGuard.test.js`, `server/tests/loop/dnsFailure.test.js` —
  DNS guard (sharing, timeout, negative cache) and the non-retry of DNS and
  connect-timeout failures.
- `server/tests/loop/adapterConformance.test.js` — the provider conformance
  matrix: every registered adapter driven through the client with wire-level
  fixtures (text, tool-call accumulation, parallel calls, thinking, usage,
  empty response, in-band errors, malformed JSON, abort, collect ≡ stream).
  Known provider gaps are asserted as such so they flip when fixed.
- `server/tests/loop/reconstruct.test.js` — proves a recorded run can be
  rebuilt from its ledger (`request/header`) and hashes to the request that
  was sent.
- `server/tests/loop/openaiProxy.test.js` — golden wire tests for the
  OpenAI-compatible inference API.

Inject fakes instead of mocking modules: `new LLMClient({ transport, createRequest, apiKeyVerifier, getModels, runLog, sleep, maxRetries })`. See `server/tests/loop/helpers/llmFixtures.js` for `sseResponse`, `jsonResponse`, `bedrockResponse` and `makeClient`.
