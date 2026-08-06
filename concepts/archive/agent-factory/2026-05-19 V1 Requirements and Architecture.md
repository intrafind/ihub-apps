# iHub Agent Factory — V1 Requirements & Architecture (rev. workflow v2)

## Context

iHub today is a control plane for AI **chat apps**: a user opens an App, has a chat, gets an answer, the conversation lives in browser localStorage. Apps are stateless config; everything autonomous a user wants done happens in their head, between their messages.

We want iHub to also be the control plane for an organization's **AI workforce**: autonomous agents that wake up on their own, do multi-step work using iHub's apps/tools/sources/models, ask a human only when they need approval, and leave durable artifacts behind. The framing:

> **"What an iHub App is to a chat session, an iHub Agent is to a job that runs by itself."**

### What changed

This spec was originally drafted before PR #1139 "agentic workflows v2" merged to main. That PR brought in a complete workflow runtime: `TriggerManager` + `ScheduleTrigger` + `WebhookTrigger` (croner-backed, in-process, restart-safe), `PromptNodeExecutor` with a real tool-calling loop, `PlannerNodeExecutor` + `SubWorkflowMaterializer` (plan-and-execute with runtime sub-DAG generation), `VerifierNodeExecutor` (quality verification with retry routing), `LoopNodeExecutor` (for / forEach / while, capped at 200 iterations), `CodeNodeExecutor` (sandboxed VM), `HttpNodeExecutor` (templated, SSRF-guarded), `ContextSummarizer` (token-window management), and a full React Flow workflow editor.

PR #1480 then landed a review pass with several improvements that matter for us:

- **Node type `agent` was renamed to `prompt`** (migrations V040 + V041). The executor was renamed `AgentNodeExecutor` → `PromptNodeExecutor`. This is purely a naming cleanup — *but it frees the "agent" name for our higher-level Profile concept, removing the collision that would have been confusing*.
- **`orphanSweeper.js`** runs on every boot, walks `contents/data/workflow-state/<id>/latest.json`, and rewrites any orphaned `running` or `pending` executions to `failed` with `reason: "server_restart"`. This solves the "what if the API server died mid-agent-run" recovery gap I had to handwave around — agents inherit this for free.
- **`chatBridge.js`** stashes pending workflow finishes for 10 min so a chat client that drops its SSE connection can reconnect and drain the missed result; it also replays state for in-flight workflows. Not V1-critical, but unlocks a V2 idea: let users "run an agent from chat" with reconnect tolerance.
- The migration numbers V039–V041 are now taken (calendar integration + workflow-tools move + the two rename migrations). **Our agent factory migration is now V042.**

Concurrently, PR #1484 landed an admin UI redesign **concept document** (draft only — no code yet) proposing a 7-section left-rail IA where agents would live under "AI Workspace" sibling to Apps, Models, Prompts, and Workflows. We do NOT gate V1 on it, but we DO design our new admin pages around its page-template patterns (List/CRUD, Settings, Integration Hub) so we don't rebuild when it lands.

**The agent factory now builds on this.** Our job is not to ship a parallel runtime; it is to add the agent-specific layer that workflows do not have yet: **AgentProfile** as a first-class owned entity, **long-term memory**, **end-of-run consolidation**, **inbox**, **service-account identity**, **App-as-tool**, **dynamic task extension**, **HITL completion**, and **artifact storage**.

> **Terminology note.** Throughout this document, "AgentNode" is the conceptual role name for *a workflow node of type `prompt` that is acting as an agent's thinking step*. The underlying workflow node type is `prompt` (renamed from `agent` in PR #1480) and the executor class is `PromptNodeExecutor`. We use "AgentNode" in prose because it more clearly conveys "this is the agent's brain", and use `type: "prompt"` in all JSON examples and file references.

### The hybrid mental model

The user's framing: *"the agent typically does not always follow a workflow. the workflow guides them."* That gives us a clear hybrid:

> **A workflow is the agent's playbook. An agent is what improvises inside it.**

The workflow defines the *shape* of what the agent does — read inbox, pick task, work, write artifact, mark done. Inside the agent-decision nodes, the LLM is free to call tools, call iHub Apps, write memory, write artifacts, and **append dynamic tasks** to a runtime task queue that the workflow's loop will drain.

For very simple agents (TODO worker), the workflow is two or three nodes. For complex agents (multi-stage research with verification), the workflow is a richer DAG with Planner / Verifier / Loop nodes. Same Profile model; different scaffolding.

## Lighthouse Use Case (locked)

A scheduled **"TODO worker"** agent — wakes every N minutes, reads an iHub-stored TODO list, picks the next item, works it using its tools and the iHub Apps it's allowed to call. If the work needs decomposition, the agent calls `createTask(...)` to enqueue sub-tasks; the workflow's drain loop processes them. Final output is written as a Markdown artifact. The TODO is marked done. If any of those actions are flagged sensitive, the run pauses for an operator approval.

## Personas

- **Agent Author** (admin / power user) — designs Profiles, picks capabilities, sets budgets, writes the brief, owns the memory file's initial content, and optionally edits the underlying workflow DAG.
- **Agent Operator** — triggers manually, watches runs, approves HITL gates, cancels runaways. Group-based.
- **Output Consumer** — reads what agents produced.
- **Auditor / Platform Admin** — "what did agents do, on whose authority, what did it cost, what data did they touch."

## Goals (V1)

1. CRUD for `AgentProfile` (the template), reusing iHub's existing config + admin-UI patterns. Profile **owns** an underlying workflow definition.
2. **Profile editor UI** — form-based for simple agents (the lighthouse case); link to the existing React Flow workflow editor for advanced editing of the underlying DAG.
3. **AgentRun** = a `WorkflowExecution` enriched with agent-specific extras (profile pointer, memory snapshot ref, artifacts list). All checkpoint/resume/cancel mechanics inherited from workflow v2.
4. **Reuse workflow triggers wholesale** — `ScheduleTrigger` and `WebhookTrigger` for cron and webhook triggers in V1; manual trigger via API.
5. **Dynamic Task Extension** — new agent-only primitive: agents can `createTask(...)` at runtime; the workflow drains the queue with a new `drain` mode added to `LoopNodeExecutor`. This is the V1 differentiator vs a plain workflow.
6. **App-as-tool**: extend `PromptNodeExecutor` to auto-register profile-allowed iHub Apps as synthetic `app__<id>` tools. No App→App nesting.
7. **Memory file** per Profile — editable by both agent (via tool) and human (via admin UI). Tripartite (`## Semantic` / `## Episodic` / `## Procedural`), per-entry `{source: agent|human}` markers, version snapshots for rollback.
7a. **Consolidation node** auto-appended to every agent's workflow — separate bounded LLM pass at end of run that writes structured updates to memory. Agent-authored entries only; human entries are immutable to the consolidation pass.
8. **Inbox** primitive — markdown work queue at `contents/data/agent-inboxes/<id>.md` users edit, agents read/write.
9. **Service-account identity** — replace the `system` user that workflow triggers currently use with a real `agent:<profileId>` principal that flows through `enhanceUserWithPermissions`.
10. **HITL** — finish the stubbed `HumanNodeExecutor`: pause node, queue approval, resume on operator decision, with group-based approver scope.
11. **Per-Profile concurrency limit** (default 1, configurable).
12. **Budgets** (steps, tokens, wall-clock) inherited from `PromptNodeExecutor`'s existing limits, plus a per-Run wall-time enforced via cancel.
13. **Artifacts** persisted to disk and downloadable from run-detail UI and from a per-Profile artifacts tab.
14. **Audit**: agent-specific events emitted into the workflow event stream with `agent.*` types, replayable, queryable.

## Non-goals (V1)

