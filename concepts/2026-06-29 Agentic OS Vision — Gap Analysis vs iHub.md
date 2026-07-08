# Agentic OS Vision — Gap Analysis vs iHub

**Date:** 2026-06-29
**Purpose:** Review the "maximally capable, self-improving agentic operating system" meta‑prompt, decompose what it actually asks for, and map every requirement against what iHub Apps already has — so we can see clearly *what we're missing*.
**Method:** Six parallel code‑mapping passes over `server/` and `client/` (orchestration, tools/adapters, memory/persistence, governance, observability/evals, UI), cross‑checked against iHub's own concept docs (`concepts/agent-factory/`, `concepts/workflow-system/`, `concepts/agent-protocols/`, marketplace/skill PRDs) and `docs/agents.md` (Agent Factory V1).

---

## TL;DR

**iHub is not a chat app being measured against an agent OS. It already implements a large fraction of the prompt's recommended architecture.** The prompt's *first and highest‑priority milestone* — prove the full closed loop `goal → task graph → execution → verification → memory update → visibility` — **already runs in iHub today** via the **Agent Factory V1 + Workflow Engine**.

What iHub matches almost exactly is the prompt's **"NON‑NEGOTIABLE DESIGN BETS"** default architecture:

> one strong generalist execution agent · one explicit task graph + workflow layer · one verifier/reviewer layer · one durable memory + artifact layer · one control plane for humans

iHub has all five. The gaps are **not** in the core loop. They cluster in the prompt's *higher‑order layers*:

