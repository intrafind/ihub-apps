---
description: "The rules for spans, metrics and logs that every change to iHub follows."
audience: developer
type: reference
---

# Observability Guidelines

The rules for traces, metrics and logs in iHub Apps. Read this together with [Telemetry](telemetry.md), which
describes what an admin configures and what the server exports today.

Why the rules exist: observability grew one feature at a time. The LLM call has a span. Tools, workflows,
retrieval and background jobs had none, so an operator could not tell why an answer was slow, and some identifiers
reached the trace backend in clear text. A feature nobody can observe in production is not finished.

They follow the [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/), above all
[GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/), with the iHub additions listed below.

**Scope:** the `server/` code of this repository. The browser client sends no telemetry.

**Rule of thumb:** every change answers one question in its pull request: *how will an operator know that this
works, is used, and is failing?* The answer may be "it is covered by an existing span or metric" or "nothing to
observe". It is never left out.

## 1. When a change needs telemetry

| The change adds…                                                        | It needs                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| An outbound dependency: HTTP API, SDK, MCP server, IdP, SMTP, OCR, storage backend | A CLIENT span per call, a duration histogram with `error.type`, the dependency kind as a label. The call goes through `httpFetch()` so the trace context propagates ([§7](#7-context-propagation)) |
| An LLM call                                                             | Nothing extra if it goes through `LLMClient`; that creates the GenAI span and metrics. Never call a provider around it                         |
| A tool                                                                  | An `activityOrigin` (`server/utils/toolDisplay.js`); the agent loop creates the `execute_tool` span and counts the call. Configured tool ids are a bounded set; tool names an MCP server reports at runtime are not |
| A user-facing feature or surface (route, workflow node type, channel)   | A usage signal: a new value of an existing label (`ihub.surface`, `ihub.client.channel`, `app.id`) or, when no label fits, a counter            |
| A background job, scheduled task, worker thread, queue consumer          | A root span per run, an outcome counter, a duration histogram; context carried across `postMessage` and the cluster bus                           |
| A queue, pool, cache or concurrency limit                               | Size gauge, wait-time histogram, and for caches hits, misses and evictions                                                                    |
| A failure a user sees (an error, a refusal, a timeout, an empty answer)  | A value of an outcome label (`ihub.turn.outcome`, `stream.outcome`, `tool.outcome`) or `ihub.errors`; and `error.type` on the span               |
| An authentication or security event                                     | `ihub.auth.events` (or a security counter) **and** an audit entry; per-user detail only in the audit log                                       |
| A config setting that changes data leaving the server                   | A WARN log and an audit entry when it is turned on (see `events.includePrompts`)                                                               |
| A UI-only change, a refactor, a test, a dependency bump                 | Usually nothing. Say so in the pull request                                                                                                    |

## 2. Which signal

| Question                                                         | Signal                    | Where                                                       |
| ---------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| How often, how fast, how many, per app / model / surface?        | Metric                    | `server/telemetry/metrics.js`                               |
| Why was *this* request slow or wrong? Which step?                | Span                      | `server/telemetry/` helpers                                 |
| What exactly happened, with detail a metric cannot carry?        | Log line                  | `server/utils/logger.js`                                    |
| Who used how much, at what cost, by group?                       | Usage record              | `server/services/usage/` (follows the usage privacy mode)   |
| Who changed or accessed what (accountability)?                   | Audit entry               | audit log (`server/validators/auditEntrySchema.js`)         |

OpenTelemetry answers *is it healthy, fast and used*. Per-user, per-group and cost figures belong in usage records,
which respect the usage tracking mode and retention. Never build a per-user report on spans.

## 3. Spans

**Names** are low-cardinality: the operation and at most one bounded name. Never an id, a user, a query or a URL.

| Operation             | Span name                    | Kind     |
| --------------------- | ---------------------------- | -------- |
| Chat turn / agent run | `invoke_agent {app.id}`      | SERVER or INTERNAL |
| LLM call              | `{gen_ai.operation.name} {gen_ai.request.model}` | CLIENT |
| Tool call             | `execute_tool {tool.name}`   | INTERNAL |
| Workflow run / node   | `workflow.run`, `workflow.node {node.type}` | INTERNAL |
| Retrieval             | `retrieval {source.provider}` | CLIENT  |
| Text extraction       | `extraction {format}`        | INTERNAL |
| Outbound dependency   | from HTTP auto-instrumentation, or `{dependency} {operation}` | CLIENT |

**Rules**

- Use the semantic convention name for an attribute when one exists (`gen_ai.*`, `error.type`, `server.address`,
  `http.*`). Own attributes use the `ihub.` prefix or an existing iHub namespace (`app.id`, `tool.origin`).
- Create spans through the helpers in `server/telemetry/`, not `trace.getTracer()` in feature code, so the tracer
  name, the attribute filter and the privacy rules apply in one place.
- Make the span **active** (`startActiveSpan` / `context.with`) when it has children, so nested calls attach to it.
  Bind async generators and stream callbacks to the context.
- **Always end the span**, in `finally`. A stream that is never read, a client that disconnects and a disabled
  setting must all still end it.
- Status: `ERROR` for a failure only. A user stop or client disconnect is not an error: leave the status unset and
  set `ihub.aborted=true`.
- Errors: set `error.type` (a class name, an HTTP status mapping, a closed code). Do **not** call
  `span.recordException()` or put `error.message` in the status: provider errors echo prompts and keys. The
  opt-in `spans.includeOptInAttributes` is the only exception.
- Record counts and sizes (`ihub.result.count`, `ihub.result.bytes`), not the content.
- Metrics never read their labels from `span.attributes`. A sampled-out span has none.

## 4. Metrics

**Define** every instrument in `server/telemetry/metrics.js` and export a `recordX()` function that is a no-op
until telemetry is initialised. Feature code calls the function and never creates an instrument.

**Name** `ihub.<area>.<thing>`, dot-separated and lower case, or the semantic convention name
(`gen_ai.client.inference.duration`). Prometheus turns dots into underscores and appends the unit.

**Unit** in UCUM: seconds `s` (never milliseconds), bytes `By`, counts as `{request}`, `{call}`, `{token}`.

**Type**

| Measures                                   | Instrument                         |
| ------------------------------------------ | ---------------------------------- |
| Things that happened                        | Counter                            |
| Durations, sizes, tokens                    | Histogram with explicit buckets    |
| Things in progress (in-flight, queued)      | UpDownCounter                      |
| A current value read on collection          | Observable gauge, **stateless** (no "since last collect" resets: two scrapers break it) |

**Labels**

- Every label value comes from a **closed set**: an enum, a model id from config, a catalog name. A value outside
  the set is recorded as a neutral one (`other`, `unknown`), as `recordToolCall()` does.
- A new label key goes into `ALLOWED_METRIC_LABELS`; anything else is dropped before recording.
- **Never** a label: user id, user name, email, group, conversation id, run id, request id, project id, document
  id, file name, URL, query, tool argument, tool names an MCP server reports at runtime, free text, a number that
  is the measured value.
- Ids belong on the span, where you can drill in.

**Cluster mode.** Every worker process exports its own metrics. State in the description whether a gauge is per
process (dashboards `sum`) or the cluster-wide union (dashboards `max`), as the existing gauges do.

## 5. Privacy and security

These hold for every signal: span attributes, span events, metric labels, resource attributes and log lines.

- **No content by default.** Prompts, completions, system prompts, search queries, tool arguments and results,
  document titles, snippets, file names and URL query strings stay out. The only path for content is the opt-in
  `telemetry.events.includePrompts` / `includeCompletions`, through the sanitizer in `server/telemetry/attributes.js`.
- **No identities in clear text.** A user goes on a span only through the pseudonymising helper, never as the raw
  login, email or Windows name. Groups stay out. Hashing of conversation and run ids follows the same helper.
- **No secrets, ever.** Tokens, keys, cookies, `Authorization` headers, OAuth `code`/`state`, signed URLs. A
  setting that holds a secret is listed in `PLATFORM_SECRET_PATHS` and encrypted at rest.
- **No raw error messages** from providers or integrations (see [§3](#3-spans)).
- A new attribute or label that could carry personal data needs a sentence in
  [PII Data Handling](pii-data-handling.md). When in doubt, leave it out: you can add an attribute later, but you
  cannot recall exported data.

## 6. Logs

- Log through `server/utils/logger.js` with a `component`; it redacts secrets. New server code does not use
  `console.*`.
- A log line is for detail you need for one case. A rate or a count is a metric; do not count log lines.
- Log lines inside a request carry the trace id so logs and traces can be joined.
- The privacy rules of [§5](#5-privacy-and-security) apply to log lines as well.

## 7. Context propagation

- Outbound HTTP goes through `httpFetch()` / `createAgent()` (`server/utils/httpConfig.js`), which the SSL rules
  already require. That is also where the trace context is injected.
- Work handed to a worker thread or another cluster process carries the context: inject it into the message
  (`propagation.inject`) and extract it on the other side.
- A run that resumes later (a workflow after a human decision, a retried task) starts a new trace with a **span
  link** to the original one, not a parent that ended hours ago.
- Incoming `traceparent` from callers (Office add-in, browser extension, OpenAI-compatible API, MCP clients) is
  honoured; it is allowed through CORS.

## 8. Tests

A new metric or span gets a test that shows it is recorded **with the expected labels or attributes**, and that a
value outside the closed set is mapped to the neutral value. Use a fake meter as
`server/tests/answer-origin-metrics.test.js` does, or an in-memory span exporter. A privacy-relevant attribute
gets a test that it is absent (or hashed) by default.

## 9. Documentation and alerts

- A new metric or span goes into the reference in [Telemetry](telemetry.md): name, type, unit, labels, and `sum`
  or `max` across workers.
- A signal that indicates an outage or a degraded service gets an alert rule and a dashboard panel next to the
  existing ones.
- A change admins can see (a new metric, a changed name or label) gets a release note in `docs/releases/next/`.
  A renamed metric or attribute breaks dashboards: say so under breaking changes.

## Checklist

- [ ] The pull request says how an operator will see that the change works, is used and fails, or why nothing applies
- [ ] New outbound dependency: span, duration with `error.type`, call through `httpFetch()`
- [ ] New background work, worker thread or resumable run: root span or link, context propagated
- [ ] Spans created through the `server/telemetry/` helpers, active when they have children, ended in `finally`
- [ ] Errors set `error.type` only; aborts are not errors
- [ ] Metrics defined in `metrics.js`, seconds and bytes, labels from a closed set and in `ALLOWED_METRIC_LABELS`
- [ ] No content, clear-text identity, secret or raw error message on any signal
- [ ] Test covers labels/attributes and the privacy default
- [ ] `docs/telemetry.md` reference, alert rule if it signals an outage, release note if admins see it

## Where we are

The rules describe the target. Issue #4008 brings the existing code there, one work package at a time.

Done (P0):

- `server/telemetry/spans.js` is the span helper (`startSpan`, `withSpan`, `SpanHandle`, the
  attribute filter, `errorTypeOf`, `isAbortError`); the LLM call span uses it
  (`GenAIInstrumentation.js`). Copy that pattern.
- `server/telemetry/identity.js` is the pseudonymising helper: `userSpanAttributes()` and
  `conversationSpanAttributes()` follow `telemetry.spans.userIdMode` (default `pseudonymised`,
  `user.hash`). Groups are never exported.
- Content capture is redacted, capped at 4096 characters and in the current semconv format
  (`contentCapture.js`); every exported span passes `spanRedaction.js`.
- GenAI metrics no longer read `span.attributes`; they are recorded with spans off.
- A signal that is off has no processor (no SDK fallback); export failures are counted
  (`ihub.telemetry.export.failures`) and shown in `/api/health` and the admin system view.
- Cluster mode: stable `service.instance.id`, one Prometheus endpoint labelling each worker.

Done (P1):

- The server starts through `server/instrumentation.mjs` (`node --import`), so HTTP and Express are
  instrumented and an incoming `traceparent` is honoured.
- `server/telemetry/traces.js` starts the spans of §3: `invoke_agent`, `inference`, `tools/call`,
  `a2a.task`, `execute_tool`, `workflow.run` / `workflow.node`, `scheduled_task.run`, `retrieval`,
  `extraction`. Use its helpers (or `withSpan`) for a new unit of work.
- `injectContext` / `extractContext` / `runInCarrierContext` / `linksFrom` carry the trace across
  the cluster bus and to resumed runs; `SpanHandle.bindIterable` binds an async iterator.
- `spans.sampleRate` is wired.

Done (P2):

- `ihub.surface` and `ihub.client.channel` (`telemetry/channel.js`) label the turn, app usage,
  stream outcome and GenAI metrics; `ihub.turns` carries `ihub.turn.outcome`.
- Turn, tool, workflow, node and human-wait durations are recorded by the `traces.js` helpers that
  start their spans, so a new unit of work gets both from one call.
- Outbound requests through `httpFetch` are measured per dependency kind: pass
  `dependency: 'llm' | 'ifinder' | 'idp' | …` for a new dependency.
- `ihub.security.events` is derived from audit entries (`telemetry/securityEvents.js`): a new
  security-relevant audit resource gets a line there.

Still open:

- Log lines carry trace ids only with `autoInstrumentation` (P3 adds them in the logger itself).