- Sub-agent delegation / multi-agent handoffs / team Profiles → V2.
- Long-term memory beyond the single memory file (no vector store, no semantic recall) → V2.
- Webhook trigger UI polish (the route exists; basic admin UI only in V1) → V2 polish.
- Sandboxed external code execution beyond what `CodeNodeExecutor` already provides → V3.
- Eval harness / re-run-and-diff → V3.
- App→App nesting → V2 at earliest.
- Replacing or migrating existing workflow executions into the Agent model.

## Architectural Insight

**iHub's Apps, Tools, Sources, Models, AND Workflows are all the right granularity for agent capabilities.** Specifically:

- Each existing iHub **App** becomes a callable verb for an agent (via the App-as-tool extension to `PromptNodeExecutor`).
- The workflow engine **is** the agent runtime. No parallel runtime, no worker daemon, no custom scheduler.
- The Profile is the *only* genuinely new domain object; everything else extends what already exists.

```
┌─────────────────────────────────────────────────────┐
│  Agent Factory UI · Profile · Inbox · Memory ·      │  agent control plane (NEW: thin)
│  Artifact viewer · Audit · Approvals                │
├─────────────────────────────────────────────────────┤
│  Workflow Engine (v2): TriggerManager · StateManager  │  runtime (EXISTS — reused wholesale)
│  PromptNodeExecutor + extensions · LoopNode (+drain)   │
│  PlannerNode · VerifierNode · HumanNode (finished)    │
│  ContextSummarizer · SubWorkflowMaterializer          │
├─────────────────────────────────────────────────────┤
│  Models · Tools · Sources · Apps                    │  iHub primitives (existing, reused)
└─────────────────────────────────────────────────────┘
```

## Agent Cognition: What it Knows, What it Does, How it Thinks

### What the agent knows it has done

Three layers, only the first two read by the agent itself in V1:

1. **Within an AgentNode invocation** — the message history accumulated across tool calls inside the current node (already implemented in `PromptNodeExecutor`). Bounded by the node's `maxIterations` and ContextSummarizer.
2. **Across AgentNode invocations within the same workflow run** — workflow state. Workflow state carries data between nodes; the agent reads relevant slices via its system-prompt-injected context.
3. **Across Runs (same Profile)** — the **memory file**, auto-included in every AgentNode's system prompt. The agent on run #15 sees what runs #1–14 chose to commit. The agent appends/edits via `writeMemory`.

Audit-only: workflow event log + agent event extras in the same stream — humans query it, the agent doesn't read it in V1.

### What the agent knows it has to do

Three input sources, evaluated together by the LLM at each AgentNode:

1. **Profile.system prompt** (and per-node prompt if multi-node workflow) — the persistent role + brief.
2. **Trigger payload** — manual: `{ brief, variables }`. Schedule: `{ cron, scheduledAt }`. Webhook: the JSON body. Recorded on the workflow's `initialData`.
3. **Work-fetching tools** — `readInbox`, source queries, dynamic task queue. The agent fetches its own work; we don't push.

### How the agent thinks

V1 layers two thinking models:

**A) Within a single AgentNode** — ReAct loop, already shipped in `PromptNodeExecutor`. The LLM either emits a tool call (execute & continue) or text (move on to next workflow node). Bounded by node-level `maxIterations`.

**B) Across the workflow run** — the workflow DAG is the agent's plan scaffold. The Profile author chooses how prescriptive: a 2-node workflow gives the agent maximum freedom; a 10-node workflow with Verifier and Loop nodes is highly prescribed.

**C) Dynamic Task Extension (new V1 capability)** — at any AgentNode, the agent may call `createTask({ title, brief, priority })` to append items to a runtime `_taskQueue` in workflow state. A downstream `LoopNode` with the new `drain` mode processes the queue until empty. Each iteration assigns the next task to a downstream AgentNode that processes it. That node may itself `createTask(...)` to enqueue sub-tasks, enabling bounded HTN-style decomposition. Hard cap of 200 iterations matches LoopNodeExecutor's existing bound.

This gives us the hybrid: workflow guides, agent improvises, dynamic tasks expand the work within hard safety bounds.

## Agent Lifecycle: Wake → Load → Work → Consolidate → Sleep

A run is not just "the workflow ran." It is a five-phase cycle, three of which the workflow engine already covers. **The phases this spec adds are Pre-work Loading (Phase 1) and Post-work Consolidation (Phase 3).** Without Phase 3, an agent gets work done but doesn't *learn* — every run starts from the same baseline. This is the AutoGPT failure mode and the structural gap LangGraph (LangMem), Hermes (background review + Curator), and OpenClaw (pre-compaction flush) all close in different ways.

### Phase 0 — Wake-up

V1 supports three triggers, all delegated to the workflow engine:

- **Schedule** (cron, croner) — the lighthouse case.
- **Manual** — operator hits "run now" in the admin UI.
- **Webhook** — external system posts to `/api/agents/profiles/:profileId/webhooks/:triggerId` with HMAC signature.