| Tier | Missing capability cluster | Severity |
|---|---|---|
| **P0** | **Evaluation + self‑improvement engine** (the "core of self‑improvement; without it the system is theater") | Largest gap — essentially absent |
| **P0** | **Economics**: cost‑aware model routing, token budgets with auto‑pause, spend caps | Absent (tracking exists, enforcement doesn't) |
| **P1** | **Trust/autonomy model**: autonomy levels, per‑skill/domain trust, risk‑tiered approval, approval *queue* | Absent / partial |
| **P1** | **Reliability hardening**: idempotency keys, compensating actions/sagas, dead‑letter/quarantine, source reconciliation | Absent |
| **P1** | **Semantic memory + provenance**: vector/knowledge index, lineage, freshness, tripartite memory split | Absent (deferred in iHub's own roadmap) |
| **P2** | **Proactive/momentum loops**: now/next/blocked/improve/recurring queues, stale‑work scanning, external‑intelligence loop | Absent |
| **P2** | **Interface doctrine**: universal ask bar, fractal altitude (task→project→company→portfolio), incident/eval/cost views | Partial |
| **By design** | Computer‑use breadth (shell/desktop/DB), multi‑machine workers, persistent chat history, multi‑tenant/portfolio | Intentional scoping, not bugs |

---

## 1. What the prompt actually asks for

Stripped of its length, the prompt specifies one system defined by:

1. **A closed loop**: goal → tasks → routed execution → verification → memory → visibility → learning.
2. **An architecture** (Layers A–L): control plane (A), execution fabric/workers (B), task‑graph engine (C), skill/profile system (D), layered memory (E), tool adapters (F), model routing + economics (G), governance/policy/trust (H), eval + learning engine (I), self‑improvement engine (J), observability + incidents (K), context management (L).
3. **Reliability engineering** ("march of nines"): deterministic rails, state machines, idempotency, compensating actions/sagas, durable waits, checkpointing, dead‑letter queues, trajectory tracing.
4. **A specialized‑harness library** (general, coding, browser‑research, document/contract, finance, customer/ops, incident, science, company‑ops).
5. **A momentum engine**: live `now / next / blocked / improve / recurring` queues; never finish empty‑handed; convert every success into a reusable asset and every repeat failure into a guardrail.
6. **A capability‑acquisition ladder**: solve once → repeatable → skill → workflow → specialized harness → eval coverage → automation → monitoring → trust‑based autonomy → package the gain.
7. **An interface doctrine**: universal ask bar, intent (not agent) selection, fractal altitude from micro‑task to portfolio, approval UX, live trace, event feed.
8. **File‑first project state**: any compatible agent can resume a project from its folder alone (`plan.md`, `tasks.md`, `knowledge.md`, `decisions.md`, `handoff.md`, `artifacts/`).
9. **Strong defaults**: single‑agent baseline first; hub‑and‑worker; SQLite control plane; pull‑based task claiming; worktree isolation; per‑skill trust; one‑change eval loops.

---

## 2. The closed loop — iHub already runs it

The prompt's #1 instruction is "prove the full loop before breadth." iHub's **Agent Factory V1** does exactly this end‑to‑end:

| Loop stage | iHub mechanism | Evidence |
|---|---|---|
| **Goal intake** | Inbox (markdown work queue), cron/webhook/manual triggers | `server/agents/inbox/inboxStore.js`; `server/services/workflow/triggers/` |
| **Decompose → task graph** | `PlannerNodeExecutor` (LLM decomposition) → `_taskQueue` + materialized sub‑DAG | `executors/PlannerNodeExecutor.js` (1229 LOC); `SubWorkflowMaterializer.js` |
| **Route + execute** | `WorkflowEngine` + `DAGScheduler` (Kahn, AND/OR deps, fan‑out/in), 24 node executors, multi‑step tool loop | `WorkflowEngine.js` (1595 LOC); `DAGScheduler.js`; `services/chat/ToolExecutor.js` |
| **Verify** | `VerifierNodeExecutor` (score/threshold/retry), `QuoteValidatorNodeExecutor` (citation grounding) | `executors/VerifierNodeExecutor.js`; `executors/QuoteValidatorNodeExecutor.js` |
| **Memory update** | `memory‑compose` (LLM distills what to keep) → `memory‑finalize` (deterministic write) | `docs/agents.md`; `server/agents/memory/memoryFile.js`; `MemoryFinalizeNodeExecutor.js` |
| **Visibility** | Live SSE trace viewer, run‑detail page, agent event stream, artifact viewer | `client/.../WorkflowExecutionPage.jsx`, `AgentRunDetailPage.jsx`; `actionTracker.js` |
| **Human‑in‑the‑loop** | `human` nodes pause/resume with deadline extension; approvals page | `executors/HumanNodeExecutor.js`; `AdminAgentApprovalsPage.jsx` |
| **Learning** | ⚠️ **weakest link** — memory captures facts, but no eval‑driven improvement | *(see §4, P0)* |

**Conclusion:** iHub is well past the prompt's "first milestone." For its domain (knowledge work, document/research workflows, app orchestration) the loop is real, durable, and observable. The learning *step* is the one place the loop is open.

---

## 3. Full capability matrix (prompt → iHub)

Legend: **✅ Have** (robust) · **🟡 Partial** (exists but basic / not wired through) · **❌ Missing** · **➖ Out of scope by design**

### Architecture layers

| Prompt layer | Status | Notes / evidence |
|---|---|---|
| **A. Control plane** | ✅ | Comprehensive admin (7 sections, 30+ pages): apps, models, providers, tools, skills, sources, workflows, agents, users/groups, OAuth, MCP, integrations, usage, audit, telemetry, features. `client/src/features/admin/` |
| **B. Execution fabric (pull‑based workers, hub‑and‑worker, multi‑machine)** | ❌ | **Single‑process, in‑process** execution. No job queue, no worker daemons, no pull‑based claiming, no multi‑machine. Branch‑level parallelism only (`ParallelNodeExecutor`, `Promise.allSettled`). |
| **C. Task‑graph engine** | ✅ | Robust DAG: deps, fan‑out/in, conditional edges, sub‑workflows w/ depth cap (3) + plan budget. `DAGScheduler.js`, `WorkflowEngine.js` |
| **D. Skill / profile system** | ✅ | `AgentProfile` JSON = loadable behavior packs; skills + activation tools; Skill Store + Marketplace PRDs in flight. `server/validators/agentProfileSchema.js`, `server/services/skillLoader.js` |
| **E. Memory (layered)** | 🟡 | hot/warm/cold/episodic/procedural/preference = ✅ (file‑first md/json/jsonl). **Semantic/vector index = ❌.** Tripartite split + provenance/freshness/consolidation = ❌ (iHub's own V1.5 deferral). |
| **F. Tool adapters** | 🟡 | Strong: MCP client (4 transports, 3 auth), OpenAPI tool‑gen, apps‑as‑tools, web search/browser screenshot/content‑extract/JIRA/Entra/iFinder/deep‑research, agent tools (memory/inbox/task/artifact). Missing computer‑use surfaces (see ➖ below). `server/toolLoader.js`, `server/services/mcp/` |
| **G. Model routing + economics** | 🟡 | 8 providers w/ normalized tool‑calling = ✅. **Cost‑aware routing (cheap↔strong per task) = ❌.** Token tracking = ✅; **budget enforcement / auto‑pause = ❌.** `server/adapters/`, `services/UsageEventLog.js` |
| **H. Governance / policy / trust** | 🟡 | RBAC + group inheritance + agent service‑accounts + audit + secret encryption = ✅. **Autonomy levels, per‑skill trust, risk tiers, approval *queue/routing*, `requireApprovalFor` = ❌.** `utils/authorization.js`, `services/AuditLogService.js`, `TokenStorageService.js` |
| **I. Evaluation + learning engine** | ❌ | **The biggest gap.** Runtime verifier ≠ eval suite. No offline harness, datasets, pass@1/regression/adversarial/long‑horizon evals, or production‑derived evals. |
| **J. Self‑improvement engine** | ❌ | No inline learning, no background one‑change eval loop, no failure→test conversion, no prompt/skill optimization. |
| **K. Observability + incidents** | 🟡 | OTel GenAI spans + `actionTracker` + audit + usage dashboards = ✅ operational visibility. **Full trajectory tracing (parent‑child spans across a run) = partial. Incident objects (severity/timeline/postmortem) = ❌.** `server/telemetry/`, `actionTracker.js` |
| **L. Context management** | ✅ | `ContextSummarizer`, file‑based state writes, checkpoint/resume, replay on SSE reconnect. `services/workflow/ContextSummarizer.js`, `StateManager.js` |

### Reliability engineering ("march of nines")

| Requirement | Status | Notes |
|---|---|---|
| Retries / timeouts (node + workflow) | ✅ | `WorkflowEngine.js` retry loop + bounded timeouts |
| Durable execution + checkpoint/resume | ✅ | `StateManager.js` (atomic, 50MB cap), `orphanSweeper.js` recovery |
| Durable waits (pause for approval/input) | ✅ | `HumanNodeExecutor` pause/resume w/ deadline extension |
| State machines / fixed vs dynamic plans | ✅ | `simple`/`drain`/`planner+drain`/`planner+review‑loop` shapes |
| **Idempotency keys (request‑level)** | ❌ | Only corpus‑search repeat‑guard + atomic config writes |
| **Compensating actions / sagas** | ❌ | No rollback path for multi‑system external mutations |
| **Dead‑letter / quarantine queue** | ❌ | Failed runs persist as `failed`; no requeue/quarantine |
| **Source reconciliation before mutation** | ❌ | No "ledger/CRM outranks model summary" policy |

### Momentum + proactive + external intelligence

| Requirement | Status | Notes |
|---|---|---|
| `recurring` queue | 🟡 | Cron/webhook triggers exist; not framed as a queue |
| Dynamic task queue | ✅ | `_taskQueue` + drain loop + `create_task`/`list_tasks`/`mark_task_done` |
| **`now`/`next`/`blocked`/`improve` queues** | ❌ | No explicit momentum queues |
| **Proactive scanning** (stale/blocked work, KPI drift, dirty repos → goals) | ❌ | No active‑learning loop |
| **External‑intelligence loop** (watch ecosystem/releases/benchmarks → improvement work) | ❌ | Only marketplace registry + local‑model discovery |
| **Failure → test/guardrail ratchet** | ❌ | Feedback + failures logged, never converted |

### Specialized harness library

| Harness | Status | Notes |
|---|---|---|
| General dynamic work | ✅ | Workflow engine + planner/review‑loop |
| Document / contract / research | 🟡 | Research + completeness‑analysis workflows, quote validation, structured records exist; not formalized as named harnesses w/ per‑harness schemas+evals |
| Coding/delivery · browser‑QA · finance · customer‑ops · incident · science · company‑ops | ❌ | Not present as specialized harnesses |

### Interface doctrine

| Surface | Status | Notes |
|---|---|---|
| Core chat (streaming, files, variables, compare) | ✅ | `AppChat.jsx` |
| Live session/trace viewer | ✅ | SSE, step detail, artifacts, checkpoints |
| Approval UX | ✅ | HITL checkpoint components |
| Admin control plane | ✅ | 7 sections, 30+ pages |
| Usage dashboard | ✅ (🟡 cost) | Usage robust; **no per‑request/model cost attribution** |
| Workflow/agent builder | ✅ | Canvas editor + profile editor + memory tools |
| **Universal ask bar / intent routing** | ❌ | Must pick an app first; no "ask anything" router |
| **Fractal altitude** (task→goal→project→company→portfolio) | ❌ | Flat, single‑tenant; no project/company/portfolio entities |
| **Task/goal board** | ❌ | Inboxes are checklists, not a board |
| **Incident view · learning/eval view · machine view** | ❌ | None |
| Activity/event feed | 🟡 | Audit log only; no live cross‑run feed |

### File‑first project operating system

| Requirement | Status | Notes |
|---|---|---|
| Durable, git‑friendly canonical state | ✅ | Everything in `contents/` (no DB) |
| Per‑agent memory.md, inbox.md, artifacts/, run state | ✅ | `contents/agents/...`, `contents/data/...` |
| **Canonical `plan.md`/`tasks.md`/`knowledge.md`/`decisions.md`/`handoff.md`** | ❌ | Plan lives in run state (machine JSON), not curated files |
| **"Any agent resumes from the folder alone"** | 🟡 | State is durable but server‑mediated + machine‑format; no human‑legible project pack; **no `project` entity at all** |

### Multi‑agent coordination

| Requirement | Status | Notes |
|---|---|---|
| Planner → executor; sub‑workflows | ✅ | `PlannerNode` + `executeSubWorkflow` (depth‑capped) |
| Generator vs **separate** adversarial reviewer | 🟡 | Review‑loop reviewer exists but in‑workflow, not an independent agent |
| **Sub‑agent delegation / multi‑agent handoffs** | ❌ | Explicitly deferred in `docs/agents.md` "Out of scope for V1" |
| Coordinator + specialists; multi‑machine same‑project | ❌ | Not present |

### Out of scope **by design** (not defects)

These are deliberate iHub scoping choices; the prompt is runtime‑agnostic and explicitly allows "narrow the milestone honestly":

- **Computer‑use surfaces** — no shell, git, DB query, desktop automation, spreadsheet, email/calendar *write*, OCR. iHub is a server‑side platform with SSRF guards, not an RPA/computer‑use agent. (Bridgeable via MCP/OpenAPI tools.) `server/services/mcp/safeFetch.js`
- **Persistent chat history** — chat is stateless by design; only SSE connection state is in memory (workflow/agent runs *are* durable).
- **Multi‑tenant / portfolio** — single‑tenant; no company/portfolio scope.

---

## 4. What we're missing — prioritized

### P0 — The system can't *improve itself* yet
This is the prompt's central thesis ("most gains come from better loops, not bigger prompts"; "without [eval] the system is theater"). iHub has every loop stage **except** learning.

1. **Offline eval harness** — datasets + scenario tests scoring *output quality* (pass@1, repeat stability, regression, adversarial/safety, long‑horizon), separate from the existing code unit tests. Feed it from the verifier signals and the already‑captured `feedback.jsonl`.
2. **Production‑derived eval pipeline** — aggregate `feedbackStorage` + `VerifierNode` scores; alert on drift; auto‑mint eval cases from low‑rated / failed runs.
3. **One‑change self‑improvement loop** — propose one bounded change (prompt/skill/workflow), run the eval slice, keep‑if‑better/revert‑if‑worse, log the delta. Treat prompts/profiles/workflows as versioned artifacts behind evals.
4. **Failure → guardrail ratchet** — second occurrence of a failure class creates a test/policy, not another blind retry.

### P0 — Economics is tracked but not enforced
5. **Token/cost budgets with auto‑pause** at task/goal/profile/user/month layers (today only agent *wall‑time* is enforced as a timeout).
6. **Cost‑aware model routing** — cheap models for draft/classify/summarize, strong models for plan/verify/critical reasoning, per profile/node. (Cost fields exist on models but are telemetry‑only.)
7. **Per‑request/model/app cost attribution** in the usage dashboard.

### P1 — Trust, approvals, reliability
8. **Autonomy levels** (supervised/guided/autonomous/trusted) + **per‑skill/domain trust** earned from outcomes — not one global switch.
9. **Risk‑tiered approval** + a real **approval queue with approver‑group enforcement** (today the human node pauses but doesn't verify the resumer's group; `requireApprovalFor` sensitive calls is deferred).
10. **Idempotent effect layer + compensating actions/sagas + dead‑letter/quarantine** — required before agents are trusted to mutate external systems (JIRA, cloud storage, email) at scale.
11. **Semantic memory + provenance** — vector/knowledge index for recall; lineage/confidence/freshness on facts; the deferred tripartite (semantic/episodic/procedural) split + consolidation node.

### P2 — Momentum, proactivity, interface, breadth
12. **Momentum queues** (`now/next/blocked/improve/recurring`) + **proactive scanning** that turns stale/blocked work and KPI drift into goals.
13. **External‑intelligence loop** — scheduled watch of releases/benchmarks/advisories → ranked improvement candidates → bounded experiments.
14. **Incident management** — incident objects (severity/timeline/root‑cause/postmortem); promote `orphanSweeper` failures + retry storms + cost spikes into incidents.
15. **Full trajectory tracing** — parent‑child spans across an entire run (plan→tool→retry→verify→approval) with a correlation id, not just per‑LLM‑call spans.
16. **Interface doctrine** — universal ask/intent bar; fractal altitude; task board; incident/eval/cost views; live activity feed.
17. **Specialized harness library** — graduate the recurring high‑value workflows (research, document/contract, completeness‑analysis) into named harnesses with per‑harness schemas + evals; add coding, browser‑QA, finance, incident, science harnesses as demand appears.
18. **Canonical file‑first project pack** + a `project` entity — materialize `plan.md`/`tasks.md`/`knowledge.md`/`decisions.md`/`handoff.md` so a run is resumable/inspectable from the folder.

### Deliberate divergences to confirm (not auto‑close)
- Computer‑use breadth (shell/desktop/DB) — keep bridging via MCP/OpenAPI, or add a sandboxed exec surface only if a use case demands it.
- Multi‑machine / pull‑based workers — only when single‑process throughput becomes a real constraint.
- Multi‑tenant/portfolio — only if iHub targets "operate many orgs."
- Persistent chat history — only if interactive long‑running conversations become a goal.

---

## 5. Where iHub sits on the prompt's own ladders

**Capability‑acquisition ladder** (1 solve‑once → 10 package‑the‑gain): iHub reliably reaches **step 5** (specialized‑ish workflows/harnesses) but stalls at **step 6 (eval coverage)** and beyond (automation w/ contracts, monitoring, trust‑based autonomy).

**Build order** (1–15): steps **1–10 effectively done** (runtime, task graph, worker loop, verification, memory, profiles, logging/visibility, basic budgets/approvals). **Missing: 11 eval harness, 12 self‑improvement loop, 13 proactive monitoring + recurring momentum, 14 breadth (browser/desktop/business/science harnesses), 15 multi‑machine.**

**Net:** iHub built the hard, durable, observable core the prompt insists on *first*. The remaining work is the prompt's *compounding* layer — eval‑driven self‑improvement, economics, trust, reliability hardening, and proactivity — plus interface and breadth.

---

## 6. Recommended next move

The single highest‑leverage gap is **P0 #1–4 (eval + one‑change self‑improvement loop)** because (a) it's the prompt's explicit prerequisite for *any* claim of improvement, (b) iHub already emits the raw signals (verifier scores, `feedback.jsonl`, usage events) so it's mostly wiring, and (c) it closes the one open arc in a loop that is otherwise complete. **Economics enforcement (P0 #5–7)** is a close second and is also mostly wiring on top of existing tracking.

A concrete first slice: an `evals/` harness that replays a small golden set through real workflows, scores with the existing `VerifierNode`, persists pass@1 + cost + latency per run, and surfaces a trend in a new admin "Learning/Eval" view — then a background job that A/B's one prompt/profile change against that slice.

---

## Appendix — key evidence files

- **Orchestration:** `server/services/workflow/{WorkflowEngine,DAGScheduler,StateManager,ExecutionRegistry,SubWorkflowMaterializer,ContextSummarizer,orphanSweeper}.js`, `executors/*` (24), `triggers/*`
- **Agent runtime:** `server/agents/{inbox,memory,profile,runtime}/*`, `docs/agents.md`, `concepts/agent-factory/*`
- **Tools/adapters:** `server/toolLoader.js`, `server/adapters/` (+ `toolCalling/`), `server/services/mcp/*`, `server/services/tools/OpenApiToolRunner.js`, `server/tools/*`
- **Memory/state:** `server/agents/memory/memoryFile.js`, `inbox/inboxStore.js`, `runtime/artifactStore.js`, `server/services/structuredRecord/*`, `configCache.js` (no DB; all `contents/`)
- **Governance:** `server/utils/authorization.js`, `services/{AuditLogService,ChangeHistoryService,TokenStorageService,CredentialService,UsageEventLog,UsageAggregator}.js`, `requestThrottler.js`
- **Observability:** `server/telemetry/*`, `telemetry.js`, `actionTracker.js`, `feedbackStorage.js`, `executors/{VerifierNodeExecutor,QuoteValidatorNodeExecutor}.js`
- **UI:** `client/src/features/admin/*` (overview, agents, approvals, usage, audit, telemetry, workflows), `features/workflows/pages/WorkflowExecutionPage.jsx`, `features/apps/pages/AppChat.jsx`
