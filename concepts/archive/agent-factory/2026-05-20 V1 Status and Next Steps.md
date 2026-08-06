# Agent Factory — V1 Status & Next Steps

**Date:** 2026-05-20
**Branch:** `claude/implement-agent-factory-v1-dZ6oJ`
**PR:** #1487 (not yet merged)
**Companion docs:** [`2026-05-20 V1 Slim Scope.md`](./2026-05-20%20V1%20Slim%20Scope.md), [`/Users/danielmanzke/.claude/plans/please-review-our-actual-giggly-newt.md`](../../) (original session plan)

This file captures the state at the end of the second working session so the next session can pick up without re-deriving context.

## Where we are

We started this session with the V1 PR open and the user reporting "agents are not really working." A long debug pass surfaced a cascading chain of bugs from the tool boundary all the way up to the planner's mental model. We fixed the layered bugs in roughly the order they manifested. The agent pipeline now reaches `write_inbox` (proven in logs by `Inbox written, version: 5`) and `write_artifact` (with defensive arg handling). The architecture mismatch between the planner's mental model and what's needed for inbox-worker / research-agent profiles is the open V1.5 question.

## What's actually fixed (commit `<this commit>`)

### Tool boundary
- **Provider-side sanitizer (`server/adapters/toolCalling/toolNameValidator.js`)**: shared `isPlausibleToolName` + `validateProviderToolName({ name, provider, log, result })`. Applied at every tool-call extraction site in Google/Anthropic/Bedrock/OpenAI converters (Mistral inherits via OpenAI). Catches Gemini's `ctrl42`/`ctrl40` control-token leakage and Anthropic/OpenAI equivalents — malformed names are dropped at the converter, the model gets a notice in `result.content` so it self-corrects on the next turn.
- **Executor strict allowlist (`PromptNodeExecutor.executeToolCall`)**: no more silent fallback to `toolCall.function.name`. Unknown tool names log an error, emit `agent.tool.hallucinated` event, record in `state.data._toolErrors` (visible in UI), and return a structured tool-error to the model. Run continues; iteration cap bounds retries.
- **Schema sanitizer fix (`sanitizeSchemaForProvider`)**: was indiscriminately deleting `title`, `format`, `minLength`, `maxLength` from any object — including from a `properties` container where those words are property NAMES. `create_task.required: ["title"]` was failing Gemini's schema validation because `properties.title` had been deleted. Now skips that strip when the current object is a `properties` container (no `type` of its own).

### Agent tools registration / admin lifecycle
- **V044 (`normalize_agent_planner_task_template`)**: flattens any legacy `taskTemplate: { type: 'prompt', config: {...} }` shape into the flat form the materializer expects. Defaults missing `planner.goal` to `${$.data.brief}`. Propagates `preferredModel` / `system` / `tools` / `apps` / `sources` from profile root into `planner.taskTemplate`. Also fixed the bundled `examples/agents/profiles/research-and-summarize.json` in-repo so fresh installs don't carry the broken shape.
- **V045 (`ensure_agent_tools_registered`)**: re-registers the 8 agent tools in `config/tools.json` after install. V042 had registered them but they could go missing.
- **V046 (`restore_agent_tools_after_admin_strip`)**: same payload as V045, runs again. Needed because…
- **`server/routes/admin/tools.js:loadRawTools` fix**: was filtering out every tool with a `method` property as "legacy expanded tool" — including all 8 script-bound agent tools. **Every GET to `/api/admin/tools` triggered a `needsCleanup` write that erased the agent tools from disk.** Filter now preserves tools with `isAgentTool: true` or a `script` reference. V046 is the one-shot data restore; the filter fix is the permanent prevention.

