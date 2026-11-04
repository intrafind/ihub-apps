# Usage Reporting

**Observability → Usage Reports** (`/admin/usage`) shows how the models are used: requests, tokens,
errors and latency of every model call, per user, group, app, model, provider and surface. It is
the analytics side of usage; enforcing budgets is [Usage Limits](usage-limits.md).

Reports show tokens and requests only. There are no prices, costs or budgets in money.

## What is counted

Every model call writes one **call record** when it ends, whether it succeeded, failed, was stopped
or was refused by a usage limit. The record is written by `LLMClient`, the one place every model
call passes through, so every surface is counted the same way:

| Surface | What it covers |
| --- | --- |
| Chat | Chat turns, including every round of a tool loop and sub-agents |
| Agent | Agent runs |
| Workflow | Workflow nodes (prompt, planner, verifier, …) |
| Scheduled task | Runs of a scheduled task |
| API | The OpenAI-compatible Inference API |
| Magic prompt | The magic prompt button |
| System | Everything else: chat titles, translations in the admin, OCR, model tests |

A record holds metadata only:

| Field | Meaning |
| --- | --- |
| time | When the call ended |
| surface | See above |
| user | Depends on the tracking mode (below); empty for system work |
| groups | The user's groups at the time of the call, without the built-in `authenticated` and `anonymous` |
| app, model, provider | Which app, model and provider adapter |
| conversation | Chat id, workflow execution or run id (fingerprinted in anonymous mode) |
| request id | The `req-…` id of the call, also in the server log |
| input, output tokens | Input includes cached tokens; output includes reasoning tokens |
| cached, cache write, reasoning, web searches | Only when the provider reports them |
| token source | `provider` (reported) or `estimate` (computed locally, e.g. for a failed call) |
| outcome | `ok`, `error`, `aborted` (stopped), `quota` (refused by a usage limit), `rate_limited` |
| error code | A normalized code such as `TIMEOUT` or `CONTEXT_WINDOW_EXCEEDED`, never a message |
| latency, time to first token | Milliseconds, from the start of the call |
| tool calls | Tool calls the model asked for in this call |

A record never holds prompt or response text. Feedback ratings are recorded the same way, with the
rating instead of tokens.

Groups are recorded when the call is made. Reports do not follow later group changes: moving a user
to another group changes the reports from then on.

### Tracking mode

**Tracking mode** at the top of the page (`features.usageTrackingMode` in `platform.json`) decides
who a record names. It applies to records written from then on.

| Mode | User | Conversation |
| --- | --- | --- |
| `pseudonymous` (default) | The conversation (each conversation counts as a user) | As is |
| `anonymous` | `usr_…` fingerprint of the user id — one person is one user | `conv_…` fingerprint |
| `identified` | The user id | As is |

Fingerprints are one-way SHA-256 hashes with a server-side pepper (`contents/.usage-pepper`).
"Active users" and the user breakdown count people in `anonymous` and `identified` mode, and
conversations in `pseudonymous` mode.

