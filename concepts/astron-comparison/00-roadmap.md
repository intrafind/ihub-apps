# Astron-Agent vs iHub-Apps — Master Roadmap

Synthesis of the six area reports in this folder. Read this first; drill into
the per-area files for evidence, file/line citations, and detailed
implementation outlines.

| # | Area | File |
|---|---|---|
| 01 | Workflow engine | [`01-workflow-engine.md`](./01-workflow-engine.md) |
| 02 | Model abstraction & MaaS | [`02-model-abstraction.md`](./02-model-abstraction.md) |
| 03 | Agent / tools / plugins / RPA | [`03-agent-tools-plugins-rpa.md`](./03-agent-tools-plugins-rpa.md) |
| 04 | Knowledge / RAG / memory | [`04-knowledge-memory-rag.md`](./04-knowledge-memory-rag.md) |
| 05 | Interfaces / console / APIs | [`05-interfaces-console-api.md`](./05-interfaces-console-api.md) |
| 06 | Tenant / collab / observability / eval | [`06-tenant-collab-observability.md`](./06-tenant-collab-observability.md) |

---

## TL;DR

Astron-agent is broader in surface area than iHub-apps, but a meaningful
fraction of that breadth is **integration with iFLYTEK's own cloud** (Spark,
Xinghuo Knowledge Base, AIUI, MaaS gateway) rather than original engineering
we should copy verbatim. The genuinely missing capabilities — and the ones
worth investing in — are concentrated in four areas:

1. **Knowledge / RAG / memory.** iHub has _no_ embeddings, vector store,
   chunking, or persistent conversation memory. This is the largest single
   technical gap.
2. **Workflow ergonomics.** The engine exists and is solid, but lacks a visual
   builder, parallel execution, and the Iteration / Loop / Code / Sub-workflow
   node primitives that make workflows usable for non-developers.
3. **MCP, both directions.** Our "MCP client" is a one-line URL stub
   ([`server/toolLoader.js:203`](../../server/toolLoader.js)); we expose
   nothing over MCP. Astron has full bidirectional MCP.
4. **Enterprise plumbing.** Spaces / workspaces, structured audit log, quotas,
   versioning, and an evaluation harness are all missing.

iHub is **ahead of astron** on five fronts that we should consciously preserve:
multi-adapter LLM layer (8 vs 3), OpenAI-compatible inference proxy, GenAI
OTel semantic conventions, breadth of external shells (browser ext, Electron,
Teams, Nextcloud, Office), and authentication options (5 modes vs Casdoor-only).

---

## 1. iHub's existing strengths (don't reinvent)

Verified across all six reports — these are areas where copying astron would
be a regression.

| Strength | Evidence (file:line) | Astron's posture |
|---|---|---|
| 8 first-class LLM adapters incl. Bedrock + GPT-5 Responses + iAssistant | `server/adapters/index.js:12-21`, see report 02 §2.1 | 3 generic adapters + Spark Java path |
| Cross-provider tool-calling normalization (8 converters) | `server/adapters/toolCalling/` (~3200 LoC), report 02 §2.2 | Implicit at runner level only |
| OpenAI-compatible inference proxy w/ tools + SSE + permissions | `server/routes/openaiProxy.js:1-612`, report 05 §2.3 | None |
| OTel GenAI semantic conventions + cardinality-safe metrics | `server/telemetry/GenAIInstrumentation.js:24`, report 06 §2.3 | OTel present but plain attributes |
| Mature usage tracking (daily/monthly rollups, JSONL, pseudonymisation) | `server/services/UsageAggregator.js`, `UsageEventLog.js`, report 06 §2.4 | Kafka events; no rollup pipeline shown |
| 5 auth modes + own OAuth2 server | `server/routes/{auth.js,oauth.js,wellKnown.js}`, report 06 §2.1 | Casdoor only |
| External shells (browser ext / Electron / Teams / Nextcloud / Office) | `browser-extension/`, `electron/`, `teams/`, `nextcloud-app/`, report 05 §2.6 | Console only |
| Group inheritance w/ circular detection | `server/utils/authorization.js:15`, report 06 §2.1 | Implicit per-space scoping |
| Agent skills lazy-loading via `activate_skill` | `server/toolLoader.js:437-475`, report 03 §2.1 | Not first-class |
| First-party `ask_user` clarification tool w/ rate limits | `server/tools/askUser.js`, report 03 §2.1 | Not first-class |
| Marketplace installer (multi-format incl. Claude Code, Anthropic skills, native) | `server/services/marketplace/RegistryService.js`, `ContentInstaller.js`, report 03 §2.3 | Plugin Square (in-platform only) |
| Per-model concurrency / requestDelayMs throttling | `server/requestThrottler.js:25,37,43`, report 02 §2.7 | None (delegated upstream) |
| Multimodal breadth (audio + docs + image gen) | report 02 §2.5 | Mostly Spark domain mapping |
| Feedback storage (1-5 stars + comments) | `server/feedbackStorage.js`, report 06 §2.2 | Not surfaced |
| Per-execution SSE channel with reconnect for workflows | `server/routes/workflow/workflowRoutes.js:1257-1408`, report 01 §2.5 | SSE via SseEmitter, simpler |
| First-class human-in-the-loop checkpoint node | `executors/HumanNodeExecutor.js`, report 01 §2.3 | Implicit via Q/A node |
| Workflow-as-tool bridge | `server/tools/workflowRunner.js`, report 01 §2.5 | Workflows are first-class; not exposed as tools |

