# iHub Apps as a SaaS Platform — Readiness Assessment and Plan

**Date:** 2026-09-15
**Status:** Concept / strategic plan — for discussion. No code changes.
**Question answered:** "To run iHub as a SaaS application, what are we missing?" — with a comparison against Open WebUI, LibreChat, Onyx, Langdock, ChatGPT Enterprise, Claude Enterprise, Microsoft 365 Copilot / Gemini Enterprise, Glean / Dust and LiteLLM.
**Related:** `concepts/multi-tenancy.md` (2025, list of open questions — answered in §5 and §7 here), `concepts/2025-07-20 OAuth2 Multi-Tenancy Final Concept.md` (assumed database tables that were never built), `concepts/persistence-layer/2026-09-09 Storage Provider and Durable Chats Design.md` (the prerequisite track), `concepts/2026-07-28 Round-Robin Worker-Local State Audit.md`, `concepts/2026-02-27 Enhanced Usage Tracking.md`, `concepts/2026-03-10 Per-User Rate Limiting Proposal.md`, `concepts/2026-03-09 Simplification Proposal.md`, `concepts/2026-05-28 Admin UI Phase 3 Roadmap.md`, `docs/multi-server-deployment.md`, `docs/scaling.md`, `docs/storage.md`, `docs/telemetry.md`, `docs/pii-data-handling.md`
**Sources (repository, verified 2026-09-15):** `server/config.js`, `server/configCache.js`, `server/services/config/ConfigStore.js`, `server/storage/**`, `server/clusterBus.js`, `server/middleware/{setup,oidcAuth,rateLimiting,auditLogger,contentAdminAuth}.js`, `server/routes/{auth,setup}.js`, `server/routes/admin/{usage,auditLog,backup,update,overview}.js`, `server/services/{AuditLogService,ChangeHistoryService,UsageEventLog,UsageAggregator,UserFingerprint,TokenStorageService}.js`, `server/usageTracker.js`, `server/utils/{requestContext,userManager,authorization}.js`, `server/featureRegistry.js`, `server/validators/modelConfigSchema.js`, `server/defaults/config/*.json`, `scripts/check-config-fs-access.js`, `docker/`, `.github/workflows/`

---

## 1. Executive summary

iHub Apps is a mature **single-tenant** enterprise AI platform: seven authentication modes, hierarchical group permissions, an admin UI that covers everything, an audit log, usage tracking with real provider token counts, OpenTelemetry with the GenAI semantic conventions, config migrations, backup/restore, self-update, a marketplace, workflows, agents and an MCP gateway in both directions. Very little of that has to be thrown away. What is missing for SaaS falls into three groups.

**1. Architecture — the platform assumes one installation per process.** The contents directory is resolved once at boot (`server/config.js`), `configCache` is a process-wide singleton keyed by file path, the filesystem is the system of record, and a dozen pieces of runtime state live in worker memory. Running more than one host today requires sticky sessions, a shared `contents/` volume and an admin UI that `docs/multi-server-deployment.md` tells operators to treat as **read-only in production** — the opposite of a self-managed SaaS. The storage-provider track (`concepts/persistence-layer/2026-09-09 …`) is the right lever and already ships the abstraction; PostgreSQL, config invalidation across instances and multi-instance mode are designed but not built.

**2. Tenant plumbing — there is no tenant.** No tenant model, no tenant-scoped configuration or secrets, no domain verification or identity discovery by e-mail domain, no SAML or SCIM, no invitations (and no way to send e-mail at all), no cost calculation, budgets or quotas, no billing, and none of the audit, telemetry, usage or reporting data carries a tenant dimension.

**3. SaaS business and operations layer.** Self-service signup and trials, plans and entitlements, provisioning and fleet upgrades, an operator console with tenant lookup and consented impersonation, SLOs and a status page, a compliance program (SOC 2 / ISO 27001), data-residency and offboarding guarantees.

### Recommendation in three bets

| Bet | What | Why |
| --- | --- | --- |
| **1. Stateless runtime on PostgreSQL first** | Finish storage step 2/3: PostgreSQL provider, configuration on the provider with cross-instance invalidation, bus over LISTEN/NOTIFY, shared rate-limit and throttle stores, S3-compatible blobs, Helm chart, readiness probe. | Every tenancy topology needs it. It also fixes today's multi-host story for self-hosted customers. |
| **2. Tenant boundary in code, cell-per-tenant in deployment** | Put `tenantId` into the request context, scope storage namespaces and configuration by tenant, tag every signal with `tenant.id` — but **ship SaaS as one runtime cell per tenant** first, orchestrated by a control plane. Pool small tenants into shared cells later, when tenant count makes a pod per tenant uneconomic. | The codebase has 54 server modules that address `contents/` directly and a process-global cache; in-process multi-tenancy is the riskiest change (an isolation bug in an AI chat product is a data breach). Cell-per-tenant gives strong isolation on day one and is what enterprise buyers ask for anyway, while the code work happens behind a single-tenant default that keeps self-hosted installs byte-identical. |
| **3. Control plane as a separate service; identity via a broker** | Signup, tenant directory, domain verification, provisioning, plans/billing, fleet operations and the operator console live outside the tenant runtime. SAML 2.0, SCIM 2.0, MFA/passkeys and home-realm discovery come from an open-source identity broker (ZITADEL or Keycloak) that iHub talks to over the OIDC it already speaks. | Keeps the runtime a product that still ships as a binary and a Docker image. Avoids writing and certifying SAML/SCIM natively. |

**Sizing (rough, for planning only):** Phase 0–2 to a sellable SaaS MVP ≈ 18–26 person-months, i.e. roughly 9–12 months with two to three engineers focused on it, on top of the storage work already in flight. Details in §6.

**Quick wins that also help self-hosted customers** (each ≤ 1 month, no tenancy required): a model **pricing catalog and a `cost` field on usage events**; **budgets/quotas** per user and group with pre-call enforcement; **per-user rate limits** backed by a shared store; a real **readiness probe**; a **Helm chart**; **audit-log CSV export** and a documented **SIEM stream**; reserving the `tenant.id` attribute in telemetry, audit and usage events today so nothing has to be re-keyed later.

---

## 2. Scope and assumptions

**Operating model assumed.** "Self-managed platform" is read as: IntraFind operates the service, and each customer's own administrators manage their tenant — users, groups, apps, models, budgets, SSO, branding, retention — without IntraFind's involvement. The same code base must keep shipping for self-hosted customers (binary, Docker, Windows service, air-gapped). If "self-managed" was meant as "customers run it themselves", most of §5 still applies (multi-instance, cost tracking, SCIM/SAML, reporting), and the control plane in §5.2 shrinks to a Helm chart plus documentation.

**Target segments and tiers.**

| Tier | Customer | Topology | Identity | Models |
| --- | --- | --- | --- | --- |
| **Starter / Team** | 5–50 users, self-service, credit card | Cell-per-tenant initially; pooled cell once available (§5.12) | E-mail + password or Google/Microsoft login via the broker | Platform-provided models with a usage allowance, marked up |
| **Business** | 50–1,000 users, procurement, DPA | Cell-per-tenant | SSO (OIDC/SAML), domain capture, SCIM | Platform models and/or bring-your-own keys |
| **Enterprise** | 1,000+ users, regulated | Dedicated cell, region choice, own database, optional own node pool | SSO, SCIM, IP allowlist, custom retention, compliance API | BYOK, private endpoints (Azure OpenAI, Bedrock, on-prem vLLM), customer-managed keys |
| **Self-hosted** | Any | Unchanged: binary / Docker / Kubernetes | Existing seven modes | Existing |

**Non-goals of this plan.** No UI redesign (see the Admin UI roadmap), no new AI capabilities, no nested tenants (departments are groups inside a tenant; reseller/partner hierarchies are a later, separate decision — §7).

**Glossary.** *Platform operator* — IntraFind staff running the service. *Tenant* — one customer organization: the unit of isolation, configuration, billing and support. *Tenant admin / owner / member* — roles inside a tenant. *Cell* — one deployable unit of the runtime (a Kubernetes namespace with iHub replicas, a database and blob storage) serving one or many tenants. *Control plane* — the operator-owned services around the cells.

---

## 3. Where iHub stands today — audit by area

### 3.1 Summary

