# One Agentic Loop — Unified Runtime for Chats, Workflows and Agents

**Date:** 2026-08-26
**Status:** Concept / design proposal
**Related:** `concepts/2026-08-26 Agent Harness Comparison — DeepSeek Harness, Hermes, Deep Agents vs iHub.md` (this concept combines roadmap items P0.1 RunLog, P0.2 server-side sessions, P1.4 approval seam, and P2.10 chat-loop parity into one architectural move)
**Sources:** `server/services/chat/ToolExecutor.js`, `server/services/chat/ChatService.js`, `server/services/workflow/executors/PromptNodeExecutor.js`, `server/services/workflow/executors/HumanNodeExecutor.js`, `server/services/workflow/WorkflowEngine.js`, `server/tools/askUser.js`, `server/tools/workflowRunner.js`, `server/actionTracker.js`, `server/routes/chat/feedbackRoutes.js`, `server/routes/agents/runs.js`

---

## 1. Executive summary

1. **iHub runs three divergent LLM loops today.** The chat loop (`ToolExecutor.processChatWithTools` → `continueWithToolExecution`, hard cap 10 sequential iterations), the workflow/agent loop (`PromptNodeExecutor.executeLLMWithTools`, budget-driven with microcompaction and circuit breakers), and the no-tools streaming/non-streaming handlers. Every loop improvement lands in one place and skews the others — budgets, context recovery, circuit breakers, and the citations ledger exist only in the workflow path; knowledge-source badges and clarifications exist only in the chat path.
2. **Human interaction exists as four disconnected mechanisms.** `ask_user` (chat: ends the turn, discards in-flight loop state, max 10/conversation), `human` nodes (workflows: durable pause with approver groups, options, input schema, wall clock suspended), the workflow-in-chat checkpoint bridge (`workflowRunner` forwards `workflow.human.required` into the chat stream), and message feedback (`POST /feedback`, stored but invisible to the running loop). They have four different data shapes, three different answer channels, and no shared audit trail.
3. **The proposal: one `AgentLoop` runtime + one `RunLog` ledger + one `Interaction` model, consumed by every surface.** A chat turn, a workflow prompt/agent node, an agent run step, an app-as-tool invocation, and an MCP-exposed app all execute the *same* loop, which writes the *same* append-only event ledger and raises the *same* typed interactions (question / approval / review) answered through whichever channel the run is attached to (chat stream, run page, notification). This is exactly how Claude Code works: one loop under interactive chat, headless runs, and subagents; a session you can leave, resume, steer, and audit — the surface is just a channel.
4. **The unified loop is extracted from `PromptNodeExecutor`, not written fresh.** It is already the superior implementation (token budgets with graceful wrap-up, reactive microcompaction, tool circuit breakers, abort-signal awareness, structured output, per-step logs). The chat path adopts it behind a feature flag; `ToolExecutor`'s duplicate loop is retired. `HumanNodeExecutor`'s checkpoint model (id, options, inputSchema, showData, expiry, approver groups, branch routing) becomes the wire format for *all* interactions — `ask_user` becomes a `question` interaction that pauses and resumes instead of ending the turn.
5. **What users get:** chats that can pause for questions and continue where they stopped (also after a browser reload or on another device), workflows and agents that can ask real questions mid-run — not only approve/reject — through the same UI as chat, feedback that is recorded on the run ledger where it can steer verifier loops and evals, one run inspector for everything, and the ability to promote any chat into a long-running, schedulable, delegable run. What the platform gets: every model-visible byte and every human decision in one reviewable ledger.

---

## 2. Today: three loops, one job