---

## 2. Cross-cutting findings (consolidated across reports)

### 2.1 Same feature mentioned by two reports — single project, not two

| Project | Appears in | Resolution |
|---|---|---|
| **Visual workflow builder** (React Flow) | 01 §4 #12, 05 §4 #1 | One project. Designed in report 05 §5.1; benefits from workflow-engine improvements in report 01. |
| **MCP server endpoint** | 03 §4 #3, 05 §4 #2 | One project. Use report 03 §5.3 outline; expose apps + workflows + tools. |
| **Real MCP client (multi-server)** | 03 §4 #1 — touches workflow's MCP node potential in 01 §3 | One project. Outline in report 03 §5.1. |
| **Sub-workflow / call-flow node** | 01 §4 #7 — also unblocks multi-agent supervisor in 03 §4 #8 | Same primitive serves both. |
| **Persistent state store** | 01 §4 #13 (workflow), 04 §4 #2 (conversations), 06 §4 #4 (audit log) | One persistence-layer decision (sqlite vs postgres) covers all three. |
| **Quotas / per-user rate limits** | 06 §4 #3 — built on `UsageAggregator` from 06 §2.4 | Single project. |
| **Code node (sandboxed)** | 01 §4 #4 — and "out-of-process tool sandbox" in 03 §4 #5 | Same sandbox tech (worker thread / isolated-vm / sidecar) serves both. Decide once. |

### 2.2 Things astron has that we should consciously NOT copy

| Astron feature | Why skip |
|---|---|
| Multi-tenant SQL data service (Xingchen DB) | Not "memory" despite the name — it's a tenant-scoped SQL gateway, niche. Report 04 §1.6. |
| iFLYTEK content-safety audit (`audit_system/`) | Domain-specific moderation, not user-action audit. Report 06 §1.4. |
| iFLYTEK MaaS HTTP gateway as shipped | Proprietary, points at `xingchen-api.xf-yun.com`. The _abstraction_ (control plane delegating to operator) is worth copying; the _implementation_ is not. Report 02 §1.4. |
| Knowledge Graph flag | Astron only exposes a passthrough flag to RAGFlow's KG; minimal product value without RAGFlow. Report 04 §4 #8. |
| Wechat/Feishu publish channels | Not relevant for iHub's market. Report 05 §1.3. |
| Bespoke iFLYTEK SDKs as client integration model | iHub's OpenAI-compatible proxy is strictly better. Report 05 §2.3. |
| `metrology_auth` native SDK (C headers) | Closed-source, iFLYTEK-internal licensing. Build an open Node equivalent instead. Report 06 §1.5. |

### 2.3 Areas where neither platform has anything (greenfield)

These are differentiator opportunities, not parity work.

- **Evaluation / regression harness** — neither has one (report 06 §1.6, §2.6).
- **Long-term user memory** (extracted facts, preferences) — astron's "memory"
  module is a SQL gateway, not this (report 04 §1.6).
