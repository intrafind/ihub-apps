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
| `TIMEOUT`                 | `timeoutMs` elapsed or connect timeout               | yes     | 504                  |
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
| `LLM_TRANSIENT_RETRIES`         | `3`     | Retry budget for transient failures (`WORKFLOW_LLM_TRANSIENT_RETRIES` still works) |
| `LLM_DEBUG_DUMP_ALL=1`          | off     | Dump every outbound request body to `contents/data/debug/llm-request/`     |
| `model.maxOutputTokens`         | —       | Default `maxTokens` for calls that do not set one                          |
| `model.concurrency`, `requestDelayMs` | — | Per-model throttling                                                       |
| `features.runLog`               | off     | Persist the per-run ledger the client writes into (see [Run Ledger](run-ledger.md)) |

Requests to a model whose provider returns a non-transient 4xx are dumped to
`contents/data/debug/llm-failures/<timestamp>-<model>-<status>.json` with
auth headers and URL keys redacted, and a shape summary (sizes and keys, no
prompt text) is logged.

## Testing

- `server/tests/loop/llmClient.test.js` — behaviour specs (retries, abort,
  timeout, error mapping, ledger events, streaming vs collect).
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
