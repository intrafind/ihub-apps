# Agent Factory — V1 Slim Scope (Revision)

**Status:** Proposal — revises the V1 spec dated 2026-05-19
**Date:** 2026-05-20
**Supersedes (partial):** [`2026-05-19 V1 Requirements and Architecture.md`](./2026-05-19%20V1%20Requirements%20and%20Architecture.md)
**Branch:** `claude/review-agent-factory-4JYM2`

This document narrows V1 to what we can ship in ~10 working days without bundling unproven features. It does **not** repeat background, mental model, or domain explanations — read the original spec for context. The original Profile-owns-workflow architecture, tripartite-memory eventual goal, and consolidation-as-learning-loop direction all stand. What changes is **what lands in V1 vs. V1.5**, and how we sequence and parallelize the work.

## Why a revision

After verifying every architectural claim in the original against the actual codebase (see `Critical Review of V1` thread on this branch), three things became clear:

1. **The original bundles ~8 distinct capabilities into V1.** Each is independently shippable and individually evaluable. Bundling them creates a long critical path with no intermediate evidence that the architecture works.
2. **Two factual claims in the original change effort estimates materially.**
   - `HumanNodeExecutor` is NOT a stub. It is 283 lines, fully implemented, with checkpoint + resume + schema validation. The only real gap is approver-group validation (~15 lines). **T7 shrinks from 2 days to ~0.5 days.**
   - `ChatService.invokeAppInternal()` is NOT a thin wrapper. `StreamingHandler` / `NonStreamingHandler` / `ToolExecutor` are tightly coupled to the Express `res` object. Decoupling to an in-memory sink touches 3 files, ~200-300 lines, with new tests. **T6 grows from 2 days to ~4-5 days.**
3. **Two features in the original have no V1 cost/benefit evidence yet:**
   - Tripartite memory (`## Semantic` / `## Episodic` / `## Procedural`) adds structure we cannot evaluate without runs.
   - End-of-run consolidation adds a separate LLM pass on every run (~10-20% cost overhead) with no eval harness to verify it produces useful memory rather than drift.

This revision keeps the durable architecture, defers the unproven mechanisms, and corrects the effort estimates.

## What's in V1 (locked)

| # | Capability | Source | Status |
|---|---|---|---|
| 1 | AgentProfile schema + CRUD + V042 migration | Original T1 | unchanged |
| 2 | Service-account identity (`agent:<profileId>`) flowing through `enhanceUserWithPermissions` | Original T2 | unchanged |
| 3 | Manual + cron + webhook triggers (reuse workflow v2 wholesale) | Original T8 | unchanged |
| 4 | **Single-section** memory file with `readMemory` / `writeMemory` / auto-include into AgentNode system prompt | Original T4 (slimmed) | **simplified** |
| 5 | Inbox primitive (markdown, `readInbox` / `writeInbox` tools, admin page) | Original T5 | unchanged |
| 6 | App-as-tool gateway via `ChatService.invokeAppInternal()` (with realistic effort) | Original T6 | **kept, effort revised** |
| 7 | **Planner + dynamic-task merge**: Planner produces initial task list → materializes sub-DAG that *ends in* a `drain`-mode loop → agent nodes may `createTask()` during execution to extend the queue | Original T3 + Planner reuse | **merged** |
| 8 | HITL completion: explicit `human` node + approver-group validation | Original T7 (slimmed) | **simplified** |
| 9 | Artifacts: `writeArtifact` tool + per-run artifact endpoints + downloadable from run-detail UI | Original T10 (slimmed) | unchanged |
| 10 | Admin UI: Profiles list/edit, Memory editor, Inboxes, Profile detail (Overview/Runs/Artifacts/Memory/Inbox tabs), Runs list, Run detail with live event stream, approvals page | Original T9 | unchanged |

## What's deferred (and why)

| Feature | Original ticket | Deferred to | Reason |
|---|---|---|---|
| Tripartite memory sections | T4 | V1.5 | Add structure once we have runs proving we need it; LLM reads single-section MD fine |
| Memory `{source: agent\|human}` per-entry markers + immutability rule | T4 | V1.5 | Bundled with tripartite; same justification |
| Memory `.v{N}.md` version snapshots | T4 | V1.5 | Git tracks `contents/agents/memory/` already; rollback story is `git checkout` for V1 |
| End-of-run consolidation node + `ConsolidationNodeExecutor` | T4.5 | V1.5 | Unproven cost/benefit; needs eval harness to validate output; risk of memory drift without source markers |
| Implicit pause on sensitive tool/app id | T7 | V1.5 | Authors can use explicit `human` node in their workflow for V1; sensitive-tool autodetection is a polish |
| Per-Profile artifact ACL groups (`agent-consumers-*`) | T10 | V1.5 | Default = operators + admins is fine for lighthouse |
| Heartbeat trigger | original V1.5 | V1.5 | Already deferred in original |