V1.5 adds **heartbeat** — a periodic cheap "anything to do?" wake-up (Hermes' primitive). Distinct from cron in that the agent returns `HEARTBEAT_OK` immediately if there's nothing to act on; only takes a real action if the agent decides one is needed. Useful for inbox-watcher patterns without paying for a full task run per tick. Out of V1 to keep scope tight; V1's cron + manual + webhook cover the lighthouse.

### Phase 1 — Pre-work Loading

When the workflow starts, the agent's first AgentNode loads context **from disk**, not from memory of the previous run (no in-process retention across runs is a non-negotiable constraint of file-based persistence). Loaded:

- The profile's system prompt (always).
- The **memory file body** (auto-included in the system prompt up to `maxBytes`).
- The latest **inbox snapshot** (if `inboxId` is set; loaded on demand via `readInbox`, not auto-included).
- The trigger payload (if any).

Progressive-disclosure principle (from Hermes): if any of these are large, the AgentNode receives a **header** with metadata and uses tools to fetch full content on demand. V1 implements this only for memory (`maxBytes` cap + `readMemory(section)`); other surfaces are V2.

### Phase 2 — Work

The workflow runs. AgentNodes call tools, apps, sub-workflows. Dynamic tasks accumulate in `_taskQueue` and are drained by the loop. This is the existing workflow-v2 mechanic plus our additions; covered in detail in the rest of this document.

### Phase 3 — Consolidation (NEW — the structural addition)

Every agent's workflow ends with a **`consolidation` node**, automatically appended by the profile-to-workflow serializer (the Profile author cannot remove it; they can configure its behavior).

The consolidation node is a **separate LLM call with its own system prompt** that reads the full run trajectory (or a summarized version when long) and decides what to persist. Output is bounded and structured:

```jsonc
{
  "summary": "...",                          // 1-2 sentence run summary (always written to ## Episodic)
  "semantic":  [ { "section": "Customer X", "body": "..." } ],  // new/updated facts
  "procedural":[ { "trigger": "When you see Y", "do": "..." } ], // patterns worth remembering
  "skip":      false                         // agent can decide: "nothing learned, nothing to write"
}
```

The consolidation step:
- Runs as `agent:<profileId>` principal, like the rest of the run.
- Uses a separate (typically cheaper) `consolidationModel` configurable on the Profile; defaults to the agent's main model.
- Hard output cap: **≤N tokens, ≤M entries per memory section** (defaults: N=2000, M=5). Over-budget → truncate + emit `agent.consolidation.truncated` event.
- Writes are marked `source: agent` in the memory file's per-entry frontmatter. **Consolidation can only edit entries already marked `source: agent`.** Human-authored entries (`source: human`) are immutable to the agent — borrowed verbatim from Hermes' Curator rule and worth adopting because it's the cleanest anti-drift guardrail anyone has shipped.
- Optional dry-run mode (`profile.consolidation.dryRun: true`) — proposed updates are written to a separate `pending-consolidations/<runId>.json` file instead of applied to memory, so operators can review and approve before activation. V1.5 polish.

`agent.consolidation.requested` / `agent.consolidation.completed` / `agent.consolidation.skipped` events emitted.

**Within-run reflection** (the LangGraph "reflect" node pattern, or Reflexion-style verifier loops) is a V2 enhancement. V1 ships only the end-of-run consolidation.

### Phase 4 — Sleep

Workflow engine handles state persistence, lock release, schedule re-registration for the next tick. No new code here; just the end of the workflow execution as workflow-v2 already does it.

## Domain Model

```
contents/
  agents/
    profiles/<profileId>.json        AgentProfile (one file per profile)
    memory/<profileId>.md            MemoryFile (markdown + frontmatter)
  data/
    agent-inboxes/<inboxId>.md       User-editable work queues
    agent-artifacts/<runId>/*.{md,json}   Run outputs
    workflow-state/                  EXISTS — workflow runs persisted here, includes agent runs
```

**No separate `agents/runs/` directory.** Agent runs ARE workflow executions; they live in `contents/data/workflow-state/<executionId>/` (existing). We add a small `_agent` envelope to workflow state so we can tell agent runs from plain workflows and join back to a Profile.

### AgentProfile (`contents/agents/profiles/<id>.json`)

```jsonc
{
  "id": "todo-worker",
  "name":        { "en": "TODO Worker", "de": "TODO-Worker" },
  "description": { "en": "...",           "de": "..." },
  "color": "#6366F1",
  "icon":  "robot",

  "workflow": {                              // the underlying workflow definition
    "ref": "embedded",                       // "embedded" | "external:<workflowId>"
    "definition": {                          // present when ref === "embedded"
      "nodes": [
        { "id": "start",         "type": "start" },
        { "id": "seed",          "type": "prompt",
          "config": {
            "modelId": "gpt-4o",
            "system": { "en": "...", "de": "..." },
            "maxIterations": 10,
            "tools":   ["webContentExtractor"],
            "apps":    ["doc-summarizer"],   // NEW: passes through to App-as-tool gateway
            "sources": ["company-handbook"],
            "dynamicTasks": { "enabled": true, "maxDepth": 3 }
          }
        },
        { "id": "drain",         "type": "loop",
          "config": { "mode": "drain", "queueKey": "_taskQueue", "child": "task_runner", "maxIterations": 50 }
        },
        { "id": "task_runner",   "type": "prompt",
          "config": { /* same shape as 'seed' */ }
        },
        { "id": "consolidation", "type": "consolidation",
          "config": { /* injected from profile.consolidation; see Phase 3 */ }
        },
        { "id": "end",           "type": "end" }
      ],
      "edges": [
        { "from": "start",         "to": "seed" },
        { "from": "seed",          "to": "drain" },
        { "from": "drain",         "to": "consolidation" },
        { "from": "consolidation", "to": "end" }
      ],
      "triggers": [
        { "type": "schedule", "config": { "cron": "*/15 * * * *", "timezone": "Europe/Berlin" } }
      ]
    }
  },

  "memory": {
    "enabled":     true,
    "autoInclude": true,                     // append memory body to every AgentNode system prompt
    "maxBytes":    8192,
    "priorVersions": 10                      // retain N prior memory file snapshots for rollback
  },

  "consolidation": {
    "enabled":          true,                // can be disabled per Profile, but discouraged
    "model":            null,                // null = use profile.workflow agent model; can override to a cheaper model
    "maxOutputTokens":  2000,
    "maxEntriesPerSection": 5,
    "dryRun":           false                // V1.5: write to pending-consolidations/ instead of memory
  },

  "inboxId": "engineering-todos",            // optional

  "hitl": {
    "requireApprovalFor": ["tool:writeInbox", "app:email-sender"],
    "approverGroups":      ["agent-operators-todo-worker"]
  },

  "budgets": {
    "maxWallTimeSec": 600                    // per-Run cancel after this; node-level maxSteps/tokens come from node configs
  },

  "concurrency": { "maxConcurrent": 1 },
  "artifacts":   { "outputDir": "auto", "primary": "report.md" },
  "groups":      ["agent-operators-todo-worker"],
  "serviceAccount": { "groups": ["agents", "authenticated"] },
  "enabled":     true
}
```

**Profile-as-thin-layer principle:** the workflow definition can be inline-embedded (default) or refer to a standalone workflow by id. Form-based editor handles the simple embedded case; power users can link to a standalone workflow they author in the workflow editor.

### AgentRun = WorkflowExecution + extras

The workflow execution state already carries `executionId`, `status`, `currentNodes`, `pendingCheckpoint`, `checkpoints`, `errors`, `data`. We extend `data` with:

```jsonc
"_agent": {
  "profileId": "todo-worker",
  "profileVersion": "sha256:...",
  "triggeredBy": { "userId": "user:alice", "kind": "manual" | "schedule" | "webhook" | "api" },
  "memorySnapshotAt": "2026-05-19T08:00:00Z",
  "artifacts": [ { "name": "report.md", "writtenAt": "...", "bytes": 4321 } ],
  "_taskQueue": [ /* see Dynamic Task Extension */ ]
}
```

This is the only structural change to existing workflow runs.

### AgentEvent

We do NOT introduce a new event log file. Instead we emit agent-specific events into the existing workflow event stream with `agent.*` type prefix:

```
agent.run.started, agent.memory.read, agent.memory.write,
agent.inbox.read, agent.inbox.write,
agent.app.call, agent.app.result,
agent.task.created, agent.task.completed,
agent.artifact.written,
agent.hitl.requested, agent.hitl.approved, agent.hitl.rejected,
agent.run.completed, agent.run.failed
```

Workflow's own events (`node.started`, `node.completed`, `llm.request`, etc.) remain unchanged. The run viewer filters and groups them appropriately.

### MemoryFile (`contents/agents/memory/<profileId>.md`)

Markdown with YAML frontmatter. **Three mandated top-level sections** — derived from LangMem and the cognitive-science split that LangGraph, Hermes, and OpenClaw all converge on:

```markdown
---
profileId: todo-worker
updatedAt: 2026-05-19T08:00:00Z
updatedBy: agent:todo-worker | user:alice
version: 17
priorVersions: 5         # how many `.v{N}.md` snapshots to retain (default 10)
---
# Memory

## Semantic
<!-- facts, preferences, definitions, stable knowledge -->
- {source: human} Engineering team prefers concise summaries (≤ 300 words).
- {source: agent, addedRunId: run_2026-05-12_xyz} Sentry tag `release/2026-05` corresponds to the May auth refactor.

## Episodic
<!-- specific past events: what happened on run X, what worked, what didn't -->
- {source: agent, runId: run_2026-05-18_abc} TODO "Triage Sentry" — used doc-summarizer App; result: identified 3 root causes; took 4 steps; HITL approved at step 3.

## Procedural
<!-- learned patterns / heuristics / mini-skills — the V1 substitute for a full skills system -->
- {source: agent, learnedRunId: run_2026-05-15_pqr}
  **Trigger**: When a TODO mentions "Sentry digest"
  **Do**: 1) Call doc-summarizer with the digest URL. 2) Group by tag. 3) Write artifact named `sentry-<date>.md`. 4) Mark inbox done.
```

**Why the structure is mandated, not optional:** without it the agent will dump everything into one bucket (the AutoGPT/BabyAGI failure mode) and the consolidation step can't make principled decisions about *what* to write *where*. The consolidation node's output schema maps 1:1 to these sections.

**Per-entry source markers (`{source: agent|human, ...}`)** are the anti-drift guardrail. Consolidation can only modify entries with `source: agent`. Human-authored entries — by hand-edit in `AdminAgentMemoryPage` or by an explicit "promote to human" admin action — are immutable to the agent. This is the cleanest pattern from Hermes' Curator and worth adopting verbatim.

**Version history.** Every `writeMemory` (whether from the agent's `writeMemory` tool, the human admin UI, or the consolidation node) snapshots the prior content to `contents/agents/memory/<profileId>.v{N}.md` before overwriting. Retention default 10 versions, configurable per Profile. Recovery is plain file copy. This is the cheap 80%-of-LangGraph-time-travel mechanism the research calls out — costs ~kilobytes per run, saves us when consolidation goes wrong.

**`writeMemory` tool extension.** In addition to `mode: replace|patch`, it now requires a `section` parameter (`semantic|episodic|procedural`) and accepts an optional `entry` shape with auto-injected `{source: agent, runId, addedAt}` markers. The tool refuses to write to sections it didn't recognize and refuses to overwrite human-authored entries.

Plain MD beats structured JSON: humans edit it, the LLM reads prose well, diffs are git-clean, `writeMemory` produces a readable diff for audit, and the per-section structure is still machine-parseable via the `## Section` headers + `{source:...}` markers.

### Inbox (`contents/data/agent-inboxes/<id>.md`)

Plain markdown checklist with frontmatter — unchanged:

```markdown
---
inboxId: engineering-todos
updatedAt: 2026-05-19T08:00:00Z
updatedBy: user:alice
version: 7
---
# Engineering TODOs
- [ ] (P1) Review the staging deploy logs for the auth change
- [ ] (P2) Draft a 1-pager on the cache invalidation bug
- [x] (P1) Triage Sentry issues from yesterday  -- done by agent:todo-worker 2026-05-19T07:45Z
```

## Architecture

### Runtime — the workflow engine, in-process

Agent runs execute inside the API server's workflow engine. No separate worker daemon, no file-based queue, no custom scheduler. This is a deliberate alignment with workflow v2's choice: the engine is in-process, triggers reconstruct from workflow definitions at startup, execution state checkpoints to `contents/data/workflow-state/`, and the existing `StateManager` handles restart-safe resume.

**Trade-offs accepted from workflow v2 (already in production):**
- API requests and agent runs share the Node event loop. Mitigated by the existing context-summarizer and node-level iteration caps; further mitigated for agents by V1's `maxWallTimeSec` per-Run cancel.
- Server restart kills in-flight LLM calls. `orphanSweeper.js` (shipped in PR #1480) marks the orphaned execution as `failed` with `reason: "server_restart"` on next boot; checkpoints from already-completed nodes survive, so a follow-up trigger / manual restart starts fresh with the prior memory state intact.
- Single API-server process model. Multi-replica HA needs leader election; deferred to V2 (same constraint workflow v2 already documents).

### Reuse table

| Need | What we use | Notes |
|---|---|---|
| Cron triggers | `ScheduleTrigger` (croner, in-process) | We just provide the cron spec on the Profile. |
| Webhook triggers | `WebhookTrigger` (HMAC-SHA256, per-trigger secret) | Public URL pattern already at `/api/workflows/:workflowId/webhooks/:triggerId`. Aliased under `/api/agents/...` for clarity. |
| Manual trigger | `engine.start()` directly | Wrapped in our `POST /api/agents/profiles/:id/runs`. |
| LLM tool-calling loop | `PromptNodeExecutor` | We extend it with App-as-tool registration and dynamic-task tools. |
| Plan-and-Execute | `PlannerNodeExecutor` + `SubWorkflowMaterializer` | Optional in Profiles; power users can stitch into the underlying workflow. |
| Verify & retry | `VerifierNodeExecutor` | Same — optional advanced primitive. |
| Iteration | `LoopNodeExecutor` (+ new `drain` mode) | Drain mode is the V1 addition for the task queue. |
| Context window mgmt | `ContextSummarizer` | Used unchanged. |
| Pause / resume / cancel | `StateManager` | Existing — we add `HumanNodeExecutor` completion for HITL on top. |
| Sub-workflow execution | `SubWorkflowMaterializer` | Used by Planner only in V1; not exposed in form editor. |
| Run history & viewer | Workflow editor's existing run views | We add an agent-centric view layered on the same data. |

### Dynamic Task Extension (the V1 differentiator)

The agent can append tasks at runtime to a workflow-state queue; a downstream loop drains it. This is the bounded version of the BabyAGI / agent-task-list pattern, embedded in a workflow scaffold so it's observable, checkpointable, and capped.

**Wire format** — tasks live at `state.data._taskQueue` (array of objects):

```jsonc
{
  "id":          "task_2026-05-19T08-00-12_a1b2",
  "title":       "Summarize Q3 financials",
  "brief":       "Fetch the data via doc-summarizer App, write a 300-word executive summary.",
  "priority":    "p1" | "p2" | "p3",
  "status":      "open" | "in_progress" | "done" | "failed" | "skipped",
  "createdBy":   "agent:todo-worker" | "system",
  "parentTaskId": null,                     // for sub-tasks created during processing
  "depth":       0,                         // increments by 1 for each level of dynamic creation
  "result":      null,                      // populated when task completes
  "createdAt":   "...",
  "updatedAt":   "..."
}
```

**Three auto-registered tools** for any AgentNode with `config.dynamicTasks.enabled === true`:

- `createTask({ title, brief, priority? })` → pushes a new open task at the end of `_taskQueue`. Refuses if the calling agent's `depth >= maxDepth` (default 3) to bound recursion. Emits `agent.task.created`.
- `listTasks({ status?, limit? })` → returns visible tasks, optionally filtered.
- `markTaskDone({ taskId, result })` → sets status=done + result. Emits `agent.task.completed`. Usually called implicitly by the drain loop's completion handler, but available as an explicit tool for early termination.

**New LoopNodeExecutor mode: `drain`** — only meaningful change to existing workflow code.

- Source = `state.data[config.queueKey || '_taskQueue']`.
- Each iteration: shift the first task with `status === 'open'`, set `status='in_progress'`, store as `_currentTask` in state, execute the child node, then on success set `status='done'`.
- The child node may *itself* mutate the queue (createTask). The loop checks for new open items at every iteration boundary — that's what makes it a drain rather than a snapshot iteration.
- Hard cap of `Math.min(maxIterations, 200)` matches existing forEach/while bound; emits `loop.bounded` warning if hit.
- Depth tracking: when a child agent createTasks during its iteration, the new task inherits `parentTaskId` and `depth = parent.depth + 1`. If a task's depth would exceed the AgentNode's `dynamicTasks.maxDepth`, the create is rejected.

For the lighthouse demo, the workflow shape is:

```
start → agent("seed inbox into tasks") → drain(child = task_agent) → end
                                                              ↑
                                  task_agent can createTask() to enqueue sub-tasks
```

### Agent Identity & Authorization

`TriggerManager` currently runs triggered workflows as a synthetic `system` user with no group memberships. We replace this for agent runs with a real `agent:<profileId>` principal.

**Construction** — when an agent workflow starts (any of: manual trigger via `/api/agents/profiles/:id/runs`, scheduled trigger fire, webhook fire, or planner sub-workflow), we replace the initial user with:

```js
{
  id:        `agent:${profile.id}`,
  name:      profile.name.en,
  email:     null,
  groups:    profile.serviceAccount.groups,
  isAgent:   true,
  profileId: profile.id,
  triggeredBy: { userId: '<triggerer-or-system:scheduler>', kind: 'manual'|'schedule'|'webhook'|'api' }
}
```

**`server/utils/authorization.js` changes:**
- `enhanceUserWithPermissions`: route `isAgent: true` through the same group-merge path as humans.
- Force `isAdmin = false` for any `isAgent: true`, regardless of group membership. Admin endpoints reject agent principals outright.
- `canUserAccessResource` honors group permissions normally — so admins control what apps/tools/models/sources agents can use by adding `agents` (or `agent:foo`) to the right groups in `groups.json`.

`triggeredBy` is recorded on the run for audit: agent is the *actor*, the human/scheduler is the *authority*. Triggerers without permission to start a Profile are rejected at enqueue.

Two new groups created by migration: `agent-operators` (default operator role for HITL approvals & run viewing) and `agents` (default service-account group). Per-Profile group overrides via `profile.serviceAccount.groups` and `profile.groups`.

### App-as-Tool Gateway

`PromptNodeExecutor` already calls existing tools via the chat-service tool plumbing. We extend it to also expose iHub Apps as synthetic tools.

For each `appId` listed in `node.config.apps`, the executor registers a tool named `app__<appId>` with `description = app.description.en` and `parameters` derived from `app.variables` (zod-to-json-schema). When the LLM calls it, the executor invokes a new `ChatService.invokeAppInternal()`:

```js
async invokeAppInternal({
  appId, user, messages, modelOverride, variables, abortSignal, runId
}) → {
  status: 'ok'|'error',
  finalMessage: { role: 'assistant', content },
  toolCalls: [...],
  usage:     { promptTokens, completionTokens, costUSD, durationMs },
  citations: [...],
  artifacts: []
}
```

Internally: `RequestBuilder.prepareChatRequest` + the same loop `ToolExecutor.processChatWithTools` uses, but with `chatId = "agent:${runId}:${uuid()}"` and `clientRes = null` — the stream is consumed in memory.

**App→App nesting is forbidden in V1.** Guard: inside `invokeAppInternal`, if `user.isAgent === true`, strip any `app__*` synthetic tools from the prepared tools list. Tools and sources work normally; only App-as-tool is stripped.

Identity & authz: agent principal flows through; `canUserAccessResource(user, 'apps', appId)` enforces visibility. Denial → error result fed back to the LLM, which can recover.

Events: `agent.app.call` / `agent.app.result` emitted into the workflow event stream with masked args.

### Memory File

Auto-registered tools for every AgentNode in an agent's workflow:

- `readMemory({ section?: string })` → full body or matched markdown section.
- `writeMemory({ mode: "replace"|"patch", content, summary })` → optimistic-version-checked write; emits `agent.memory.write` with unified diff in payload.

When `profile.memory.autoInclude` is true (default), the file body is appended to each AgentNode's system prompt as `# Long-term memory (last updated <ts>)`, capped at `profile.memory.maxBytes` (default 8KB). Oversized → tell the LLM via system note and rely on `readMemory` for fetching slices.

**Human edit:** new admin page reuses `DualModeEditor`. `PUT /api/admin/agents/profiles/:id/memory` checks `frontmatter.version` for optimistic concurrency.

### Inbox

Auto-registered tools for every AgentNode whose Profile has `inboxId`:

- `readInbox({ inboxId, status?: "open"|"done"|"all" })` → array of `{ line, priority, text, status }`.
- `writeInbox({ inboxId, mode: "markDone"|"add"|"replace", item, body? })` → version-checked write; emits `agent.inbox.write`.

**Admin UI** — new page `AdminAgentInboxesPage` reusing `DualModeEditor`. Raw mode = Monaco markdown; form mode = checkbox-list editor (add / remove / reorder items, set priority). `PUT /api/admin/agents/inboxes/:inboxId` with version check.

### HITL — finish HumanNodeExecutor

`HumanNodeExecutor` exists as a stub. We complete it.

**Two trigger paths for HITL:**

1. **Explicit `human` node** in a workflow — author wires it where a checkpoint is needed (already the v2 mechanism; we just complete the stub).
2. **Implicit pause on sensitive tool/app call** inside an AgentNode — when the LLM calls a tool/app id matching `profile.hitl.requireApprovalFor` (or a tool/app schema with `sensitive: true`), the executor pauses the run BEFORE executing the call, emits `agent.hitl.requested`, sets state status PAUSED with `pendingCheckpoint = { kind: "agent_sensitive", targetId, args, requestedAt }`.

**Resume mechanics** — reuses StateManager's existing checkpoint clear path. `POST /api/agents/runs/:runId/approve` with `{ approvalId, decision, note }`:

- Server validates the user belongs to a group in `profile.hitl.approverGroups` (default = the Profile's main `groups` list).
- On approve: writes the resume marker, engine resumes the AgentNode (re-enters the executor), which now executes the queued tool/app call.
- On reject: synthetic `tool.result` of `"Operator rejected this action: <note>"` is fed to the LLM, which may recover or fail.

`agent.hitl.approved` / `agent.hitl.rejected` events emitted.

### Triggers

All trigger mechanics inherited from workflow v2.

- **Schedule:** `ScheduleTrigger` reads `profile.workflow.definition.triggers[].type === 'schedule'` and registers a croner job at startup. Schedules survive restart because they're reconstructed from the persisted Profile, which is loaded at boot.
- **Webhook:** `WebhookTrigger` exposes a per-trigger URL at `/api/workflows/:workflowId/webhooks/:triggerId` — we add an alias route `/api/agents/profiles/:profileId/webhooks/:triggerId` that resolves to the same handler. HMAC-SHA256 signature required.
- **Manual:** `POST /api/agents/profiles/:id/runs` with optional `{ brief, variables }` body → calls `engine.start()` directly. Honors `profile.concurrency.maxConcurrent` — over-limit returns 409 with `runningRuns` info.

**Concurrency enforcement** — we check active executions for this profile via the StateManager's user-index (we'll use the new agent principal id as the key). Over-limit → 409.

**Cron evaluator HA** — single process is V1 assumption (matches workflow v2 today). Multi-replica deferred to V2 with a leader-election file lock under `contents/data/workflow-state/.scheduler-leader`.

### Observability

- Agent events emitted into the existing workflow event stream with `agent.*` prefix.
- Replay: workflow's existing run viewer renders the conversation + tool/app/llm calls; we add an agent-centric overlay that surfaces memory writes, inbox writes, task queue, and HITL events prominently.
- OpenTelemetry: one root span per agent run (`agent.run`), reuses workflow's per-node spans. Existing OTel adapter instrumentation for LLM and HTTP continues to apply.
- Usage tracking: agent events feed the existing `usageTracker` pipeline with a new `type=agent_event` discriminator so cost/usage reports include agent activity.

## API Surface

We aim to NOT duplicate workflow endpoints. Agent endpoints sit on top.

```
# Profiles (admin)
GET    /api/admin/agents/profiles
GET    /api/admin/agents/profiles/:id
POST   /api/admin/agents/profiles
PUT    /api/admin/agents/profiles/:id
DELETE /api/admin/agents/profiles/:id

# Memory (admin)
GET    /api/admin/agents/profiles/:id/memory
PUT    /api/admin/agents/profiles/:id/memory        # optimistic version check

# Inboxes (admin / operators)
GET    /api/admin/agents/inboxes
GET    /api/admin/agents/inboxes/:inboxId
PUT    /api/admin/agents/inboxes/:inboxId
POST   /api/admin/agents/inboxes/:inboxId/items     # convenience: append a single item

# User-visible profiles
GET    /api/agents/profiles
POST   /api/agents/profiles/:id/runs                # manual trigger; honors concurrency
GET    /api/agents/profiles/:id/artifacts           # all artifacts across runs

# Runs (proxies to workflow execution endpoints, filtered to agent runs)
GET    /api/agents/runs                              # filter ?profileId&status&from&to
GET    /api/agents/runs/:id                          # returns workflow execution state + _agent envelope
GET    /api/agents/runs/:id/events                   # filtered to agent.* + relevant workflow events
GET    /api/agents/runs/:id/stream                   # SSE — reuses workflow's stream endpoint
POST   /api/agents/runs/:id/cancel                   # delegates to workflow engine
POST   /api/agents/runs/:id/approve                  # HITL decision (group-validated)
GET    /api/agents/runs/:id/artifacts
GET    /api/agents/runs/:id/artifacts/:name

# Webhooks — alias to workflow webhook endpoint
POST   /api/agents/profiles/:profileId/webhooks/:triggerId   # aliased; same handler

# Cross-profile approvals queue
GET    /api/agents/approvals
```

SSE reuses workflow's run-stream endpoint where possible; the agent endpoint just filters events.

## UI Surface

New pages under `client/src/features/admin/pages/`:

- **`AdminAgentsPage.jsx`** — list. Columns: name, enabled/disabled, schedule (cron + next run), last-run status/timestamp, concurrency. Mirrors `AdminAppsPage`.
- **`AdminAgentEditPage.jsx`** — wraps `DualModeEditor`. New form component `AgentProfileFormEditor` reuses `ToolsSelector`, `SourcePicker`, and adds:
  - `AppMultiSelector`, `InboxPicker`, `BudgetEditor`, `ScheduleEditor` (croner `nextRuns(5)`), `MemoryConfigEditor`, `HitlConfigEditor`, `DynamicTasksToggle`.
  - **"Advanced: edit workflow"** link → opens the underlying workflow in the existing React Flow workflow editor. Power users can author multi-node DAGs (Planner / Verifier / Loop / etc.) there; the form editor handles simple single-AgentNode shapes.
- **`AdminAgentMemoryPage.jsx`** — `DualModeEditor` over the memory MD file. Raw = Monaco; form = per-`##`-section. Version-checked.
- **`AdminAgentInboxesPage.jsx`** — list + per-inbox editor. List shows inboxId, last-updated, open-item count, profile-binding count. Editor: `DualModeEditor` with checkbox-list form mode.
- **`AgentProfileDetailPage.jsx`** — non-edit operator view. Tabs: Overview · Runs · Artifacts · Memory · Inbox · Workflow (read-only DAG view linking to the workflow editor for power users).
- **`AgentRunsPage.jsx`** — filterable list of agent runs (proxies to workflow runs filtered to agents).
- **`AgentRunDetailPage.jsx`** — three-pane view:
  - Left: live event stream (SSE), filtered to agent + relevant workflow events.
  - Center: conversation viewer + task-queue widget (the dynamic tasks the agent created, with status) + artifact previews + memory snapshot.
  - Right: metadata — budgets used, status, triggeredBy, profile link.
  - Top sticky banner when PAUSED with `pendingCheckpoint.kind === "agent_sensitive"`: Approve / Reject buttons.
- **`AdminAgentApprovalsPage.jsx`** — cross-profile pending-approval queue for operators.

Reuse the existing `useEventSource`-style chat SSE hook. Add a new top-level "Agents" group in `AdminNavigation.jsx`, sibling to "Workflows", with children: Profiles · Runs · Approvals · Inboxes.

## Build Order

Each ticket is a 1–3 day PR. End-of-T10 demo.

| # | Ticket | Effort | Lands |
|---|--------|--------|-------|
| **T1** | Foundation, schema, Profile CRUD | 1–2 d | Migration `V042__add_agent_factory.js` (dirs + groups + default Profile example). `agentProfileSchema.js` (Zod). `agentsLoader.js` + `configCache` integration. CRUD admin routes. Profile save serializes a default workflow definition if none provided. |
| **T2** | Service-account identity | 1 d | New `agent:<profileId>` principal kind in `authorization.js`. `isAgent` + `isAdmin=false` guard. `enhanceUserWithPermissions` branch. Migration seeds `agents` and `agent-operators` groups. **TriggerManager updated to use this principal for agent workflows** (replaces the synthetic `system` user). |
| **T3** | LoopNodeExecutor — `drain` mode + dynamic task tools | 2 d | New `drain` mode in `LoopNodeExecutor` (~50 lines). Auto-registered `createTask` / `listTasks` / `markTaskDone` tools in `PromptNodeExecutor` for nodes with `config.dynamicTasks.enabled`. Depth tracking. `agent.task.*` events. Tests for queue drain + max-depth + bounded loop. |
| **T4** | Memory file (tripartite + versions) | 2 d | `readMemory`/`writeMemory` tools auto-registered with `section` parameter (`semantic`/`episodic`/`procedural`). Source markers (`{source: agent\|human}`). Per-entry refusal to overwrite human-authored entries. Auto-inject body into system prompt with cap. Version snapshots to `<profileId>.v{N}.md` on every write; configurable retention. `AdminAgentMemoryPage` with optimistic-concurrency, three-section form view, and a "promote to human" action that flips an entry's source marker. Diff payload in events. |
| **T4.5** | Consolidation node | 2 d | New `ConsolidationNodeExecutor` registered in `workflow/executors/`. Reads run trajectory, calls separate LLM with structured-output schema, validates entry counts/token caps, writes results via the same `writeMemory` path (auto-tagged `source: agent`). Profile-to-workflow serializer auto-appends a consolidation node to every Profile's workflow. `agent.consolidation.*` events. Skip path when nothing learned. |
| **T5** | Inbox primitive | 1–2 d | Storage + schema. `readInbox`/`writeInbox` tools. `inboxId` field on Profile. `AdminAgentInboxesPage` (list + editor). Routes under `/api/admin/agents/inboxes`. Version-checked writes. |
| **T6** | App-as-tool gateway | 2 d | `ChatService.invokeAppInternal()`. Synthetic `app__*` tool registration in `PromptNodeExecutor`. App→App nesting guard. `agent.app.*` events. Authorization via agent principal. |
| **T7** | HITL completion | 2 d | Finish `HumanNodeExecutor`. Implicit pause path in `PromptNodeExecutor` on sensitive tool/app id. `pendingCheckpoint.kind = "agent_sensitive"`. `POST /api/agents/runs/:id/approve` with group-validation against `profile.hitl.approverGroups`. UI banner + cross-profile approvals page. |
| **T8** | Agent run alias + trigger plumbing | 1–2 d | `POST /api/agents/profiles/:id/runs` manual trigger; webhook alias route. Concurrency enforcement (default 1). Profile-aware schedule registration at boot (in addition to workflow's own). The "save Profile" path persists trigger config into the embedded workflow definition so `TriggerManager` picks it up after restart. |
| **T9** | Agent-centric admin UI | 3 d | `AdminAgentsPage`, `AdminAgentEditPage` with `AgentProfileFormEditor`, `AgentProfileDetailPage` (Overview / Runs / Artifacts / Memory / Inbox / Workflow tabs), `AgentRunsPage`, `AgentRunDetailPage` with live SSE stream, task-queue widget, artifact downloads, HITL banner. Nav integration. Advanced "edit workflow" link to existing workflow editor. |
| **T10** | Artifacts + polish + docs | 1–2 d | `writeArtifact` tool (explicit; allows multiple per run). Implicit fallback: final assistant message of the final AgentNode saved as `report.md` if no explicit artifact written. Profile-level artifact index endpoint. Cost rollup in run summary. OTel `agent.run` root span. `docs/agents.md`. Lighthouse demo wired end-to-end. |

**Total**: ~16–22 days of focused work; comfortable in **4–5 weeks** at a normal pace with review and iteration. **No deployment-shape change** — agent runs share the API server process exactly as workflow runs do today.

## Verification — Lighthouse Demo Walkthrough

This is the end-of-T10 demo. Anyone running the dev server should reproduce it.

1. **Create an Inbox** via `AdminAgentInboxesPage` → "New inbox": id `engineering-todos`. Add three items via the checkbox form:
   - `(P1) Summarize yesterday's Sentry digest`
   - `(P2) Draft a 1-pager on the cache invalidation bug`
   - `(P1) Review the staging deploy logs for the auth change`
   Save. Verify `contents/data/agent-inboxes/engineering-todos.md` exists with `version: 1`.
2. **Define a "TODO Worker" Profile** in `AdminAgentEditPage`:
   - Identity: name "TODO Worker", description, icon, color.
   - Inbox: `engineering-todos`.
   - Capabilities: `tools = []` (`readInbox`/`writeInbox`/`readMemory`/`writeMemory`/`writeArtifact`/`createTask`/`listTasks`/`markTaskDone` are auto-registered), `apps = [doc-summarizer]`, `sources = []`.
   - System prompt: "On each wake, call `readInbox`. Pick the highest-priority open item. If the item is complex, call `createTask` to enqueue sub-tasks. Work each task using your tools and the doc-summarizer App. Call `writeArtifact` with a useful name and content. Call `writeInbox` with `markDone` to mark the original inbox item done. Append a note to your memory describing what you did. If you need to send any email, ASK FIRST."
   - Memory: enabled, autoInclude true, 8KB.
   - Schedule: enabled, `*/15 * * * *`, timezone `Europe/Berlin`.
   - Dynamic tasks: enabled, maxDepth=2.
   - Concurrency: maxConcurrent=1.
   - HITL: requireApprovalFor = `["tool:writeInbox"]` (so the operator sees the pause flow).
3. **Save Profile.** Verify `contents/agents/profiles/todo-worker.json` exists; the embedded workflow definition includes the `drain` loop node; `TriggerManager` logs that the schedule registered.
4. **Trigger manually** from the Profile detail page (don't wait for cron).
5. **Open `AgentRunDetailPage`**, observe the live event stream and the task-queue widget. Sequence:
   - `node.started(seed)` → AgentNode invocation
   - `agent.inbox.read`, `llm.request`, `llm.response`, `agent.task.created` (one or two sub-tasks)
   - `node.started(drain)` → drain loop
   - First iteration: `agent.app.call(doc-summarizer)`, `agent.app.result`, `agent.artifact.written`
   - Second iteration: another sub-task processed
   - Final step in the loop: `agent.hitl.requested` for `writeInbox` — run pauses, banner appears
6. **Approve** the `writeInbox` call from the banner (logged in as a user in `agent-operators-todo-worker`). The run resumes.
7. **Consolidation phase**: `node.started(consolidation)` → `agent.consolidation.requested` → separate LLM call → `agent.consolidation.completed` with payload showing what was written to `## Episodic` and (optionally) `## Procedural`. Final `agent.run.completed` lands.
8. **Open the artifact** — renders as Markdown in-page.
9. **Reload the Inbox page** — the worked item is now `[x]` with an agent-attribution note.
10. **Open the memory file** in `AdminAgentMemoryPage` — verify three sections exist (`## Semantic`, `## Episodic`, `## Procedural`), the consolidation appended a one-line summary to `## Episodic` with `{source: agent, runId: ...}`, and if the agent found a reusable pattern it appears under `## Procedural`. Verify `<profileId>.v17.md` (or whatever prior version) exists as a snapshot.
11. **Edit the memory file by hand**, save, verify version increments, the new entry is marked `{source: human}`, and the next run's consolidation does NOT modify it.
12. **Trigger a second run**. Pre-work loading auto-includes the now-richer memory. Confirm the agent uses what it learned (e.g., follows the procedural pattern it stored after run 1).
13. **Add a new TODO** to the inbox via the form, then trigger again — observe it picks up the new item, possibly creates new dynamic tasks.
14. **Cancel a running run**: click Cancel → workflow engine's existing cancel mechanism stops it at the next node boundary.
15. **Restart the API server mid-run** — the in-flight run resumes from its last completed node, observable in the event log.
16. **Audit query**: `cat contents/data/workflow-state/<execId>/history.jsonl | jq 'select(.type | startswith("agent."))'` — every agent action with masked args and `triggeredBy`, including the consolidation pass.
17. **Memory rollback**: pick a `<profileId>.v{N}.md` snapshot, copy it over the current memory file via the admin UI's "Restore version" button — verify subsequent runs see the rolled-back state.

Acceptance: every step works without intervention beyond what the script describes.

## Critical Files to Create / Modify

**New files:**
- `server/agentsLoader.js`
- `server/validators/agentProfileSchema.js`, `agentInboxSchema.js`
- `server/agents/profile/profileLoader.js`, `profileWorkflowSerializer.js` (builds default workflow def from Profile config)
- `server/agents/memory/memoryFile.js`
- `server/agents/inbox/inboxStore.js`
- `server/agents/tools/readMemory.js`, `writeMemory.js`, `readInbox.js`, `writeInbox.js`, `createTask.js`, `listTasks.js`, `markTaskDone.js`, `writeArtifact.js`
- `server/agents/runtime/agentToolRegistrar.js` (extends PromptNodeExecutor with the auto-registered agent tools)
- `server/services/workflow/executors/ConsolidationNodeExecutor.js`
- `server/agents/runtime/consolidationPrompt.js` (the structured-output prompt + Zod schema)
- `server/agents/runtime/appAsToolGateway.js` (synthetic `app__*` registration)
- `server/routes/agents/index.js`, `routes/agents/profiles.js`, `routes/agents/runs.js`, `routes/agents/memory.js`, `routes/agents/inboxes.js`, `routes/agents/approvals.js`, `routes/agents/webhooks.js` (alias to workflow webhook handler)
- `server/migrations/V042__add_agent_factory.js`
- `client/src/features/admin/pages/AdminAgentsPage.jsx`
- `client/src/features/admin/pages/AdminAgentEditPage.jsx`
- `client/src/features/admin/pages/AdminAgentMemoryPage.jsx`
- `client/src/features/admin/pages/AdminAgentInboxesPage.jsx`
- `client/src/features/admin/pages/AgentProfileDetailPage.jsx`
- `client/src/features/admin/pages/AgentRunsPage.jsx`
- `client/src/features/admin/pages/AgentRunDetailPage.jsx`
- `client/src/features/admin/pages/AdminAgentApprovalsPage.jsx`
- `client/src/features/admin/components/AgentProfileFormEditor.jsx`
- `client/src/features/admin/components/AppMultiSelector.jsx`, `InboxPicker.jsx`, `BudgetEditor.jsx`, `ScheduleEditor.jsx`, `MemoryConfigEditor.jsx`, `HitlConfigEditor.jsx`, `DynamicTasksToggle.jsx`, `TaskQueueWidget.jsx`
- `docs/agents.md`

**Modified files:**
- `server/services/chat/ChatService.js` — add `invokeAppInternal()`.
- `server/services/workflow/executors/PromptNodeExecutor.js` — register agent-specific tools (memory, inbox, task queue, artifact), wire the App-as-tool gateway, add sensitive-call pause.
- `server/services/workflow/executors/LoopNodeExecutor.js` — add `drain` mode (~50 lines).
- `server/services/workflow/executors/HumanNodeExecutor.js` — complete the stub.
- `server/services/workflow/triggers/TriggerManager.js` — agent-principal construction path.
- `server/utils/authorization.js` — `isAgent` branch + admin guard.
- `server/validators/toolConfigSchema.js`, `appConfigSchema.js` — optional `sensitive` field.
- `server/validators/workflowConfigSchema.js` — add `consolidation` to the `nodeTypeEnum` (currently: start, end, prompt, tool, decision, parallel, join, human, transform, memory, planner, verifier, loop, http, code); register `drain` mode for loop nodes; accept `dynamicTasks` config on `prompt` nodes (no schema change needed there if passthrough config is kept).
- `server/services/workflow/executors/index.js` — register `ConsolidationNodeExecutor`.
- `server/server.js` — mount `/api/agents` routes.
- `server/configCache.js` — load agent profiles + inboxes.
- `client/src/features/admin/components/AdminNavigation.jsx` — new "Agents" group sibling to "Workflows".
- `client/src/App.jsx` + `client/src/utils/runtimeBasePath.js` — register `/admin/agents`, `/admin/agents/runs`, `/admin/agents/approvals`, `/admin/agents/inboxes` routes.
- `contents/config/groups.json` — `agent-operators`, `agents` (via migration).

## Open Questions Resolved

| Question | Decision |
|---|---|
| V1 lighthouse demo | **TODO worker** — scheduled wake-up, reads inbox, processes via dynamic task queue, writes artifact, marks done. |
| Workflow vs Agent — relationship | **Profile owns a workflow.** Workflow is the playbook/scaffold; agent improvises within (tools + apps + dynamic tasks). |
| Runtime location | Workflow engine, **in-process in the API server.** No separate worker daemon, no file-based queue. Aligns with workflow v2's existing model. |
| Multi-agent in V1 | No. Single AgentNode (or multi-node single-agent DAG) per Run. App-as-tool is the composition substitute. |
| Trigger system | Reuse `TriggerManager` + `ScheduleTrigger` + `WebhookTrigger`. No new scheduler. |
| Persistence | Workflow execution state under `contents/data/workflow-state/` (existing). Plus `contents/agents/profiles/` + `memory/`, `contents/data/agent-inboxes/` + `agent-artifacts/`. |
| Memory model | Editable per-Profile markdown file with three mandated sections (Semantic / Episodic / Procedural), per-entry `{source: agent\|human}` markers, version snapshots, optimistic-version writes. No vector store in V1. |
| Learning loop | **End-of-run consolidation node** in every agent's workflow. Separate bounded LLM pass; only writes entries marked `source: agent`; human entries immutable to the agent. Procedural section is V1's substitute for a full skills system. |
| Within-run reflection | V2. V1 ships only end-of-run consolidation. |
| Wake-up triggers V1 | Cron + manual + webhook. Heartbeat (Hermes-style cheap "anything to do?" tick) is V1.5. |
| Where does a user add work? | **Agent Inbox** primitive (markdown files at `contents/data/agent-inboxes/<id>.md`, edited via `AdminAgentInboxesPage`, read/written by agents via auto-registered tools). |
| Dynamic step extension | **New V1 capability.** `_taskQueue` in workflow state + `createTask`/`listTasks`/`markTaskDone` tools + `drain` mode added to `LoopNodeExecutor`. Bounded by per-AgentNode `maxDepth` and the existing 200-iteration loop cap. |
| App→App nesting | **Forbidden in V1.** Stripped from synthetic tools when caller is an agent. |
| Concurrency | `maxConcurrent` per Profile, default 1, admin-configurable. Enforced at manual-trigger enqueue and at scheduled fire. |
| HITL approver | Anyone in `profile.hitl.approverGroups` (defaults to the Profile's `groups`). Group inheritance applies. |
| HITL implementation | Finish `HumanNodeExecutor` (was stub). Implicit pause path on sensitive tool/app id inside `PromptNodeExecutor`. |
| Memory auto-include cost | Auto-include on by default, `maxBytes = 8KB`. Raise via Profile. |
| Cron catchup on downtime | Skip missed; emit `schedule.missed` (handled by workflow v2). |
| Cancel mechanism | Workflow engine's existing cancel — checked at every node boundary. |
| Agent events into usage tracking | Yes — `type=agent_event` so cost reports include agent activity. |
| Multi-replica HA / cron double-fire | Single API-server process in V1 (same as workflow v2). Leader-election file lock V2. |

## Learning V1 → V2 → V3 Trajectory

V1 ships the foundation: tripartite memory, end-of-run consolidation, version snapshots, source-marker guardrail. The natural growth path (parking these explicitly so they don't accidentally creep into V1):

- **V2: Skills as first-class entities.** Promote `## Procedural` entries to a separate `contents/agents/skills/<profileId>/<skillId>.md` directory with explicit invocation lifecycle (the agent calls `useSkill(id, args)` rather than relying on prompt injection). Adds Hermes' progressive-disclosure: a lightweight skill list loads in the system prompt, full bodies fetched on demand.
- **V2: Within-run reflection.** Optional reflect/verifier node between work and consolidation that loops the AgentNode back if quality threshold isn't met. Reuses `VerifierNodeExecutor`.
- **V2: Consolidation dry-run + approval queue.** Proposed memory updates queue into `pending-consolidations/`; operators review and approve before they land. Same approver model as HITL.
- **V2: Heartbeat trigger.** Cheap periodic "anything to do?" tick. Adds a new trigger type to `TriggerManager`. Useful for inbox-watcher patterns without paying for a full run per tick.
- **V3: Curator pass.** Weekly/scheduled background agent that grades, consolidates, prunes, and archives memory entries and skills. Scope-limited like Hermes: can only modify agent-authored content.
- **V3: Cross-agent memory namespaces.** Profiles can opt into a shared memory namespace, letting a team of agents share semantic memory. Permission-scoped via groups.

## Remaining Open Questions (not blocking V1 start)

- **Artifact ACL granularity.** V1 default: only `agent-operators-<profile>` and admins read run artifacts. Decide if end-users need a `agent-consumers-<profile>` read role before T10.
- **Trigger-payload UX.** Manual-trigger modal where the operator can paste a `brief` string. Trivial; lands in T9.
- **`writeArtifact` UX.** V1: explicit tool primary + implicit fallback (final AgentNode's last message saved as `report.md` if no explicit write). Confirm fallback at T10.
- **AgentProfile inheritance.** iHub Apps support parent/child config inheritance. Skipping for V1 Profiles; revisit V2.
- **Editor UX for advanced agents.** V1 form editor handles single-AgentNode + drain-loop shapes. For multi-AgentNode DAGs with Planner/Verifier, we link to the existing React Flow workflow editor. Whether to also build an "agent-flavored" simplified DAG editor is a V2 question.
- **Inbox shape evolution.** V1 inbox is plain markdown with a checkbox-list form mode. If teams want richer items (assignee, due date, attachments), we'll evolve to a structured JSONL inbox in V2, with V1 markdown remaining as "simple mode".

## Risks

1. **`PromptNodeExecutor` extension scope creep.** We're adding several auto-registered tools and the App-as-tool gateway. Each can leak edge-case interactions with the existing tool-calling loop. Allocate full 2 days each for T3, T6; add a feature flag for App-as-tool if regressions surface.
2. **Drain-mode loop bugs.** `LoopNodeExecutor` is generic and widely used by workflows. Add `drain` carefully behind an explicit config opt-in; never default-on for existing loops.
3. **Identity bleed.** When workflows trigger sub-workflows (Planner) or HITL resumes happen, the principal must remain `agent:<profile>` consistently. Test for principal continuity across pause/resume and sub-workflow boundaries.
4. **Memory file contention.** `maxConcurrent = 1` per Profile sidesteps the race in V1. If a Profile sets `maxConcurrent > 1`, two parallel runs of the same Profile race on `memory.md`. The optimistic-version check returns 409; the LLM gets the 409 as a tool-error and is expected to retry. Document this.
5. **HITL inbox overload.** A misconfigured Profile marking too many tools sensitive will spam approvals. UI surfaces "pending approvals by Profile" prominently so misconfig is obvious.
6. **Cost surprise.** Auto-included memory + multi-node workflows + dynamic tasks + agentic loops can produce single-run cost orders of magnitude beyond a chat. Hard token + step caps on each AgentNode are enforced; per-Run `maxWallTimeSec` is the safety net; run-detail cost rollup is mandatory at T10.
7. **Cancel latency on long LLM streams.** Cancel is checked at node boundaries. A long-running LLM call inside a node continues until the call returns. Acceptable for V1; revisit if operator pain is real.
8. **Dynamic task recursion.** `maxDepth` plus the 200-iteration cap bound it, but a poorly-prompted agent can still chew through budget creating shallow tasks. Surface `task.created` rate prominently in run-detail UI.
9. **Consolidation drift.** A poorly-prompted consolidation step could fill semantic memory with garbage over many runs. Guardrails: bounded output (`maxOutputTokens`, `maxEntriesPerSection`), `source: agent` markers + immutable human entries, version snapshots for rollback, `agent.consolidation.*` events. Mitigation also needs a run-detail UI affordance: "show consolidation diff for this run" with a one-click rollback to the previous memory version.
10. **Consolidation cost.** Every run pays for one extra LLM call. For cheap models on short runs this is noise; for expensive models on long runs it can be 10–20% overhead. Mitigated by `consolidation.model` override (default to a cheap model) and `consolidation.skip` path (the consolidation LLM can choose to write nothing).

## Next Step

If this spec is approved: open T1 as the first PR — Foundation, schema, Profile CRUD. It's genuinely independent of all later tickets and creates the surface the rest of the work hangs off of. T1 + T2 + T8 together also yield the first end-to-end "agent fires on a schedule with the right identity" milestone, which is a good early proof point.