| Capability | Chat loop (`ToolExecutor`) | Workflow/agent loop (`PromptNodeExecutor.executeLLMWithTools`) |
|---|---|---|
| Entry signature | `processChatWithTools({prep, chatId, buildLogData, DEFAULT_TIMEOUT, getLocalizedError, clientLanguage, user})` | `executeLLMWithTools({model, messages, tools, config, context, nodeId, nativeWebSearch})` |
| Iteration control | Hard `maxIterations = 10` (ToolExecutor.js:1365) | `config.maxIterations \|\| budgets.maxToolRoundsPerNode` round cap **above** a run-level token budget (`_budget` on workflow state, PromptNodeExecutor.js:1403–1419) |
| Budget exhaustion | — | Tools withdrawn, one final tool-less turn, `finishReason: 'budget_exhausted'` |
| Context overflow | Turn fails to the client | Reactive microcompaction + retry, `MAX_REACTIVE_ATTEMPTS = 2` (PromptNodeExecutor.js:1428–1431) |
| Failing tools | Retried until the iteration cap | Circuit breakers: 2 rate-limit failures or 3 consecutive failures disable the tool; no tools left → forced final answer (PromptNodeExecutor.js:1435–1453) |
| Cancellation | `AbortController` per chatId in a module-level `activeRequests` map + `setTimeout` (ToolExecutor.js:900–922) | `context.abortSignal` from `WorkflowEngine._executeWithTimeout` (engine cancel / node timeout, PromptNodeExecutor.js:1465–1474) |
| Parallel tool calls | Executed sequentially | Executed sequentially (both lose against every studied harness) |
| Human interaction | `ask_user` → `trackClarification` SSE, turn **ends** with `finishReason:'clarification'`; the assistant tool_call + pending tool messages are discarded; answer arrives as a fresh user message | `human` node → durable `pendingCheckpoint`, run pauses with wall clock suspended, resume via API with approver-group validation and branch routing |
| Transcript | None server-side (client localStorage; `logInteraction` truncates to 1000 chars) | `_stepLogs[nodeId]` inside run state: resolved prompts, tools offered, tool calls with args + result previews, tokens, citations |
| Telemetry | OTel GenAI span per round (`llmCallTelemetry`) | Usage into `_budget` + step logs; spans via `WorkflowLLMHelper` |
| Citations / knowledge sources | Knowledge-source badges (`trackAnswerSource`) | `_citations` ledger |

Also in the field: `NonStreamingHandler`/`StreamingHandler` (the no-tools degenerate cases), `WorkflowLLMHelper` (direct adapter calls with their own retry policy), and `ChatService.invokeAppInternal` (the whole chat pipeline replayed against an `InMemorySink` for app-as-tool). Every one of these is a place loop behavior can diverge — and per the harness study, all three reference harnesses (DeepSeek Harness, Hermes, Deep Agents) run **one** loop under every surface precisely to avoid this.

## 3. Today: four human-interaction mechanisms

| Mechanism | Shape | Channel | Pause semantics | Audit |
|---|---|---|---|---|
| `ask_user` tool (`server/tools/askUser.js`, intercepted in ToolExecutor.js:183) | `{question, input_type: text\|select\|multiselect\|confirm\|number\|date, options, validation}` | `clarification` SSE event → chat widget | Turn ends; in-flight tool-loop state discarded; answer = new user message; max 10/conversation | `logInteraction` line only |
| `human` node (`HumanNodeExecutor.js:84–96`) | checkpoint `{id, nodeId, type:'human_input', message, options[{value,label,style,description}], inputSchema, showData→displayData, timeout, expiresAt}` | `workflow.human.required` + `agent.hitl.requested` SSE → run page / approvals queue | Run pauses (`status:'paused'`, `pendingCheckpoint`), wall clock suspended; resume validates approver groups + options + inputSchema, response becomes the routing `branch` | Checkpoint in run state; `agent.hitl.*` events (ephemeral) |
| Workflow-in-chat bridge (`server/tools/workflowRunner.js`) | Same checkpoint, re-emitted as a `workflow.checkpoint` chat event; safety timeout suspended while paused | Chat stream → `POST /api/workflows/executions/:id/respond` | Workflow pauses; chat turn stays open | Same as human node |
| Feedback (`server/routes/chat/feedbackRoutes.js`) | `{messageId, appId, chatId, messageContent, rating}` → `recordFeedback` + `storeFeedback` | Thumbs/star UI on chat messages | None — fire-and-forget; the running loop never sees it | usage.json / feedback store, detached from any run |

