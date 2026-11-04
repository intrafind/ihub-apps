# Usage Reporting Improvements — Gap Analysis & Plan

Status: decided (see §5) · Builds on `concepts/2026-02-27 Enhanced Usage Tracking.md` (which delivered provider-reported tokens, the JSONL event log, rollups and tracking modes).

**Out of scope:** pricing, cost and currency budgets. Reports show tokens and requests only.

## 1. Where we stand

There are three stores:

| Store | File | What it holds | Feeds |
|---|---|---|---|
| Lifetime counters | `contents/data/usage.json` (`server/usageTracker.js`) | totals per user/app/model/provider since last reset, no time axis | Overview, Users, Apps, Magic, Details tabs |
| Event log + rollups | `usage-events.jsonl`, `usage-daily/`, `usage-monthly/` (`server/services/UsageEventLog.js`, `UsageAggregator.js`) | one event per chat request *and* per response; hourly rollup job | Timeline tab |
| Quota ledger | `quota-usage.json` (`server/services/quota/QuotaLedger.js`) | current window counts per user × model | Limits & quotas tab, enforcement |

Admin UI: `client/src/features/admin/pages/AdminUsageReports.jsx` + `components/UsageTimeline.jsx` (hand-rolled SVG charts).

## 2. Gaps (verified in code)

### Correctness — the numbers are wrong or incomplete today

1. **Only interactive chat is counted.** Analytics are recorded via `chatTelemetry` → `chatTurnSeam`, whose only caller is `ChatService`. Agents, workflows, scheduled tasks and the Inference API reach the quota ledger (`LLMClient.execute`) but never the usage reports. Reports undercount, and the quota view and the reports disagree.
2. **Message counts are inflated.** `UsageAggregator.buildDailyRollup` (L93–133) adds `messages: 1` to every per-dimension entry for *every* event — including `feedback` and `magic_prompt` — and a request plus its response count as two messages.
3. **"Identified" mode isn't identified.** `chatTelemetry.recordChatCallRequest` passes `baseLog.userSessionId` as the user id, so in all three modes "users" are browser sessions. `anonymous` hashes the session id, not the user; one person appears as many users and "unique users" is meaningless.
4. **Tabs disagree.** Overview/Users/Apps read lifetime `usage.json` with no date filter; Timeline reads rollups. The same screen shows two different totals.
5. **Failures are invisible.** Aborted or failed calls record an estimated prompt and nothing else — no status, no error code.

### Missing capability

6. **No group dimension** in analytics, so no breakdown per department, even though groups drive everything else.
7. **No latency, error rate, tool-call or surface (chat/agent/workflow/API) fields.** These exist only in OpenTelemetry (`server/telemetry/metrics.js`), which many installs do not run.
8. **No per-conversation stats.** The `cid` field exists in the event schema but is never set.
9. **No request-level view.** "Details" shows lifetime counters, not individual calls; there is no way to answer "what happened at 14:02 for this user?".
10. **No live view.** Data lags up to one hour (rollup cadence) unless an admin clicks "Generate report"; there is no "today so far" or "in flight now".
11. **Export is unused.** `GET /api/admin/usage/export` (raw events, CSV/JSON) exists but the UI only offers a summary-totals CSV.

### Scale and robustness

12. Every rollup run re-reads the **whole** event file and regenerates **every** day.
13. The single JSONL file never rotates; retention rewrites it under a lock that is per-process only (`server/utils/jsonlAppender.js`), which races with other workers in multi-worker deployments.
14. `/usage/feedback` loads and sorts the whole feedback file per request.

## 3. Target picture

One **call record** per LLM call, written at a single seam that every surface goes through, carrying tokens, outcome, timing and groups. Pre-aggregated daily rollups with hourly buckets make range queries cheap. Every tab reads from that one pipeline with one shared time-range selector. The lifetime counter file and its endpoint go away (clean break, §5.1), and existing usage data is reset (§5.2).