- **Conversation summarisation** to extend context budget (report 04 §3 #17).
- **Cohesive content-safety audit** with admin policy (report 06 §1.4).
- **Multi-agent supervisor with first-class agent-as-tool wrapper** — both
  realise it via workflow chaining only (report 03 §1.1, §4 #8).
- **In-product trace viewer** — astron uses Elasticsearch + `WorkflowTraceEsClient`
  but the viewer is theirs; iHub ships no trace UI (report 06 §4 #6).

---

## 3. Master priority matrix

Aggregated from §4 of each area report. Scope: S < M < L < XL. Risk: L / M / H.
"Cumulative" effort is a rough order-of-magnitude in dev-weeks for a single
senior engineer.

### Tier A — Quick wins (S, low risk, ship in weeks not quarters)

| # | Feature | Area | Scope | Risk | Why now |
|---|---|---|---|---|---|
| A1 | Honour `errorHandler: continue` + `customReturn` strategy | 01 §4 #5 | S | L | Schema declares it; engine fails anyway. Quick correctness win. |
| A2 | Fail-branch edge routing (`sourceHandle: "fail"`) | 01 §4 #6 | S | L | Pairs with A1; tiny scheduler change. |
| A3 | LLM-based decision routing (already stubbed) | 01 §4 #9 | S | L | `DecisionNodeExecutor.js:413-429` is a stub. |
| A4 | Connection validation on model save | 02 §5.1 | S | L | Eliminates "wrong URL" footgun. |
| A5 | Workflow/app integrity cleanup on model removal | 02 §5.3 | S | L | Sweep apps/workflows for dangling `preferredModel`. |
| A6 | SSRF guard for admin-supplied URLs | 02 §4 #6 | S | L | Security hardening. |
| A7 | Cost (price/currency) metrics in `executionMetrics` | 01 §4 #15 | S | L | Pair with existing model-pricing config. |
| A8 | OCR-as-tool — expose existing `toolsService/ocrRoutes.js` to agents | 03 §4 #10 | S | L | Reuses code already shipped. |
| A9 | Tool usage analytics surfacing ("heat") | 03 §4 #11 | S | L | `usageTracker.js` already counts; just expose. |
| A10 | Generated client SDKs (Python / TS / Java) from Swagger | 05 §4 #8 | S | L | `openapi-generator-cli` over existing specs. |
| A11 | Per-provider declarative capability matrix | 02 §4 #8 | S | L | Centralizes scattered adapter capability flags. |

**Tier A cumulative:** ~6-8 dev-weeks for the lot.

### Tier B — Mid bets (M, low-medium risk, 2-6 weeks each)

| # | Feature | Area | Scope | Risk | Dependencies |
|---|---|---|---|---|---|
| B1 | **Real MCP client** (multi-server, SSE+stdio+ws, schema-validated, encrypted creds) | 03 §5.1 | M | L | none |
| B2 | **Generic OpenAPI HTTP tool runner** | 03 §5.2 | M | L | none |
| B3 | **MCP server endpoint** (expose apps/workflows/tools) | 03 §5.3, 05 §5.2 | M | L-M | B1 (shared transport code) |
| B4 | **Parallel execution in `WorkflowEngine`** | 01 §5.1 | M | M | none — unblocks B5 |
| B5 | **Iteration node** (subgraph per list item) | 01 §5.2 | L | M | B4 |
| B6 | **Loop node** with declarative termination conditions | 01 §5.3 | M | L | none |
| B7 | **Sub-workflow / call-flow node** | 01 §4 #7 | M | M | none |
| B8 | **Structured user-action audit log** | 06 §4 #4 | M | L | none |
| B9 | **Webhook framework (in + out, HMAC-signed)** | 05 §5.3 | M | L-M | none |
| B10 | **Quotas / credits / per-user rate limits** | 06 §5.3 | M | M | builds on `UsageAggregator`; nicer scoped per-space (G2) |
| B11 | **First-class knowledge/RAG node** in workflow | 01 §4 #8 | M | L | C1 (vector RAG) ideal but not strictly required |
| B12 | **Persistent conversation memory** (SQLite/Postgres-backed) | 04 §5.2 | L | L-M | C1 nice-to-have for semantic recall |
| B13 | **Model categorization / "shelf" + admin marketplace polish** | 02 §4 #2 | M | L | none |
| B14 | **iFLYTEK Spark adapter** (`spark.js`, OpenAI-compatible HTTP) | 02 §4 #5 | M | M | only if Spark/CN-market relevant |
| B15 | **Code node** (sandboxed JS first, Python via sidecar later) | 01 §4 #4 | L | H | sandbox decision (§4) |
| B16 | **Browser-automation tool** (Playwright DSL: click/type/screenshot/extract) | 03 §4 #4 | M | M | none — Playwright already a dep |
| B17 | **Reranker + hybrid (BM25 + vector) retrieval** | 04 §4 #4 | M | L | C1 |
| B18 | **In-product trace viewer** (proxy OTLP collector or ship Tempo/CH) | 06 §4 #6 | M | M | storage decision |
| B19 | **App-scoped Bot API keys** (per-app keyed REST endpoint) | 05 §4 #5 | M | L | existing OAuth client store |
| B20 | **End-user marketplace browse UI** (atop existing admin marketplace) | 03 §4 #6, 05 §4 #6 | S-M | L | none |
| B21 | **DB-backed workflow state for horizontal scaling** | 01 §4 #13 | L | M | persistence decision (§4) |
| B22 | **Token-level streaming from agent nodes to client** | 01 §4 #14 | M | L | none |

**Tier B cumulative:** ~30-40 dev-weeks, parallelisable.

### Tier C — Strategic bets (L–XL, high reward, quarter-scale)

| # | Feature | Area | Scope | Risk | Dependencies |
|---|---|---|---|---|---|
| C1 | **In-process vector RAG** (chunk → embed → retrieve) | 04 §5.1 | XL | M | A11 helpful |
| C2 | **Visual workflow builder** (React Flow) | 01 §4 #12, 05 §5.1 | L–XL | M | DSL stability — pin schema before starting |
| C3 | **Long-term user memory + summarisation** | 04 §5.3 | L | M | C1, B12 |
| C4 | **Eval / regression harness for apps & workflows** | 06 §5.2 | L | M | none; opt-in cost guard |
| C5 | **App / workflow versioning + share-with-user/group** | 06 §4 #5 | L | M | C6 (sharing scope) |
| C6 | **Spaces / workspaces / per-space membership** | 06 §5.1 | XL | H | foundational; design carefully |
| C7 | **MaaS deployment lifecycle (pluggable inference operator)** | 02 §5.2 | XL | H | product decision (§4) |

### Won't-do (for v1)

| Feature | Why not |
|---|---|
| Desktop RPA suite à la astron-rpa | XL effort, OS-level automation, niche audience for iHub. Defer or partner. |
| Knowledge Graph | Only valuable atop external RAGFlow; revisit if customer demand emerges. |
| Multi-tenant SQL data service (Xingchen DB clone) | iFinder / Jira / Office already cover structured data via tools. |
| WeChat / Feishu publish channels | Not in target audience. |
| Multi-agent supervisor as separate class | Workflow + sub-workflow node (B7) gives 80% of value at 20% of cost. |

---

## 4. Decision points that gate the work

Each decision below unblocks one or more Tier-B/C items. **Resolve before
starting** the dependent project, not during.

| ID | Decision | Affects | Default recommendation |
|---|---|---|---|
| D1 | **Persistence substrate** — keep `contents/*.json` only, add SQLite, or add Postgres | B8, B12, B21, C1, C3, C5, C6 | Start SQLite-by-default, `pgvector`/Postgres opt-in via `platform.json` |
| D2 | **Sandbox tech** for Code node and out-of-process tool execution | B15, B16, future plugins | Try `isolated-vm` first (sync, mature); fall back to worker_threads for portability; sidecar Python via subprocess for D3 follow-up |
| D3 | **Vector store backend** | C1 | `sqlite-vss` default (file per KB), `pgvector` opt-in for scale, `lancedb` follow-up |
| D4 | **Embedding model strategy** | C1 | Pluggable: provider adapter (OpenAI/Bedrock/Cohere) + bundled `@xenova/transformers BGE-small` for air-gapped |
| D5 | **MaaS scope** — own data plane, thin proxy to KServe/Ollama/vLLM-operator, or skip | C7 | Thin proxy (control plane only); document operator compliance |
| D6 | **Spaces scope** — per-space resource catalogs, or one global catalog + per-space ACL | C5, C6 | Per-space catalogs; gate behind `features.spaces` flag, default off |
| D7 | **MCP auth model for our server** | B3 | API keys v1 (per-key tool ACL via existing groups); OAuth 2.1 v2 |
| D8 | **Workflow versioning persistence** | C5 | Sidecar `versions/<workflow-id>/<semver>.json` with `current.json` pointer; promote later to DB |
| D9 | **In-product trace viewer storage** | B18 | Proxy configured OTLP collector via API v1; ClickHouse-backed embedded reader v2 |
| D10 | **Spark / Chinese-market priority** | B14 | Skip unless explicit customer demand; HTTP-only adapter is M effort |

---

## 5. Suggested phased sequence

This is one valid ordering; reshuffle to taste. Numbers reference the IDs
above. "Track" lets two engineers work in parallel without stepping on each
other.

### Phase 1 — "Make it correct" (≈ 6–10 weeks)

Goal: close advertised-but-broken features; raise security floor; ship MCP
properly.

- **Track 1 (correctness):** A1, A2, A3, A4, A5, A6, A7
- **Track 2 (MCP + tools):** B1 → B2 → B3 → B20
- **Track 3 (ops):** A8, A9, A10, A11, B8 (audit log)

Outcomes: real MCP client + server, generic OpenAPI tools, end-user
marketplace browse, model save validation, integrity sweeps, audit trail.

### Phase 2 — "Make it powerful" (≈ 8–12 weeks)

Goal: workflow ergonomics + persistent memory.

- **Track 1 (workflow):** B4 → B5 → B6 → B7 → B22
- **Track 2 (model + interfaces):** B9 (webhooks), B13 (model marketplace), B19 (bot API keys), optionally B14 (Spark)
- **Track 3 (persistence):** D1 decision → B12 (persistent conversations) → B21 (DB-backed workflow state). Same store unblocks Phase 3.

Outcomes: parallel workflow execution, Iteration/Loop/Sub-workflow nodes,
webhooks, persistent conversations, optional Spark.

### Phase 3 — "Make it smart" (≈ 10–14 weeks)

Goal: knowledge layer.

- **Track 1 (RAG):** D3+D4 decisions → C1 (vector RAG) → B11 (RAG node in workflow) → B17 (rerank + hybrid)
- **Track 2 (visual builder):** D8 schema freeze → C2 (visual workflow builder) → B18 (trace viewer)
- **Track 3 (control):** B10 (quotas), B15 (Code node — D2 decision)

Outcomes: real RAG with citation; visual workflow editor; quota
enforcement; sandboxed Code node.

### Phase 4 — "Make it enterprise" (≈ 12–20 weeks)

Goal: multi-tenancy, evaluation, lifecycle.

- **Track 1 (eval):** C4 (eval harness — can start earlier, cheap to prototype)
- **Track 2 (memory):** C3 (long-term user memory + summarisation)
- **Track 3 (tenant):** D6 decision → C6 (spaces) → C5 (versioning + sharing)
- **Track 4 (model lifecycle):** D5 decision → C7 (MaaS lifecycle, only if D5 = "yes")

Outcomes: per-space catalogs and quotas, app/workflow versioning,
evaluation harness, ChatGPT-style long-term memory.

---

## 6. Risk register (top 5)

| Risk | Mitigation |
|---|---|
| **Visual builder (C2) creates a schema fork** between admin-edited JSON and the engine's expected shape | Freeze workflow DSL before C2 starts (D8); preserve presentation metadata under `viewport`; keep Monaco "raw JSON" fallback tab. |
| **Spaces (C6) becomes a breaking-change retrofit** across every loader and route | Default-space alias; feature flag `features.spaces`; ship with all-or-nothing migration. Pair with CLAUDE.md migration system (`server/migrations/`). |
| **Vector RAG (C1) leaks proprietary docs** if multi-tenancy lands before isolation rules | Tie KB ACL to groups initially (matches today's model); revisit when C6 lands. |
| **MaaS lifecycle (C7) implies an inference operator we don't own** | Stay control-plane only; document KServe/Ollama compatibility; never bundle an operator. |
| **MCP server (B3) exposes more tools than intended** | Per-API-key tool allowlist; reuse `enhanceUserWithPermissions` for ACL; default-deny new tools until enabled. |

---

## 7. Effort + value snapshot

Rough one-line summary for each Tier-B/C item. Use for prioritisation
conversations.

```
A1  errorHandler:continue/customReturn  S/L  HIGH  schema already lies; fix
A2  fail-branch edge routing            S/L  MED   pairs with A1
A3  LLM decision routing                S/L  MED   stubbed; finish it
A4  model save: connection validation   S/L  HIGH  eliminates wrong-URL footguns
A5  model removal integrity sweep       S/L  HIGH  prevents dangling refs
A6  SSRF guard on admin URLs            S/L  HIGH  security floor
A7  cost in executionMetrics            S/L  MED   token→cost mapping exists
A8  OCR-as-tool                         S/L  MED   reuses shipped route
A9  tool heat / favourites              S/L  LOW   discoverability
A10 generated SDKs                      S/L  MED   one-shot generator job
A11 capability matrix                   S/L  MED   unblocks B14 + caching

B1  real MCP client                     M/L  HIGH  closes #1 platform fib
B2  OpenAPI HTTP tool runner            M/L  HIGH  zero-code integrations
B3  MCP server endpoint                 M/L-M HIGH MCP gateway story
B4  parallel workflow execution         M/M  HIGH  unblocks B5
B5  Iteration node                      L/M  HIGH  big UX win
B6  Loop node w/ termination            M/L  HIGH  declarative loops
B7  Sub-workflow node                   M/M  MED   composition + multi-agent stand-in
B8  user-action audit log               M/L  HIGH  compliance floor
B9  webhook framework (in+out)          M/L-M MED  enterprise integration
B10 quotas / credits / per-user RL      M/M  HIGH  cost control
B11 first-class RAG node                M/L  MED   when C1 lands
B12 persistent conversations            L/L-M HIGH multi-replica safe
B13 model marketplace polish            M/L  LOW   nice-to-have
B14 Spark adapter                       M/M  LOW   only if CN demand
B15 Code node (sandboxed JS)            L/H  MED   power-user feature
B16 Playwright DSL tool                 M/M  MED   beyond screenshots
B17 rerank + hybrid retrieval           M/L  HIGH  big quality lever atop C1
B18 in-product trace viewer             M/M  MED   support productivity
B19 app-scoped Bot API keys             M/L  MED   external integrations
B20 marketplace browse UI               S-M/L MED  end-user discoverability
B21 DB-backed workflow state            L/M  MED   horizontal scale
B22 token-level streaming               M/L  MED   perceived latency

C1  in-process vector RAG               XL/M  CRIT  headline parity feature
C2  visual workflow builder             L-XL/M HIGH adoption blocker today
C3  long-term user memory               L/M   MED  differentiator
C4  eval / regression harness           L/M   HIGH differentiator (neither has)
C5  app/workflow versioning + share     L/M   MED  enterprise asks
C6  spaces / workspaces                 XL/H  HIGH every enterprise deal eventually
C7  MaaS lifecycle                      XL/H  LOW  product-strategy call (D5)
```

---

## 8. Open questions (rolled up from area reports)

Listed by area for traceability; resolution unblocks the corresponding Tier
item.

- **01 §6:** workflow persistence model (D1), Code-node sandbox (D2),
  JSON-files vs DB workflows (D1), streaming protocol for token-level
  output (B22 design), sub-workflow permission inheritance.
- **02 §6:** MaaS scope decision (D5), Spark demand (D10), in-transit
  encryption of admin-submitted API keys (Astron's RSA flow vs current
  TLS+AES-at-rest), where to mount MaaS UI in admin.
- **03 §6:** astron's exact agent-loop semantics (CoT-only vs ReAct), Plugin
  Square packaging format, SkillHub package spec compatibility with
  Anthropic Skills, RPA host requirements (Electron client vs headless),
  out-of-process sandbox technology (D2), MCP auth standard (D7).
- **04 §6:** vector backend (D3), embedding model licensing (D4), KB
  multi-tenancy scope (depends on D6), iAssistant vs internal RAG strategy,
  reranker bundling in `build:binary`, memory-extraction cost guardrails,
  citation enforcement approach.
- **05 §6:** astron MCP server channel scope, gRPC publicness, webhook
  framework completeness, plugin store openness, embed widget existence,
  marketplace registry topology, Bot API auth (OAuth client vs new API
  keys — B19/D7), visual builder schema strategy (D8), MCP-server token model (D7).
- **06 §6:** astron tenant member storage (informational only), quota
  schema (D5 adjacent), product decision on per-space catalogs vs global +
  ACL (D6), persistence direction (D1), workflow versioning scheme (D8),
  audit retention requirements, eval CI integration, in-product trace
  storage (D9).

---

## 9. What to do with this

1. **Treat each per-area report as a working PRD.** Each §4 is a ranked
   backlog; each §5 is an implementation outline detailed enough to start.
2. **Resolve D1–D10 first.** Many Tier-B/C items branch on these decisions.
3. **Don't sequence by area report — sequence by phase.** Phases 1–4 in §5
   intentionally interleave area reports because real value lands in
   cross-area combinations (e.g. MCP server + tool runner + marketplace
   browse, or RAG + RAG node in workflow + visual builder).
4. **Convert tracked items to concept docs.** Each Tier-B/C item should
   graduate into its own `concepts/YYYY-MM-DD …` file when it's about to be
   built, citing the area report.

---

_Word count: ~2300. Cross-references are intentional; the area reports
remain the authoritative evidence._