## Factual corrections to the original spec

The following lines in the original need correction when we close out the V1 spec:

- `## Goals (V1)` item 10: "HITL — finish the stubbed `HumanNodeExecutor`" → **rephrase**: "HITL — extend `HumanNodeExecutor` with approver-group validation (file is already complete; only the group check is missing)."
- `## Build Order` T7 row: "Finish `HumanNodeExecutor`" → "Add approver-group validation in `HumanNodeExecutor.resume()`."
- `## Architecture / HITL` section: drop "exists as a stub. We complete it" — the executor is production-grade today; only group-scoped approval is missing.
- `## Build Order` T6 row: "App-as-tool gateway · 2 d" → "**App-as-tool gateway · 4-5 d**". The ChatService refactor to support an in-memory sink is the actual work; tool registration in `PromptNodeExecutor` is the small part.
- `## Risks` should add: "T6 is the single highest-effort and highest-risk ticket; the streaming path is tightly coupled to `res` today."

## The Planner + Dynamic Task merge (V1's most interesting mechanic)

The original spec treats `PlannerNodeExecutor` (exists, mature) and dynamic task extension (new) as parallel decomposition primitives. **They're better as one mechanic:**

```
                       ┌─────────────┐
trigger → start ──────▶│ planner     │── produces task list →─┐
                       └─────────────┘                        │
                                                              ▼
                              ┌─────────── sub-DAG materialized by Planner ──────────┐
                              │  start → task_1 → task_2 → ... → task_N → drain loop │
                              │                                              │       │
                              └──────────────────────────────────────────────┼───────┘
                                                                             │
                       ┌──────────────┐                                      │
                       │ drain loop   │◀─── agent in any task_i can ────────┘
                       │  (new mode)  │     call createTask() to enqueue
                       └──────────────┘     more tasks; drain processes them
                                │
                            (queue empty)
                                │
                                ▼
                              end
```

**The interoperation:**

- Planner runs first and emits an initial task list of size N (existing behavior; `SubWorkflowMaterializer` handles it). Profile authors can set the planner's max-tasks low to keep the initial plan focused.
- `SubWorkflowMaterializer` is extended: the materialized sub-DAG ends with a `loop` node in the new `drain` mode whose `child` is a generic task-runner AgentNode. This is a one-place change to `SubWorkflowMaterializer`.
- The initial tasks ARE the seed entries in `state.data._taskQueue`. Each task carries `{id, title, brief, priority, status, depth: 0, parentTaskId: null, createdBy: 'planner'}`.
- During execution of any task, the AgentNode may call `createTask({title, brief, priority})`. The new task is appended to `_taskQueue` with `depth = parent.depth + 1` and `parentTaskId = parent.id`.
- The drain loop pops the next `status: 'open'` task on every iteration boundary, sets `status: 'in_progress'`, invokes the child, then marks `status: 'done'` (or `failed` on error).
- **Bounded by:** existing 200-iteration `LoopNodeExecutor` cap, per-Profile `dynamicTasks.maxDepth` (default 3), per-Run `maxWallTimeSec`.
- **For Profiles that don't need decomposition:** set `planner.enabled: false` and `dynamicTasks.enabled: false` — workflow degrades to a simple `start → AgentNode → end` shape.
- **For Profiles that need only decomposition without runtime extension:** set `dynamicTasks.enabled: false` — Planner produces a fixed plan, executes, no drain loop needed.
- **For Profiles that need only runtime extension:** set `planner.enabled: false` — drain loop seeds from an initial AgentNode that pushes tasks, like the lighthouse demo.

This gives **one decomposition primitive with three configurations**, instead of two competing primitives. The build cost is unchanged from the original: `~30-40 lines` for the drain mode, `~20 lines` in `SubWorkflowMaterializer` to optionally append the drain tail, `~50 lines` for the three task tools.

`agent.task.created` / `agent.task.completed` / `agent.task.failed` / `loop.drained` events emitted into the existing workflow event stream.

## App-as-tool (kept; effort revised)

The user's argument for keeping App-as-tool in V1 is sound and worth stating explicitly:

> **Apps are tested, reusable, composable units of LLM behavior.** A `doc-summarizer` App bundles "what tools/sources/system prompt does summarization need" into one named entity. An author can build small custom Apps, smoke-test them in chat, then wire them as verbs an agent calls. Apps abstract "how to call what and when" — exactly what we want agents to consume rather than re-invent.

