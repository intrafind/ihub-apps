---
description: "Export OpenTelemetry traces, metrics and logs of LLM operations."
audience: admin
type: how-to
adminPage: /admin/telemetry
---

# Telemetry and Observability

iHub Apps emits OpenTelemetry signals for every LLM operation following the official
[Generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
Administrators can wire iHub into any standard observability backend - Jaeger, Tempo,
Grafana, Prometheus, or a generic OTLP collector - to monitor app usage, track token
consumption, identify errors, and analyze performance.

Developers adding spans or metrics: follow the [Observability Guidelines](observability-guidelines.md).

## At a glance

| Signal type | Examples | Where it ends up |
| --- | --- | --- |
| **Spans** | `chat gpt-4o`, `generate_content gemini-2.5-pro` | Jaeger, Tempo, OTLP collector |
| **Metrics** | `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `ihub.app.usage`, `ihub.active.users` | Prometheus, OTLP collector |
| **Captured content** (opt-in) | `gen_ai.input.messages`, `gen_ai.output.messages` | Attributes of the LLM span |
| **Logs**    | Activity summary, structured server logs | Stdout, file, OTLP log collector |

Telemetry is **disabled by default**. No PII (prompts, completions) is captured unless
admins explicitly opt in. Activating telemetry only emits structural data (model name,
provider, token counts, durations, error type) and the iHub-specific dimensions
described below.

## Quick start

1. **Enable in the admin UI**
   - Navigate to `Admin → More → Telemetry`
   - Tick "Enable telemetry"
   - Pick a provider (`Console`, `OTLP`, `Prometheus`)
   - Save and **restart the server** (provider/exporter changes need a restart)

2. **Or wire via env vars** (no admin UI required):

   ```bash
   export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"
   export OTEL_SERVICE_NAME=ihub-apps
   export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
   ```

   Setting `OTEL_EXPORTER_OTLP_ENDPOINT` automatically switches the provider to `otlp`
   on startup if the admin hasn't configured a different exporter.

3. **Start the server through the telemetry bootstrap.** The Docker image, `npm start`,
   `npm run dev` and the binary do this already. A custom start command needs
   `--import ./server/instrumentation.mjs` (path relative to the working directory) before the
   script:

   ```bash
   node --import ./server/instrumentation.mjs server/server.js
   ```

   The bootstrap starts telemetry before the application loads, which is what lets
   `autoInstrumentation` patch HTTP and Express (inbound spans with `http.route`, an incoming
   `traceparent` honoured, outbound calls carrying the trace). Without it the server still exports
   its own spans and metrics, logs a warning when `autoInstrumentation` is on, and creates no
   HTTP spans.

4. **Verify** Prometheus is being scraped:

   ```bash
   curl http://localhost:9464/metrics | grep gen_ai
   ```

## Configuration

The `telemetry` block in `contents/config/platform.json` (and the matching admin UI):

```json
{
  "telemetry": {
    "enabled": false,
    "provider": "console",
    "exporters": {
      "otlp": {
        "endpoint": "http://localhost:4318",
        "protocol": "http/protobuf",
        "headers": {}
      },
      "prometheus": {
        "port": 9464,
        "host": "127.0.0.1"
      }
    },
    "spans": {
      "enabled": true,
      "sampleRate": 1.0,
      "includeOptInAttributes": false,
      "userIdMode": "pseudonymised"
    },
    "events": {
      "enabled": true,
      "includePrompts": false,
      "includeCompletions": false,
      "maxEventSize": 1024
    },
    "metrics": {
      "enabled": true,
      "exportInterval": 60000
    },
    "logs": {
      "enabled": false,
      "level": "info"
    },
    "activitySummary": {
      "enabled": false,
      "intervalSeconds": 300,
      "windowMinutes": 5
    },
    "resource": {
      "service.name": "ihub-apps",
      "service.version": "auto",
      "deployment.environment.name": "production"
    }
  }
}
```

The OTLP exporters connect like every other outbound call: a collector whose host is on
`ssl.domainWhitelist` (with `ssl.ignoreInvalidCertificates` on) may use a certificate from a
private CA, and the outbound proxy settings apply. A CA, client certificate and key set through
`OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` and
`OTEL_EXPORTER_OTLP_CLIENT_KEY` (or their `_TRACES_` / `_METRICS_` variants) still apply, so a
collector that requires mutual TLS keeps working. Exports that run before the configuration has
finished loading at startup are dropped rather than sent without these settings. See
[SSL certificates](ssl-certificates.md) and [Proxy configuration](proxy-configuration.md).

`exporters.otlp.headers` usually carries a bearer token or an API key. Every header value is a
secret: it is stored encrypted in `platform.json` (`ENC[...]`, the key in
`contents/.encryption-key`), shown as `***REDACTED***` by the admin API and in the change history,
and kept when a page sends the redacted value back. A value written as an `${ENV_VAR}` placeholder
stays a placeholder. Plain-text headers in an existing `platform.json` are encrypted on the next
save.

A signal that is off exports nothing: no span processor, no log processor and no metric reader
is registered for it, so the SDK never falls back to its own `OTEL_*` defaults (OTLP to
`localhost:4318`). With `provider: "prometheus"` no traces are exported; run an OTLP collector to
get traces as well.

### Is telemetry on and exporting?

- At startup the server logs `Telemetry disabled (telemetry.enabled is false)` or
  `Initializing telemetry` followed by `Telemetry initialization complete` with the exporter per
  signal.
- When exports to the collector start failing the server logs `Telemetry export failing` (WARN,
  with the signal and a reason such as `tls`, `connection_refused` or `http_5xx`), once, and
  `Telemetry export recovered` when they succeed again. Errors of the OpenTelemetry SDK itself go
  to the application log at WARN (`component: OpenTelemetry`).
- `GET /api/health` has a `telemetry` block: `enabled` and per signal (`traces`, `metrics`,
  `logs`) its `status` (`off`, `pending`, `ok`, `failing`) and `lastSuccessAt`.
- **Admin → System resources** shows the same per signal, with the last failure reason and the
  failure count, as the answering worker sees it.
- The metrics `ihub.telemetry.export.failures`, `ihub.telemetry.export.last_success` and
  `ihub.build.info` (see [Metrics](#telemetry-self-monitoring)) let an alert fire when exports stop.

### User identity on spans

`spans.userIdMode` decides how a span names the user:

| Value | On the span |
| --- | --- |
| `pseudonymised` (default) | `user.hash`: an HMAC-SHA256 of the user id under a key derived from the installation's encryption key. The same user gets the same value on every span and in every worker; the login is not exported |
| `off` | No user attribute |
| `clear` | `user.id` with the login in clear text. A per-employee activity profile in the trace backend; agree it with the works council first |

`gen_ai.conversation.id` is hashed with the same key unless the mode is `clear`. Groups are never
exported. Rotating the encryption key (`TOKEN_ENCRYPTION_KEY` or `contents/.encryption-key`)
changes every pseudonym, which unlinks older traces. Per-user reports belong in
[Usage reporting](usage-reporting.md), not in traces.

### Protocols and environment variables

`exporters.otlp.protocol` is `http/protobuf` (the default) or `http/json`. gRPC is not supported:
its client cannot use the platform's proxy and SSL whitelist. A `grpc` setting exports with
`http/protobuf` and logs a warning; point the endpoint at the collector's HTTP receiver (4318).
The endpoint is the collector's base URL; `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended
(a trailing slash is fine).

The standard OpenTelemetry variables apply:

| Variable | Effect |
| --- | --- |
| `OTEL_SDK_DISABLED=true` | Telemetry stays off whatever `telemetry.enabled` says |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint when `exporters.otlp.endpoint` is not set; also switches a `console` provider to `otlp` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_LOGS_ENDPOINT` | The full URL of one signal (no path appended) |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `…_TRACES_PROTOCOL`, … | `http/protobuf` or `http/json`, over the config |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers when the config has no endpoint (`key=value,key2=value2`) |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`, `…_CLIENT_CERTIFICATE`, `…_CLIENT_KEY` | CA bundle and client certificate (mutual TLS), also per signal |
| `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME` | Extra resource attributes, the service name |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in ms, over `metrics.exportInterval` |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Sampler, over `spans.sampleRate` |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Defaults to `http` (stable HTTP attribute names) |
| `K8S_POD_NAME`, `K8S_NAMESPACE_NAME`, `K8S_NODE_NAME` | `k8s.*` resource attributes (downward API) |

A `provider` other than `otlp`, `prometheus` or `console` exports nothing and logs a warning; it
no longer falls back to the console silently.

The Prometheus endpoint listens on `127.0.0.1` unless `exporters.prometheus.host` says otherwise.
It has no authentication: in Kubernetes set `0.0.0.0` and restrict who may scrape it with a
NetworkPolicy (or a `PodMonitor` in the same namespace). Configurations saved before keep their
value.

### Logs

Every log line written inside a span carries `trace_id` and `span_id`, so Loki (or any log store)
can link a line to its trace in Tempo.

With `logs.enabled: true`, log lines also go to the OpenTelemetry logs pipeline: over OTLP with
`provider: otlp`, to stdout with `provider: console`, nowhere with Prometheus. `logs.level` (default
`info`) is the lowest level sent. The full line stays in the container log; what is exported is
less:

- the message (already redacted by the logger) and the severity,
- the `component` and a short list of fields that carry no content or identity (codes, statuses,
  model and app ids, counts, durations), and `error.type` for an error,
- the user only pseudonymised (`user.hash`, following `spans.userIdMode`), never the IP address,
- the trace and span id of the active span.

### Health and readiness

- `GET /api/health` is the **liveness** probe: 200 while the process answers. It also reports the
  storage and the telemetry state.
- `GET /api/ready` is the **readiness** probe: 200 when the platform configuration is loaded, the
  storage provider is up and the contents directory is writable; otherwise 503 with
  `details.checks` naming what is not ready (`config`, `storage`, `contents`).

```yaml
livenessProbe:
  httpGet: { path: /api/health, port: 3000 }
readinessProbe:
  httpGet: { path: /api/ready, port: 3000 }
  periodSeconds: 10
```

On shutdown the server flushes telemetry first and in parallel with its other flushes, within
1.5 seconds, so the last export interval of a rollout is not lost.

### Hot-reload behaviour

| Setting | Restart required |
| --- | --- |
| `enabled` | Yes |
| `provider` (console / otlp / prometheus) | Yes |
| `exporters.*` (endpoint, port, headers, protocol) | Yes |
| `logs.enabled`, `logs.level` | Yes |
| `metrics.exportInterval` | Yes |
| `autoInstrumentation` | Yes |
| `events.includePrompts`, `events.includeCompletions`, `events.maxEventSize` | No - applied immediately |
| `spans.includeOptInAttributes`, `spans.userIdMode` | No - applied immediately |
| `spans.sampleRate` | Yes |
| `spans.enabled` | Turning spans **off**: no - applied immediately, auto-instrumentation spans included. Turning them **on** after a start with spans off: yes |
| `activitySummary.*` | No - re-armed on save |

## Spans

### Span tree

Every unit of work starts a span, and what it does becomes a child, so one chat turn is one
trace:

```text
POST /api/apps/{appId}/chat/{chatId}         SERVER  (autoInstrumentation, http.route)
└─ invoke_agent {app.id}                     the turn (ChatService.runTurn)
   ├─ chat {model}                           one per model call (CLIENT)
   │  └─ POST                                the provider request (autoInstrumentation)
   ├─ execute_tool {tool}                    one per tool call
   │  ├─ retrieval {provider}                knowledge search, iFinder, iAssistant (CLIENT)
   │  │  └─ POST                             the outbound request
   │  └─ invoke_agent {app.id}               an app called as a tool (ihub.turn.kind=subagent)
   └─ chat {model}                           the next round of the tool loop
```

| Span | Where it starts | Notable attributes |
| --- | --- | --- |
| `invoke_agent {app.id}` | a chat turn, an app run through the inference API, a scheduled task, an app called as a tool, MCP / A2A app calls | `app.id`, `ihub.turn.kind` (`turn`, `subagent`), `ihub.trigger.type`, `ihub.turn.status`, `user.hash`, `gen_ai.conversation.id` (hashed) |
| `inference {api}` | `/api/inference/v1/chat/completions` (`chat_completions`) and `/responses` | `ihub.inference.target` (`app`, `model`), `ihub.streaming` |
| `tools/call {tool}` (SERVER) | a tool call to iHub's MCP server | `mcp.method.name`, `gen_ai.tool.name` |
| `a2a.task {kind}` | an A2A task (`app`, `workflow`) | `ihub.a2a.skill.kind`, `ihub.a2a.skill.id` |
| `execute_tool {tool}` | a tool call in the agent loop. A tool an MCP server or A2A agent reports at runtime is named `mcp` / `a2a`; a tool the app does not offer `unknown` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `tool.origin`, `tool.outcome`, `ihub.result.count`, `ihub.result.bytes` |
| `workflow.run` | one segment of a workflow execution. A run that resumes (after a human decision, a checkpoint, a restart) starts a **new trace with a span link** to the segment before | `ihub.workflow.id`, `ihub.workflow.execution_id`, `ihub.workflow.resumed`, `ihub.workflow.status` |
| `workflow.node {node.type}` | one node attempt | `ihub.workflow.node.type`, `ihub.workflow.node.id`, `ihub.retry.attempt` |
| `scheduled_task.run` | a scheduled task run, always a new trace | `app.id`, `ihub.trigger.type` |
| `retrieval {provider}` (CLIENT) | `project` (knowledge search), `ifinder`, `iassistant` | `source.provider`, `ihub.result.count` |
| `extraction {format}` | text extraction from a file; the extraction thread's work is timed from the calling thread | `ihub.extraction.format`, `ihub.input.bytes` |

A failure sets `error.type` and status `ERROR`; a user stop sets `ihub.aborted=true` and leaves
the status unset. No span carries prompts, queries, tool arguments or results unless content
capture is on, and then only the LLM span.

**Trace context** comes in through `traceparent` / `tracestate` (allowed through CORS for the
Office add-in, browser extension and API clients) and goes out with every outbound request. It is
carried across the cluster bus, so the spans a request causes on another worker join its trace.
Log lines written inside a span carry `trace_id` and `span_id` when `autoInstrumentation` is on
(winston instrumentation).

### Sampling

`spans.sampleRate` (0–1, default 1) is applied as `ParentBased(TraceIdRatioBased)`: that share of
new traces is recorded, and a request that arrives with a `traceparent` follows its caller's
decision. `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` override it. Head sampling decides
before anything is known about the trace; to keep every failed or slow trace at a low rate,
leave `sampleRate` at 1 and sample in the collector (tail sampling, see
[Backend integration](#backend-integration)).

### The LLM span

Each LLM call produces one span named `<operation> <model>` (e.g. `chat gpt-4o`). It is active
while the provider request runs, so the HTTP client span is its child. A retried attempt adds an
`ihub.llm.retry` event (`ihub.retry.attempt`, `error.type`), a provider `pause_turn` an
`ihub.llm.pause_turn` event. A stream that is dropped without being read ends its span with
`ihub.stream.abandoned=true`.
Required and conditionally required attributes follow the gen-ai conventions:

| Attribute | Notes |
| --- | --- |
| `gen_ai.operation.name` | `chat`, `generate_content`, `text_completion` |
| `gen_ai.provider.name`  | `openai`, `anthropic`, `gcp.gemini`, `mistral_ai`, `aws.bedrock`, `local`, `vllm`, `iassistant` |
| `gen_ai.request.model`  | Model id sent to the provider |
| `gen_ai.request.temperature` | Only when the model config sets `sampling.temperature` |
| `gen_ai.request.top_p`       | Only when the model config sets `sampling.topP` |
| `gen_ai.request.top_k`       | Only when the model config sets `sampling.topK` |
| `gen_ai.request.max_tokens`  | When set |
| `gen_ai.response.id`         | Provider response id |
| `gen_ai.response.model`      | Provider-reported model |
| `gen_ai.response.finish_reasons` | Array of finish reasons |
| `gen_ai.usage.input_tokens`  | Prompt tokens — the whole input, cached tokens included, for every provider |
| `gen_ai.usage.output_tokens` | Completion tokens — the whole output, reasoning included |
| `gen_ai.usage.cache_read.input_tokens` | Input tokens served from the provider's prompt cache (when reported) |
| `gen_ai.usage.cache_creation.input_tokens` | Input tokens written to the prompt cache (Anthropic, Bedrock; when reported) |
| `gen_ai.usage.reasoning.output_tokens` | Output tokens spent on reasoning (OpenAI, Gemini; when reported) |
| `error.type`                 | `rate_limit_exceeded`, `authentication_error`, `timeout`, `http_<code>`, or the call's error code (`CONTEXT_WINDOW_EXCEEDED`, `NETWORK`, …). Never the error message |
| `server.address`, `server.port` | Host and port of the model endpoint |

iHub-specific span attributes:

| Attribute | Description |
| --- | --- |
| `app.id` | iHub app receiving the request |
| `user.hash` | Pseudonymised user (default `spans.userIdMode`); `user.id` only with `userIdMode: clear` |
| `gen_ai.conversation.id` | Chat session id, hashed unless `userIdMode` is `clear` |
| `ihub.aborted` | `true` when the user stopped the answer or the client went away. Not an error: the status stays unset and no duration is recorded |
| `conversation.is_follow_up` | True when the chat already had >2 messages |
| `conversation.message_count` | Length of the message array |

## Metrics

Standard gen-ai histograms:

- `gen_ai.client.token.usage` - histogram of tokens per call, by `gen_ai.token.type`: `input`,
  `output`, and, when the provider reports them, `cache_read`, `cache_write` (prompt cache) and
  `reasoning`. The last three are subsets of `input` / `output`: sum only `input` and `output`
  for totals
- `gen_ai.client.operation.duration` - histogram of operation durations in seconds
- `gen_ai.client.operation.time_to_first_chunk` - histogram (seconds) from the start of a
  streamed model call to its first output chunk, retries included. Streamed calls only
  (semantic conventions v1.41; newer drafts call it `gen_ai.client.inference.time_to_first_chunk`)

The GenAI metrics carry `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`app.id`, `ihub.surface` (`chat`, `agent`, `workflow`, `task`, `api`, `magic`, `system`) and
`server.address` (the host of the model endpoint, from the model config: one of two vLLM nodes
degrading shows up). They are recorded whether or not spans are on or sampled. On these metrics
`ihub.surface` is what [Usage reporting](usage-reporting.md) calls the surface of a model call: an
app run through the inference API counts as `chat` there, while its turn (`ihub.turns`) is
`api`.

Turns and tools:

- `ihub.turn.duration` - histogram (seconds) of a whole turn: every model call and tool round
  until the answer, as the user waited for it
- `ihub.turns` - counter of turns by `ihub.turn.outcome`: `ok`, `error`, `quota` (usage limit),
  `rate_limited`, `aborted` (the user stopped it), `empty` (no answer, question or result to
  show), `tool_degraded` (it answered, but a tool call failed). Both carry `ihub.surface`,
  `ihub.client.channel` and `app.id`. An MCP or A2A app call is a turn with surface `api`; an app
  that another app calls as a tool is part of that turn and is not counted on its own (it keeps
  its `invoke_agent` span with `ihub.turn.kind=subagent`)
- `ihub.client.channel` - which client a turn came through: `web`, `office` (the Office add-in in
  Outlook, Word, Excel or PowerPoint; the server cannot tell the host apart), `browser_extension`,
  `teams`, `nextcloud`, `mcp`, `a2a`, `openai_proxy`, or `system` outside a request. Decided from
  the route and the OAuth client, never from a header the client sends. Also on `ihub.app.usage`
  and `ihub.stream.outcome`
- `ihub.tool.duration` - histogram (seconds) per tool call, by `tool.name` (a configured tool id;
  `mcp` / `a2a` for tools a remote system reports at runtime, `unknown` for a tool the app does
  not offer), `tool.origin` and `tool.outcome`

Workflows:

- `ihub.workflow.executions` + `ihub.workflow.duration` - execution segments by
  `ihub.workflow.outcome` (`completed`, `failed`, `cancelled`, `paused` = waits for a human)
- `ihub.workflow.node.duration` - per node attempt, by `ihub.workflow.node.type` and
  `ihub.workflow.outcome` (`ok`, `error`)
- `ihub.hitl.wait.duration` - how long a workflow waited for a human decision before it resumed
  (measured by the process that paused it; a restart in between loses the measurement)

Capacity and dependencies:

- `ihub.llm.requests.inflight` - up-down counter of model calls in progress, by
  `gen_ai.provider.name`
- `ihub.llm.requests.queued` - up-down counter of model calls waiting for a concurrency slot of
  their model (`concurrency` in the model config), by `gen_ai.request.model`. Rising before the
  provider answers 429 means saturation
- `ihub.outbound.request.duration` - histogram (seconds, until the response headers) of every
  outbound request through `httpFetch`, by `ihub.dependency.kind` (`llm`, `ifinder`, `iassistant`,
  `idp`, `search`, `web`, `integration`, …, `other`) and `error.type` (`http_<status>`, `tls`,
  `connection_refused`, `dns`, `timeout`, `network`)
- `ihub.outbound.tls.errors` - counter of TLS handshake failures by dependency kind: a private CA
  that rotated, a proxy that intercepts
- `ihub.dependency.up` - gauge, 1 when the last outbound request of a dependency kind got a
  response below 500, 0 when it failed. Per process: `min` across workers
- `ihub.storage.filesystem.usage` / `.limit` - gauges (bytes) of the volume behind each storage
  location, by `ihub.storage.mount` (`contents`, `data`, `uploads`, `logs`, `temp`), measured
  every minute. Same on every worker: `max`
- `ihub.lock.wait.duration` - histogram (seconds) of waits for a file lock before a write
- `ihub.clusterbus.timeouts` - counter of cross-worker requests that got no answer in time, by
  `clusterbus.operation` (`request`, `gather`)

Security:

- `ihub.auth.events` - now also for OIDC, NTLM, Teams (`login_success`, `login_failure`) and
  proxy authentication (`token_validated`; `token_invalid` for a JWT no provider accepts,
  `login_failure` for a user the platform refuses). `auth.provider` and `auth.event`
  are closed sets; anything else is `other`
- `ihub.security.events` - counter by `security.event`: `login_failure`, `admin_config_change`,
  `content_capture_change`, `permission_change`, `user_change`, `api_key_change`,
  `oauth_client_change`, `oauth_grant`, `oauth_revoke`, `tool_approval_denied`, `bulk_export`,
  `share_created`. Derived from the audit log entries (and the tool approval answer); who and
  what is in the audit log, never on the metric

iHub product counters & gauges:

- `ihub.app.usage` - per app request counter
- `ihub.errors` - errors by type and context (`llm_call`, `inference_api`, ...)
- `ihub.conversations` - chat messages with the `conversation.is_follow_up` dimension
- `ihub.active.users` - **observable gauge**, distinct users active in the rolling
  window (default 5 min). In cluster mode this is the union across the workers of
  the pod (each user counted once), not one worker's share. Every worker reports the
  same pod-wide value, so aggregate with `max` per pod, never `sum`
- `ihub.active.chats` - **observable gauge**, distinct chats active in the rolling
  window, counted across workers the same way
- `ihub.projects.active` + `ihub.projects.active.chars` - **observable gauges**, the
  working set of projects: distinct projects used by a chat turn or a knowledge tool
  within the last 5, 15 or 60 minutes (`window.minutes` label), and the text
  characters they hold. The characters times about 4.5 bytes is the index memory the
  working set needs, which is what the knowledge index cache has to hold. In cluster
  mode both are the **union** over the workers (a project used on three workers is
  one project), refreshed about every 10 seconds
- `ihub.knowledge.index.cache.hits` / `.misses` / `.evictions` - counters of the
  per-process knowledge search-index cache. A miss is an index build; an eviction is
  an index dropped to stay within the cache's entry or character limit (not one
  invalidated because a project changed). Sum over workers for the pod total, or
  keep the per-worker series
- `ihub.knowledge.index.cache.entries` / `.chars` - gauges of what the cache holds now
- `ihub.knowledge.index.build.duration` - histogram (seconds) of index builds; a
  build blocks the event loop
- `ihub.extraction.duration` - histogram (seconds) of text extraction from a file,
  labelled by `format` (`pdf`, `docx`, `pptx`, `xlsx`, `odt`, `ods`, `odp`, `html`,
  `eml`, `msg`, `text`). It is the time of the extraction itself, failures included:
  measured in the extraction thread (not counting the wait for it). A file stopped at the time budget is
  recorded with the budget under `format="unknown"`
- `ihub.extraction.queue.duration` - histogram (seconds) of the time a file waited for a
  free extraction thread; rising values mean a server process gets more files than one thread reads; add `WORKERS`
- `ihub.stream.outcome` - streaming chat outcomes (`completed`, `aborted`, `error`)
- `ihub.ratelimit.hits` - throttler / rate-limit hits, labelled by `ratelimit.scope`
  (`http`, `llm`) and `ratelimit.route`
- `ihub.auth.events` - login / logout / token-validated / token-invalid /
  token-expired counters labelled by `auth.provider`
- `ihub.upload.requests` + `ihub.upload.size` - file upload counter and size
  histogram, labelled by `upload.kind` and `upload.outcome`
- `ihub.config.reload` + `ihub.config.reload.duration` - configuration cache
  reload counter and duration histogram, labelled by `config.file`
- `ihub.magicprompt.usage` - magic-prompt invocation counter
- `ihub.feedback` + `ihub.feedback.rating` - user feedback counter (per rating)
  and 1-5 rating histogram
- `ihub.tool.calls` - search and fetch calls, labelled by `tool.origin` (`web`, `project`,
  `ifinder`, `iassistant`, `documents`, `integration`, or `none` for a call the server could
  not place) and `tool.outcome` (`results`, `empty`, `error`, `unknown`). `none` on a built-in
  tool is a classifier gap. `empty` needs the server to have declared a count of zero (or a
  page read that delivered no text); a result that does not say is `unknown`, never `empty`.
  The share of `empty` per origin shows which origin does not match how people ask
- `ihub.answer.basis` - answers, labelled by `answer.kinds_bucket` (`0`, `1`, `2`, `3+`): how
  many kinds of source the answer's basis names. `0` means no named source kind: the model's own
  knowledge, or a passthrough answer (a tool's own output) that used none. Everything but `0` is
  an answer that used a source, which is the denominator for mixed-origin shares
- `ihub.answer.origin.mismatch` - answers whose sources name an origin that the footer's basis
  leaves out, so the footer and the Sources panel would disagree. Expected to stay at 0
- `ihub.source.actions` - successful requests for a source document's content or details
  through its integration, labelled by `source.provider` and `source.action` (`content`,
  `details`). `source.provider` is the integration's catalog definition (for example
  `com.intrafind/ifinder`), `project` for the project provider, or `unknown`; two installations
  of one integration share a label. The server sees the request, not the button, so a preview
  and a download are both `content`, and opens of an external link are not counted
- `ihub.structured_output.validation` - server-side structured-output checks of
  the inference API, labelled by `structured_output.outcome` (`valid`,
  `valid_after_retry`, `invalid`, `skipped`, `not_reached`) and
  `structured_output.source` (`app` for an app's output schema, `request` for a
  caller's `response_format` / `text.format`)

Process / runtime gauges (registered automatically when telemetry is enabled):

- `process.cpu.utilization` - 0-1 CPU utilisation (user + system, summed)
- `process.memory.usage` - resident set size in bytes (heap detail: `v8js.memory.heap.*`)
- `process.open_file_descriptor.count` - open file descriptors (Linux)
- `nodejs.eventloop.delay.*` (`min`, `max`, `mean`, `stddev`, `p50`, `p90`, `p99`),
  `nodejs.eventloop.utilization`, `v8js.gc.duration`, `v8js.memory.heap.*` - from
  `@opentelemetry/instrumentation-runtime-node`. They replace
  `process.runtime.nodejs.event_loop.delay`, which reset its histogram on every read and so
  showed each of two scrapers only half
- `ihub.workers.count` - 1 per worker process (`cluster.role=worker`); `sum` across workers is
  the number of live workers

### Telemetry self-monitoring

- `ihub.telemetry.export.failures` - counter of failed exports, labelled by `telemetry.signal`
  (`traces`, `metrics`, `logs`) and `error.type` (`tls`, `connection_refused`, `dns`, `timeout`,
  `network`, `authentication`, `http_4xx`, `http_5xx`, `incomplete` (a Prometheus scrape that
  lacked a worker's answer), `unknown`). Per process: `sum`
  across workers
- `ihub.telemetry.export.last_success` - gauge, seconds since the epoch of the last successful
  export per `telemetry.signal`; for Prometheus the last served scrape. Per process: `max` across
  workers. `time() - max(ihub_telemetry_export_last_success) > 600` means exports stopped
- `ihub.build.info` - always 1, labelled by `service.version`, `telemetry.provider` and
  `telemetry.enabled`. `absent(ihub_build_info)` means nothing arrives at all

### Cluster mode

With more than one worker (`WORKERS`, sized automatically by default) every worker is its own
process with its own metrics:

- **Resource.** `service.instance.id` is `<host>-w<slot>` (the pod name in Kubernetes plus the
  worker slot) instead of the SDK's random UUID, so the series stay the same across restarts and
  rollouts; `cluster.worker.id` names the slot. `k8s.pod.name`, `k8s.namespace.name` and
  `k8s.node.name` are set from `K8S_POD_NAME` (or `POD_NAME`), `K8S_NAMESPACE_NAME` (or
  `POD_NAMESPACE`) and `K8S_NODE_NAME` (or `NODE_NAME`); pass them through the downward API, or set
  `OTEL_RESOURCE_ATTRIBUTES`. The process id and command line are not detected.
- **Prometheus.** One endpoint answers for the whole pod. Whichever worker receives the scrape asks
  the others over the cluster bus and returns every worker's series, each labelled
  `cluster_worker_id`. A counter therefore only resets when its own worker restarts, and
  `rate()` handles that. A worker that does not answer within 2 seconds is missing from that one
  scrape.
- **OTLP.** Every worker exports its own series, told apart by `service.instance.id`.

How to aggregate across workers:

| Signal | Across workers |
| --- | --- |
| Counters and histograms (`ihub.*`, `gen_ai.*`) | `sum` |
| `ihub.active.users`, `ihub.active.chats`, `ihub.projects.active*` (cluster union) | `max` |
| `ihub.knowledge.index.cache.entries` / `.chars`, process gauges | `sum` (or per worker) |
| `ihub.telemetry.export.last_success` | `max` |
| `ihub.workers.count` | `sum` |
| `ihub.llm.requests.inflight` / `.queued` | `sum` |
| `ihub.dependency.up` | `min` |
| `ihub.storage.filesystem.usage` / `.limit` | `max` (per mount) |

No metrics backend? **Admin → System Resources** shows the same process numbers, plus disk space
and host memory, without enabling telemetry. See the
[Admin UI Guide](admin-ui.md#system-resources).

Optional: enable `telemetry.autoInstrumentation: true` (admin UI / platform.json)
to also load these library instrumentations: HTTP (inbound requests and outbound calls through
`httpFetch`), undici (the global `fetch`), Express (route names) and winston (trace ids in log
records; it never sends logs). DNS, net and fs are not instrumented. Health probes
(`/api/health`, `/api/ready`) and static assets get no span. The stable HTTP semantic conventions
are used (`OTEL_SEMCONV_STABILITY_OPT_IN=http` unless set otherwise). URLs are exported without
query string and user info, and inbound spans without the caller's IP address (see
[Privacy & security](#privacy--security)). Every API request becomes a span - turn it on
intentionally.

### Useful PromQL examples

Names as the built-in Prometheus endpoint exposes them: dots become underscores, counters end in
`_total`, and no unit suffix is added. Through OTLP into Mimir or Prometheus, the collector's
translation usually appends the unit (`gen_ai_client_operation_duration_seconds_bucket`); adjust
the queries and the shipped dashboards' metric names if yours does.

```promql
# Token usage by model
sum by (gen_ai_request_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum[5m]))

# P95 latency per provider
histogram_quantile(0.95,
  sum by (le, gen_ai_provider_name) (rate(gen_ai_client_operation_duration_bucket[5m])))

# Error rate
rate(ihub_errors_total[1h])

# Turn p95 per surface and channel
histogram_quantile(0.95,
  sum by (le, ihub_surface, ihub_client_channel) (rate(ihub_turn_duration_bucket[5m])))

# Share of turns that ended badly for the user
sum(rate(ihub_turns_total{ihub_turn_outcome!~"ok|aborted"}[15m])) / sum(rate(ihub_turns_total[15m]))

# Time to first chunk p95 per endpoint
histogram_quantile(0.95,
  sum by (le, server_address) (rate(gen_ai_client_operation_time_to_first_chunk_bucket[5m])))

# Is the Outlook / Office add-in used?
sum by (ihub_client_channel) (increase(ihub_turns_total[7d]))

# Top 10 most used apps
topk(10, sum by (app_id) (rate(ihub_app_usage_total[1h])))

# Follow-up message ratio
sum(rate(ihub_conversations_total{conversation_is_follow_up="true"}[1h])) /
sum(rate(ihub_conversations_total[1h]))

# Concurrent user/chat count
ihub_active_users
ihub_active_chats
```

## Content capture

Off by default. When `telemetry.events.enabled` is true and `events.includePrompts` /
`events.includeCompletions` is set, the LLM span carries the content in the current GenAI
semantic conventions:

- `gen_ai.input.messages`: the messages sent, as a JSON array of `{ role, parts }`
- `gen_ai.output.messages`: the answer, with the names of the tools the model called (never their
  arguments)

The content is:

- **redacted**, best effort: e-mail addresses, phone numbers, IBANs, JWTs, bearer tokens, common
  API key formats and `key=value` secrets are replaced by `[REDACTED:<kind>]`. Names, addresses and
  other personal data in free text are not recognised;
- **capped** at `events.maxEventSize` characters per attribute, and never more than 4096 whatever
  the setting says. The newest messages are kept, older ones dropped first;
- free of file and image data: an attachment becomes `{ "type": "blob", "modality": "image" }`.

Turning capture on logs a WARN at startup and on save, and the save writes an audit entry
(`resource: telemetryContentCapture`). Keep it off in production.

## Activity summary log (bonus feature)

Independent of any backend, iHub can periodically log how many users and chats it has
seen recently. Configure via `telemetry.activitySummary` or the admin UI:

```json
{
  "activitySummary": {
    "enabled": true,
    "intervalSeconds": 300,
    "windowMinutes": 5
  }
}
```

Every `intervalSeconds` the server emits a structured log line:

```
[Telemetry/ActivityTracker] Activity summary
  activeUsers=12  activeChats=8  windowMinutes=5  deltaUsers=+2  deltaChats=+1
```

The same numbers are exposed as the `ihub.active.users` and `ihub.active.chats`
observable gauges, so Grafana panels and the log line stay in sync.

## Backend integration

### OpenTelemetry collector + Jaeger + Prometheus

```yaml
# docker-compose.yml
services:
  ihub:
    image: ihub-apps:latest
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
      - OTEL_SERVICE_NAME=ihub-apps
    ports:
      - "3000:3000"
      - "9464:9464"   # Prometheus exporter (only if provider=prometheus)

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otel-config.yaml"]
    volumes:
      - ./otel-config.yaml:/etc/otel-config.yaml
    ports:
      - "4318:4318"

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
```

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: ihub-apps
    static_configs:
      - targets: ["ihub:9464"]
```

`exporters.prometheus.host` must be `0.0.0.0` for a scrape from another host or pod.

### Dashboards and alert rules

Grafana dashboards, Prometheus alert rules, the collector settings that keep series counts stable
(dropping `process.pid` and `host.*` before `resource_to_telemetry_conversion`) and a tail-sampling
setup are in [Dashboards, Alerts and Collector Setup](observability/README.md).

## Privacy & security

- No prompts or completions are captured unless `events.includePrompts` /
  `events.includeCompletions` is explicitly enabled; then they are redacted and capped (see
  [Content capture](#content-capture)).
- Users are pseudonymised on spans by default and groups are never exported (see
  [User identity on spans](#user-identity-on-spans)).
- Every span passes a final redaction before export: `url.full` / `http.url` lose user info,
  query string and fragment, `url.query` is dropped, inbound (SERVER) spans lose the caller's IP
  address, and exception events lose message and stack trace. The OIDC callback `code` and
  `state`, signed URLs and `token` / `key` parameters therefore never reach the trace backend.
- `error.type` is always a generic classification (e.g. `rate_limit_exceeded`),
  never a raw error message. The exception object's `.message` and `.stack`
  are **not** attached to spans by default; set `spans.includeOptInAttributes:
  true` to opt into capturing them for debugging.
- Tool-call arguments are never captured.
- OTLP headers are secrets: encrypted at rest and redacted on admin reads.
- Resource attributes can include service version and deployment environment to
  correlate signals across deployments.
- The startup log line for telemetry redacts OTLP headers (which often contain
  bearer tokens) and only logs header counts plus non-sensitive routing
  metadata.

## Implementation notes

| File | Purpose |
| --- | --- |
| `server/telemetry.js` | SDK bootstrap, public API |
| `server/telemetry/spans.js` | **The** span helper: `startSpan`, `withSpan`, the attribute filter, `error.type`, abort handling |
| `server/telemetry/identity.js` | Pseudonymised user and conversation attributes (`userIdMode`) |
| `server/telemetry/contentCapture.js` | Opt-in prompt / completion capture: redaction, cap, semconv format |
| `server/telemetry/spanRedaction.js` | Last redaction of every span before export (URLs, caller address, exceptions) |
| `server/telemetry/autoInstrumentation.js` | The explicit list of library instrumentations |
| `server/telemetry/exportStatus.js` | Export success / failure per signal, health and admin status |
| `server/telemetry/prometheusCluster.js` | One Prometheus endpoint for all cluster workers |
| `server/telemetry/traces.js` | Spans (and their metrics) of turns, tools, workflows, jobs, retrieval, extraction |
| `server/telemetry/channel.js` | Which client a request came through (`ihub.client.channel`) |
| `server/telemetry/logBridge.js` | Log lines to the OpenTelemetry logs pipeline, filtered |
| `server/telemetry/filesystemSampler.js` | Disk usage for the filesystem gauges |
| `server/telemetry/securityEvents.js` | Which audit entries count as security events |
| `server/instrumentation.mjs` | The `--import` bootstrap |
| `server/telemetry/attributes.js` | Attribute builders for the gen-ai conventions |
| `server/telemetry/metrics.js` | Histograms, counters, observable gauges |
| `server/telemetry/exporters.js` | Console / OTLP / Prometheus exporter wiring |
| `server/telemetry/GenAIInstrumentation.js` | Span and metrics of one LLM call (`LLMCallTelemetry`) |
| `server/telemetry/ActivityTracker.js` | Rolling-window active users / chats tracker |
| `server/telemetry/ProjectActivityTracker.js` | Project working set (5 / 15 / 60 min windows) |
| `server/telemetry/clusterUnion.js` | Union of active ids across cluster workers (via the cluster bus) |
| `server/services/knowledge/indexCacheStats.js` | Index-cache counters behind the knowledge metrics |

The gen-ai span around a provider call is owned by `LLMClient`
(`server/services/loop/LLMClient.js`): one span per model call, whoever the
caller is (chat, workflow nodes, the OpenAI-compatible inference API, admin
utilities). Chat adds its own bookkeeping on top in
`server/services/chat/chatTelemetry.js`: `recordChatCallStart()` /
`recordChatCallEnd()` run from the chat turn seam once per model call — so every
round of a tool loop is counted — and record usage tracking, user activity,
per-app usage and conversation metrics, and the stream outcome. The inference
API (`server/routes/openaiProxy.js`) records activity and counters itself.
