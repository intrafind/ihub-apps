# Agent Factory (V1)

The Agent Factory turns iHub Apps into a control plane for an organization's AI
workforce. Agents are autonomous Profile-defined entities that wake on their
own (cron, webhook, manual trigger), do multi-step work using iHub's apps,
tools, sources, and models, ask a human only when they need approval, and
leave durable artifacts behind.

> **"What an iHub App is to a chat session, an iHub Agent is to a job that runs by itself."**

## Concepts

| Concept | Description |
|---|---|
| **AgentProfile** | One JSON file per agent at `contents/agents/profiles/<id>.json`. Owns an embedded workflow definition, memory config, inbox binding, HITL approver groups, concurrency limits, and budget settings. |
| **AgentRun** | A `WorkflowExecution` enriched with an `_agent` envelope. Lives in `contents/data/workflow-state/<execId>/`. |
| **Memory file** | Plain markdown at `contents/agents/memory/<profileId>.md`, optionally auto-included into every agent prompt up to `memory.maxBytes`. Optimistic-version writes. |
| **Inbox** | Markdown checklist at `contents/data/agent-inboxes/<id>.md`. Users add work; agents read/mark-done via `read_inbox`/`write_inbox`. |
| **Service-account identity** | Agent runs execute as `agent:<profileId>` principals. Groups in `profile.serviceAccount.groups` determine what apps/tools/models the agent can use. `isAdmin` is forced false. |
| **Dynamic tasks** | Agents may call `create_task` to enqueue work onto `state.data._taskQueue`. A drain-mode loop processes the queue until empty (bounded by `dynamicTasks.maxDepth` and the existing 200-iteration cap). |
| **App-as-tool** | When `features.appAsTool: true` and a node has `config.apps: [appId, ...]`, the LLM sees `app__<appId>` synthetic tools that call into `ChatService.invokeAppInternal`. App→App nesting is forbidden. |
| **HITL** | Explicit `human` nodes in the workflow pause until an operator in `profile.hitl.approverGroups` approves via `POST /api/agents/runs/:runId/approve`. |
| **Artifacts** | Agents call `write_artifact({ name, content })` to persist to `contents/data/agent-artifacts/<execId>/`. Each run can produce multiple artifacts. |

## Quick start

1. Enable the factory (turned on by default after V042 migration):
   ```jsonc
   // contents/config/platform.json
   {
     "features": { "agentFactory": true, "appAsTool": false }
   }
   ```
2. Create an inbox: visit `/admin/agents/inboxes` → "Create inbox" with id `engineering-todos`.
3. Create a profile: visit `/admin/agents` → "New profile". Fill in identity,
   set `inboxId`, enable `dynamicTasks`, optionally configure a cron schedule.
4. Trigger manually from the list page (`Run` button) or wait for the schedule.
5. Watch the run live at `/admin/agents/runs/:runId`.

## Auto-registered tools

Every agent run gets these tools merged into its toolset (in addition to any
configured per-node `tools`):

| Tool | Description |
|---|---|
| `read_memory` | Read the agent's long-term memory file. |
| `write_memory` | Append or replace memory body. Optimistic-version write. |
| `read_inbox` | Read the bound inbox (or override via `inboxId`). |
| `write_inbox` | Add / markDone / replace items. |
| `create_task` | Push a new open task onto `_taskQueue`. Honors `dynamicTasks.maxDepth`. |
| `list_tasks` | View current queue items. |
| `mark_task_done` | Explicitly complete a queue item. |
| `write_artifact` | Save a named file under the run's artifact directory. |

Memory tools are always on. Inbox tools require `profile.inboxId`. Dynamic-task
tools require `dynamicTasks.enabled` on the node (or profile).

## App-as-tool feature flag

`features.appAsTool` defaults to **OFF** for safety. Turning it on lets
profiles list `apps` on a `prompt` node; those apps then become callable verbs
the LLM can invoke. The agent principal flows through `canUserAccessResource`,
so admins control reach by listing the right groups on the app and on
`profile.serviceAccount.groups`.

App→App nesting is forbidden: when an agent calls an app internally, all
`app__*` tools are stripped from the nested call's tool list.

## Workflow shapes

The Profile editor lets you pick the underlying shape implicitly:

- **`simple`** — no Planner, no dynamic tasks. `start → agent → end`.
- **`drain-only`** — `dynamicTasks.enabled: true`. `start → seed(prompt) → drain(loop) → end`.
- **`planner+drain`** — `planner.enabled: true` and `dynamicTasks.enabled: true`. Planner emits N tasks; the materialized sub-DAG ends in a drain tail.
- **`planner+review-loop`** — `planner.enabled: true` and `review.enabled: true`. Planner runs inside a `while` loop with a toolless reviewer that judges sufficiency; on insufficient runs, the planner re-runs with prior task results and reviewer-identified gaps surfaced, emitting only new gap-closing tasks (id-namespaced `r{round}_*`).

