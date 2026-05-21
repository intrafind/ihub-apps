# Agent Lifecycle Redesign — V1 Hardening

**Status**: implemented (this branch).
**Replaces**: prompt-as-firewall pattern in `profileWorkflowSerializer.js` (`"DO NOT include orchestration steps"`); `read_inbox` / `write_inbox` / `write_artifact` / `mark_task_done` as default LLM tools.

## Why this change

The first V1 implementation routed deterministic lifecycle work through the LLM as tool calls. Three things converged into one bug class:

1. Each profile author put orchestration verbs ("On each wake call `read_inbox`, do the work, call `write_artifact`, then `write_inbox(mode=markDone)`") into `profile.system`.
2. The serializer propagated that same `system` into every materialized planner task.
3. The serializer also injected its own hard-coded prompts for `load-inbox`, `planner`, and `finalize` — three additional, conflicting instruction sets.

Result: the planner regularly hallucinated lifecycle tool calls, marked the wrong inbox item, or duplicated artifact writes. Every fix added more `"DO NOT…"` prose, which models routinely ignored.

The redesign separates the LLM's job from the runtime's job.

## New lifecycle

For inbox-bound profiles with the planner enabled:

```
start
  ↓
inbox-load           [deterministic — runtime reads inboxStore, picks top item, writes state.data.currentInboxItem]
  ↓
planner              [LLM, NO tools — returns JSON plan]
  ↓
task_1 … task_N      [LLM with research tools only; runtime auto-persists each task result]
  ↓
synthesize           [LLM, NO tools — pure text-in/text-out]
  ↓                  [runtime persists synthesizer output as profile.artifacts.primary]
inbox-finalize       [deterministic — runtime marks inbox item done via inboxStore]
  ↓
end
```

Variants:

| Profile shape          | Workflow                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| inbox + planner        | `start → inbox-load → planner → tasks → synthesize → inbox-finalize → end`      |
| inbox + no planner     | `start → inbox-load → agent → synthesize? → inbox-finalize → end`               |
| no inbox + planner     | `start → planner → tasks → synthesize → end`                                    |
| no inbox + no planner  | `start → agent → end`                                                           |
| dynamicTasks + no inbox| drain-only loop (unchanged from earlier V1)                                     |

## Configuration boundary

| Profile field                  | Used by                          | Example                                                       |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `profile.system`               | Every planner task / main-task   | "You are a research analyst with deep enterprise expertise." |
| `profile.planner.system`       | Planner LLM call only            | "You are a planner. Decompose the brief into N tasks…"        |
| `profile.planner.goal`         | Planner LLM call only            | `## Item\n${$.data.currentInboxItem}\n\n## Brief\n${$.data.brief}` |
| `profile.planner.modelId`      | Planner LLM call only            | Optional override; defaults to `profile.preferredModel`       |
| `profile.synthesizer.system`   | Synthesizer LLM call only        | "You are a synthesizer. Compose one cohesive markdown…"       |
| `profile.synthesizer.prompt`   | Synthesizer LLM call only        | `## Brief\n…\n{{previousTaskResults}}\n\nProduce the report.` |
| `profile.synthesizer.modelId`  | Synthesizer LLM call only        | Optional override                                             |
| `profile.synthesizer.enabled`  | Workflow shape                   | `false` skips the synthesize step                             |
| `profile.tools[]`              | Task executors (research tools)  | `["webSearch"]`                                               |
| `profile.apps[]`               | Task executors (App-as-tool)     | `["ihub-support-bot"]`                                        |
| `profile.sources[]`            | Task executors                   |                                                               |

## Tool surface

The LLM no longer has access to deterministic lifecycle operations.

| Tool             | Status v1.0+                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `read_inbox`     | Removed from `ALWAYS_ON`. Runtime calls `inboxStore.readInbox()` from `inbox-load` node.                    |
| `write_inbox`    | Removed from `ALWAYS_ON`. Runtime calls `inboxStore.markInboxItemDone()` from `inbox-finalize` node.        |
| `write_artifact` | Removed from `ALWAYS_ON`. Runtime auto-persists synthesizer + per-task results via `writeArtifactDirect()`. |
| `mark_task_done` | Removed from `ALWAYS_ON`. Runtime auto-marks the task in `_taskQueue` after the LLM returns.                |
| `create_task`    | Kept — legitimate LLM agency for dynamic decomposition during research.                                     |
| `list_tasks`     | Kept — read-only introspection.                                                                             |
| `read_memory`    | Kept — LLM-driven memory management is intentional.                                                         |
| `write_memory`   | Kept — same.                                                                                                |
| webSearch / apps / sources | Kept — research tools for task executors.                                                         |

The removed tools are still defined in `config/tools.json` (so existing profiles that explicitly list them in `profile.tools[]` continue to work as an escape hatch), but they are no longer auto-attached to every agent prompt by the registrar.

Synthesizer nodes (`_isSynthesizer: true`) get NO tools at all — they are pure text-in/text-out.