### Workflow / agent infrastructure
- **`TaskRecord` shape contract (`server/agents/runtime/taskRecord.js`)**: `buildTaskRecord` + `validateTaskRecord`. `create_task` tool now validates before pushing to `_taskQueue`; malformed entries refused at producer with `{error, code: 'INVALID_TASK'}`.
- **`SubWorkflowMaterializer`** changes:
  - Marks every materialized planner task node with `_isPlannerTask: true`.
  - Materialized task prompts include three blocks: `## Context` (brief + currentInboxItem), `## Previous task results` (`{{nodeResults}}` accumulator — `iterative-research-auto` pattern), and `## Current task` (title + description from plan output).
  - System prompt is NO LONGER overridden by `task.description` — the profile's persona stays intact across every plan task. Task instruction goes in the user prompt.
  - Assertion: every task node must have both system + user prompt; fails at materialize time, not at the provider API.
  - Drain task_runner also marked `_isPlannerTask: true`.
- **`agentToolRegistrar.getAgentToolIds`**: when `nodeConfig._isPlannerTask === true`, strips inbox tools (`read_inbox` / `write_inbox`) so plan tasks can't re-read the inbox or double-mark items. Always-on memory tools and dynamic-task tools (when `dynamicTasks.enabled`) still register.
- **`profileWorkflowSerializer.buildPlannerWorkflow`**:
  - For inbox-bound profiles (`profile.inboxId` set + `planner.enabled: true`): builds `start → load-inbox → planner → finalize → end`. The orchestrator nodes own inbox lifecycle (read once, mark done once). The planner only plans WORK.
  - Planner's `system` prompt now explicitly forbids orchestration steps in the plan ("DO NOT include steps for reading the inbox, marking items done, or writing artifacts — those are handled separately").
  - Planner's `goal` references `${$.data.currentInboxItem}` so the plan is tailored to the loaded item.
  - `finalize` prompt spells out the exact arg shapes for `write_artifact` and `write_inbox` with examples — Gemini-flash needs that explicit guidance.
- **External workflow refs** (`server/routes/agents/runs.js`): when `profile.workflow.ref === 'external'`, the trigger handler resolves the workflow from `configCache.getWorkflowById(workflowId)`. Lets authors wire hand-authored workflows like `iterative-research-auto` to an agent profile.
- **State cycle fix preserved** (from `4e1880e2`): `PlannerNodeExecutor` strips 19 engine-internal keys before passing state to child workflows, preventing the deepMerge recursion crash.

### Live UI for agent runs
- **Server SSE** (`/api/agents/runs/:runId/stream`): mirrors workflow SSE but gated on agentFactory feature. **Tracks child execution IDs** — seeds from `state.data._childExecutionIds` on connect, watches for `workflow.subworkflow.start` events, forwards all events whose `chatId` or `executionId` is in the tracked set. Without this, planner sub-workflow events (chatId = childExecutionId) never reached the parent run's stream and the UI showed nothing happening.
- **Server agent run endpoint** (`GET /api/agents/runs/:runId`): returns the enriched shape the existing workflow hook expects (`canReconnect`, `pendingCheckpoint`, etc).
- **Client hook** (`useWorkflowExecution`): parameterized with `requireFeature` / `stateEndpoint` / `streamEndpoint` so agent runs can reuse it without forking. Handles `workflow.*` AND `agent.*` events (`agent.task.created`, `agent.artifact.written`, `agent.tool.hallucinated`, `agent.hitl.*`, `agent.memory.*`, `agent.inbox.*`).
- **`AgentRunDetailPage` rewrite**:
  - Live "Live / Reconnecting / Disconnected" pulse indicator.
  - **Unified Tasks panel**: planner tasks (purple badge) + dynamic create_task tasks (orange badge) in one table with live `open / in_progress / done / failed` status derived from sub-workflow node events.
  - **Artifacts panel** with fallback to `state.data._agent.artifacts` (event-driven) when disk listing is empty/lagging.
  - **Tool issues panel**: surfaces `agent.tool.hallucinated` events with the offending name and the list of tools actually available to the node.
  - **Recent events tape**.
- **`AgentRunsPage`**: now polls every 5 seconds so newly-triggered runs appear and statuses update.