| Area | Exists today | Gap for SaaS | Severity |
| --- | --- | --- | --- |
| **Tenancy & per-tenant config** | Layered config (defaults → `contents/` → `IHUB_*` env), `ConfigStore` seam, raw storage namespaces, group-based permissions, feature flags | No tenant model; one `contents/` tree per process; process-global cache; 54 modules touch `contents/` directly; no tenant-scoped secrets | Blocking |
| **Identity & access** | Anonymous, local, OIDC (multi-provider, PKCE, `autoRedirect`), proxy/JWT, LDAP, NTLM, Teams; group mapping with inheritance; admin + content-admin roles; iHub as OIDC IdP / OAuth AS; personal API keys | No SAML, no SCIM, no domain verification / home-realm discovery, no invitations or self-signup, no e-mail, no MFA for local accounts, users kept in `users.json`, no cross-instance session revocation | Blocking |
| **Scalability** | Node cluster with IPC bus, round-robin workers, config sync across workers | Multi-host needs sticky sessions + shared volume; 12 documented worker-local state findings; per-process rate limits and throttles; uploads on local disk; no Helm chart; liveness-only health | Blocking |
| **Persistence** | `StorageProvider` (documents, blobs, append-logs, notifier, locks) with filesystem provider; durable chats and run ledger (both dark); config through raw namespaces | Only the filesystem provider exists; SQLite/PostgreSQL/OpenSearch designed; users, groups, OAuth clients, usage, audit, feedback, short links, change history are files outside the provider | Blocking |
| **Observability** | OTel GenAI spans/metrics/events, Prometheus/OTLP, process metrics, activity gauges, Winston JSON logs with redaction, IP anonymization | No `tenant.id` anywhere; no SLOs, alert rules or shipped dashboards; no readiness semantics; no status page; no per-tenant cost signal | High |
| **Auditing** | Daily JSONL audit log with retention, e-mail masking, IP anonymization, filters, admin UI, change-history snapshots, Winston mirror for SIEM | No tenant partition, no export (CSV planned), no compliance/eDiscovery API, no tamper evidence, no operator-action audit, retention not per tenant | High |
| **Usage & cost** | JSONL usage events with real provider token counts, daily/monthly rollups, three identity modes, web-search counting, CSV export, admin reports | No prices, no cost, no budgets or quotas, no seat metering, no metering export for billing, no attribution to tenant/team/workflow, no alerts | High |
| **Reporting** | Six-tab usage report, overview dashboard | No tenant-facing vs operator-facing split, no adoption metrics (WAU/MAU, retention), no scheduled reports, no BI export | Medium |
| **Administration & onboarding** | First-run setup wizard, default seeding, admin rescue, Cmd+K, marketplace, backup/restore, self-update, theming | No tenant signup/provisioning, no invitations, no guided tenant onboarding, admin UI is "read-only in production" for multi-host, roles limited to admin/content admin | High |
| **Rate limiting & abuse** | Six IP-based limiters, request throttler per provider, SSRF/DNS guard, body limits | Counters are per process; no per-user/per-tenant limits; provider quotas shared across tenants without fairness | High |
| **Security & compliance** | Secrets encrypted at rest (one key), RS256 JWT, CORS, Trivy/OSV scanning, PII handling doc, retention switches | Single encryption key; no per-tenant keys/KMS; no IP allowlists; no DLP/guardrail hooks; no isolation test suite; no SOC 2 / ISO 27001; no per-tenant export/erasure | High |
| **Operations** | Flyway-style config migrations, backup zip, self-update with rollback, Docker images, binaries, CI (unit, integration, a11y, Docker, scanners) | No Helm, no zero-downtime deploy guidance, no SQL migrations yet, no per-tenant backup/restore, no DR runbook, no job queue | Medium |
| **Billing & commercial** | — | Nothing: plans, entitlements, trials, invoicing, tax, dunning | Blocking for SaaS |
| **Notifications** | — | No e-mail or webhook delivery (invites, password reset, budget alerts, reports) | Blocking for SaaS |

### 3.2 Tenancy and configuration

- The contents directory is fixed at boot: `config.CONTENTS_DIR` in `server/config.js`, resolved via `getRootDir()` in `server/pathUtils.js`. Every loader and most services import it at module load time (`server/usageTracker.js`, `server/services/UsageEventLog.js`, `server/services/AuditLogService.js`, …).
- `server/configCache.js` (2,000 lines) is a singleton keyed by relative file path (`config/platform.json`, `apps/<id>`). It resolves group inheritance, decrypts credentials and applies `IHUB_PLATFORM__*` overrides — all once per process, for one installation.
- The one seam that already points the right way: `server/services/config/ConfigStore.js` routes every configuration read and write through the storage provider's **raw namespaces** (`server/storage/namespaces.js`: `config`, `apps`, `models`, `prompts`, `tools`, `workflows`, `agents`, `locales`), and `scripts/check-config-fs-access.js` fails CI when code bypasses it. Tenant scoping can be added inside that seam without touching admin routes.
- 54 server modules still build paths under `contents/` themselves (Appendix A). Some are legitimately the filesystem provider's internals; the rest are runtime data that has not moved onto the provider (usage, audit, feedback, short links, change history, consent, refresh tokens, agent inboxes/memory/artifacts, workflow registry, OAuth connections) or text trees (pages, sources, skills, renderers).
- `concepts/multi-tenancy.md` (2025) lists eleven open questions and answers none; `concepts/2025-07-20 OAuth2 Multi-Tenancy Final Concept.md` assumed `organization` / `user_organization` tables in a database the project did not have. §5 and §7 answer those questions.

### 3.3 Identity and access

- Strong base: `server/middleware/setup.js` chains proxy → Teams → JWT → local → LDAP → NTLM; OIDC supports multiple providers with PKCE, group claims, `autoRedirect` and RP-initiated logout (`server/middleware/oidcAuth.js`, `server/routes/auth.js`). Group inheritance and external group `mappings` live in `groups.json`. iHub can itself act as an OIDC identity provider and OAuth authorization server (DCR, CIMD, consent, refresh tokens, personal API keys).
- Roles: `adminAccess` and `contentAdmin` (`server/middleware/contentAdminAuth.js`). There is no owner, billing or support role and no way to scope an admin to a subset of resources.
- Discovery by domain or e-mail does not exist. `autoRedirect` sends everyone to **one** provider; with several providers the user picks. Nothing maps `alice@acme.com` → tenant `acme` → Acme's Entra ID.
- No SAML 2.0 and no SCIM 2.0. Every competitor's business tier has both (§4).
- Users from LDAP/NTLM/OIDC are persisted into `contents/config/users.json` (`server/utils/userManager.js`) — a whole-file rewrite on each external login, announced over the bus. Fine for hundreds of users on one host, not for SaaS.
- Sessions are stateless RS256 JWTs (8 h default). Revoking a user or a compromised token across instances needs a denylist or short-lived tokens with refresh.
- The server cannot send e-mail (no mail dependency anywhere): no invitations, no password reset, no alerts.

### 3.4 Scalability and state