### 3.1 Call record (event schema v2)

Written once per model call, after it finishes (success, error or abort):

| Key | Field | Notes |
|---|---|---|
| `v` | schema version | `2`; v1 data is reset, so the aggregator reads v2 only |
| `ts` | end timestamp | |
| `type` | `llm_call` / `feedback` / `magic_prompt` | replaces `chat_request` + `chat_response` pair |
| `surf` | surface | `chat`, `agent`, `workflow`, `task`, `api`, `magic` |
| `uid` | user | resolved by tracking mode from the **real** user id |
| `grp` | groups | recorded at call time (§5.3); inherited defaults (`authenticated`, `anonymous`) are left out |
| `app`, `model`, `prov` | as today | |
| `cid` | conversation / run id | fingerprinted in anonymous mode (`fingerprintConversation` exists) |
| `pt`, `ct`, `cr`, `cw`, `rt`, `ws` | tokens | as today; `pt` includes cached tokens, consistently across adapters |
| `src` | `provider` / `estimate` | as today |
| `st` | outcome | `ok`, `error`, `aborted`, `quota`, `rate_limited` |
| `err` | error code | normalized code, no message text |
| `lat`, `ttft` | total ms, time to first token | |
| `tc` | tool calls in this call | count |

**Seam:** record from `LLMClient` (where quota is already counted and every surface converges), not from `chatTurnSeam`. The caller passes `surface` and `conversationId` in the execution context. The chat seam stops recording analytics itself, and `chatTelemetry` keeps only OTel and activity.

### 3.2 Storage & aggregation

- **Daily event files:** rotate the event log into `usage-events/YYYY-MM-DD.jsonl`. Retention then becomes "delete files older than `eventRetentionDays`", with no rewrite and no cross-process race. Appends stay cross-process safe.
- **Incremental rollup:** re-aggregate only *today* and *yesterday* (late flushes), plus any day marked dirty, and stop re-reading history.
- **Hourly buckets:** daily rollups gain `byHour[0..23]` totals for the Today/24h charts.
- **Read path:** ranges up to now combine stored rollups with a live aggregation of today's file, cached ~30s. This removes the one-hour lag and the "Generate report" button.
- **Rollup dimensions:** user, group, app, model, provider, surface, outcome. Each carries requests, tokens by kind, errors, and latency sum/count plus a small fixed-bucket histogram, enough for p50/p95 without raw data.
- **Reset:** `usage.json`, `usage-events.jsonl` and the old `usage-daily/` and `usage-monthly/` rollups are deleted once at first start on the new version. The quota ledger is untouched.

### 3.3 Admin dashboard

All tabs share one **time-range control** (Today, 24h, 7d, 30d, 90d, 12m, custom), stored in the URL.

1. **Overview KPI cards:** requests, input tokens, cached tokens (with cache-hit %), output tokens, error rate, p95 latency, active users. Each card shows the change against the previous equal period.
2. **Usage over time:** one chart with a metric toggle (Tokens / Requests). Buckets are hourly for Today/24h and daily otherwise. Input, cached and output are stacked.
3. **Breakdown table:** a dimension switch (User, Group, App, Model, Provider, Surface).
   - Rows expand into per-model sub-rows.
   - Columns are sortable, with the sort kept in the URL, and include a "last used" column.
   - This replaces today's separate Users and Apps tabs.
4. **Top-N charts:** top models and top apps.
5. **Reliability panel:** error rate over time, errors by code and by provider, and latency p50/p95 by model.
6. **Request log (new "Requests" tab):**
   - Paginated list of call records with filters for user, app, model, surface, outcome and date.
   - A drawer shows metadata only: tokens, latency, tool calls, error code.
   - **No prompt or response bodies:** this follows `docs/pii-data-handling.md` and respects the tracking mode, and `logInteraction` already covers debugging.
   - Retention follows `eventRetentionDays` (§5.5).