### Provider-specific behaviour
- **Google native grounding** (`PromptNodeExecutor`): when the resolved model's provider is `google` and the node lists `webSearch`, swap to `googleSearch` (native grounding). Because Gemini's API cannot combine `google_search` with function calling, this swap is node-scoped and drops all function tools for that node. Logs `droppedFunctionTools` so the operator sees what happened. Implication: plan tasks needing search become search-only on Google; the orchestrator persists results via function tools afterwards. Mixed-need nodes are not expressible on Gemini and must be split.
- **`writeArtifact` defensive arg handling**: missing `name` → falls back to `profile.artifacts.primary` (or `report.md`); non-string `content` → coerces objects to JSON, primitives via `String(...)`. Returns structured `{error, code, message}` instead of throwing, so the model can self-correct on the next iteration.

## What works end-to-end now

Verified by logs in the latest session:
- Server boots; all migrations apply cleanly (V042-V046).
- 73/73 unit tests pass.
- SSE connection established, events flow live to the UI.
- Plan generation works (Gemini returns valid JSON plan; sub-workflow materializes 3-7 tasks).
- Tasks execute sequentially; `nodeResults` accumulates across tasks.
- `read_inbox` returns daniel-todos items.
- `write_inbox(markDone)` actually persists (`Inbox written, version: 5`).
- `write_artifact` schema rejects with structured error → model can retry.
- Tool hallucination event surfaces in UI.

## What is still broken / unclear

1. **The planner still produces orchestration tasks for some prompts.** Even with the new `system` + `goal` directives, Gemini sometimes emits a plan like "Read Inbox → Pick Item → Do Work → Write Artifact → Mark Done." The fix landed in `buildPlannerWorkflow` (new shape) and `plannerSystem` (explicit "DO NOT include orchestration"), but the user had not yet re-saved `testrunner-1` when this surfaced. **Action next session: confirm the user re-saved the profile so the new shape is on disk; verify the new system prompt actually reaches `PlannerNodeExecutor._generatePlan` (it uses `config.system` if provided).** If it still happens, the V1.5 escape is `workflow.ref: 'external'` pointing at a hand-authored workflow.

2. **The planner pattern is fundamentally one-shot decomposition.** The user's mental model — and what `iterative-research-auto.json` does — is iterative loop: think → research → accumulate → think again until done. The current `PlannerNodeExecutor` generates the whole plan in one LLM call, materializes a static sub-DAG, then runs it. For open-ended research ("who is Daniel Manzke?") this is the wrong shape; iterative is genuinely better. The escape hatch `workflow.ref: external` lets authors opt into iterative-style workflows today. A V1.5 ticket should add an `iterative` planner mode that loops a thinker node + a worker node with accumulating state, like the workflow does manually.

3. **Plan tasks share state via `{{nodeResults}}` template** — we added it to the materialized prompt — but I haven't tested that PromptNodeExecutor's template resolver renders `{{nodeResults}}` as a useful representation of an object full of prior outputs. Likely it stringifies as `[object Object]` or JSON-dumps; the model may need either a `formatNodeResults` helper or per-task explicit `${$.data.task_X_result}` references generated by the materializer. **Action next session: trace one real run and look at what the plan-task LLM actually receives in `## Previous task results`.**

4. **Admin UI exposes no way to set `workflow.ref: 'external'`**. The schema supports it, the trigger handler resolves it, but the form-based editor in `AdminAgentEditPage` doesn't have a field. Users have to hand-edit the JSON file or use the raw JSON mode. **Action: add a "Workflow" section with a dropdown of available workflows; show "Auto-built" (embedded) as default.**

5. **`load-inbox` orchestrator node** uses `tools: []` in node config, expecting `getAgentToolIds` to add `read_inbox` automatically because the profile has `inboxId`. Verified the registrar does add it for non-planner-task nodes. But the orchestrator also gets `write_inbox` / `write_artifact` / `create_task` / etc — more tools than it needs. The system prompt forbids using them, but in practice Gemini-flash may still get confused. **Optional V1.5 polish: a per-node `excludeAgentTools: [...]` whitelist field.**

6. **Multiple `start` / `planner` events in the UI tape.** The user noted this. It's because the parent fires `workflow.node.start/complete` for `start` and `planner` at its level, AND the child sub-workflow fires `workflow.node.start/complete` for its `sub-start`. Both come through SSE with different `executionId` but same event name. The UI renders them all in the history tape with the same label. **Action: the UI should prefix or indent child events, or filter to show only parent-level nodes in the main tape and put child events in a collapsible sub-section.** Minor UX polish.