Power users can hand-author the workflow in `profile.workflow.definition` and
mix Verifier, additional Loops, etc.

### Memory pipeline (`memory-compose` → `memory-finalize`)

When `memory.enabled !== false` (the default), the planner / inbox-worker
shapes append a two-step memory tail after the synthesizer:

```
… → synthesize → memory-compose (LLM, toolless) → memory-finalize (deterministic) → [inbox-finalize?] → end
```

1. **`memory-compose`** is an explicit toolless LLM prompt that sees the
   brief, the inbox item, every sub-task result, the citations ledger,
   the tools/apps the agent used, and the current memory file. It
   returns a flat `{ skip, mode, content, summary }` JSON object
   describing what (if anything) from this run is worth committing to
   long-term memory. The composer is instructed to cite the tool/URL
   behind each fact, skip duplicates already in memory, and prefer
   `append` over `replace`. Operator-overridable via `memory.modelId`,
   `memory.temperature` (default 0.2), `memory.system`, and
   `memory.prompt`. Splitting this from the synthesizer keeps the report
   writer focused on the report and avoids cross-provider schema
   headaches (Gemini's proto schema rejects union types like
   `["object", "null"]`).
2. **`memory-finalize`** is deterministic — no LLM call. It drains
   `state.data._pendingMemoryUpdates` (populated by `memory-compose`'s
   auto-persist branch in `PromptNodeExecutor`) and writes via
   `memoryFile.writeMemory()`. Because no LLM is involved, the write is
   immune to the Gemini grounding swap that would otherwise strip the
   legacy `write_memory` LLM tool.

The synthesizer itself is plain markdown (no `outputSchema`) — keeping
the report and memory responsibilities split so a structured-output
failure on one path can never break the other.

The legacy `write_memory` LLM tool stays auto-registered as an in-run
escape hatch for compose flows that want to write mid-run.

### Plan-and-review loop (`review.enabled`)

Opt-in via:

```json
"review": {
  "enabled": true,
  "maxRounds": 3,
  "modelId": "optional",
  "system": { "en": "optional custom reviewer system prompt" }
}
```

The reviewer returns structured JSON
`{ needs_more_work, rationale, gaps[] }`. The loop re-enters the planner
when `needs_more_work === true` and the round budget isn't spent; the
planner sees `state.data._taskResults` (prior rounds' work) and
`state.data._lastReviewGaps` (reviewer-identified gaps) and emits only
new gap-closing tasks. Task ids are namespaced `r{round}_*` to keep
`_taskResults` keyed cleanly across rounds. Hard cap of
`review.maxRounds + 1` iterations defends against runaway loops; the
shared planner budget (`_planBudget`) caps total tasks across rounds.

## HITL approval

Place a `human` node anywhere in the workflow. When it executes, the run pauses
and `agent.hitl.requested` is emitted. An operator (member of
`profile.hitl.approverGroups`) calls `POST /api/agents/runs/:runId/approve`
with `{ checkpointId, response }` to resume; `agent.hitl.approved` /
`agent.hitl.rejected` fires.

## Demos shipped

Two demo Profiles ship disabled in `contents/agents/profiles/`:

1. **`todo-worker.json`** — drain-only path. Reads inbox, dynamic-tasks fan-out, writes artifact, marks done.
2. **`research-and-summarize.json`** — Planner + drain. Plans tasks, runs them, drain handles sub-tasks.

Enable them by setting `"enabled": true` in their JSON, then trigger from the
admin UI.

## Out of scope for V1

These pieces are explicitly **deferred to V1.5+** — see `concepts/agent-factory/2026-05-20 V1 Slim Scope.md`:

- Tripartite memory sections (Semantic / Episodic / Procedural)
- Per-entry `{source: agent|human}` markers and immutability
- End-of-run consolidation node + `ConsolidationNodeExecutor`
- `priorVersions` snapshots (git is the V1 audit story)
- `maxTokensPerRun` budget enforcement
- Implicit pause on sensitive tool/app calls (`requireApprovalFor`)
- Sub-agent delegation / multi-agent handoffs
- Vector store / semantic recall
- Heartbeat trigger
- App→App nesting

## Events

Agent-specific events emitted into the workflow event stream (filterable on the
run-detail page):

- `agent.memory.read` / `agent.memory.write`
- `agent.inbox.read` / `agent.inbox.write`
- `agent.task.created` / `.completed` / `.failed`
- `agent.artifact.written`
- `agent.hitl.requested` / `.approved` / `.rejected`
- `agent.app.call` / `agent.app.result` (when App-as-tool is enabled)

## File layout

```
contents/
  agents/
    profiles/<profileId>.json        AgentProfile config
    memory/<profileId>.md            Per-profile long-term memory
  data/
    agent-inboxes/<inboxId>.md       User-editable work queues
    agent-artifacts/<runId>/*        Per-run artifact outputs
    workflow-state/<execId>/         Existing — agent runs land here
```