## What the runtime now owns

| Operation                | Where it lives                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Inbox read + item pick   | `InboxLoadNodeExecutor` (deterministic, no LLM)                                               |
| Inbox mark-done          | `InboxFinalizeNodeExecutor` (deterministic, no LLM)                                           |
| Per-task result persist  | `PromptNodeExecutor._autoPersistResult` for nodes with `_isPlannerTask: true`                 |
| Task auto-mark done      | Same — runtime sets `_taskQueue[i].status = 'done'` on LLM return                             |
| Final artifact persist   | `PromptNodeExecutor._autoPersistResult` for nodes with `_isSynthesizer: true`                 |
| Per-task artifact file   | Same — writes `task_<id>.md` via `writeArtifactDirect`                                        |
| `{{previousTaskResults}}` | `PromptNodeExecutor._formatPreviousTaskResults` — formats `state.data._taskResults` to markdown |

## Migration path

`V047__split_planner_synthesizer_and_scrub_orchestration.js` runs automatically on next boot:

1. Scrubs orchestration verbs from `profile.system` and any embedded `taskTemplate.system` using regex patterns like `/call (read_inbox|write_inbox|write_artifact|mark_task_done)/i`, `/On each wake[^.]*\.?/i`.
2. Seeds `profile.planner.{system, goal}` defaults when the planner is enabled.
3. Seeds `profile.synthesizer.{system, prompt}` defaults when the planner is enabled OR an `inboxId` is set.
4. Wipes `profile.workflow.definition` for embedded workflows so the new serializer rebuilds the workflow shape on next save/load. External workflow refs are left untouched.

Migration is idempotent: profiles already in canonical shape are skipped.

## Verification

Boot output for `testrunner-1` after V047:

```text
Scrubbed orchestration prose from agents/profiles/testrunner-1.json profile.system
Set default planner.system for agents/profiles/testrunner-1.json
Set default planner.goal for agents/profiles/testrunner-1.json
Set default synthesizer.system for agents/profiles/testrunner-1.json
Set default synthesizer.prompt for agents/profiles/testrunner-1.json
Wiped embedded workflow.definition for agents/profiles/testrunner-1.json (will rebuild)
Migrated 2 agent profile file(s) to split planner/synthesizer config
```

Subsequent `serializeProfile(testrunner)` emits the new lifecycle shape:

```text
start → inbox-load → planner → synthesize → inbox-finalize → end
```

End-to-end run on `testrunner-1` (manual trigger via admin UI) should show:

- `agent.inbox.read` (from runtime, no LLM)
- `agent.plan.generated` (planner LLM call, no tool calls)
- One `agent.task.completed` per planner task + per-task artifact event
- Synthesizer LLM call (single turn, no tool calls)
- `agent.artifact.written` for the primary artifact (`report.md`)
- `agent.inbox.marked_done` (from runtime, no LLM)
- No `agent.tool.hallucinated` events — the LLM no longer has lifecycle tools to hallucinate

Dynamic decomposition still works: planner tasks may call `create_task()` to enqueue follow-up work, which the drain loop processes and feeds into the synthesizer.

## Files touched

- `server/validators/agentProfileSchema.js` — extended `plannerSchema`, added `synthesizerSchema`
- `server/migrations/V047__split_planner_synthesizer_and_scrub_orchestration.js` — NEW
- `server/services/workflow/executors/InboxLoadNodeExecutor.js` — NEW
- `server/services/workflow/executors/InboxFinalizeNodeExecutor.js` — NEW
- `server/services/workflow/executors/PromptNodeExecutor.js` — auto-persist hook + `{{previousTaskResults}}` template support
- `server/services/workflow/executors/index.js` — registered new executors
- `server/agents/runtime/artifactStore.js` — NEW (extracted from `agentTools.js` write block)
- `server/agents/runtime/agentToolRegistrar.js` — stripped inbox/artifact/mark-done from auto-registration; synthesizer short-circuit
- `server/agents/profile/profileWorkflowSerializer.js` — new lifecycle shapes; planner/synthesizer config sourced from profile
- `server/services/workflow/SubWorkflowMaterializer.js` — `{{nodeResults}}` → `{{previousTaskResults}}`; `_taskId`/`_taskTitle` on task config
- `server/tools/agentTools.js` — `writeArtifact` tool now delegates to `writeArtifactDirect`; remains as opt-in escape hatch
- `client/src/features/admin/pages/AdminAgentEditPage.jsx` — three-section prompt form (Agent persona / Planner / Synthesizer); placeholder no longer suggests orchestration verbs

## Out of scope (V1.5+)

- Iterative planner mode (re-plan after partial results).
- Per-task tool restriction in the admin form (V1 propagates `profile.tools` uniformly).
- Streaming the synthesizer output live to the UI before persistence.
- Per-task artifact ACL groups.
- True provider-side strict tool enforcement to make the escape-hatch path safer.