Plus the *intervention* channel: `POST /api/apps/:appId/chat/:chatId/stop` (cluster-aware abort) and `engine.cancel()` — stop exists everywhere, but **steering** (redirect a running loop without killing it, Claude Code's mid-turn message / dsh's `steer()` / Hermes' `/steer`) exists nowhere.

The inconsistency is user-visible: an app author who wants "ask the user something mid-task" gets a turn-ending clarification in chat but a durable resumable checkpoint in a workflow; an agent can be approved but not *asked*; feedback can't fail a verifier; and none of it lands in one reviewable record.

---

## 4. Target picture — what "like Claude Code" means for iHub

Claude Code's operating model, mapped onto iHub's vocabulary:

1. **Everything is a run on one loop.** An interactive chat is a run with a live channel attached. A headless/scheduled execution is the same run without one. A workflow prompt node is a run segment. A subagent / app-as-tool call is a child run. The *only* differences are the channel, the trigger, and the policy — never the loop code.
2. **Every run writes one ledger.** Prompts as rendered, tool calls and results, interactions asked and answered, budget events, compactions — append-only, reviewable later in one inspector, resumable and (eventually) replayable. ("Model-visible ⟺ logged", per the harness study.)
3. **Human interaction is one typed stream, both directions.** Agent→human: questions, approvals, reviews — rendered inline when a human is attached, parked as durable pending interactions with notifications when not. Human→agent: answers, steering, stop, feedback — accepted mid-run without destroying loop state.
4. **Pauses are durable.** A question or approval pauses the run; the run survives a browser reload, a server restart, or an overnight wait, and resumes from exactly where it stopped, on any device.

Concretely for iHub users: start a task in chat, answer a clarification an hour later from the run page; give an agent profile the *same* `ask_user` capability workflows have; rate an agent's draft and have the verifier loop consume the rating; open one trajectory view for a chat, a workflow execution, or an agent run and see the same event types.

---

## 5. Design

### 5.1 `AgentLoop` — the one loop

A new service `server/services/loop/AgentLoop.js`, extracted from `PromptNodeExecutor.executeLLMWithTools` (the richer implementation — budgets, microcompaction, circuit breakers, abort awareness, structured output). Target shape:

```js
// One invocation = one "segment": the model works until it produces a final
// answer, raises an interaction, exhausts a budget, or is aborted.
const result = await agentLoop.run({
  runId,                    // RunLog stream this segment appends to
  principal,                // user | agent service account (frozen for children)
  model, messages, tools,   // as today (prep / node config)
  policies: {
    budgets,                //  maxTokensPerRun / maxToolRounds / wallTime — one schema
    approval,               //  approval rules consulted by the pre-tool gate (P1.4)
    interactions,           //  which interaction kinds this run may raise + limits
    context,                //  compaction thresholds, spill limits
  },
  channel,                  // ChannelBinding: chat SSE | run page | none (headless)
  signal,                   // AbortSignal (chat stop / engine cancel / timeout)
});
// result: { status: 'completed'|'paused'|'aborted'|'error'|'budget_exhausted',
//           content, structured, finishReason, usage, citations,
//           pendingInteraction?  // when status === 'paused'
//         }
```

Internal step pipeline with three seams, so cross-cutting behavior is registered, not woven in (the waterfall/middleware pattern every studied harness uses):

- **`pre-step`** — context policies run here: proactive summarization, spill of oversized tool results, prompt assembly finalization. The full request envelope (rendered system prompt + tool schemas + call config) is written to the RunLog *before* the call.
- **`pre-tool` / `post-tool`** — the approval gate (P1.4), circuit breakers, argument-default injection, result-size spill, citation extraction. `ask_user` stops being special-cased in the loop body: it is a `question` interaction raised through the same seam any tool could use (`requiresUserInput` already exists on tool descriptors).
- **`step-end`** — budget accounting, telemetry span finalization, knowledge-source/citation merge.

Independent tool calls in one assistant turn execute concurrently behind a segment planner (read-only tools always parallel; others sequential), matching Hermes' dispatch design.

**Who calls it:**

| Surface | Adapter |
|---|---|
| Chat (`routes/chat/sessionRoutes.js`) | Builds prep via `RequestBuilder` as today, opens/continues a chat run, calls `agentLoop.run` with a chat `ChannelBinding` (actionTracker SSE). `StreamingHandler`/`NonStreamingHandler` become the tool-less fast path inside the loop, not siblings. |
| Workflow `prompt`/`agent` nodes | `PromptNodeExecutor` keeps prompt resolution, tool registration, and output parsing; delegates execution to `agentLoop.run` with the node's config mapped onto `policies` and the engine's abortSignal. A `paused` result propagates exactly as human-node pauses do today. |
| Agent runs | Unchanged shape (profile → workflow) — they inherit the unified loop through the node executors; budgets already live in the profile. |
| App-as-tool / `invokeAppInternal` | A child run with frozen principal + policies, linked via `parentRunId`; the `InMemorySink` becomes a headless ChannelBinding. |
| MCP gateway (apps/workflows as tools) | Same child-run path; interactions in headless mode follow the `never`/park policy (5.3). |

### 5.2 `RunLog` — the ledger underneath

One append-only event stream per run (chat conversation, workflow execution, agent run — same schema), JSONL per run under `contents/data/run-log/` following the `AuditLogService` write pattern (buffered appends, retention policy, atomic files). Event families:

```
run/start        {runId, kind: chat|workflow|agent|subagent, parentRunId?, principal, app|workflow|profile, trigger}
request/header   {step, model, provider, renderedSystemPrompt, toolSchemasHash → toolSchemas, callConfig}
message/user     message/assistant   (content, usage, finishReason)
tool/call        {step, toolId, args}          // logged BEFORE execution
tool/result      {step, toolId, resultPreview, spillRef?, error?, durationMs}
interaction/raised     interaction/answered    // see 5.3 — includes feedback
budget/checkpoint      budget/exhausted
context/compaction     {shadowedRange, summaryRef, trigger: proactive|overflow}
run/paused       run/resumed        run/end {status, finishReason, usage, cost?}
```

Rules carried over from the harness study: **anything model-visible must be reconstructable from the log** (new model-visible inputs require new event types — review rule, later a runtime assertion); tool calls are logged before execution so a crash mid-tool is visible; `_stepLogs` is refactored to be a *projection* of this ledger rather than a second store. The existing run-detail SSE stream and a future chat-history endpoint both become projections too — this is what makes "one run inspector for everything" (roadmap P0.3) a rendering exercise instead of four integrations.

Server-side chat sessions fall out of this: a chat's RunLog *is* its transcript. The client keeps localStorage as a cache; the server becomes the source of truth for apps that opt in (`features.serverSessions` or per-app flag), which also fixes cross-device history and post-hoc review of chat tool use.

### 5.3 `Interaction` — one model for every human touchpoint

One service (`server/services/loop/InteractionService.js`) and one wire shape, generalizing today's checkpoint (which already has 80% of the needed fields):

```js
Interaction {
  id, runId, step,
  kind: 'question' | 'approval' | 'review' | 'notify',
  origin: 'tool' | 'node' | 'policy' | 'system',      // ask_user, human node, approval gate, budget warning…
  prompt: { message, options?, inputSchema?, showData? },  // exactly HumanNodeExecutor's checkpoint fields
  policy: { approverGroups?, expiresAt?, onTimeout: 'fail'|'branch:<value>'|'deny',
            fallback: 'park' | 'deny' | 'default:<value>' },   // what happens with no human attached
  status: 'pending' | 'answered' | 'expired' | 'cancelled',
  answer?: { value, data?, by, at, channel },
}
```

- **`question`** replaces the `ask_user` special case *and* the human node's input-collection use. In chat it renders as today's clarification widget — but the run **pauses** (loop state persisted, like workflow pauses) instead of ending the turn, so the answer resumes the same step. The 10-per-conversation cap becomes `policies.interactions.maxQuestions`. Workflows and agents raise the identical kind; an agent profile can finally *ask* rather than only seek approval.
- **`approval`** covers human nodes' approve/reject use **and** the P1.4 per-tool-call gate. Decisions: approve / edit-args / reject-with-reason / respond (the harness-consensus set); the answer value doubles as the routing `branch`, preserving `HumanNodeExecutor.resume()` semantics, approver-group validation included (HumanNodeExecutor.js:175–216 moves into the service).
- **`review`** is the structured "look at this draft" gate (showData/displayData today) — distinct from approval so UIs can render content-first with comment fields, and so verifier loops can consume the reviewer's comments as gaps.
- **`notify`** is fire-and-forget (budget 80% warnings, completion notices) — no pause, but on the ledger.
- **Human→agent events** ride the same rails as ledger events and, where the loop is live, as inputs: `answer` (resolves a pending interaction), **`steer`** (new: queue a user message into a *running* loop, delivered at the next step boundary inside an explicit trust marker — Hermes' design), `stop` (today's abort, now logged), and **`feedback`** — `POST /feedback` additionally appends `interaction/answered {kind:'feedback', rating, messageId}` to the run's ledger, which verifier/review loops and future evals can read. Existing feedback storage stays; it gains a run linkage.

**Delivery is a channel concern, not the raiser's:** a pending interaction is (a) pushed inline when a live channel is bound (chat SSE `interaction.raised` event — superseding `clarification` and `workflow.checkpoint`; run page via the existing `agent.hitl.*` stream), (b) parked in a durable pending store visible in the approvals queue (which becomes the *interactions* queue), and (c) escalated per policy — email/Teams webhook to `approverGroups`, expiry enforcement with `onTimeout`. Headless runs (cron, MCP callers, CI) declare `fallback` per kind: `deny` for approvals (fail-closed, the dsh `never` stance), `park` for questions (pause + notify), `default:<value>` where the author pre-answers.

Answering goes through one endpoint (`POST /api/runs/:runId/interactions/:id/answer`) with the existing three kept as thin aliases during migration (chat clarification reply, `/api/workflows/executions/:id/respond`, `/api/agents/runs/:runId/approve`).

### 5.4 Configuration surface

One shared block, referenced from all three author surfaces instead of three dialects:

```jsonc
"execution": {
  "budgets": { "maxTokensPerRun": 0, "maxToolRounds": 30, "maxWallTimeSec": 600 },
  "approval": { "mode": "ask" | "never", "rules": [ /* tool/path/arg predicates, P1.4 */ ] },
  "interactions": {
    "maxQuestions": 10,
    "question":  { "fallback": "park", "notify": ["group:agents-ops"] },
    "approval":  { "approverGroups": ["managers"], "onTimeout": "deny", "expiresAfterSec": 86400 },
    "review":    { "fallback": "park" }
  },
  "context": { "summarizeAtPercent": 75, "spillToolResultBytes": 51200 }
}
```

- **Apps** (`appConfigSchema`): optional `execution` block; absent = today's defaults (so plain chat apps change nothing).
- **Workflow nodes**: `config.execution` overrides per node; `human` nodes become sugar for raising a declared interaction (executor stays, delegates to InteractionService).
- **Agent profiles**: `budgets`/`hitl` fields migrate into the same shape (Flyway migration maps `hitl.approverGroups` → `execution.interactions.approval.approverGroups`).

### 5.5 What explicitly does *not* change

The adapter layer (`server/adapters/` + `toolCalling/`) and `RequestBuilder` prompt assembly stay as-is — the loop consumes them. The workflow engine's scheduling, checkpointing, and node model stay — only the *inside* of prompt-type nodes changes. The visual editor, run pages, and approvals queue keep working through event aliases until their upgrade. Group-based permissions and feature flags are untouched.

---

## 6. Migration plan (strangler, four stages)

**S0 — Seams first (no behavior change).**
Introduce `RunLog` and `InteractionService`; both existing loops write to them in parallel with their current stores (`_stepLogs` double-writes; checkpoints register as interactions; feedback gains run linkage). Ships dark behind `features.runLog`. *Value even if S2 never ships: the unified ledger + interactions queue.*

**S1 — Extract the loop.**
Lift `executeLLMWithTools` into `AgentLoop` with the three seams; `PromptNodeExecutor` becomes its first consumer (pure refactor, verified by replaying recorded runs — the RunLog from S0 provides the fixtures). Port the segment planner for parallel tool calls here.

**S2 — Chat adopts the loop** (feature flag `unifiedLoop`, per-app opt-in).
`sessionRoutes` opens/continues a chat run; `ToolExecutor` delegates to `AgentLoop`; `ask_user` becomes a pausing `question` interaction; chat gains budgets, microcompaction, circuit breakers, and steer. The SSE contract is preserved via a compatibility emitter (old event names emitted alongside `interaction.*` — see open question 1).

**S3 — Converge and retire.**
Remove `continueWithToolExecution` and the duplicated dispatch in `ToolExecutor` (it shrinks to chat-specific concerns: knowledge sources, upload handling); `HumanNodeExecutor` and the workflow chat bridge delegate to InteractionService; the three answer endpoints alias the unified one; approvals page becomes the interactions queue with notifications (P1.5).

**S4 — The payoff features.**
Server-side chat history UI + one run inspector over the ledger (P0.3); "promote chat to run" (hand a chat run to the scheduler/inbox machinery); replay harness over RunLog fixtures (P3.15).

Each stage is independently shippable and reversible; nothing waits on the full vision.

---

## 7. Risks and open questions

1. **SSE backward compatibility (decision needed).** Replacing `clarification`/`workflow.checkpoint` events with `interaction.*` breaks existing clients (SPA versions, Teams/Outlook embeds, API consumers). Proposal: emit both during S2/S3 and drop legacy names in a major release — but per project policy ("always ask before backward-compatibility shims"), this needs an explicit decision: dual-emit window vs. clean break.
2. **Chat pause semantics vs. provider message invariants.** Resuming a paused chat step re-sends an assistant message with tool_calls and a pending tool result; malformed resumes are a known crash class. Mitigation: adopt the Deep Agents `PatchToolCalls` trick — on resume, synthesize tool results for calls that can no longer complete ("cancelled — user answered differently") so transcripts stay provider-valid.
3. **Storage growth.** Request headers per step are large. Mitigations: hash-dedupe unchanged tool schemas/system prompts within a run (log `toolSchemasHash` + one full copy per epoch, the dsh `request/header` reason=`initial|change` pattern), spill previews for big tool results, retention policy from day one.
4. **Privacy.** Server-side chat transcripts are new personal data. Follow the existing audit-log posture (retention, pseudonymization options, admin-scoped access, per-app opt-in), and surface the setting to admins before default-on is even discussed.
5. **Cluster correctness.** Chat pauses add durable per-run state where today only workflows have it; `StateManager`/registry are per-process + files. S2 rides on the same scheduler-lock + sticky-session model as workflow pauses; the SQLite run store (roadmap P3.13) is the structural fix, not a prerequisite.
6. **Scope discipline.** This concept deliberately excludes: the subagent primitive (P2.11 — but it lands trivially on child runs), agent scheduling (P2.8), and the execution substrate (P3.17). The loop unification makes them cheaper; it does not depend on them.

## 8. Success criteria

- One loop implementation executes chat, workflow prompt/agent nodes, and app-as-tool; the chat-only loop code is deleted (S3).
- A chat with an unanswered `ask_user` survives server restart and browser reload, and resumes correctly on answer.
- A workflow can ask a free-text question and an agent profile can raise one, both answered from the same queue UI as chat clarifications.
- Every LLM call in every surface has a `request/header` ledger event; a run inspector shows chats and agent runs with identical event rendering.
- Feedback given on a chat or run message is visible in that run's ledger and consumable by a verifier node.