7. **The two example profiles need a fresh real-LLM test.** Specifically: re-save `testrunner-1` after the new auto-builder, trigger a run, observe whether the planner stays away from orchestration and whether finalize successfully writes one artifact + marks one inbox item. We need ONE clean end-to-end pass before declaring V1 done.

8. **Pre-existing issues we did not touch** (out of scope this session):
   - `UsageAggregator` startup error `ReferenceError: e is not defined` at `services/UsageAggregator.js:214`. Unrelated to agent factory but noisy in logs.
   - Migration lock contention across cluster workers — also pre-existing.
   - `server/tests/gemini3-converter.test.js` and `server/tests/toolCalling.test.js` are standalone scripts that don't run under vitest; they were broken before this PR.

## Next session — recommended order of operations

1. **Confirm the user re-saved `testrunner-1` and trigger one fresh run.** Capture the server log + UI screenshot. If clean end-to-end → V1 ships.
2. **If still broken**: trace the specific failure point. The instrumentation we added (`_resolveAgentProfile` info logs, `agent.tool.hallucinated` events, `droppedFunctionTools` log line) should make the diagnosis fast.
3. **Add the `workflow.ref: external` field to `AdminAgentEditPage`** so the user can wire `iterative-research-auto` to research-agent-1 without hand-editing JSON.
4. **Validate the `{{nodeResults}}` accumulator** in a real plan task prompt — see point 3 in "still broken" above.
5. **Cleanup pass**: remove the runtime taskTemplate-unwrap defensive code in `routes/agents/runs.js` and `profileWorkflowSerializer.js` now that V044 normalizes data at rest. Document the runtime patches we're keeping as belt-and-suspenders (the 19-key SHARED_INTERNAL_KEYS strip, the Anthropic/OpenAI converter sanitizers).
6. **Open V1.5 tickets** for:
   - Iterative planner mode (think→work→accumulate loop as a first-class planner.mode option).
   - Per-node `excludeAgentTools` field.
   - Better child sub-workflow event labeling in the UI tape.
   - Per-task tool restriction in the admin form.
   - True state-passing redesign for child workflows (replace the 19-key blacklist with deep-clone or explicit `state.public` projection).

## Critical files touched (~1450 net lines)

```
 client/src/features/admin/pages/AgentRunDetailPage.jsx
 client/src/features/admin/pages/AgentRunsPage.jsx
 client/src/features/workflows/hooks/useWorkflowExecution.js
 examples/agents/profiles/research-and-summarize.json
 server/adapters/toolCalling/AnthropicConverter.js
 server/adapters/toolCalling/BedrockConverter.js
 server/adapters/toolCalling/GenericToolCalling.js
 server/adapters/toolCalling/GoogleConverter.js
 server/adapters/toolCalling/OpenAIConverter.js
 server/adapters/toolCalling/toolNameValidator.js          (new)
 server/agents/profile/profileWorkflowSerializer.js
 server/agents/runtime/agentToolRegistrar.js
 server/agents/runtime/taskRecord.js                       (new)
 server/migrations/V044__normalize_agent_planner_task_template.js  (new)
 server/migrations/V045__ensure_agent_tools_registered.js          (new)
 server/migrations/V046__restore_agent_tools_after_admin_strip.js  (new)
 server/routes/admin/tools.js
 server/routes/agents/runs.js
 server/services/workflow/SubWorkflowMaterializer.js
 server/services/workflow/executors/PromptNodeExecutor.js
 server/tools/agentTools.js
```

## How to resume

1. `git log --oneline main..HEAD | head -20` — see all the commits in this session.
2. `cat concepts/agent-factory/2026-05-20\ V1\ Status\ and\ Next\ Steps.md` — this file.
3. Tell the next session: "We're continuing the V1 agent factory work on branch `claude/implement-agent-factory-v1-dZ6oJ`. Read `concepts/agent-factory/2026-05-20 V1 Status and Next Steps.md` for state. Goal is to land one clean end-to-end run of `testrunner-1` with Gemini, then ship."
