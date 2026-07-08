# Tenancy, Collaboration, Observability, Eval — astron-agent vs ihub-apps

Research date: 2026-05-13. Focus: tenant/space/workspace management, team collaboration
(sharing, comments, versioning), observability (tracing/metrics/audit), usage
tracking / billing / credits / quotas, evaluation / testing harnesses.

---

## 1. astron-agent

### 1.1 Spaces / tenants / members / roles

Astron is built around a four-level identity hierarchy: **Enterprises → Spaces → Users → Resources**
([DeepWiki tenant page](https://deepwiki.com/iflytek/astron-agent/3.2-tenant-and-multi-tenancy-management)).

- **Identity provider:** Casdoor (OAuth2/OIDC). Astron does NOT implement local
  user/credential storage — Spring Security in `console/hub` validates JWTs issued
  by Casdoor.
- **Core tenant service:** `core/tenant/` is a Go microservice with classic Go DDD
  layout: `internal/{dao, service, handler, models}`. Visible files are
  `app_dao.go`, `app_service.go`, `auth_dao.go`, `auth_service.go`, `base.go`
  ([repo dir](https://github.com/iflytek/astron-agent/tree/main/core/tenant/internal)).
  Despite the name "tenant", this service's _primary_ entities are **Apps**
  (credential containers with `appKey`/`appSecret`) and **API key bundles**
  (`SaveAuth`, `DeleteAuth`, `ListAuth`, `GetAppByAPIKey`).
  PROJECT_MODULES describes it as: "Multi-tenant management, space isolation and
  permission control, organization structure management, resource quota management"
  ([docs](https://github.com/iflytek/astron-agent/blob/main/docs/PROJECT_MODULES.md)).
- **Space data model (DB):** Persistence is split between MySQL (workflow service,
  Alembic migrations under `core/workflow/alembic/`) and PostgreSQL (multi-tenant
  memory DB). **Every MySQL table includes a `space_id` foreign key** for
  row-level isolation; "all queries in the console backend include user and space
  context for data isolation"
  ([DeepWiki schema page](https://deepwiki.com/iflytek/astron-agent/11.4-mcp-protocol-and-tool-integration)).
- **Two ownership models:**
  - **Personal spaces** — keyed by requester `uid`.
  - **Team spaces** — `uid` is resolved to the space owner, members share access
    ([DeepWiki 7.4](https://deepwiki.com/iflytek/astron-agent/7.4-multi-tenancy-and-data-isolation)).
- **Memory DB isolation** is two-layer: schema-based (`{env}_{uid}_{db_id}`,
  one production + one test schema per DB) **plus** automatic row-level rewriting
  of every `SELECT/UPDATE/DELETE/INSERT` to inject a `uid` filter and
  system-managed `id, uid, create_time, update_time` columns.
- **Role/member tables:** Not directly exposed in the public schema docs, but
  console backend depends on space membership for every CRUD call (Java service
  layer in `console/hub`). Permission decisions happen in Java aspect classes
  (e.g. `DistributedLockAspect` for race protection on publish operations).

### 1.2 Team collaboration & sharing

- **Bot publishing pipeline:** Each agent (bot) goes through "Bot Lifecycle
  Management" with explicit publish targets (Marketplace, API, WeChat, MCP).
  Only the **space creator** can publish — enforced via Redis distributed locks
  (`publish_api + uid`, 3000ms TTL) ([DeepWiki Bot API Publishing](https://deepwiki.com/iflytek/astron-agent/4.5-workflow-versioning-and-release-management)).
- **Workflow versioning & release management:** Dedicated wiki section
  "Workflow Versioning and Release Management" exists (deepwiki section 4.5).
  Workflows have versioned releases; the `chat_bot_api` table holds bot-to-app
  associations with channel-specific status. **Workflow execution traces are
  stored in Elasticsearch via `WorkflowTraceEsClient`** for audit & replay-style
  inspection.
- **Real-time chat & SSE** for interactive collaboration with bots.
- **Plugin store / marketplace** as a sharing channel for tools.
- **Comments / threaded review:** Not documented as a distinct module — likely
  absent or buried in the frontend `pages/` tree.

### 1.3 Observability stack

`core/common/otlp/` (Python) is a first-class subsystem:

```
core/common/otlp/
  args/        log_trace/    metrics/    trace/    ip.py    sid.py
```

- **OpenTelemetry**: `opentelemetry-api`, `opentelemetry-sdk`, plus OTLP
  exporters over **gRPC, HTTP, and OpenCensus** (multiple exporter packages in
  the Python dependency set).
- **Structured logging**: `loguru`.
- **Kafka event bus** (optional, `KAFKA_ENABLE=0` by default):
  - `WORKFLOW_KAFKA_TOPIC` — workflow execution events
  - `AGENT_KAFKA_TOPIC` — agent invocations
  - tool telemetry from `core-link`
  - Astron explicitly calls these out as feeds for "monitoring, auditing, and
    analytics systems"
    ([DeepWiki Kafka page](https://deepwiki.com/iflytek/astron-agent/11.4-mcp-protocol-and-tool-integration)).
- **Elasticsearch for trace storage**: `WorkflowTraceEsClient` retrieves agent
  execution logs from ES.
- **Common module advertises**: "MetrologyAuth for authentication and audit
  system, OpenTelemetry/OTLP observability support."

### 1.4 Audit log

`core/common/audit_system/`:

```
audit_system/
  base.py       enums.py    orchestrator.py    utils.py
  audit_api/    strategy/
```

The audit system in astron is somewhat misleadingly named: it focuses on
**content-safety auditing** of LLM input/output frames (compliance moderation),
not user-action audit. Classes include `BaseFrameAudit`, `InputFrameAudit`,
`OutputFrameAudit`, `FrameAuditResult`, with statuses `STOP/CONTINUE`,
risk-detection error tracking, and a per-session `AuditContext` that holds
`chat_id`, `uid`, content concatenation, and an async output queue. Strategies
pluggable per provider via `strategy/`.

User-/admin-action audit (e.g. "who deleted this bot") is handled implicitly
through Kafka event streams + Casdoor's own audit log, plus Elasticsearch
storage of workflow traces.

### 1.5 Usage / billing / credits / quotas

`core/common/metrology_auth/` is the metering & licensing SDK:

```
metrology_auth/
  base.py    calc.py    conc.py    licc.py    rep.py    errors.py
  ma-sdk-default.toml   ma-sdk.cfg.toml   ma-sdk.toml
  ma_sdk_linux_x64.h    ma_sdk_macos_arm64.h    ma_sdk_windows.h
  include/    ma-sdk-cfg/
```

- **Cross-platform native SDK** (C headers for Linux/macOS/Windows) — the SDK
  appears to be a closed-source iFLYTEK-internal metering library, exposed via
  CPython bindings.
- `calc.py` calculates metrics; `conc.py` likely tracks concurrency; `licc.py`
  is licensing; `rep.py` is reporting.
- The tenant service description includes **"resource quota management"**
  ([PROJECT_MODULES](https://github.com/iflytek/astron-agent/blob/main/docs/PROJECT_MODULES.md))
  but no quota schema is publicly documented and no credit / billing UI is
  documented in the wiki.
- **No public billing UI / pricing-plan model** appears in the open-source repo
  — likely reserved for iFLYTEK's hosted Astron Cloud offering.

### 1.6 Evaluation / replay harness

- **No dedicated evaluation/eval-suite/replay subsystem** found in the open
  source repo. Wiki contents only cover Bot Lifecycle, Workflow Versioning,
  CI/CD pipelines, tests (`make test-{go,java,python,typescript}`), and unit
  test directories per service.
- **Memory DB has a `test` schema** alongside `production` per database — gives
  a per-tenant test sandbox, but that is integration-time isolation, not an
  evaluation harness.
- **Workflow ES trace storage** is the closest thing to replay: ES-indexed
  traces are queryable by execution ID via `WorkflowTraceEsClient`.

---

## 2. ihub-apps

### 2.1 Tenancy / spaces / members

**There is no tenant or space concept.** The platform is single-tenant by
design: one set of `contents/apps/*.json`, one set of `contents/models/*.json`,
one global config. There is no `space_id` / `workspace_id` anywhere in the
codebase — `grep -rn "spaceId\|space_id\|workspace\|tenant"` returned only:

- `server/middleware/teamsAuth.js` (Microsoft Teams integration, unrelated)
- `server/services/integrations/Office365Service.js` (Office tenant, unrelated)
- `server/services/integrations/EntraService.js` (Azure AD tenant, unrelated)
- `server/configCache.js`, `server/services/TokenStorageService.js` (none of
  these are "workspaces" in the product sense)

**Auth & permissions** are group-based, with hierarchical inheritance:

- `server/utils/authorization.js:15` — `resolveGroupInheritance()` recursively
  merges parent permissions, detects circular inheritance, returns flattened
  `apps/prompts/models/workflows/skills/adminAccess` sets per group.
- `server/utils/authorization.js:171` — `loadGroupsConfiguration()` reads
  `contents/config/groups.json`.
- `server/utils/authorization.js:517` — `enhanceUserWithPermissions()` resolves
  user → groups → permissions, with OAuth-client-credential & authorization-code
  filtering paths.
- `server/utils/authorization.js:395` — `intersectWithClientAllowList()` for
  OAuth client allow-list intersection.
- `server/utils/authorization.js:465` — `hasAdminAccess()` short-circuit.
- `server/middleware/authRequired.js:13` — `authRequired` middleware; allows
  anonymous when `anonymousAuth.enabled`.
- `server/middleware/authRequired.js:91` — `resourceAccessRequired(type)`
  factory used by `appAccessRequired`, `modelAccessRequired`.
- `server/defaults/config/groups.json` — only four built-in groups: `admins`,
  `users`, `anonymous`, `authenticated`. No notion of group "owner" or
  membership lists beyond external-group mappings.

**Identity providers** (`server/routes/auth.js`): local, LDAP, OIDC, NTLM,
Microsoft Teams, proxy headers — all converging on a single JWT cookie.
Stronger than astron's pure Casdoor reliance (astron delegates everything).

### 2.2 Collaboration / sharing / versioning / comments

- **App/workflow sharing**: only via **short links** — `server/shortLinkManager.js`
  stores opaque tokens in `contents/data/shortlinks.json` with expiry. There is
  no concept of "share with user X / group Y".
- **No comments, no review threads, no annotations** on apps, workflows, or
  conversations.
- **No versioning** of apps or workflows. `defaults/apps/*.json` files have **no**
  `version` field. The marketplace installer in
  `server/services/marketplace/ContentInstaller.js:310` has an audit-trail
  comment about `installedBy='admin'`, but there's no version diff/history.
- **Feedback storage** (`server/feedbackStorage.js`) writes JSONL records keyed by
  `messageId, appId, chatId, modelId, rating, comment` to
  `contents/data/feedback.jsonl` — a flat append-only log, not threaded.
- **Microsoft Teams "team" feature** (`client/src/features/teams/`) is a Teams-SDK
  embed shell (TeamsTab.jsx, TeamsAuthStart/End, TeamsWrapper) — NOT a
  collaboration model; it's just the M365 Teams app surface for embedding iHub.

### 2.3 Observability

iHub already has a serious OpenTelemetry implementation:

- `server/telemetry.js:77` — `initTelemetry()` bootstraps `@opentelemetry/sdk-node`
  with configurable provider (`otlp`, `prometheus`, `console`), resource
  attributes, optional auto-instrumentation, log record processors, periodic
  metric reader.
- `server/telemetry/GenAIInstrumentation.js:24` — `GenAIInstrumentation` class
  follows OTel **GenAI semantic conventions** (`gen_ai.operation.name`,
  `gen_ai.provider.name`, `gen_ai.request.model`, token usage attributes).
- `server/telemetry/metrics.js:33` — strict allow-list of metric labels to avoid
  Prometheus cardinality explosion: `gen_ai.*`, `error.type`, `app.id`,
  `auth.provider`, `auth.event`, `ratelimit.scope`, `stream.outcome`,
  `feedback.rating`, etc.
- `server/telemetry/ActivityTracker.js` — rolling 5-min window for active users
  and chats, exposed as observable gauges `ihub.active.users`, `ihub.active.chats`.
- `server/telemetry/ProcessMetrics.js` — process-level metrics.
- `server/telemetry/exporters.js` — OTLP/Prometheus/Console exporter factory,
  honors `OTEL_EXPORTER_*` env vars.
- `server/telemetry/events.js` — emit prompt/completion events on spans, gated
  by `events.includePrompts/includeCompletions` config.
- `server/middleware/rateLimiting.js:33` — calls `recordRateLimitHit('http', type)`
  for telemetry on every limit hit.
- Admin UI: `client/src/features/admin/pages/AdminTelemetryPage.jsx` and
  `AdminUsageReports.jsx`, plus `AdminLoggingPage.jsx`.

**What's missing**: no centralized **trace store / search UI** (astron uses
Elasticsearch for `WorkflowTraceEsClient`-style retrieval). Spans go to an
external OTLP collector but iHub doesn't ship its own trace viewer.

### 2.4 Usage tracking

iHub has a mature usage-tracking pipeline (more advanced than astron's
open-source surface):

- `server/usageTracker.js:230` — `recordChatRequest({userId, appId, modelId,
  tokens, tokenSource, user})` increments aggregates in
  `contents/data/usage.json`: messages/tokens by user/app/model, prompt vs
  completion split, magicPrompt counters, feedback ratings, token-source quality
  (`provider` vs `estimate`).
- `server/usageTracker.js:312` — `recordFeedback({rating})` 1-5 star + legacy
  good/bad.
- `server/usageTracker.js:367` — `recordMagicPrompt({inputTokens, outputTokens})`.
- `server/services/UsageEventLog.js:41` — `logUsageEvent()` appends every event
  to `contents/data/usage-events.jsonl` (buffered 10 s flush).
- `server/services/UsageAggregator.js:17` — `buildDailyRollup()` and
  `buildMonthlyRollup()` aggregate JSONL into rollups under
  `contents/data/usage-{daily,monthly}/`. `runRollups()` orchestrates flush →
  daily → monthly → retention cleanup.
- `server/services/UsageAggregator.js:278` — `startRollupScheduler()` runs
  every hour.
- `server/routes/admin/usage.js` — admin API: `/api/admin/usage/timeline`,
  `/api/admin/usage/users`, with CSV export.
- **Pseudonymisation:** `server/services/UserFingerprint.js` + `usageTracker.js:241`
  `trackingMode` of `pseudonymous` vs `identified`.

**What's missing:** there is no **quota enforcement** anywhere. `grep -rn
"quota\|credit\|billing" /home/user/ihub-apps/server/` returned 3 hits, all in
unrelated text content (faq.md, nda-risk-analyzer.json, telemetry/attributes.js
metric label). Per-user rate limiting is a concept document
(`concepts/2026-03-10 Per-User Rate Limiting Proposal.md`) but **not
implemented** beyond IP-based limiter in `server/middleware/rateLimiting.js`.

### 2.5 Audit log

There is **no structured user-action audit log**. `grep -rn "audit"` returns:

- A doc comment in `server/services/marketplace/ContentInstaller.js:310` about
  `installedBy` ("Username of the installing admin for audit trail") — a single
  metadata field, not an audit subsystem.
- `server/routes/chat/dataRoutes.js:464` — a docstring mentioning request IDs
  "for debugging and audit trails".
- `server/tests/admin-endpoints-security.test.js` — security tests.
- `server/defaults/pages/en/faq.md`, `nda-guide.md` — content files.

`telemetry/attributes.js` builds OTel span attributes but spans are not a
queryable audit log. Logging via `server/utils/logger.js` is structured JSON
(component, action, userId) but it's an operational log, not an immutable
chronological audit feed with retention/integrity guarantees.

### 2.6 Evaluation / testing harness

**Nothing.** `grep -rn "evaluation\|eval-suite\|replay\|playground"` returns
only unrelated hits (workflow conditional-edge evaluation in
`DAGScheduler.js:425`, OAuth code store, refresh token store). There is:

- No batch eval runner.
- No prompt regression suite.
- No conversation replay.
- No test-data dataset model.
- No A/B harness for comparing models on a fixed task set.
- No golden-output diffing.

The only test surface is unit/integration tests in `server/tests/`.

---

## 3. Gap matrix

| Capability                                  | astron-agent                                                                                | ihub-apps                                                  | Gap severity   | Notes                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Spaces / workspaces                         | Yes — `space_id` FK on every table; personal & team spaces; isolation row-level + schema    | None — single-tenant                                       | **Critical**   | Largest single product gap                                                     |
| Tenant service (org / quotas)               | Yes — Go `core/tenant`, advertises "resource quota management"                              | None                                                       | High           |                                                                                |
| Members & roles per space                   | Implicit (space ownership + uid filtering); Casdoor role for global RBAC                    | Global groups only (`admins/users/anon/auth`), no per-space   | High           | iHub group inheritance is rich but global                                      |
| Sharing apps/workflows with users           | Publish to marketplace; channel-specific bot APIs                                           | Short links only (anonymous, opaque)                       | Medium-High    | iHub short-link manager: `server/shortLinkManager.js`                          |
| Versioning workflows/apps                   | Yes — dedicated "Workflow Versioning and Release Management" section                        | None — no `version` field on apps                          | High           |                                                                                |
| Comments / review                           | Not visible                                                                                 | None                                                       | Low            | Neither has it                                                                 |
| OpenTelemetry tracing                       | Yes — full OTLP stack (gRPC/HTTP/OpenCensus)                                                | Yes — `server/telemetry.js`, GenAI semantic conventions    | None / on par  | iHub may even be ahead on GenAI semconv compliance                             |
| Centralized trace store / viewer            | Yes — Elasticsearch + `WorkflowTraceEsClient`                                               | No — relies on external OTLP collector                     | Medium         | iHub has no in-product trace UI                                                |
| Audit log (user actions)                    | Implicit via Kafka event topics + Casdoor                                                   | None — only ad-hoc `logger.info` lines                     | High           | Compliance blocker for enterprise                                              |
| Audit (content safety)                      | Yes — `core/common/audit_system/` (input/output frame moderation)                           | None                                                       | Medium         | Optional / domain-specific                                                     |
| Usage tracking (tokens/messages)            | Via Kafka events + ES traces                                                                | **Mature** — `usageTracker.js`, `UsageAggregator.js`       | None / iHub ahead | iHub has daily+monthly rollups, JSONL events, pseudonymisation, admin UI       |
| Quotas / credits enforcement                | Tenant service ("resource quota management") — closed metrology_auth SDK                    | None                                                       | High           | iHub has counters but no enforcement                                           |
| Billing                                     | Closed (Astron Cloud commercial)                                                            | None                                                       | Low            | OSS gap on both sides                                                          |
| Per-user rate limiting                      | Implicit per-tenant via metrology_auth                                                      | IP-based only (`server/middleware/rateLimiting.js`); per-user is a draft proposal | Medium |  |
| Evaluation harness / replay                 | None public                                                                                 | None                                                       | High           | Both lack this; market-differentiator opportunity                              |
| Workflow test sandbox                       | Yes — per-tenant `test` schema separate from `production`                                   | None                                                       | Medium         |                                                                                |
| Feedback storage                            | Not surfaced                                                                                | Yes — `feedbackStorage.js`, 1-5 ratings + comments         | None           | iHub ahead                                                                     |

---

## 4. What we should reimplement (ranked)

### Rank 1 — Spaces / workspaces with per-space membership and resource scoping

- **Why:** every enterprise customer story (multiple business units, per-team
  app catalogs, "give my agency client access to just these apps without
  showing my internal ones") hits this wall. iHub today forces one global
  config namespace; even the rich group inheritance in
  `server/utils/authorization.js:15` cannot model "team A owns these 3 apps and
  shares them with team B".
- **Scope:** **XL**. Touches data model, every route, every loader, every admin
  page.
- **Risk:** very high — breaking change unless we keep a "default space" alias
  for the legacy single-tenant mode.
- **Dependencies:** none (foundation).

### Rank 2 — Evaluation / regression harness for apps & workflows

- **Why:** prompt drift, model swaps, and workflow refactors all silently
  regress quality. Today an iHub admin cannot answer "did changing
  `preferredModel` to gemini-2.0-pro improve or degrade this app?". Neither
  platform offers this OSS, so building it is a differentiator.
- **Scope:** **L**. New `contents/eval-suites/` directory, runner service,
  results viewer, optional LLM-as-judge.
- **Risk:** medium — execution sandboxing, cost control.
- **Dependencies:** existing chat service (`server/services/chat/`),
  usageTracker for cost reporting, optional structured-output mode for golden
  comparison.

### Rank 3 — Quotas, credits, and per-user rate limits

- **Why:** without enforcement, every cost-leak incident requires a human
  reading rollups. Per-user rate limiting was already proposed (`concepts/
  2026-03-10 Per-User Rate Limiting Proposal.md`) — a credit/quota layer
  generalises it.
- **Scope:** **M**. Build on `UsageAggregator` infrastructure. Add a `quotas`
  config block, enforce in chat path, return 429 with retry-after.
- **Risk:** medium — clock skew, distributed counter consistency under
  clustering.
- **Dependencies:** None hard, but cleaner if scoped per-space (so Rank 1
  should land first or in parallel).

### Rank 4 — Structured user-action audit log

- **Why:** "who deleted that app config", "who changed group permissions" —
  compliance-table-stakes for enterprise. iHub's
  `server/utils/logger.js` produces structured logs but they have no retention
  guarantees, no immutability, no per-resource history view.
- **Scope:** **M**. Append-only `audit-events.jsonl` similar to `UsageEventLog`,
  schema with `actor, action, target, before, after, ts, requestId`, admin UI.
- **Risk:** low.
- **Dependencies:** none.

### Rank 5 — App/workflow versioning + share-with-user/group

- **Why:** today apps live in flat `contents/apps/*.json`. Promoting an app
  from draft to production, or rolling back, requires git knowledge. Sharing
  is "either everyone in your group, or use a short link".
- **Scope:** **L**. Schema bump on `appConfigSchema`, history table, diff UI,
  share ACL.
- **Risk:** medium — file-based persistence vs DB tension.
- **Dependencies:** Rank 1 (sharing scope only makes sense once spaces exist).

### Rank 6 — In-product trace viewer

- **Why:** OTel data already flows out; admins still need to spin up Jaeger /
  Tempo / Grafana to debug a request. A minimal trace explorer ("show all
  spans for this conversation ID") would massively speed up support.
- **Scope:** **M**. Either ship a built-in Tempo/ClickHouse-backed reader or
  pull traces from configured OTLP collector via API.
- **Risk:** medium — storage choice.
- **Dependencies:** none.

### Rank 7 — Per-tenant test sandbox / preview environment

- **Why:** astron's `test` vs `production` schema per memory DB is a neat
  pattern. iHub doesn't have one.
- **Scope:** **M-L**, scoped after Rank 1.
- **Risk:** medium.
- **Dependencies:** Rank 1.

---

## 5. Implementation outline (top 3)

### 5.1 Spaces / workspaces (Rank 1)

**Data model (new file: `contents/config/spaces.json`):**

```json
{
  "spaces": {
    "default": {
      "id": "default",
      "name": { "en": "Default workspace" },
      "ownerId": "system",
      "members": [
        { "userId": "...", "role": "owner|admin|editor|viewer", "addedAt": "..." }
      ],
      "resources": {
        "apps": ["*"],
        "workflows": ["*"],
        "models": ["*"]
      },
      "quotas": {
        "monthlyTokens": null,
        "monthlyMessages": null,
        "maxConcurrentChats": null
      }
    }
  },
  "metadata": { "version": "1.0.0" }
}
```

**Migration (`server/migrations/V020__add_default_space.js`):**

- Create `spaces.json` with one `default` space whose `members` is empty (any
  user falls back to default via "membership-or-default" rule).
- Add `spaceId` field to every resource record by stamping `"default"`.
- Add `currentSpaceId` to user session token claims.

**Server changes:**

- `server/configCache.js` — load and cache `spaces.json`; add
  `getSpaceForUser(userId, providedSpaceId)`.
- `server/utils/authorization.js` — add `enhanceUserWithSpaces()` after
  `enhanceUserWithPermissions()` (line 517) that resolves accessible spaces and
  exposes `req.user.spaceId` + `req.user.spaceRole`.
- `server/middleware/authRequired.js` — extend `resourceAccessRequired()` to
  intersect with `space.resources[type]` (line 91 currently only checks
  `user.permissions`).
- `server/appsLoader.js`, `workflowsLoader.js`, `promptsLoader.js` —
  filter loaded resources by `spaceId`.
- `server/routes/admin/spaces.js` — NEW: CRUD for spaces, members,
  invitations.
- `server/routes/auth.js` — `/api/auth/status` returns `availableSpaces` and
  current `spaceId`; new endpoint `POST /api/auth/switch-space`.

**Client changes:**

- New space switcher in header.
- `client/src/shared/contexts/SpaceContext.jsx` mirrors `PlatformConfigContext`.
- All admin pages gain space scope (e.g. `AdminAppsPage` lists apps for
  current space).

**Compatibility strategy:** Single-space install (`default`) is the default.
Spaces feature flag (`features.spaces`) gated; when off, behavior is identical
to today.

### 5.2 Evaluation harness (Rank 2)

**Data model (`contents/eval-suites/<suite-id>.json`):**

```json
{
  "id": "support-bot-regression-v1",
  "appId": "support-bot",
  "datasetVersion": "2026-05-13",
  "cases": [
    {
      "id": "case-1",
      "input": { "messages": [{ "role": "user", "content": "How do I reset password?" }] },
      "expected": {
        "contains": ["password reset", "email"],
        "notContains": ["unable", "sorry"],
        "minLength": 80,
        "jsonSchema": null,
        "judge": {
          "model": "gpt-4o-mini",
          "rubric": "Does the answer correctly guide the user through password reset?"
        }
      }
    }
  ]
}
```

**Server (new `server/services/eval/`):**

- `EvalRunner.js` — runs a suite against an app (uses existing
  `server/services/chat/ChatService.js`), captures latency, tokens, raw
  output, judge verdict.
- `EvalResultStore.js` — persists results to
  `contents/data/eval-results/<suite>/<run-id>.json`.
- `LLMJudge.js` — optional LLM-as-judge; emits structured pass/fail with
  reasoning.
- `server/routes/admin/evals.js` — list suites, run suite, list runs, diff two
  runs.

**Hook into existing telemetry:** every eval run emits OTel spans with
attribute `eval.suite=...`, `eval.run=...`; admins can filter eval-vs-prod
traffic.

**Schema validator:** add `server/validators/evalSuiteSchema.js`.

**Admin UI:** `client/src/features/admin/pages/AdminEvalsPage.jsx` with
suite editor, run trigger, results matrix (case × variant), regression diff.

**Migration:** none for V1 (file-only). Add `V0NN__add_eval_dir.js` to ensure
`contents/eval-suites/` exists and add a sample suite.

### 5.3 Quotas / credits / per-user rate limits (Rank 3)

**Config additions in `platform.json`:**

```json
{
  "quotas": {
    "enabled": false,
    "scope": "perUser|perSpace|perGroup",
    "defaults": {
      "monthlyTokens": 1000000,
      "monthlyMessages": 5000,
      "concurrentChats": 3
    },
    "perGroup": { "users": { "monthlyTokens": 500000 } },
    "actionOnExceed": "block|warn|degrade"
  }
}
```

**Server:**

- `server/services/QuotaEnforcer.js` — checks current usage from
  `UsageAggregator` rollups (lazy-cached) + in-memory delta since last flush.
- Hook into `server/services/chat/ChatService.js` _before_ adapter call:
  reject with HTTP 429 + `Retry-After` header when over quota.
- Hook into `server/middleware/rateLimiting.js` to add a per-user limiter
  (currently IP only, line 19).
- Add OTel metric `ihub.quota.exceeded` with `quota.scope`, `quota.kind` labels.
- New admin route `GET /api/admin/quotas/usage` returns "X / Y used this
  period" per user/space.

**Migration:** `V0NN__add_quotas_config.js` adds `quotas.enabled=false` block
to `platform.json` (default off, opt-in).

**Schema impact:** none on app configs — quotas are platform-level + group/space
overlays.

---

## 6. Open questions

1. **Astron's true tenant model details** — without the source code of
   `core/tenant/internal/models/*.go` and Java console aspects, I cannot
   confirm whether members are stored as a join table (`space_member`) or as
   array fields on space. DeepWiki only documents the high-level isolation
   strategy.
2. **Astron quota schema** — `metrology_auth` is a closed-source SDK with C
   headers; the actual quota table layout, refresh windows, and quota types
   are not in the public repo.
3. **Whether iHub leadership wants per-space resource catalogs or one global
   catalog + per-space permissions** — these are very different data models.
   Recommend product decision before Rank 1.
4. **Persistence direction** — iHub uses JSON files via `configCache`. At what
   point do spaces, members, audit, eval results justify a real DB? If we
   need this for scale, Rank 1 should land alongside a persistence-layer
   refactor (existing concept in `concepts/persistence-layer/`).
5. **Workflow versioning expectations** — astron uses an explicit
   `version`/release table per workflow. iHub flat files would need either a
   `<workflow-id>@<version>.json` filename scheme or a sidecar `versions.json`
   per workflow.
6. **Compliance retention requirements** — what audit log retention does the
   target customer base need (90 days? 7 years for SOC2/GDPR? configurable)?
7. **Whether evaluation should be runnable from CI** — i.e., a CLI entry point
   that fails the build on regression — vs. only on-demand from admin UI.
8. **In-product trace storage choice** — ClickHouse vs. Tempo vs. proxying
   existing OTLP collector. Each implies a very different ops footprint.

---

**Word count estimate:** ~2400.
