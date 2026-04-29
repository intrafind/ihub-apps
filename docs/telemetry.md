# Telemetry & Observability

iHub Apps emits OpenTelemetry signals for every LLM operation following the official
[Generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
Administrators can wire iHub into any standard observability backend - Jaeger, Tempo,
Grafana, Prometheus, or a generic OTLP collector - to monitor app usage, track token
consumption, identify errors, and analyze performance.

## At a glance

| Signal type | Examples | Where it ends up |
| --- | --- | --- |
| **Spans** | `chat gpt-4o`, `generate_content gemini-2.5-pro` | Jaeger, Tempo, OTLP collector |
| **Metrics** | `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `ihub.app.usage`, `ihub.active.users` | Prometheus, OTLP collector |
| **Events**  | `gen_ai.content.prompt`, `gen_ai.content.completion`, `gen_ai.choice` | Attached to spans |
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

3. **Verify** Prometheus is being scraped:

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
        "host": "0.0.0.0"
      }
    },
    "spans": {
      "enabled": true,
      "sampleRate": 1.0,
      "includeOptInAttributes": false
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
      "deployment.environment": "production"
    }
  }
}
```

### Hot-reload behaviour

| Setting | Restart required |
| --- | --- |
| `enabled` | Yes |
| `provider` (console / otlp / prometheus) | Yes |
| `exporters.*` (endpoint, port, headers) | Yes |
| `metrics.exportInterval` | Yes |
| `events.includePrompts`, `events.includeCompletions`, `events.maxEventSize` | No - applied immediately |
| `spans.includeOptInAttributes` | No - applied immediately |
| `activitySummary.*` | No - re-armed on save |

## Spans

Each LLM call produces one span named `<operation> <model>` (e.g. `chat gpt-4o`).
Required and conditionally required attributes follow the gen-ai conventions:

| Attribute | Notes |
| --- | --- |
| `gen_ai.operation.name` | `chat`, `generate_content`, `text_completion` |
| `gen_ai.provider.name`  | `openai`, `anthropic`, `google`, `mistral_ai` |
| `gen_ai.request.model`  | Model id sent to the provider |
| `gen_ai.request.temperature` | When known |
| `gen_ai.request.max_tokens`  | When set |
| `gen_ai.response.id`         | Provider response id |
| `gen_ai.response.model`      | Provider-reported model |
| `gen_ai.response.finish_reasons` | Array of finish reasons |
| `gen_ai.usage.input_tokens`  | Prompt tokens |
| `gen_ai.usage.output_tokens` | Completion tokens |
| `error.type`                 | `rate_limit_exceeded`, `authentication_error`, `timeout`, `http_<code>` |

iHub-specific span attributes:

| Attribute | Description |
| --- | --- |
| `app.id`, `app.name` | iHub app receiving the request |
| `user.id`, `user.groups` | Identified user (when authentication is enabled) |
| `gen_ai.conversation.id` | Chat session id |
| `conversation.is_follow_up` | True when the chat already had >2 messages |
| `conversation.message_count` | Length of the message array |

## Metrics

Standard gen-ai histograms:

- `gen_ai.client.token.usage` - histogram of input/output tokens (one record per
  direction, with `gen_ai.token.type=input|output`)
- `gen_ai.client.operation.duration` - histogram of operation durations in seconds

iHub product counters & gauges:

- `ihub.app.usage` - per app request counter
- `ihub.errors` - errors by type and context (`llm_call`, `inference_api`, ...)
- `ihub.conversations` - chat messages with the `conversation.is_follow_up` dimension
- `ihub.active.users` - **observable gauge**, distinct users active in the rolling
  window (default 5 min)
- `ihub.active.chats` - **observable gauge**, distinct chats active in the rolling
  window
- `ihub.stream.outcome` - streaming chat outcomes (`completed`, `aborted`, `error`)
- `ihub.ratelimit.hits` - throttler / rate-limit hits, labelled by `ratelimit.scope`
  (`http`, `llm`) and `ratelimit.route`
- `ihub.auth.events` - login / logout / token-validated / token-invalid /
  token-expired counters labelled by `auth.provider`
- `ihub.upload.requests` + `ihub.upload.size` - file upload counter and size
  histogram, labelled by `upload.kind` and `upload.outcome`
- `ihub.source.duration` + `ihub.source.errors` - source / RAG load duration
  histogram and error counter, labelled by `source.type`
- `ihub.config.reload` + `ihub.config.reload.duration` - configuration cache
  reload counter and duration histogram, labelled by `config.file`
- `ihub.magicprompt.usage` - magic-prompt invocation counter
- `ihub.feedback` + `ihub.feedback.rating` - user feedback counter (per rating)
  and 1-5 rating histogram

Process / runtime gauges (registered automatically when telemetry is enabled):

- `process.cpu.utilization` - 0-1 CPU utilisation (user + system, summed)
- `process.runtime.nodejs.memory.usage` - rss / heap_used / heap_total / external
- `process.runtime.nodejs.event_loop.delay` - mean event-loop delay in seconds
- `ihub.workers.count` - number of cluster workers visible from this process

Optional: enable `telemetry.autoInstrumentation: true` (admin UI / platform.json)
to also load the Node auto-instrumentations: HTTP/Express/DNS/fs/net. That gives
you `http.server.duration`, `http.server.active_requests`, request/response
size histograms etc. for free, but every HTTP request becomes a span - turn it
on intentionally.

### Useful PromQL examples

```promql
# Token usage by model
sum by (gen_ai_request_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum[5m]))

# P95 latency per provider
histogram_quantile(0.95,
  sum by (le, gen_ai_provider_name) (rate(gen_ai_client_operation_duration_bucket[5m])))

# Error rate
rate(ihub_errors_total[1h])

# Top 10 most used apps
topk(10, sum by (app_id) (rate(ihub_app_usage_total[1h])))

# Follow-up message ratio
sum(rate(ihub_conversations_total{conversation_is_follow_up="true"}[1h])) /
sum(rate(ihub_conversations_total[1h]))

# Concurrent user/chat count
ihub_active_users
ihub_active_chats
```

## Events

When `telemetry.events.enabled` is true and the corresponding opt-in is set:

- `gen_ai.content.prompt` - emitted with `gen_ai.prompt = "<role>: <message>..."`
- `gen_ai.content.completion` - emitted with `gen_ai.completion`
- `gen_ai.choice` - emitted for tool calls; tool arguments are *not* included by
  default to avoid leaking sensitive payloads

Event content is truncated to `events.maxEventSize` bytes (default 1 KB) before being
attached to the span.

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

## Privacy & security

- No prompts or completions are captured unless `events.includePrompts` /
  `events.includeCompletions` is explicitly enabled.
- `error.type` is always a generic classification (e.g. `rate_limit_exceeded`),
  never a raw error message. The exception object's `.message` and `.stack`
  are **not** attached to spans by default; set `spans.includeOptInAttributes:
  true` to opt into capturing them for debugging.
- Tool-call arguments are excluded from `gen_ai.choice` events by default.
- Resource attributes can include service version and deployment environment to
  correlate signals across deployments.
- The startup log line for telemetry redacts OTLP headers (which often contain
  bearer tokens) and only logs header counts plus non-sensitive routing
  metadata.

## Implementation notes

| File | Purpose |
| --- | --- |
| `server/telemetry.js` | SDK bootstrap, public API |
| `server/telemetry/attributes.js` | Attribute builders for the gen-ai conventions |
| `server/telemetry/events.js` | Prompt / completion / choice event emission |
| `server/telemetry/metrics.js` | Histograms, counters, observable gauges |
| `server/telemetry/exporters.js` | Console / OTLP / Prometheus exporter wiring |
| `server/telemetry/GenAIInstrumentation.js` | Span lifecycle helper |
| `server/telemetry/llmInstrumentation.js` | Reusable wrapper used at chat fetch sites |
| `server/telemetry/ActivityTracker.js` | Rolling-window active users / chats tracker |

The chat call sites (`server/services/chat/NonStreamingHandler.js`,
`server/services/chat/StreamingHandler.js`, `server/routes/openaiProxy.js`) all
register activity, record iHub counters, and create gen-ai spans around the
provider HTTP call.