This is correct and the right reason to keep App-as-tool in V1. The cost is the `ChatService` refactor, not the synthetic-tool registration.

**Refactor scope (revised):**

1. Introduce a `StreamSink` abstraction inside `server/services/chat/`. Two implementations: `ExpressResSink` (current behavior, default) and `InMemorySink` (buffers chunks, exposes final assembled response + tool calls + usage).
2. `StreamingHandler`, `NonStreamingHandler`, and `ToolExecutor` accept a `sink` parameter instead of `clientRes`. The Express response path becomes `sink = new ExpressResSink(res)`; nothing changes for chat callers.
3. `ChatService.invokeAppInternal({appId, user, messages, modelOverride, variables, abortSignal, runId})` constructs an `InMemorySink`, runs the standard chat pipeline against it, returns `{status, finalMessage, toolCalls, usage, citations, artifacts}`.
4. Add `app__<appId>` synthetic tool registration in `PromptNodeExecutor` for any AgentNode whose `config.apps` is non-empty. Tool description = `app.description.en`, parameters = `zod-to-json-schema(app.variables)`.
5. App→App nesting guard: in `invokeAppInternal`, if `user.isAgent === true`, strip `app__*` synthetic tools from the prepared tools list (other tools and sources flow normally).
6. Feature flag `features.appAsTool` (default off in V1, on for the lighthouse demo) — gives us a kill switch if regressions surface in chat after the streaming refactor lands.

**Effort: 4-5 focused days.** Allocate this as its own track (Phase 3 below) and land it behind the feature flag so it can ship before agent factory uses it.

## Domain model (slimmed from original)

The original AgentProfile shape stays, with these simplifications:

```jsonc
{
  "id": "todo-worker",
  "name":        { "en": "...", "de": "..." },
  "description": { "en": "...", "de": "..." },
  "color": "#6366F1",
  "icon":  "robot",

  "workflow": { "ref": "embedded", "definition": { /* ... */ } },

  "memory": {
    "enabled":     true,
    "autoInclude": true,
    "maxBytes":    8192
    // REMOVED for V1: priorVersions (use git)
    // REMOVED for V1: tripartite section config
  },

  // REMOVED for V1: "consolidation": { ... }

  "inboxId": "engineering-todos",

  "hitl": {
    // V1: only explicit `human` nodes in the workflow trigger HITL.
    // REMOVED for V1: requireApprovalFor (sensitive-tool autodetection is V1.5)
    "approverGroups": ["agent-operators-todo-worker"]
  },

  "planner": {
    "enabled":   false,                    // opt in per Profile
    "maxTasks":  10                        // bound on initial plan size
  },
  "dynamicTasks": {
    "enabled":   true,                     // opt in per Profile
    "maxDepth":  3
  },

  "budgets": {
    "maxWallTimeSec":   600,
    "maxTokensPerRun":  500000             // NEW: token ceiling per Run (in addition to per-node maxIterations)
  },

  "concurrency":     { "maxConcurrent": 1 },
  "artifacts":       { "outputDir": "auto", "primary": "report.md" },
  "groups":          ["agent-operators-todo-worker"],
  "serviceAccount":  { "groups": ["agents", "authenticated"] },
  "enabled":         true
}
```

Memory file (`contents/agents/memory/<profileId>.md`) becomes plain markdown with optional frontmatter — no mandated sections. Agents append; humans hand-edit. Git is the audit + rollback story for V1.

## Revised build order

Total: **~10 working days** with parallel agent dispatch.

### Phase 1 — Independent foundations (~2 days, 4 agents in parallel)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **A** | T1 — Foundation, schema, CRUD | 2 d | `agentProfileSchema.js`, `agentsLoader.js`, `configCache` integration, `V042__add_agent_factory.js`, `/api/admin/agents/profiles` routes |
| **B** | T2 — Service-account identity | 1 d | `isAgent` branch in `enhanceUserWithPermissions`, `agent:<profileId>` principal construction, V042 seeds `agents` + `agent-operators` groups, **TriggerManager principal injection** |
| **C** | T4-slim — Memory file (single-section) | 1.5 d | `readMemory` / `writeMemory` tools auto-registered for agent runs, auto-include into AgentNode system prompt with `maxBytes` cap, optimistic-version writes |
| **D** | T5 — Inbox primitive | 1.5 d | Storage + schema, `readInbox` / `writeInbox` tools, `/api/admin/agents/inboxes` routes, version-checked writes |