`features.usageTracking: false` turns recording off entirely. Usage limits still count: they keep
their own counters (see [Usage Limits](usage-limits.md#storage-and-privacy)).

## The page

All tabs except **Limits & quotas** share one time range: **Today**, **24 hours**, **7 days**,
**30 days**, **90 days**, **12 months** or a **Custom** span of days. Days are UTC days. The range,
tab, breakdown dimension, sort and chart metric are part of the URL, so a view can be bookmarked and
shared. **Today** and **24 hours** offer **Auto-refresh** (every 30 seconds).

Today is always live: the reports combine the stored daily rollups with what was recorded today, at
most 30 seconds old. There is no lag and nothing to generate by hand.

### Overview

- **KPI cards**: requests, input tokens, cached input (with the cache hit rate), output tokens,
  error rate, p95 latency (with p50) and active users. Each shows the change against the previous
  period of the same length, which ends at the same time of day (so a week that ends part-way
  through today is compared with a week that ends at the same hour); for error rate and latency a
  rise is shown in red.
- **Usage over time**: tokens (uncached input, cached input and output, stacked) or requests (with
  errors), per hour for Today and 24 hours and per day otherwise.
- **Top models** and **Top apps** by tokens.

### Breakdown

One table per **User**, **Group**, **App**, **Model**, **Provider** or **Surface** with requests,
input, cached, output and total tokens, error rate, p95 latency and when the row was last used.
Click a column to sort; expand a row for its per-model figures (not on the Model table).

- **Table CSV** downloads the table, per-model rows included.
- **Raw events CSV** downloads every record of the range
  (`GET /api/admin/usage/export?range=…&format=csv`, or `format=json`).

### Reliability

Error rate over time, errors by code (with the providers they came from), requests and errors per
provider, and latency p50/p95 and average time to first token per model. Latency is the whole call
from the request to the last token; calls refused by a usage limit are left out of it.

### Requests

The request log: individual model calls of the range, newest first, filtered by user, app, model,
surface and outcome. Click a call for its details — tokens, cache, latency, tool calls, error code,
conversation and request id. There is no prompt or response text to show; for debugging a
conversation use the interaction log (see [PII data handling](pii-data-handling.md)).

The request log reaches back as far as the event files (`usageTracking.eventRetentionDays`,
90 days by default).

### Limits & quotas

Budgets, who is near them and who was refused: see [Usage Limits](usage-limits.md#what-administrators-see).

## Storage and retention

| Data | Location | Kept | Setting |
| --- | --- | --- | --- |
| Call records | `contents/data/usage-events/YYYY-MM-DD.jsonl`, one file per UTC day | 90 days | `usageTracking.eventRetentionDays` |
| Daily rollups | `contents/data/usage-daily/YYYY-MM-DD.json` | 365 days | `usageTracking.dailyRetentionDays` |
| Monthly rollups | `contents/data/usage-monthly/YYYY-MM.json` | forever | `usageTracking.monthlyRetentionDays` |

`-1` keeps data forever. Retention deletes whole files; nothing is rewritten, so several workers or
servers can append to the same directory safely.

Every worker appends its records to the file of the record's day (buffered for up to 10 seconds).
Once an hour, one process rolls the days up: today, yesterday, and any day whose event file changed
after its rollup was written. A rollup holds totals, 24 hourly buckets, the per-dimension figures
with per-model sub-rows, outcomes, error codes, a latency histogram (for p50/p95) and feedback
ratings. When daily rollups have expired, a range still includes a month from its monthly rollup,
but only when the whole month lies in the range: a monthly rollup cannot be split into days, so an
expired month only partly in the range is left out.

`POST /api/admin/usage/_rollup` rolls up immediately (`?all=1` rebuilds every day that still has
events).

### Upgrading

The first start on this version deletes the old usage data once (migration V225):
`contents/data/usage.json`, `usage-events.jsonl`, `usage-daily/` and `usage-monthly/`. It counted
chat only, counted every exchange twice and keyed users on browser sessions, so it could not be
merged with the new records. The usage-limit counters (`quota-usage.json`) are not touched.

## API

All endpoints require an admin. Range parameters everywhere: `range` = `today`, `24h`, `7d`, `30d`,
`90d`, `12m` or `custom` with `from` and `to` (`YYYY-MM-DD`, inclusive).

| Endpoint | Returns |
| --- | --- |
| `GET /api/admin/usage/summary` | KPIs for the range and the previous period, the series, top models and apps |
| `GET /api/admin/usage/breakdown?dimension=user\|group\|app\|model\|provider\|surface&sort=&order=` | Rows with per-model sub-rows |
| `GET /api/admin/usage/reliability` | Error rate series, errors by code and provider, latency per model |
| `GET /api/admin/usage/calls?user=&app=&model=&surface=&outcome=&limit=&cursor=` | One page of call records, newest first, and `nextCursor` |
| `GET /api/admin/usage/export?format=csv\|json` | Every record of the range |
| `GET /api/admin/usage/feedback/summary` | Feedback ratings in total and per user, app and model |
| `GET /api/admin/usage/feedback?limit=&offset=` | Stored feedback entries with comments, newest first |
| `GET/PUT /api/admin/usage/meta` | The tracking mode |
| `POST /api/admin/usage/_rollup` | Rolls up now |

`GET /api/admin/usage` and its all-time counters (`usage.json`) no longer exist.