- Within a host: `server/clusterBus.js` relays SSE state between workers and its transport is deliberately abstracted ("Going cross-pod needs the same interface backed by Redis pub/sub"). Config edits propagate across workers via `server/configSync.js`.
- Across hosts (`docs/multi-server-deployment.md`): sticky load balancer, one shared read-write `contents/` volume, identical secrets, and "production hosts read configuration, they do not author it". Usage counters are last-writer-wins across hosts; rate limits multiply by host count.
- `concepts/2026-07-28 Round-Robin Worker-Local State Audit.md` lists twelve open worker-local findings, several of which break user-visible flows in multi-worker mode (OIDC `MemoryStore` sessions, integration OAuth sessions, MCP sessions, short links, workflow `ExecutionRegistry`, OCR job store, rate limiters, request throttler, iAssistant conversation state, workflow abort controllers).
- The storage design's step 3 ("Multi-instance, must ship") covers the bus over PostgreSQL LISTEN/NOTIFY, lock-elected singletons and cross-instance SSE. It is the single most important prerequisite in this plan.
- Uploads (`contents/uploads`) and agent artifacts are local files; a shared volume or the blob facet on S3 is required for more than one replica.
- `GET /api/health` always returns `status: OK` (it reports `storage.ready` but does not gate on it). Kubernetes needs a readiness probe that fails when configuration is not loaded or the provider is down.
- No Helm chart; Docker Compose only. No job queue (issue #1495 stays open per the storage design) — long-running tool jobs, exports and scheduled reports need one.

### 3.5 Persistence

- `StorageProvider` (`server/storage/StorageProvider.js`) with five facets, conditional writes by etag (409 on mismatch — exactly what a self-service admin UI with several admins needs), owner-indexed listing, cursor paging and a conformance suite. Only the filesystem provider is implemented.
- Durable chats (`features.chatPersistence`) and the run ledger (`features.runLog`) are built on it and ship dark. Both matter for SaaS: chat history is table stakes for a hosted product, and the ledger is the raw material for cost accounting, support debugging and eDiscovery.
- Still files, outside the provider: `users.json`, `groups.json`, `oauth-clients.json`, `credentials.json`, usage events and rollups, feedback, audit log, change history, short links, consent, refresh tokens, `.encryption-key`, `.jwt-secret`.

### 3.6 Observability

- Good: `server/telemetry/*` emits GenAI-convention spans and metrics, `ihub.*` product counters, active user/chat gauges, process metrics, optional auto-instrumentation, prompt/completion capture opt-in, header redaction. Logging is structured JSON with request-context enrichment (`userId`, `oauthClientId`, `ip` via `server/utils/requestContext.js`).
- Missing for a fleet: a `tenant.id` resource/span/log attribute; request-id ↔ trace-id correlation in logs; SLO definitions (availability, time-to-first-token, stream error rate, tool failure rate); shipped Grafana dashboards and alert rules; synthetic canaries; a status page; readiness vs liveness.

### 3.7 Auditing

- `server/services/AuditLogService.js` writes one JSONL file per day under `contents/data/audit-log/`, with retention, e-mail masking, IP anonymization, a Zod-validated entry schema, request-id linkage and a global mutation-safety-net middleware. `ChangeHistoryService` keeps 20 before/after snapshots per entity. `audit.winstonMirror` can copy entries into the log stream for a SIEM.
- Missing: tenant partitioning; export (CSV is in the Admin UI Phase 3 roadmap); a queryable compliance API for chats, runs and activity by user and time range (ChatGPT Enterprise and Claude Enterprise both sell this); tamper evidence (hash chain, external anchoring); a separate operator audit (who at IntraFind touched which tenant, impersonation with consent); per-tenant retention and legal hold; a user-facing "my data / my activity" view.

### 3.8 Usage and cost

- `server/usageTracker.js` + `UsageEventLog` + `UsageAggregator`: per-event JSONL with `pt`/`ct` and `src: provider|estimate`, daily and monthly rollups, retention, three identity modes (anonymous fingerprint, pseudonymous, identified), web-search counting, `GET /api/admin/usage/export` (CSV). The 2026-02-27 concept has been implemented except **cost estimation**.
- `server/validators/modelConfigSchema.js` has no price fields. Nothing computes cost, so nothing can enforce a budget, show a bill or reconcile provider invoices.
- No quotas or budgets at any level; `AgentLoop` budgets (`maxTokensPerRun`, `maxWallClockMs`) are per run, not per user, group or tenant.
- No seat/MAU metering, no attribution to team or workflow, no alerts, no export shaped for billing (Stripe usage records, invoice lines).

### 3.9 Reporting, administration, onboarding

- The admin UI is complete for one installation (65 pages, sidebar, Cmd+K, change history, audit log, overview stats). For SaaS it needs two audiences: **tenant admins** (their users, apps, models, budgets, SSO, branding, retention, reports) and **operators** (tenants, plans, fleet version, provider health, margin per tenant, support tools). Today's UI is neither scoped nor role-split beyond admin/content admin.
- Onboarding: `server/routes/setup.js` handles the first API key; `setupUtils` seeds `server/defaults/`. There is no tenant signup, invitation, domain setup, starter pack or checklist. The Simplification Proposal's "profiles instead of middleware soup" and "platform-managed models so tenants never see an API key" are directly reusable here.
- Reporting exists as one usage dashboard; adoption analytics, scheduled reports, and BI exports do not.

### 3.10 Security, compliance, operations

- Present: AES-256-GCM secrets at rest with one key file (`TokenStorageService`), RS256 JWT, SSRF/DNS guard, rate limits, CORS, body limits, path security, log redaction, Trivy and OSV scanning in CI, a PII handling document, `docs/security.md`.
- Missing for SaaS: per-tenant encryption keys (envelope encryption with a KMS), secrets from a vault rather than files, IP allowlists per tenant, session controls (idle timeout, revoke-all), DLP/PII redaction and prompt-injection guardrails as a platform hook (the GDPR anonymizer exists only as an app), an automated cross-tenant isolation test suite, penetration test cadence, SOC 2 / ISO 27001, DPA and subprocessor list, per-user and per-tenant export and erasure, offboarding with deletion evidence.
- Operations: config migrations are solid; the storage design adds a SQL migration runner. Missing: Helm, rolling/blue-green procedure, per-tenant backup/restore, DR runbook, capacity model per tenant.

---

## 4. Competitive comparison

### 4.1 Feature matrix

Legend: ✅ available · ⚠️ partial, paid tier, or not independently verified · ❌ not available · – not applicable. Third-party columns were compiled from vendor documentation and public reviews in September 2026 (Appendix B); re-verify before using them externally.

| Capability | iHub today | Open WebUI | LibreChat | Onyx | Langdock | ChatGPT Enterprise | Claude Enterprise | LiteLLM (gateway) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Multi-tenant (one deployment, many customer orgs) | ❌ | ❌ single org | ❌ single org | ✅ Cloud | ✅ workspaces | ✅ workspaces | ✅ orgs | ✅ org → team → key |
| Self-service signup and trial | ❌ | – | – | ✅ | ✅ | ⚠️ sales-led | ⚠️ sales-led | ⚠️ cloud |
| SSO via OIDC | ✅ multi-provider | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ ent. |
| SAML 2.0 | ❌ | ❌ (OIDC/LDAP/trusted header) | ✅ | ✅ ent. | ✅ | ✅ | ✅ | ✅ ent. |
| SCIM 2.0 provisioning | ❌ | ✅ | ❌ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ ent. |
| Domain verification / capture, discovery by e-mail | ❌ (single-provider `autoRedirect` only) | ❌ | ❌ | ⚠️ | ⚠️ | ✅ | ✅ | – |
| LDAP / Active Directory, NTLM | ✅ both | ✅ LDAP | ✅ LDAP | ❌ | ❌ | ❌ | ❌ | ❌ |
| Group-based access to apps and models | ✅ hierarchical groups + external mappings | ✅ | ✅ | ✅ | ✅ | ✅ custom roles | ✅ | ✅ teams |
| Admin roles beyond admin/user | ⚠️ content admin | ❌ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| Audit log (admin, auth, config) | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ 150+ event types | ✅ ent. |
| Compliance / eDiscovery API (chats, files, activity by user/time) | ⚠️ run ledger, dark, no API | ⚠️ DB access | ❌ | ⚠️ | ⚠️ | ✅ | ✅ | – |
| SIEM streaming | ⚠️ Winston mirror | ✅ container logs | ❌ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |
| Usage analytics for admins | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost per request / model prices | ❌ | ❌ | ✅ token credits | ❌ | ✅ | – seats + credits | – seats | ✅ 140+ providers |
| Budgets / spend limits (user, team, org) | ❌ | ❌ | ✅ balances, auto-refill | ❌ | ⚠️ | ⚠️ credits | ⚠️ | ✅ per key/team/org |
| Per-user rate limits | ❌ IP only | ⚠️ | ✅ | ⚠️ | ✅ | – | – | ✅ |
| Stateless horizontal scaling, external DB | ❌ sticky + shared volume | ✅ PostgreSQL + Redis + S3 | ✅ MongoDB + Redis | ✅ | – | – | – | ✅ PostgreSQL + Redis |
| OpenTelemetry | ✅ GenAI conventions | ✅ | ❌ | ⚠️ | – | – | – | ✅ |
| Self-hosted / on-prem | ✅ binary, Docker, Windows service, air-gap | ✅ | ✅ | ✅ | ⚠️ dedicated from 5,000 users | ❌ | ❌ | ✅ |
| EU data residency | ✅ wherever hosted; SaaS: to build | – | – | ✅ | ✅ EU-hosted | ✅ option | ⚠️ | – |
| Curated app / assistant catalogue with governance | ✅ 30+ apps, marketplace, per-group | ✅ | ✅ agents | ✅ assistants | ✅ assistants | ✅ GPTs with domain controls | ✅ projects | – |
| Workflows / agents | ✅ | ⚠️ pipelines | ✅ | ⚠️ | ✅ paid add-on | ✅ | ✅ | – |
| MCP client **and** MCP server/gateway | ✅ both | ✅ client | ✅ client | ✅ client | ⚠️ | ✅ connectors | ✅ | ✅ gateway |
| OpenAI-compatible API for customers | ✅ | ✅ | ❌ | ⚠️ | ✅ | ❌ | ❌ | ✅ core |
| Acts as OIDC IdP / OAuth AS for other apps | ✅ unique | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Certifications (SOC 2 / ISO 27001) | ❌ | – software | – software | ✅ SOC 2 | ✅ both | ✅ | ✅ | ✅ cloud |
| E-mail invitations and notifications | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |

### 4.2 What the market treats as table stakes for a hosted enterprise AI product

1. **Workspaces with self-service admin**: invite by e-mail, verified domains, domain capture (anyone with `@acme.com` lands in Acme's workspace), SSO on the business tier, SCIM for joiners/leavers.
2. **Governance of the catalogue**: who may use which model, app, connector and agent; approval for sharing; custom admin roles.
3. **Evidence**: audit log, exportable; a compliance API for chats and activity; SIEM integration; retention controls; SOC 2 / ISO 27001.
4. **Money**: per-seat pricing with a usage component (Langdock: €20/user/month on Business plus a 10 % markup on model usage and a separate workflow-run add-on; Microsoft 365 Copilot: $30/user/month), budgets and cost visibility, credits for the pooled models.
5. **Scale without ceremony**: stateless replicas on PostgreSQL + Redis + object storage (Open WebUI and LibreChat both document this; iHub documents the opposite).
6. **Residency**: EU hosting is a buying criterion in iHub's home market; Langdock's positioning is built on it.

### 4.3 iHub's differentiators to protect

- **Apps as the product**, not "a chat with a model picker": 30+ curated apps, per-group rollout, marketplace, skills, prompt library, starter prompts, variables, structured output. Langdock's "assistants" and ChatGPT's "GPTs" are the same idea with less governance.
- **On-prem lineage**: LDAP, NTLM, proxy auth, Windows service, single binary, air-gapped, local vLLM/LM Studio. None of the SaaS incumbents have this; the OSS peers have LDAP at best. It is what makes a **hybrid** offer credible (SaaS for most, dedicated or on-prem for the regulated few).
- **Integration surface**: iFinder, Teams, Outlook add-in, browser extension, Nextcloud, Jira, Office 365, Google Drive; MCP in both directions; OpenAI-compatible inference API; iHub as OIDC IdP — a tenant can plug its other tools into iHub's identity and model gateway.
- **Runtime unification**: one agent loop for chats, workflows and agents with a replayable ledger — the raw material for cost attribution, support and compliance that competitors sell as separate "compliance API" products.
- **EU company, EU hosting** by default.

### 4.4 Patterns worth copying

| From | Pattern | Where it lands in this plan |
| --- | --- | --- |
| LiteLLM | Org → team → key hierarchy with budgets and rate limits at every level; spend attributed to key, user, team and org at once; spend-report API | §5.7 cost model and enforcement points |
| LibreChat | Token balances per user with auto-refill; enforcement on prompt tokens **before** the call, settle after | §5.7 budgets |
| Open WebUI | PostgreSQL + Redis + S3 as the documented scaling recipe; SCIM 2.0 with SCIM operations audited | §5.5, §5.6 |
| ChatGPT / Claude Enterprise | Domain verification (DNS TXT), domain capture, Compliance API with 150+ typed activity events, IP allowlists | §5.6, §5.9, §5.13 |
| Langdock | EU-first positioning, seat price + usage markup + workflow-run packages, IP restrictions, ISO 27001 + SOC 2 | §5.7, §5.13, §7 |
| Onyx | Self-serve multi-tenant cloud beside the same open-source self-hosted product | Bet 2/3, §5.12 |
| Microsoft Agent 365 | One control plane for agent inventory, permissions and lifecycle | §5.11 tenant admin console (agents and workflows are already first-class in iHub) |

---

## 5. Target architecture

### 5.1 Principles

1. **One code base, three topologies.** Self-hosted single tenant, SaaS cell-per-tenant, SaaS pooled cell. The topology is a deployment choice; the code always has a tenant boundary, and in single-tenant mode the tenant is `default` and behaviour is byte-identical to today.
2. **Tenant everywhere or nowhere.** `tenantId` sits in the request context and is derived, never trusted from the client. Every storage call, cache key, log line, span, metric, audit entry and usage event carries it. A background job carries it explicitly.
3. **PostgreSQL is the system of record for SaaS.** Configuration, users, groups, chats, ledger, usage, audit — all through the storage provider. The filesystem stays the default for self-hosted.
4. **Stateless runtime.** No worker- or instance-local state that a later request depends on. The bus, locks, rate limits and throttles live in shared infrastructure.
5. **Control plane is a separate service.** The tenant runtime does not know about credit cards, trials or fleet upgrades. It exposes a small **tenant-management API** (create tenant, set entitlements, suspend, export, delete, read metering) that the control plane calls.
6. **Usage events are the metering truth.** One event per model call (and per billable tool call) with tokens, computed cost, price version and full attribution. Bills, budgets, reports and dashboards derive from it.
7. **Secure by construction.** Isolation is enforced by the storage layer (schema or database per tenant), not by remembering to add a `WHERE` clause; an automated cross-tenant test suite runs in CI.

### 5.2 Components

```
                 ┌────────────────────────────────────────────────────────────┐
  Users, IdPs,   │  Edge: DNS *.ihub.cloud + verified custom domains, TLS,    │
  API clients    │  WAF, per-tenant IP allowlists, tenant routing by host      │
                 └───────────────┬──────────────────────────┬─────────────────┘
                                 │                          │
             ┌───────────────────▼───────────┐   ┌──────────▼───────────────────────────────┐
             │ CONTROL PLANE (new service)   │   │ CELLS (iHub runtime, N replicas each)     │
             │ - Tenant directory & domains  │   │  cell "acme"      cell "shared-eu-1"      │
             │ - Signup, trials, invitations │   │  ┌─────────────┐  ┌─────────────────────┐ │
             │ - Home-realm discovery (login)│──▶│  │ iHub x3     │  │ iHub x6             │ │
             │ - Plans, entitlements, billing│   │  │ PG db: acme │  │ PG: schema/tenant   │ │
             │ - Provisioning & fleet ops    │   │  │ S3: acme/   │  │ S3: <tenant>/       │ │
             │ - Operator console & support  │   │  └─────────────┘  └─────────────────────┘ │
             └───────────────┬───────────────┘   └──────────┬───────────────────────────────┘
                             │                              │
             ┌───────────────▼──────────────────────────────▼───────────────────────────────┐
             │ SHARED SERVICES: identity broker (ZITADEL/Keycloak: SAML, SCIM, MFA, orgs),   │
             │ PostgreSQL cluster, Redis (optional; PG LISTEN/NOTIFY suffices per design),   │
             │ S3-compatible object store, KMS/Vault, e-mail provider, OTel collector →      │
             │ Prometheus/Loki/Tempo + SIEM export, metering pipeline → billing (Stripe)      │
             └──────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Tenant resolution and request context

- **Resolution order:** (1) verified custom domain or `<slug>.ihub.cloud` host → tenant; (2) `tid` claim in an iHub-issued JWT or API key / OAuth client record → tenant (and it must match the host, otherwise 404); (3) in single-tenant mode, `default`. Resolution happens in a middleware that runs before the auth chain in `server/middleware/setup.js`.
- **Context:** `server/utils/requestContext.js` gains `tenantId` next to `userId`, `oauthClientId`, `ip`. The logger already merges the context into every line, so logs get the tenant for free. Background work (retention sweeps, resume-on-boot, scheduled workflows) iterates tenants explicitly and runs each inside `runWithContext({ tenantId })`.
- **Cache:** `configCache` becomes a per-tenant cache behind the same API — `getPlatform()`, `getApps()` … read the tenant from the context; calls without a context resolve to `default`. That keeps hundreds of call sites unchanged and makes "forgot the tenant" a loud failure in SaaS mode (no context ⇒ throw, never fall back to another tenant). Entries are evicted by LRU with a per-cell tenant limit, and invalidated through the provider's `ChangeNotifier`.
- **Client:** the SPA learns the tenant from `GET /api/auth/status` / `GET /api/configs/platform` (branding, features, login options) — no client-side tenant switching in v1.

### 5.4 Configuration per tenant

Replace "one `contents/` tree" with **layered configuration documents**:

| Layer | Owner | Storage | Examples |
| --- | --- | --- | --- |
| **Product defaults** | Code (`server/defaults/`) | Ships with the release | Apps, models, prompts, workflows, mimetypes |
| **Platform baseline** | Operator | Control plane → `config` namespace of a `_platform` pseudo-tenant | Curated model catalogue with prices, default features per plan, security policy, EU provider endpoints |
| **Tenant overrides** | Tenant admins | Tenant's `config`/`apps`/`models`/… namespaces | Enabled apps, own models and keys, groups, branding, retention, budgets, SSO connection |
| **Environment** | Operator | `IHUB_*` env per cell | Ports, bus, storage DSN, KMS |

- The **effective configuration** is defaults ⊕ baseline ⊕ tenant override (deep merge for objects, tenant wins; arrays replaced, not merged, as today's config semantics expect). It is computed and cached per tenant.
- **Entitlements** (plan limits) are enforced as a filter on the effective configuration: a Starter tenant cannot enable `workflows` even if the override says so; the feature registry (`server/featureRegistry.js`) already has the flag model.
- **Config migrations** (`server/migrations/`) run per tenant on upgrade with the migration lock held per tenant. The runner already records history per installation; it becomes per tenant.
- **Concurrency:** admin saves use the provider's etag compare-and-set (already implemented) and the UI shows a conflict instead of silently overwriting — this is what turns "Admin UI read-only in production" into "safe for many admins".
- **Baseline promotion:** operators edit the baseline in a staging cell and promote it via Git, exactly the workflow `docs/multi-server-deployment.md` prescribes today, now for the operator only.
- **Self-hosted:** nothing changes — defaults ⊕ `contents/` ⊕ env, tenant `default`, files byte-identical.

#### How the services hold configuration

Today every service keeps its own copy of configuration in one of four ways. Three of them stop working the moment one process serves more than one tenant, because "the configuration" becomes "a configuration per tenant" and a module-level variable can only hold one.

| Pattern today | Examples | Problem with many tenants |
| --- | --- | --- |
| **Boot-time snapshot.** `server/server.js` reads `platform.json` once and hands it to `setupMiddleware(app, platformConfig)`; rate limiters, body limit, `trustProxy`, session middleware and `app.set('platform', …)` are built from that object. `initTelemetry()` and `configureOidcProviders()` (one global passport strategy `oidc-<provider>` per provider) run at boot; the NTLM middleware is memoized per config. | `server/middleware/setup.js`, `server/middleware/rateLimiting.js`, `server/middleware/oidcAuth.js`, `server/telemetry.js` | One value per process. A tenant admin who changes SSO or rate limits would need a cell restart, which is not acceptable in a shared cell. Two places already read the **live** cache per request instead (the CORS options and the permission enhancer in `setup.js`) — that is the pattern to generalize. |
| **Module-level lazy copy.** A service reads its slice once and keeps it in module variables (`trackingEnabled`, `trackingMode`, `configLoaded`); `server/configReloadHooks.js` watchers compare the slice's serialization after a reload and call `reloadConfig()` / `resetConfig()` on the other workers. | `server/usageTracker.js`, `server/feedbackStorage.js`, iFinder/iAssistant services, `McpClientManager` | The copy has no tenant dimension, and the watcher list is a hand-maintained registry that grows with every service. |
| **Pull on use.** The service calls `configCache.getPlatform()` (90 files) or `getModels()` at the moment it needs a value. | `AuditLogService`, `tokenService`, `authorization.js`, `requestThrottler`, `LLMClient`'s model-catalog seam | Already correct — it only needs the cache to answer for the current tenant. |
| **Module-level paths and stores.** `const contentsDir = config.CONTENTS_DIR` at import time; debounced JSON stores and JSONL appenders keyed by nothing. | `usageTracker`, `UsageEventLog`, `feedbackStorage`, `shortLinkManager`, `consentStore`, `installedVersionStore` | One directory per process; buffers mix tenants. |

`configCache` itself is one process-wide cache keyed by relative file path, refreshed by a 5-minute TTL, by key announcements over the cluster IPC bus after admin saves, and by the storage provider's `ChangeNotifier` (in-process on the filesystem provider).

**Target contract — services hold nothing.**

1. **Four holders, one direction of flow.** The **store** holds the truth (a document per tenant per file, with an etag). The **cache** holds per-tenant *versions* of the effective configuration, invalidated by the notifier. The **request** holds a *snapshot reference*. **Services** hold nothing: they read the value at use time from the snapshot, exactly like the pull-on-use pattern today.
2. **Read at use time, never at import or boot** — unless the value is cell-level (rule 3). The two "live" reads in `setup.js` become the norm; `app.set('platform', …)` and `platformConfig` parameters disappear.
3. **Split `platform.json` into cell-level and tenant-level.** Cell-level is process infrastructure and comes from the environment or a `cell` config module: port, workers, storage DSN, bus, telemetry exporters, logging transports, outbound proxies, TLS, `trustProxy`, body limits, KMS. Tenant-level is everything a tenant admin may change and lives in documents: auth connections, groups, features, branding, retention, budgets, rate limits, integrations, apps, models, prompts. Rule of thumb: **anything that needs a restart today is cell-level; anything tenant-level must be hot-reloadable.** In single-tenant mode one `platform.json` still carries both, so self-hosted installations do not change.
4. **Request-scoped snapshot.** The tenant-resolution middleware resolves the tenant, takes the tenant's current effective configuration (an immutable, frozen object, cheap because it is cached) and stores `{ tenantId, config, configVersion }` in `requestContext`. `configCache.getPlatform()`, `getApps()`, `getModels()` … return from that snapshot while inside a request, so one request sees one consistent version even when an admin saves halfway through, and no call site has to change. Outside a request the same calls return the `default` tenant in single-tenant mode and **throw** in SaaS mode — a missing tenant must fail loudly, never fall back to another tenant's configuration. Background work (retention sweeps, rollups, schedule triggers, resume-on-boot) iterates tenants and opens one context per tenant.
5. **Derived objects are memoized per `(tenantId, sourceEtag)`.** Passport strategies (named `oidc-<tenant>-<provider>`), rate limiters (or function-valued `limit`/`keyGenerator` reading the snapshot, on the shared store), LDAP/NTLM and JWKS clients, MCP client connections, source handlers, compiled tool registries and the effective-config merge itself go into one `DerivedCache`: `derive(name, builder, { dispose })` builds lazily on first use for a tenant, returns the cached object while the source etag is unchanged, disposes (closes connections, stops timers) when the notifier reports a change, and evicts by LRU and idle time. This replaces the hand-maintained watcher list in `configReloadHooks.js` with one mechanism that is keyed by tenant and driven by change events instead of signature polling.
6. **Per-tenant runtime resources have an owner.** Connections and timers that belong to a tenant (LDAP pools, MCP sessions, schedule triggers, retention state) hang off a `TenantRuntime` object with `dispose()`; a cell keeps a bounded set of active runtimes and disposes idle ones.
7. **Stateful buffers key by tenant.** Usage and audit appenders, the activity tracker and the rollup builder stay singletons but partition their in-memory buffers by tenant and write each record with its tenant through the provider; flush loops iterate the partitions.
8. **One invalidation path.** Storage `ChangeNotifier` (PostgreSQL `NOTIFY` in SaaS, in-process on the filesystem) → `configCache` drops `(tenant, ns, key)` and emits `config:changed { tenantId, key, etag }` → `DerivedCache` disposes matching entries → the next request rebuilds. The TTL stays as a safety net; the cluster IPC announcements stay for the filesystem provider. A change to the platform **baseline** bumps a baseline version; every tenant's effective configuration is recomputed lazily on its next read instead of eagerly for all tenants.
9. **Guardrails in CI.** Extend `scripts/check-config-fs-access.js` (or an ESLint rule) to fail on `configCache.get*` at module scope, on module-scope `config.CONTENTS_DIR` / `getRootDir()` + `contents`, and on `process.env` reads outside the cell config module (today 30 distinct variables are read in 25+ places outside `server/config.js`). Add isolation tests for configuration bleed: a change in tenant A is never visible to tenant B, and a request in B during A's reload sees a single consistent snapshot.
10. **Client.** `PlatformConfigContext` and `UIConfigContext` fetch `/api/configs/*` per host, so they are tenant-scoped as soon as the server resolves the tenant by host; add an `ETag` and `Vary: Host` so a CDN never serves one tenant's branding to another.

**Other deployables.** The control plane owns the tenant registry, domains, plans and entitlements, but the runtime never reads them synchronously from the control plane: the tenant-management API *writes* a tenant record document into the cell's own database, and the runtime reads that. A control-plane outage therefore never blocks a request. The identity broker owns identity-connection configuration; the runtime keeps only its OIDC client per tenant. Integration configuration (iFinder, Jira, Office 365) stays tenant-level configuration inside the runtime.

**Migration order (workstream P1.7).** (1) Effective-config resolution plus the request snapshot behind the unchanged `configCache` API, `default` tenant everywhere. (2) Convert the lazy-copy services (`usageTracker`, `feedbackStorage`, iFinder/iAssistant, MCP client manager) to pull-on-use or `DerivedCache`. (3) Convert the boot-time snapshot in `setupMiddleware`: live rate limiters on the shared store, per-tenant passport strategies, per-tenant LDAP/NTLM clients, signed tickets instead of session middleware (already recommended by the 2026-07-28 audit). (4) Cell/tenant split of `platform.json` with a config migration that keeps one file valid in single-tenant mode. (5) Module-level paths and stores onto the provider (P0.5). (6) Lint guard and bleed tests.

### 5.5 Storage and isolation

- **PostgreSQL provider** as designed (`documents`, `log_entries`, `change_log` + NOTIFY, advisory locks, SQL migration runner). Tenancy is added at the provider boundary: the provider receives `(tenant, ns, key)`; nothing above it changes.
- **Isolation model:** **schema-per-tenant** in pooled cells, **database-per-tenant** in dedicated cells (same code, different DSN). Schema-per-tenant is preferred over a `tenant_id` column because (a) export, delete and "move this tenant to a dedicated cell" become schema-level operations, (b) an isolation bug cannot leak rows across tenants through a missing predicate, (c) per-tenant retention sweeps and backups are trivial, (d) cross-tenant analytics are not needed in the runtime — they go through the metering pipeline. The cost is more schemas to migrate, which the SQL runner handles by iterating tenants. Row-level security is a fallback if a pooled cell ever needs thousands of tenants per database.
- **Blobs** (uploads, artifacts, spill files) move to the blob facet on S3-compatible storage with a `<tenant>/` prefix and per-tenant encryption context. This removes the last shared-volume requirement.
- **Move everything onto the provider:** users, groups, OAuth clients and credentials become `config`-class namespaces; usage events, audit entries, feedback, short links, change history, consent, refresh tokens, agent inboxes/memory, workflow registry and OAuth connections become runtime namespaces or append-log streams. Appendix A is the checklist; `scripts/check-config-fs-access.js` is extended to forbid `contents/` path construction outside `server/storage/` and the filesystem provider.
- **Filesystem provider** learns tenants only to the extent tests need it (`contents/` for `default`, `contents/tenants/<id>/` otherwise); it is not a production multi-tenant backend.
- **Per-tenant encryption:** `TokenStorageService` moves from one `.encryption-key` file to envelope encryption — a data key per tenant wrapped by a KMS key (or a master key from Vault for self-hosted). Enterprise tenants can bring their own KMS key.

### 5.6 Identity and access

**Login flow with discovery (home-realm discovery):**

1. `login.ihub.cloud` (control plane) asks for an e-mail address.
2. Domain lookup: verified domain → exactly one tenant → that tenant's identity connection (SSO) or the broker's password/passkey login; unverified domain → tenant picker for the user's memberships, or signup.
3. The user lands on `<tenant>.ihub.cloud` with an OIDC code from the broker; iHub's existing OIDC middleware validates it and maps groups. Every tenant is one OIDC client of the broker; per-tenant SSO (Entra ID, Okta, Google, SAML IdPs) is federated **inside the broker's organization** for that tenant, so iHub never speaks SAML itself.
4. Fallback for links deep into a tenant (`<tenant>.ihub.cloud/apps/…`): the tenant's login page redirects to the connection directly (`autoRedirect` semantics already exist).

**Domains:** tenants register domains and prove them with a DNS TXT record; a verified domain can enable **domain capture** (users signing in with that domain are auto-joined, with JIT provisioning into mapped groups) and blocks other tenants from claiming it.

**Provisioning:** SCIM 2.0 (Users, Groups) is served by the broker and synchronized into iHub through a webhook or scheduled reconciliation that creates/deactivates users and maps groups to `groups.json` mappings. Invitations are e-mailed by the control plane; accepting an invitation creates the membership.

**Sessions and API keys:** JWTs stay but shorten (15–60 min) with a refresh flow, and a revocation list lives in the provider so "deactivate user" and "sign out everywhere" work across instances. Personal API keys and OAuth clients (already implemented) become tenant-scoped and count against entitlements.

**Roles:** tenant `owner` (billing, domains, SSO, delete tenant), `admin` (everything else), `content admin` (exists), `billing admin` (invoices, budgets), `member`. Operator roles: `support` (read-only, consented impersonation), `sre`, `billing`, `superadmin`. All role checks stay group-based so self-hosted installs keep working; SaaS just ships the groups.

**Self-hosted** keeps native OIDC/LDAP/NTLM/proxy/local exactly as today; the broker is a SaaS deployment choice.

### 5.7 Cost tracking, budgets, metering and billing

**Pricing catalog.** Add optional `pricing` to the model schema (`server/validators/modelConfigSchema.js`):

```json
"pricing": {
  "currency": "EUR",
  "input": 2.50,           // per 1M tokens
  "output": 10.00,
  "cachedInput": 0.25,
  "reasoning": 10.00,
  "perRequest": 0.0,
  "perImage": 0.04,
  "perAudioMinute": 0.006,
  "effectiveFrom": "2026-09-01"
}
```

Tool-level prices (web search per call, OCR per page, transcription per minute) live on the tool or provider. The platform baseline carries the operator's prices for platform-provided models (including markup); a tenant's BYOK model carries the provider's list price so the tenant sees its true spend.

**Usage event, extended.** Every event (`server/services/UsageEventLog.js`) gains `tenant`, `group`/`team`, `runId`, `kind` (chat, workflow node, agent, inference API, tool), `cost`, `currency`, `priceVersion`, `billable` (platform model vs BYOK) and cached/reasoning token counts. Cost is computed at write time by `LLMClient` — the one place every model call passes through — so estimates never drift from the price that applied at the time.

**Budgets and quotas.** Budgets attach to tenant, group and user with a window (day/month/billing period), a hard or soft limit, and alert thresholds (80 %, 100 %). Enforcement happens in `LLMClient` before the call (estimated prompt cost against remaining budget, LibreChat-style) and settles after the call with the real usage; workflows and agents check per node. Plan entitlements are budgets the tenant cannot raise. Alerts go out by e-mail and webhook. Budget counters live in the provider (atomic increments), not in worker memory.

**Fairness against shared provider limits.** The request throttler (`server/requestThrottler.js`) becomes shared and gains per-tenant concurrency shares, so one tenant's workflow fan-out cannot exhaust a platform key's rate limit for everyone; Enterprise tenants get their own keys.

**Seats and metering.** A nightly job computes per tenant: active seats (users who signed in or made a call in the billing period), tokens and cost per model, workflow runs, storage bytes, API calls. It writes metering records that the control plane pulls (`GET /api/tenant/metering?period=`) and pushes to the billing system (Stripe usage-based billing or invoice lines). Reconciliation reports compare billed platform-model cost with provider invoices.

**Commercial model to implement first** (decision in §7): seat price per tier + included monthly credit for platform models + overage at list price plus markup; BYOK usage tracked but not marked up; workflow runs metered separately once they are a paid add-on.

### 5.8 Observability

- `tenant.id` (and `tenant.plan`) as a resource attribute per cell in dedicated topologies and as a span/log attribute in pooled cells; **not** as a label on high-cardinality metrics — per-tenant numbers come from usage events, fleet-level metrics stay in Prometheus.
- Correlate logs and traces: `trace_id`/`span_id` into the log context; the audit `requestId` already links to the request.
- **SLOs** per cell: availability of `/api/auth/status`, time-to-first-token p95 per provider, stream error rate, tool failure rate, config reload duration. Ship Grafana dashboards and alert rules in the repo (`docker/observability/`) so self-hosted operators get them too.
- **Probes:** `/api/health/live` (process up) and `/api/health/ready` (config loaded for the cell, storage healthy, bus connected; optional provider reachability). Today's `/api/health` stays as an alias for liveness.
- Synthetic canary per cell (login → chat → one token), a public status page, and provider-health signals surfaced to tenant admins ("OpenAI degraded since 14:02").

### 5.9 Auditing and compliance

- Audit entries move to an append-log stream per tenant on the provider, with the existing schema plus `tenantId` and an `actorType` (user, api-key, scim, operator-impersonation, system). Operator actions are written to both the tenant's log and an operator log.
- **Tamper evidence:** each entry carries the hash of the previous one; a daily anchor (hash of the day) is written to a separate store and optionally to the tenant's own S3 bucket.
- **Export:** CSV/JSON by filter (already specified in the Admin UI roadmap), a documented SIEM stream (OTLP logs or webhook; the Winston mirror stays for self-hosted), and a **Compliance API** for Enterprise: list audit events, chats, runs, artifacts and interactions by user and time range, with content when the run ledger is enabled — the same data the ledger already holds, behind a scoped `compliance:read` OAuth client.
- **Retention** per tenant (audit, chats, ledger, usage) with legal hold; **erasure** per user (GDPR Art. 17) and per tenant (offboarding: export archive, delete, deletion certificate) as runtime API calls the control plane orchestrates.

### 5.10 Reporting

- **Tenant admin reports** (in-product): adoption (DAU/WAU/MAU, new vs returning users, per-group), catalogue use (apps, models, workflows, skills, tools), cost by model/app/group/user with budget status, quality (feedback ratings, error rate, aborted streams), all with the anonymous/pseudonymous/identified modes that exist today. Scheduled e-mail digests (weekly adoption, monthly cost) via the e-mail service.
- **Operator reports**: tenants and growth, revenue vs platform-model cost (margin per tenant), provider health and spend, feature adoption by plan, support signals (error spikes per tenant, budgets exhausted).
- **BI export:** nightly CSV/Parquet of usage and audit to the tenant's own bucket (Enterprise) or the operator's warehouse.

### 5.11 Onboarding and administration

- **Signup:** e-mail → verification → tenant slug → 14-day trial with platform models and a small credit → guided checklist: invite colleagues, pick a starter pack (industry app bundle from the marketplace), set language and branding, connect a knowledge source, optionally verify a domain and enable SSO. No API key is ever required for platform models — the Simplification Proposal's "hide the JSON" principle applied to tenants.
- **Tenant settings page** (new): domains and SSO, members and roles, plan and billing, budgets and alerts, retention and data export, allowed models and default model, API access (personal keys on/off, OAuth clients), IP allowlist, branding.
- **Progressive disclosure:** the existing admin UI is scoped to the tenant and shows basic sections by default (Apps, Models, Users, Groups, Reports, Settings); advanced sections (Sources, Tools, Skills, Workflows, Agents, MCP, OAuth server) appear by entitlement and an "advanced" toggle.
- **Operator console** (control plane): tenant list and search, plan changes, suspend/resume, provisioning status, cell and version per tenant, migration status, consented impersonation ("start support session" creates an audited, time-boxed token the tenant owner approved), provider health, fleet upgrade orchestration with canary tenants.
- **Fleet upgrades:** rolling per cell; canary set of internal and volunteer tenants; config and SQL migrations per tenant; rollback per cell (the self-update service's rollback semantics move to the control plane).

### 5.12 Deployment topologies and cells

| Topology | Unit | Isolation | Cost per tenant | When |
| --- | --- | --- | --- | --- |
| **Cell-per-tenant** (Phase 2) | Kubernetes namespace: iHub Deployment (1–N replicas, `WORKERS=1` per pod), database per tenant on a shared PostgreSQL cluster, S3 prefix | Strongest short of separate clusters | ~0.25–0.5 vCPU / 512 MB–1 GB idle per tenant plus a database; fine for tens to a few hundred tenants | First SaaS launch; Business and Enterprise permanently |
| **Pooled cell** (Phase 3) | One iHub Deployment serving many tenants, schema per tenant | Storage-level; code isolation tested in CI | Marginal per tenant | Starter/Team tier once tenant count makes pods-per-tenant uneconomic |
| **Dedicated cell** | As cell-per-tenant, plus own database instance, optional own node pool and region | Strongest | Highest | Enterprise, regulated, region-specific |
| **Self-hosted** | Customer's infrastructure | Customer's | — | Unchanged |

A Helm chart with values for all three, shipped in the repo, is the deployment artifact for SaaS and for self-hosted Kubernetes customers alike.

### 5.13 Security and compliance program

- Envelope encryption per tenant (§5.5), secrets from KMS/Vault, no key files on volumes.
- Per-tenant IP allowlists at the edge and in the runtime; session idle timeout; revoke-all.
- **Guardrail hooks** in `LLMClient`/`AgentLoop`: PII redaction, prompt-injection and jailbreak filters, output classifiers, configurable per tenant and per app, with audit of interventions. Start with the GDPR anonymizer logic as the first redaction provider.
- **Isolation test suite** in CI: every storage namespace and every API route is exercised with two tenants and asserted to never return the other tenant's data; fuzzing of ids and hosts.
- Penetration test before launch and yearly; bug bounty later.
- **SOC 2 Type I** at launch, **Type II** after twelve months; ISO 27001 aligned with IntraFind's existing certification scope where possible. Evidence automation from day one (access reviews, change management from Git and audit logs, vendor list).
- DPA, subprocessor list, EU-only inference option, transparency page on what is stored (`docs/pii-data-handling.md` is the seed).

---

## 6. Roadmap

Effort is in person-months (PM), rough, for planning. Phases overlap; exit criteria are what matters.

### Phase 0 — Stateless runtime on PostgreSQL (prerequisite, partly in flight) · 4–6 PM

| # | Workstream | Deliverable | Depends on |
| --- | --- | --- | --- |
| P0.1 | PostgreSQL provider | Documents, blobs (S3 facet), append-logs, NOTIFY notifier, advisory locks, SQL migration runner, conformance suite green, Compose service | storage design §8 |
| P0.2 | Configuration on the provider | Reads and admin writes through `ConfigStore` on PostgreSQL, etag conflicts surfaced in the UI, `ChangeNotifier` invalidation across instances | P0.1 |
| P0.3 | Multi-instance | Bus over LISTEN/NOTIFY, lock-elected singletons, cross-instance SSE, no sticky sessions, no shared volume | P0.1, P0.2 |
| P0.4 | Worker-local state closed | The twelve findings of the 2026-07-28 audit moved to the provider (sessions, MCP sessions, short links, execution registry, job store, rate limiters, throttler, conversation state, abort routing, update state) | P0.1 |
| P0.5 | Runtime data onto the provider | Users, groups, OAuth clients, credentials, usage events, audit, feedback, change history, consent, refresh tokens, agent state, OAuth connections (Appendix A) | P0.1 |
| P0.6 | Kubernetes readiness | Helm chart, `/api/health/live` + `/ready`, graceful shutdown, dashboards and alert rules in repo | — |

**Exit:** three replicas behind a plain round-robin load balancer, no shared volume, admins on any replica can edit configuration safely, all self-hosted single-process behaviour unchanged (`test:quick` green on filesystem provider).

### Phase 1 — Tenant boundary in code, single-tenant by default · 4–6 PM

| # | Workstream | Deliverable |
| --- | --- | --- |
| P1.1 | Tenant context | `tenantId` in `requestContext`; tenant-resolution middleware (host, token claim, `default`); background jobs iterate tenants |
| P1.2 | Tenant-scoped storage | Provider API takes the tenant from context; schema-per-tenant in PostgreSQL; `contents/tenants/<id>/` in the filesystem provider for tests; extended `check-config-fs-access` guard |
| P1.3 | Per-tenant configuration | Layered effective config (defaults ⊕ baseline ⊕ tenant), per-tenant `configCache`, entitlement filter, per-tenant config migrations |
| P1.4 | Tenant on every signal | `tenant.id` in telemetry, logs, audit entries, usage events, run summaries |
| P1.5 | Tenant management API | Create/suspend/delete/export tenant, set entitlements, read metering — the runtime's contract with the control plane |
| P1.6 | Isolation test suite | Two-tenant tests for every namespace and route in CI |
| P1.7 | Service configuration contract | Request-scoped config snapshot, `DerivedCache` for per-tenant derived objects, cell/tenant split of `platform.json`, lazy-copy services converted, lint guard (§5.4 "How the services hold configuration") |

**Exit:** one process serves two tenants in the integration suite with zero cross-tenant reads; a self-hosted install upgraded to this release has a byte-identical `contents/` and identical behaviour. No service keeps a module-level copy of tenant configuration; a tenant admin's change to SSO, rate limits or features takes effect without a restart.

### Phase 2 — SaaS MVP: control plane, identity, money · 10–14 PM

| # | Workstream | Deliverable |
| --- | --- | --- |
| P2.1 | Control plane service | Tenant directory, domains + DNS verification, signup and trial lifecycle, invitations, operator console v1, provisioning of cells via Helm/operator |
| P2.2 | Identity broker | ZITADEL or Keycloak deployed; per-tenant organization and OIDC client; SAML and SCIM federation; home-realm discovery login; domain capture; JIT and group mapping into iHub |
| P2.3 | E-mail and notifications | Transactional e-mail service (invites, verification, budget alerts, digests) and outbound webhooks |
| P2.4 | Pricing, cost, budgets | Model pricing catalog, `cost` on usage events, budgets per tenant/group/user with pre-call enforcement and alerts, shared throttler with tenant shares |
| P2.5 | Metering and billing | Nightly metering per tenant, Stripe integration (seats + usage), plan entitlements, invoices, dunning → suspend |
| P2.6 | Tenant admin experience | Tenant settings page, scoped admin UI with progressive disclosure, onboarding checklist, starter packs, tenant reports (adoption, cost, quality) |
| P2.7 | Audit and data lifecycle | Per-tenant audit streams, export, per-tenant retention, user and tenant export/erasure, offboarding |
| P2.8 | Security baseline | Envelope encryption per tenant, KMS/Vault, IP allowlists, short-lived sessions with revocation, pen test |
| P2.9 | Platform models | Operator-managed provider keys and EU endpoints in the baseline, marked-up prices, fair-use throttling |

**Exit:** a company signs up, verifies its domain, enables SSO, invites users, uses platform models within a budget, receives an invoice, exports its data and deletes the tenant — with nobody at IntraFind involved. SOC 2 Type I evidence collection running.

### Phase 3 — Scale and enterprise · 8–12 PM, then continuous

| # | Workstream | Deliverable |
| --- | --- | --- |
| P3.1 | Pooled cells | Starter/Team tenants on shared cells, schema-per-tenant, per-cell tenant limits, move-tenant-between-cells tooling |
| P3.2 | Compliance API and SIEM | Scoped compliance client, chats/runs/audit by user and time, OTLP/webhook SIEM stream, tamper-evident chain |
| P3.3 | Enterprise controls | Dedicated cells with region choice, customer-managed keys, custom retention and legal hold, private model endpoints |
| P3.4 | Reporting and FinOps | Scheduled digests, BI export, operator margin reports, provider reconciliation, cost routing hints |
| P3.5 | Guardrails | PII redaction and prompt-injection filters as tenant-configurable hooks with audit |
| P3.6 | Reliability | SLO dashboards, status page, canaries, DR runbook and tested restores per tenant, job queue for long-running work |
| P3.7 | Certifications | SOC 2 Type II, ISO 27001 scope extension, DPA and subprocessor program |

**Exit:** hundreds of tenants across pooled and dedicated cells with published SLOs; Enterprise checklist (SSO, SCIM, audit export, compliance API, residency, CMK) fully covered.

### Later — partner and reseller model

IntraFind partners (system integrators, MSPs) managing several customer tenants under one contract is the point where a **hierarchy above tenants** becomes useful (LiteLLM's org → team → key). It is deliberately out of scope until Phase 3 has shipped.

---

## 7. Decisions needed

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Tenancy topology at launch | (a) pooled multi-tenant runtime, (b) cell-per-tenant, (c) hybrid | **(b) first, (c) later.** Isolation and time-to-market beat unit cost for the first hundred tenants; the tenant boundary is built in Phase 1 either way. |
| D2 | Isolation model in PostgreSQL | schema-per-tenant vs `tenant_id` column with RLS | **Schema-per-tenant** (database-per-tenant for dedicated). Export/delete/move as schema ops; leak-proof by construction. RLS as fallback for very high tenant counts. |
| D3 | SAML, SCIM, MFA, discovery | native in iHub vs identity broker (ZITADEL / Keycloak) vs SaaS identity vendor | **Broker.** iHub keeps native OIDC; the broker carries the protocols and MFA. ZITADEL (organizations as first-class, modern) or Keycloak (IntraFind experience?) — spike both in P2.2. |
| D4 | Per-tenant configuration | layered baseline + overrides vs full copy per tenant | **Layered.** Baseline updates reach all tenants; overrides stay small; matches existing defaults ⊕ contents ⊕ env semantics. |
| D5 | Commercial model | per seat only · usage only · seat + included credit + overage | **Seat + included platform-model credit + overage**, BYOK tracked without markup, workflow runs metered for a later add-on (Langdock precedent). |
| D6 | Provider keys | tenant brings keys vs platform-provided default | **Platform-provided by default** (no API key in onboarding), BYOK optional from Business up. |
| D7 | Control plane implementation | inside the iHub server vs separate Node service in this repo vs separate repo | **Separate service in this monorepo** (`control-plane/`), sharing validators and the tenant-management API contract. |
| D8 | Nested tenants | departments as sub-tenants vs groups | **Groups inside a tenant.** Hierarchy only for the partner/reseller case, later. |
| D9 | Region and residency | EU only at launch vs EU + US | **EU only at launch**; the cell model makes a US region an operations task, not a code change. |
| D10 | E-mail provider and billing provider | build vs buy | **Buy** (transactional e-mail API with EU data processing; Stripe with EU entity). |
| D11 | Interpretation of "self-managed" | operated by IntraFind, customer self-service (assumed) vs customer-operated | Confirm the assumption in §2. |

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cross-tenant data leak | Existential for an AI chat product | Schema/database-level isolation (D2), tenant from context only, CI isolation suite (P1.6), pen test before launch, cell-per-tenant at launch (D1) |
| Regression for self-hosted customers | Churn in the existing base | `default` tenant path identical, byte-identical `contents/`, conformance and `test:quick` on the filesystem provider on every PR, feature flags for SaaS-only behaviour |
| Storage track slips | Everything behind it slips | It is already the approved plan with an issue stack; staff it first; Phase 1 can start on the filesystem provider with `contents/tenants/<id>/` |
| Shared provider rate limits and spend | One tenant degrades or bankrupts the platform | Per-tenant throttle shares, hard budgets with pre-call checks, trial caps, several platform keys, Enterprise on own keys |
| Metric cardinality with thousands of tenants | Prometheus cost and outages | `tenant.id` on spans/logs and in usage events, not on metrics; per-tenant numbers from the metering pipeline |
| Broker adds an operational component and a login hop | Complexity, latency | Managed/HA deployment; native OIDC fallback for self-hosted; spike UX in P2.2 |
| Compliance timeline | Enterprise deals blocked | Start SOC 2 evidence collection in Phase 2, Type I at launch |
| Scope creep in the control plane | Delays the MVP | Control plane MVP = signup, domains, invitations, provisioning, plans, billing, operator list; everything else via the runtime's own admin UI |
| Team bandwidth | 18–26 PM is a real programme | Phase gates with exit criteria; quick wins (§1) ship value for self-hosted customers early and de-risk the design |

---

## 9. Immediate next steps (next 4–6 weeks)

1. **Confirm** the assumption in §2 and take decisions D1–D6; record them in this document.
2. **Create epics** for P0.4–P0.6 and P1.1–P1.6 next to the existing storage issue stack; label the quick wins.
3. **Three spikes** (one to two weeks each):
   - PostgreSQL provider with two tenants (schema-per-tenant) behind the `ConfigStore` seam; measure the size of the `configCache` change.
   - Home-realm discovery with ZITADEL and Keycloak: e-mail → organization → federated Entra ID → iHub OIDC login; compare operability.
   - Pricing catalog + `cost` on usage events + a tenant/group/user budget enforced in `LLMClient`; ship as a self-hosted feature if it works.
4. **Reserve the fields now:** `tenant.id` in telemetry attributes, audit entries and usage events (value `default`), so nothing has to be back-filled.
5. **Mark** `concepts/multi-tenancy.md` and `concepts/2025-07-20 OAuth2 Multi-Tenancy Final Concept.md` as superseded by this document.

---

## Appendix A — Inventory of single-tenant assumptions

Server modules that build `contents/` paths directly (grep for `'contents'`, `contents/data`, `CONTENTS_DIR`; 54 files on 2026-09-15), grouped by what has to happen to them.

**A. Legitimately filesystem-provider internals or boot-time (keep, but only here):** `server/config.js`, `server/server.js`, `server/utils/setupUtils.js`, `server/utils/configFileLocation.js`, `server/utils/resourceLoader.js`, `server/services/config/ConfigStore.js`, `server/storage/namespaces.js`, `server/storage/providers/filesystem/{FilesystemStorageProvider,FilesystemDocumentStore,RawDocumentStore}.js`, `server/migrations/runner.js`, `server/migrations/V042__add_agent_factory.js`, `server/migrations/V068__split_tools_config_into_individual_files.js`, `server/services/TokenStorageService.js` (`.encryption-key` → KMS in §5.5).

**B. Runtime data that must move onto the provider (P0.5):** `server/usageTracker.js`, `server/services/UsageEventLog.js`, `server/services/UserFingerprint.js`, `server/services/AuditLogService.js`, `server/services/ChangeHistoryService.js`, `server/feedbackStorage.js`, `server/shortLinkManager.js`, `server/utils/consentStore.js`, `server/utils/refreshTokenStore.js`, `server/utils/installedVersionStore.js`, `server/services/oauth/ConnectionService.js`, `server/services/loop/{llmDebug,InteractionService,LLMClient,runLedgerStore}.js`, `server/services/runtime/runSummaryImport.js`, `server/services/workflow/{ExecutionRegistry,WorkflowStateRepository}.js`, `server/services/workflow/triggers/schedulerLock.js`, `server/agents/runtime/artifactStore.js`, `server/agents/inbox/inboxStore.js`, `server/agents/memory/memoryFile.js`, `server/services/tools/OpenApiToolRunner.js`, `server/routes/toolsService/jobStore.js`.

**C. Content trees read as text (need a tenant-aware text/blob path, P1.2):** `server/services/skillLoader.js`, `server/services/PromptService.js`, `server/services/marketplace/ContentInstaller.js`, `server/sources/{SourceManager,PageHandler,FileSystemHandler}.js`, `server/renderersLoader.js`, `server/featureRegistry.js`, `server/utils/authorization.js`, `server/services/workflow/executors/{PromptNodeExecutor,TemplateRenderNodeExecutor}.js`, `server/routes/admin/{backup,changelog,browserExtension,usage,pages}.js`, `server/routes/agents/artifacts.js`.

**D. Process-global state with no tenant dimension:** `server/configCache.js` (singleton), `server/requestThrottler.js`, `server/middleware/rateLimiting.js`, `server/telemetry/ActivityTracker.js` (active users/chats are platform-wide), `server/actionTracker.js` / `server/sse.js` (keyed by chat id only — chat ids must become unique per tenant or be namespaced).

**E. Documentation that encodes the single-tenant model and must be rewritten after Phase 0:** `docs/multi-server-deployment.md`, `docs/scaling.md`, `docs/storage.md` (provider lineup), `docs/security.md`, `docs/pii-data-handling.md`.

## Appendix B — External sources consulted (September 2026)

- Open WebUI: [Security / enterprise](https://docs.openwebui.com/enterprise/security/), [SCIM 2.0](https://docs.openwebui.com/features/authentication-access/auth/scim/), [Scaling](https://docs.openwebui.com/getting-started/advanced-topics/scaling/), [Scaling & HA (multi-replica)](https://docs.openwebui.com/troubleshooting/multi-replica/), [Palo Alto Networks: adding enterprise controls to Open WebUI](https://live.paloaltonetworks.com/t5/engineering-blogs/how-to-add-enterprise-controls-to-open-webui-cost-tracking/ba-p/1263487), [MintMCP overview](https://www.mintmcp.com/blog/open-webui)
- LibreChat: [Token usage](https://www.librechat.ai/docs/configuration/token_usage), [Balance configuration](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/balance), [Automatic balance refill discussion](https://github.com/danny-avila/LibreChat/discussions/6275)
- Onyx: [Multi-tenant cloud](https://docs.onyx.app/security/onyx_cloud/multi_tenant), [Open WebUI vs LibreChat vs Onyx](https://onyx.app/insights/openwebui-vs-librechat-vs-onyx)
- Langdock: [Security & compliance](https://langdock.com/security), [Pricing](https://langdock.com/pricing), [Pricing docs](https://docs.langdock.com/en/admin/billing/pricing), [Workspace settings](https://docs.langdock.com/en/admin/workspace/workspace), [Review (tl;dv)](https://tldv.io/blog/langdock/), [Pricing review (Workativ)](https://workativ.com/ai-agent/blog/langdock-pricing)
- ChatGPT Enterprise: [Admin quickstart](https://help.openai.com/en/articles/20001264-chatgpt-enterprise-admin-quickstart), [New compliance and administrative tools](https://openai.com/index/new-tools-for-chatgpt-enterprise/), [Admin controls overview (IntuitionLabs)](https://intuitionlabs.ai/articles/chatgpt-enterprise-admin-controls-security)
- Claude Enterprise: [Enterprise plan](https://www.anthropic.com/product/enterprise), [What is the Enterprise plan](https://support.claude.com/en/articles/9797531-what-is-the-enterprise-plan), [Datadog: Claude compliance logs](https://docs.datadoghq.com/integrations/anthropic-compliance-logs/), [Security configuration guide (PlatformSecurity)](https://platformsecurity.com/blog/how-to-secure-your-claude-enterprise-tenant)
- LiteLLM: [Multi-tenant architecture](https://docs.litellm.ai/docs/proxy/multi_tenant_architecture), [Budgets and rate limits](https://docs.litellm.ai/docs/proxy/users), [Enterprise](https://docs.litellm.ai/docs/enterprise)
- Microsoft 365 Copilot / Gemini Enterprise: [Copilot vs Gemini Enterprise](https://www.microsoft.com/en-us/microsoft-365-copilot/copilot-vs-gemini-enterprise), [Copilot Studio governance updates](https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/new-and-improved-agent-governance-intelligent-workflows-and-connected-app-experiences/), [Copilot admin updates summer 2026](https://www.hubsite365.com/en-ww/crm-pages/microsoft-365-copilot-admin-updates-summer-2026.htm)
- Glean / Dust: [Dust: Glean alternatives](https://dust.tt/landing/glean), [Glean vs Dust (Carly)](https://www.usecarly.com/blog/glean-vs-dust/)
- Self-hosted comparisons: [AnythingLLM vs Open WebUI vs LibreChat (DEV)](https://dev.to/jovan_chan_9500711396d4e6/anythingllm-vs-open-webui-vs-librechat-in-2026-which-self-hosted-ai-interface-should-you-use-24cl), [Open WebUI vs LibreChat vs AnythingLLM (RemoteWebAdmin)](https://remotewebadmin.com/blog/open-webui-vs-librechat-vs-anythingllm-2026/)
- PostgreSQL tenancy patterns: [PlanetScale: approaches to tenancy in Postgres](https://planetscale.com/blog/approaches-to-tenancy-in-postgres), [AWS: multi-tenant PostgreSQL decision matrix](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/matrix.html)