7. **Exports:**
   - The breakdown table exports to CSV.
   - "Raw events" wires up the existing `/usage/export` with the current range.
8. **UX polish:**
   - Charts render in the existing chart library or are lazy-loaded, so they stay out of the main admin bundle.
   - Every view has its own empty state.
   - Refreshes keep the previous data visible behind a small loading indicator instead of a spinner over a blank page.
   - An optional auto-refresh toggle covers "Today".
   - Numbers use `Intl.NumberFormat` with K/M on chart axes, and times are relative ("5m ago").

### 3.4 Quotas (Limits & quotas tab)

- **Per user × model rows:** a % used bar (green → amber at 70% → red at 90%) and a reset countdown, from `resetSchedule.js`.
- **"Near limit" list:** users above 80% of any limit, sorted by time to reset.

### 3.5 End users

`GET /api/usage/me` already exists. Add a small "My usage" panel (tokens this period, remaining quota with reset time) so users understand a `QUOTA_EXCEEDED` before they hit it.

### 3.6 Live activity (optional, last)

- **Panel:** "in flight now" count by model and a ring buffer of recent calls, served over SSE.
- **Multi-worker caveat:** state is per worker, so this needs cross-worker aggregation, either cluster IPC to the primary or a short-TTL shared file. Treat it as nice-to-have and see `concepts/2026-07-28 Round-Robin Worker-Local State Audit.md`.

## 4. Phased plan

| Phase | Scope | Size | Depends on |
|---|---|---|---|
| **0 — Fix the numbers** | Fix message inflation (gap 2). Use the real user id for `identified`/`anonymous` (gap 3). Count a request/response pair as one message. Unit tests for `buildDailyRollup`. | S | — |
| **1 — One seam, v2 records** | Move recording into `LLMClient` with `surface`/`conversationId` context. Write v2 `llm_call` events with outcome, error code, latency, TTFT, tool calls and groups. One-time reset of the old usage data. Agents, workflows, tasks and the API now appear in reports. | M | 0 |
| **2 — Storage** | Daily-rotated event files. Incremental rollups with hourly buckets and the new dimensions. Live "today" read path. File-delete retention. Paginated feedback reads. | M | 1 |
| **3 — Dashboard** | Shared range control, KPI cards with deltas, metric-toggle chart, breakdown table, reliability panel, exports. All tabs on rollups. Remove `usage.json`, `server/usageTracker.js` counters and `GET /api/admin/usage`. | L | 2 |
| **4 — Request log** | `GET /api/admin/usage/calls` (paginated and filtered over the day files) and the Requests tab with its drawer. | M | 2 |
| **5 — Quotas & end users** | % bars, reset countdowns, near-limit list, "My usage" panel. | M | 1 |
| **6 — Live activity** | SSE in-flight and recent calls, with cross-worker aggregation. | M | 1 |

Phases 0 and 1 matter most: until they land, every chart is built on undercounted and miscounted data.

**Each phase also delivers:**

- unit tests in `tests/unit/`;
- an e2e check of the admin page using the default local admin;
- doc updates in `docs/usage-limits.md` and a new or updated usage-reporting section in `docs/`;
- i18n keys for all new UI strings (en, de).

Usage reporting has not been rolled out, so the fixes and the reset need no release note. Run `/document-feature` per phase anyway; it skips changes to features that have not shipped.

## 5. Decisions

1. **`usage.json` and `GET /api/admin/usage`:** clean break, no compatibility view.
2. **History:** the identity fix ships with a reset of all usage data, and no release note, since usage reporting has not been rolled out.
3. **Groups:** recorded on each call record at call time; reports do not follow later group reassignments.
4. **Pricing:** left out entirely, with no cost fields, pricing config or budgets.
5. **Request log retention:** the same `eventRetentionDays` setting as the event log (default 90).