### Phase 2 — Trigger surface + HITL polish (~2 days, 2 agents in parallel; depends on Phase 1)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **E** | T8 — Trigger plumbing | 1.5 d | `POST /api/agents/profiles/:id/runs` (manual), webhook alias route, concurrency enforcement (default 1), Profile-aware schedule registration |
| **F** | T7-slim — Approver-group validation | 0.5 d | Group check in `HumanNodeExecutor.resume()` against `profile.hitl.approverGroups`; `agent.hitl.requested` / `.approved` / `.rejected` events |

### Phase 3 — App-as-tool track (~5 days, 1 focused agent; parallel to Phase 2 and 4)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **G** | T6 — App-as-tool + ChatService refactor | 4-5 d | `StreamSink` abstraction (`ExpressResSink` / `InMemorySink`), `StreamingHandler` / `NonStreamingHandler` / `ToolExecutor` accept sinks, `ChatService.invokeAppInternal()`, `app__*` synthetic tools in `PromptNodeExecutor`, App→App nesting guard, `features.appAsTool` flag, regression tests for chat streaming |

### Phase 4 — Planner + Dynamic Task merge (~2 days, 1 agent; depends on Phase 1)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **H** | T3-merged — Drain mode + dynamic task tools + Planner integration | 2 d | New `drain` mode in `LoopNodeExecutor` (~40 lines), `createTask` / `listTasks` / `markTaskDone` tools (~50 lines), `SubWorkflowMaterializer` appends drain tail when `dynamicTasks.enabled` (~20 lines), depth tracking, `agent.task.*` events, tests for queue drain + max-depth + 200-iter bound |

### Phase 5 — UI (~5 days, 1 agent; depends on Phases 1+2)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **I** | T9-slim — Admin UI | 5 d | `AdminAgentsPage`, `AdminAgentEditPage` + `AgentProfileFormEditor` (`AppMultiSelector`, `InboxPicker`, `ScheduleEditor`, `MemoryConfigEditor`, `BudgetEditor`, `DynamicTasksToggle`, `PlannerToggle`), `AdminAgentMemoryPage`, `AdminAgentInboxesPage`, `AgentProfileDetailPage` (Overview/Runs/Artifacts/Memory/Inbox tabs), `AgentRunsPage`, `AgentRunDetailPage` (live SSE, task-queue widget, artifact downloads, HITL banner), `AdminAgentApprovalsPage`, nav integration, `App.jsx` + `runtimeBasePath.js` updates |

### Phase 6 — Polish + lighthouse (~1.5 days; depends on Phases 3+4+5)

| Agent | Ticket | Effort | Output |
|---|---|---|---|
| **J** | T10-slim — Artifacts + docs + demo | 1.5 d | `writeArtifact` tool + implicit-fallback (final assistant message → `report.md`), per-Profile artifacts endpoint, OTel `agent.run` root span, `docs/agents.md`, lighthouse demo wired end-to-end |

### Critical path

```
Phase 1 (2 d) ─┬─▶ Phase 2 (2 d) ─┬─▶ Phase 5 (5 d) ─▶ Phase 6 (1.5 d)
               │                  │
               ├─▶ Phase 4 (2 d) ─┘
               │
               └─▶ Phase 3 (5 d) ─────────────────────▶ ↑ feeds Phase 5/6
```

**Wall clock: ~10 working days** assuming Phase 3 starts in parallel and doesn't block Phase 5 except on the App-as-tool form field. Phase 3 is the long pole and the only true risk to the schedule.

## Verification — Lighthouse Demo (revised)

Same lighthouse use case (scheduled TODO worker reading an inbox and writing artifacts), simplified to the V1 surface:

1. Create an inbox `engineering-todos` via `AdminAgentInboxesPage`. Add 3 items.
2. Create a `todo-worker` Profile in `AdminAgentEditPage`:
   - `inboxId: engineering-todos`
   - `apps: [doc-summarizer]` (tests App-as-tool)
   - `planner.enabled: false` (lighthouse doesn't need it; we test Planner separately with a different demo)
   - `dynamicTasks.enabled: true, maxDepth: 2` (lighthouse uses dynamic-only path)
   - Schedule: `*/15 * * * *`
   - HITL: explicit `human` node in the workflow between "draft artifact" and "mark inbox done" so an operator sees the approval flow
3. Save Profile. Verify file on disk; verify `TriggerManager` registers the schedule.
4. Trigger manually from Profile detail page.
5. Observe in `AgentRunDetailPage` (live SSE):
   - `agent.run.started` → `node.started(seed)` → `agent.inbox.read` → `llm.request` → `agent.task.created` (one or two sub-tasks) → `node.started(drain)`
   - Drain iteration 1: task runs, `agent.app.call(doc-summarizer)` → `agent.app.result` → `agent.artifact.written`
   - Drain iteration 2: another sub-task processed
   - `node.started(human)` → `agent.hitl.requested` → run pauses, banner appears
6. Approve from the banner (logged in as user in `agent-operators-todo-worker`). Run resumes.
7. Final `agent.inbox.write` (`markDone`) → `agent.run.completed`.
8. Open the artifact — renders as Markdown in-page.
9. Reload inbox — worked item is `[x]` with agent attribution.
10. Open memory file in `AdminAgentMemoryPage` — verify the agent appended a note via `writeMemory` during the run. (No consolidation; no tripartite sections to validate.)
11. Edit memory file by hand, save, verify next run sees the new content.
12. Trigger a second run. Confirm new content from inbox is picked up.
13. Cancel a running run; restart the API server mid-run (verify `orphanSweeper.js` marks orphaned execution `failed`).
14. Audit: `cat contents/data/workflow-state/<execId>/history.jsonl | jq 'select(.type | startswith("agent."))'`.

Acceptance: every step works without intervention beyond what the script describes. Steps 10-11 are noticeably simpler than the original; this is intentional.

## What we'll learn before V1.5

Running V1 for ~2 weeks before scoping V1.5 lets us answer:

- Do agents actually produce useful artifacts, or do they spin? (validates the runtime)
- Does manual memory editing happen enough that the source-marker rule matters? (validates tripartite-structure investment)
- Do operators end up wanting more memory rollback than `git checkout` gives them? (validates `.v{N}.md` snapshots investment)
- Does the cost per run trend toward sustainable, or does it explode with dynamic tasks? (validates token-budget design and motivates consolidation as a cost-control rather than learning mechanism)
- Are explicit `human` nodes sufficient, or do authors keep forgetting to wire them and complain that "sensitive tools should auto-pause"? (validates implicit-pause investment)

These five questions are the prioritization function for V1.5 scope.

## Open questions for V1 scoping

1. **Planner demo profile** — separate from the lighthouse, do we want a second demo (e.g., "research-and-summarize agent") that exercises Planner + drain? Recommend yes, written as a separate acceptance test on top of T10.
2. **Token budget enforcement granularity** — `maxTokensPerRun` is new in this revision. Enforced at which boundary: per LLM call return (early), per AgentNode end (late), or rolled forward continuously? Recommend: tally on every `llm.response` event, check before next `llm.request`, cancel run if exceeded. ~30 lines in `PromptNodeExecutor`.
3. **App-as-tool feature flag** — should the flag default ON in dev / staging and OFF in production for the first deploy? Recommend ON in dev, OFF in production until we have a week of clean chat-streaming traffic post-refactor.
4. **Profile Inheritance** — Apps have it, Profiles in V1 do not. Confirm OK to defer.

## Risks (revised, ordered by severity)

1. **Phase 3 ChatService refactor regresses chat streaming.** This is the only ticket that touches code chat users depend on. Mitigation: keep `ExpressResSink` byte-identical to current behavior; merge refactor without enabling `app__*` registration; bake for 3-5 days against the existing chat workflow tests; then enable App-as-tool behind the feature flag.
2. **Dynamic-task depth runaway.** A poorly-prompted agent can create shallow tasks fast and exhaust budget. Bounded by `maxDepth`, 200-iter cap, `maxWallTimeSec`, and the new `maxTokensPerRun`. Surface task-creation rate prominently in `AgentRunDetailPage`.
3. **Schedule fires while previous run still in flight.** Concurrency limit (default 1) handles this — schedule fire returns 409 and emits `schedule.skipped`. Spec the operator UI to show skipped fires clearly.
4. **Agent principal continuity across sub-workflows.** When `PlannerNodeExecutor` invokes a sub-workflow, the principal must remain `agent:<profileId>`. Add a continuity test for this in Phase 4.
5. **Memory file race when `maxConcurrent > 1`.** Optimistic-version check returns 409; agent gets the 409 as a tool-error and is expected to retry. V1 default of 1 sidesteps. Document.
6. **No eval / drift detection.** V1 has no automated way to detect "agent memory is degrading." Mitigated by V1's git-tracked memory (humans can review diffs in PR). V1.5 adds the consolidation eval story.

## Next step

Open T1 + T2 + T4-slim + T5 + Phase 3 (App-as-tool refactor) as five parallel PRs targeting `claude/review-agent-factory-4JYM2` (or whichever working branch). Phase 3 starts immediately because it has the longest individual effort and zero dependencies. The remaining tickets join in as their dependencies clear.
