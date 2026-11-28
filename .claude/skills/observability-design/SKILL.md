---
name: observability-design
description: Spans, metrics and logs for iHub's server — when a change needs telemetry, naming, bounded labels, privacy rules, context propagation. Auto-invoked when implementing a feature, route, outbound dependency (HTTP/SDK/MCP/IdP), tool, workflow node, background job, worker thread, queue/cache/pool, auth or security event, or when touching `server/telemetry/`, `metrics.js` or `logger.js`.
user-invocable: false
---

# Observability Design

The canonical rules are in **`docs/observability-guidelines.md`**; read it for the reasoning. This is the working
summary. What admins configure and what is exported today is in `docs/telemetry.md`; the gap list is issue #4008.

## Before you finish an implementation

Answer, and write the answer into the pull request under **Impact**: *how will an operator know that this works,
is used, and is failing?* Pick from the table; "covered by <existing signal>" and "nothing to observe (UI-only /
refactor / test)" are valid answers. Leaving it out is not.

| You added…                                   | Add                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Outbound dependency (HTTP, SDK, MCP, IdP, SMTP, OCR, storage) | CLIENT span, duration histogram with `error.type`, call via `httpFetch()` |
| LLM call                                     | Nothing, if it goes through `LLMClient`                                                 |
| Tool                                         | `activityOrigin` in `server/utils/toolDisplay.js`; the agent loop does the rest         |
| User-facing feature, surface, channel        | A value of an existing label, else a counter                                            |
| Background job, scheduled run, worker thread | Root span, outcome counter, duration histogram, context across `postMessage`            |
| Queue, pool, cache, limit                    | Size gauge, wait histogram; cache hits/misses/evictions                                 |
| User-visible failure                         | Outcome label value or `ihub.errors`; `error.type` on the span                          |
| Auth or security event                       | `ihub.auth.events` (or a security counter) **and** an audit entry                       |
| Setting that sends more data out             | WARN log + audit entry when turned on                                                   |

## Rules

**Spans.** Name = operation + at most one bounded name (`execute_tool {tool.name}`, `workflow.node {node.type}`),
never an id, user, query or URL. Semantic-convention attribute names first (`gen_ai.*`, `error.type`,
`server.address`), own ones under `ihub.`. Create them through `server/telemetry/` helpers, not
`trace.getTracer()` in feature code. Active (`startActiveSpan` / `context.with`) when it has children. End in
`finally`. `ERROR` only for failures; a user stop sets `ihub.aborted=true`, no error. Only `error.type`: no
`recordException()`, no `error.message`. Counts and sizes, not content.

**Metrics.** Instrument defined in `server/telemetry/metrics.js` with an exported `recordX()` that no-ops before
init; feature code only calls it. Name `ihub.<area>.<thing>` or the semconv name. Units: `s`, `By`,
`{request}`. Counter for events, histogram (explicit buckets) for durations/sizes, UpDownCounter for in-flight,
stateless observable gauge for current values. Labels from a **closed set**, mapped to `other`/`unknown` outside it,
key added to `ALLOWED_METRIC_LABELS`. Never a label: user, email, group, any id, file name, URL, query, tool
argument, MCP-reported tool names, free text. Say in the description whether a gauge is per process (`sum`) or the
cluster union (`max`). Never read labels from `span.attributes`.

**Privacy.** No content (prompts, completions, queries, tool args/results, titles, file names, URL queries) on
any signal unless through the opt-in content events. No clear-text identity: users only via the pseudonymising
helper, no groups. No secrets (tokens, keys, cookies, OAuth `code`/`state`, signed URLs); a secret setting goes
into `PLATFORM_SECRET_PATHS`. No raw provider error text. A new attribute that could be personal data gets a
sentence in `docs/pii-data-handling.md`.

**Logs.** `server/utils/logger.js` with a `component`, not `console.*`. Detail for one case only; rates are
metrics.

**Propagation.** HTTP via `httpFetch()` / `createAgent()`. Inject/extract context across worker threads and the
cluster bus. A resumed run gets a span link, not a stale parent.

**Tests.** Assert the recorded labels/attributes (fake meter as in `server/tests/answer-origin-metrics.test.js`,
or an in-memory span exporter), the neutral value for out-of-set input, and the privacy default.

**Docs.** New signal → metric/span reference in `docs/telemetry.md` (type, unit, labels, `sum`/`max`). Outage
signal → alert rule. Admin-visible or renamed signal → release note in `docs/releases/next/` (a rename breaks
dashboards: breaking change).

## Touching existing code

Until #4008 lands, only the LLM call has a span and `user.id` goes out in clear text (`server/telemetry/attributes.js`).
Do not copy that pattern into new code. Bring code you touch in line when it is cheap; do not widen a task into a
telemetry rewrite.
