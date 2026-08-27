# One Agentic Loop — Unified Runtime for Chats, Workflows and Agents

**Date:** 2026-08-26 (revised 2026-08-27: full cutover, no coexisting implementations, TDD-first)
**Status:** Concept / design proposal
**Decision recorded:** The unification only succeeds if *everyone* uses the same loop. Therefore this is **not** a lift-and-delegate refactor that leaves old paths alive: every caller is changed, every old implementation is **deleted**, the SSE contract is redesigned and the frontend migrated with it, and the whole effort is driven test-first.
**Related:** `concepts/2026-08-26 Agent Harness Comparison — DeepSeek Harness, Hermes, Deep Agents vs iHub.md` (combines roadmap items P0.1 RunLog, P0.2 server-side sessions, P1.4 approval seam, P2.10 chat-loop parity)
**Sources:** `server/services/chat/{ToolExecutor,StreamingHandler,NonStreamingHandler,ChatService,appToolsGateway}.js`, `server/services/workflow/executors/{PromptNodeExecutor,HumanNodeExecutor,VerifierNodeExecutor,PlannerNodeExecutor,DecisionNodeExecutor}.js`, `server/services/workflow/WorkflowLLMHelper.js`, `server/routes/openaiProxy.js`, `server/tools/{askUser,workflowRunner}.js`, `server/actionTracker.js`, `client/src/features/chat/hooks/useAppChat.js`, `client/src/features/workflows/hooks/useWorkflowExecution.js`, `tests/` + `server/tests/`

---

## 1. Executive summary

1. **iHub runs three divergent LLM loops and several loop-adjacent call paths.** The chat tool loop (`ToolExecutor`, hard cap 10 sequential iterations), the workflow/agent loop (`PromptNodeExecutor.executeLLMWithTools`, budget-driven with microcompaction and circuit breakers), the no-tools `StreamingHandler`/`NonStreamingHandler` pair, `WorkflowLLMHelper`'s direct adapter calls (used by planner/verifier/summarizer/memory-composer), and the OpenAI-compatible inference proxy (`routes/openaiProxy.js`). Every improvement lands in one of them and skews the rest.
2. **Human interaction exists as four disconnected mechanisms** — `ask_user` (ends the chat turn, discards in-flight loop state), `human` nodes (durable pause with approver groups and branch routing), the workflow-in-chat checkpoint bridge, and message feedback (stored, invisible to the running loop) — with four data shapes, three answer channels, and no shared audit trail.
3. **The proposal: `AgentLoop.run()` is the *only public entry point* for any LLM interaction — one `RunLog` ledger, one `Interaction` model, no exceptions and no surviving alternatives.** Inside the loop package, `LLMClient` is the private provider-request primitive (streaming-native; "non-streaming" is a collected stream, not a second code path) — importable only within `server/services/loop/**`, enforced by lint. A single-shot call is a *degenerate run* of the same loop (one step, no server-executed tools, interactions off — composition, not a mode flag), so chat turns, workflow prompt/agent nodes, agent run steps, app-as-tool, the MCP gateway, the OpenAI-compatible inference API, and every internal utility caller (admin model test, admin translate, magic prompt, title generation) all enter through the same door: **input → loop → LLM call**. `ToolExecutor`'s loop, both handlers, `WorkflowLLMHelper`'s private path, and `simpleCompletion` are **deleted**, not wrapped.
4. **The SSE contract is redesigned once (v2) and the frontend moves with it — a clean break, decided.** Today the chat client alone consumes 17 ad-hoc event names, with different vocabularies again in the workflow-execution and agent-run views. SSE v2 is one typed event schema (a projection of RunLog events) consumed by **one** client-side event reducer shared by chat, workflow, and run-detail surfaces. No dual-emit compatibility layer; embedded surfaces (Teams, Outlook add-in, Nextcloud) migrate in the same major release. The one deliberately unchanged wire contract is the inference API — it is OpenAI-shaped by definition; only its implementation moves.
5. **Test-driven, in the strict sense.** The contracts (LoopRequest/LoopResult, RunLog events, Interaction, SSE v2) are written as executable schemas and contract-test suites *before* the implementation; recorded provider-stream fixtures and replay tests pin current behavior before any caller moves; each migration stage's definition of done is "old code deleted, all suites green". The repo's existing infrastructure carries this: Jest unit/integration suites (including the agent-loop behavior tests that become the shared spec — `agent-budget-loop`, `agent-loop-proactive-compaction`, `agent-audit-trail`, `tests/integration/workflows`), per-provider adapter fixture tests, cluster tests, and Playwright e2e.

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

Per the harness study, all three reference harnesses (DeepSeek Harness, Hermes, Deep Agents) run **one** loop under every surface precisely to avoid this divergence.

## 3. Today: four human-interaction mechanisms

| Mechanism | Shape | Channel | Pause semantics | Audit |
|---|---|---|---|---|
| `ask_user` tool (`server/tools/askUser.js`, intercepted in ToolExecutor.js:183) | `{question, input_type: text\|select\|multiselect\|confirm\|number\|date, options, validation}` | `clarification` SSE event → chat widget | Turn ends; in-flight tool-loop state discarded; answer = new user message; max 10/conversation | `logInteraction` line only |
| `human` node (`HumanNodeExecutor.js:84–96`) | checkpoint `{id, nodeId, type:'human_input', message, options[{value,label,style,description}], inputSchema, showData→displayData, timeout, expiresAt}` | `workflow.human.required` + `agent.hitl.requested` SSE → run page / approvals queue | Run pauses (`status:'paused'`, `pendingCheckpoint`), wall clock suspended; resume validates approver groups + options + inputSchema, response becomes the routing `branch` | Checkpoint in run state; `agent.hitl.*` events (ephemeral) |
| Workflow-in-chat bridge (`server/tools/workflowRunner.js`) | Same checkpoint, re-emitted as a `workflow.checkpoint` chat event; safety timeout suspended while paused | Chat stream → `POST /api/workflows/executions/:id/respond` | Workflow pauses; chat turn stays open | Same as human node |
| Feedback (`server/routes/chat/feedbackRoutes.js`) | `{messageId, appId, chatId, messageContent, rating}` → `recordFeedback` + `storeFeedback` | Thumbs/star UI on chat messages | None — fire-and-forget; the running loop never sees it | usage.json / feedback store, detached from any run |

Plus the *intervention* channel: `POST /api/apps/:appId/chat/:chatId/stop` and `engine.cancel()` — stop exists everywhere, but **steering** (redirect a running loop without killing it) exists nowhere.

## 4. The complete caller inventory — everything that moves, everything that dies

The success criterion is architectural monoculture: after the cutover there is exactly **one** way a model gets called and exactly **one** way a tool loop runs. Every row below is in scope; "same interface" admits no exceptions.

| # | Caller today | Path today | Target | Deleted afterwards |
|---|---|---|---|---|
| 1 | Chat with tools | `ToolExecutor.processChatWithTools` → `continueWithToolExecution` | `AgentLoop.run` with a chat channel | The entire duplicated loop (dispatch, accumulation, iteration control) in `ToolExecutor.js` |
| 2 | Chat without tools, streaming | `StreamingHandler.executeStreamingResponse` | Same `AgentLoop.run` — a no-tools run is the same loop finishing in one step | `StreamingHandler.js` as a separate implementation (thinking/grounding/image handling moves into the loop's stream pipeline) |
| 3 | Chat without tools, non-streaming | `NonStreamingHandler.executeNonStreamingResponse` | Same run, **collect mode**: the caller awaits the assembled `LoopResult` instead of subscribing to events — streaming is the only wire path to providers | `NonStreamingHandler.js` |
| 4 | OpenAI-compatible inference API | `routes/openaiProxy.js` (models + chat completions incl. tool calls) | Thin OpenAI wire adapter over a **degenerate `AgentLoop` run**: the API passes a model id and messages; the loop resolves the model, verifies the key, and hides all adapter specifics. Client-defined tools use toolset mode `execution: 'caller'` — the loop **returns** tool_calls as the run result (finish `tool_calls`), never executes them, never loops, never compacts the caller-owned conversation (pinned off by policy). External wire contract unchanged: OpenAI-shaped by definition | The proxy's private request/streaming plumbing |
| 5 | Workflow `prompt`/`agent` nodes | `PromptNodeExecutor.executeLLMWithTools` | `AgentLoop.run` (this loop is the *donor* — extracted, not rewritten) | The in-executor copy of the loop |
| 6 | Planner / verifier / decision / summarizer / memory-composer / title generation (`agents/runtime/titleGenerator.js`) / magic prompt | `WorkflowLLMHelper.executeStreamingRequest`, ad-hoc adapter calls | Degenerate `AgentLoop` runs — bound to the **parent runId** as purpose-tagged segments when they serve a run (compaction summarizer, titles, verifier scoring), standalone runs otherwise; the verifier's tool-enabled adversarial mode is a full loop run | `WorkflowLLMHelper`'s private path — its retry/option-allowlist logic *becomes* the loop-internal `LLMClient` |
| 7 | Agent runs | Profile → workflow → node executors | Unchanged shape; inherits the loop through #5/#6 | — |
| 8 | App-as-tool / `ChatService.invokeAppInternal` | Full chat pipeline replayed against `InMemorySink` | Child `AgentLoop.run` (headless channel, frozen principal + policies, `parentRunId` link) | `InMemorySink`'s response-shape normalization hacks (ChatService.js:127–169) |
| 9 | MCP gateway (apps/workflows as tools) + A2A `tasks/send` | `invokeAppNonStreaming` → chat pipeline | Same child-run path as #8 | Bespoke invocation glue |
| 10 | Chat-embedded workflows | `workflowRunner` bridging engine events onto chat SSE | Unchanged trigger; its event bridge becomes a RunLog→SSE-v2 projection instead of hand-mapped events | Hand-mapped event translation |
| 11 | Internal/admin utility calls: admin **model test** (`routes/admin/models.js:459`), admin **translate** (`routes/admin/translate.js`), admin prompts/agents assists (`routes/admin/{prompts,agents}.js`), **magic prompt** (`routes/magicPromptRoutes.js`) | `simpleCompletion` in `server/utils.js:501` — a **fourth** private LLM path | Degenerate `AgentLoop` runs, `kind: 'utility'` or `'diagnostic'` — which makes the admin "test model" click an *auditable* diagnostic run with the standard error taxonomy for free | `simpleCompletion` |

Two clarifications keep this honest. First, `AgentLoop.run()` is the **single public entry point**; `LLMClient` exists as the loop's private wire primitive (streaming, retries, telemetry, `request/header` logging) but is importable only inside `server/services/loop/**` — a lint/CI guard (see §8) fails the build on any other import and on any direct adapter/completion call elsewhere. Single-shot is a *degenerate run* — same code, empty registrations (one step, no server-executed tools, interactions/compaction off) — not a mode flag inside the loop, so there is nothing to drift. Callers pass a model id; model resolution, key verification (`ApiKeyVerifier`), adapter selection, and retry all live behind the loop. Second, the one deliberate exclusion: `ModelDiscoveryService` fetches provider `/models` **metadata** — not a completion — and stays an adapter-layer concern rather than being force-fitted through the loop.

---

## 5. Design

### 5.1 `AgentLoop.run()` — the single public entry point

Every LLM interaction in the product — agentic or single-shot — enters through `agentLoop.run()`. A degenerate run (one step, no server-executed tools, interactions/compaction off) *is* a plain completion with the run envelope around it; a toolset marked `execution: 'caller'` makes the loop return tool_calls as the result instead of executing them (the inference API's mode, and A2A's later). Runs are standalone (`kind: chat|workflow|agent|inference|utility|diagnostic`) or bound to a parent (`parentRunId` for subagent/app-as-tool children; purpose-tagged segments on the *same* runId for auxiliary calls like the compaction summarizer or title generation, so ledgers stay coherent instead of exploding into micro-runs).

### 5.2 `LLMClient` — the loop's private wire primitive

`server/services/loop/LLMClient.js`, absorbed from `WorkflowLLMHelper` + the fetch/parse plumbing duplicated across `ToolExecutor`, the handlers, and `simpleCompletion`. **Private to the loop package** — no other module may import it:

```js
const stream = llmClient.execute({
  model, messages, tools?, apiKey,
  options: { temperature, maxTokens, responseSchema?, responseFormat?, thinking?, nativeWebSearch? },
  telemetry: { runId, step },        // OTel GenAI span + RunLog request/header handled HERE, once
  signal,
});
// stream: AsyncIterable<GenericChunk> (text | thinking | tool_call_delta | image | grounding | usage | finish)
// await llmClient.collect(stream) → { content, toolCalls, thinking, usage, finishReason, ... }
```

Properties: streaming is the only provider wire path (`collect()` is how "non-streaming" callers consume it — one code path, two consumption modes); provider normalization stays in `adapters/toolCalling/` untouched; retry/failover policy (transient 429/5xx/network) lives here once; **every** call logs a `request/header` RunLog event and opens the GenAI span here, so no caller can forget telemetry or the ledger.

### 5.3 The loop mechanics

Extracted from `PromptNodeExecutor.executeLLMWithTools` (the richer implementation: run-level token budgets with graceful wrap-up, reactive microcompaction, circuit breakers, abort awareness, structured output). One invocation = one *segment*: the model works until final answer, raised interaction, exhausted budget, or abort — and for a degenerate run, "final answer" is simply the first response, tool_calls included when the toolset is caller-executed.

```js
const result = await agentLoop.run({
  runId, principal,                     // agent principals frozen for children
  model, messages, tools,
  policies: { budgets, approval, interactions, context },
  channel,                              // chat SSE | run page | none (headless)
  signal,
});
// → { status: 'completed'|'paused'|'aborted'|'error'|'budget_exhausted',
//     content, structured, finishReason, usage, citations, pendingInteraction? }
```

Three seams keep cross-cutting behavior registered, not woven in (the waterfall/middleware pattern every studied harness uses): **pre-step** (compaction, spill, prompt finalization), **pre/post-tool** (the approval gate, circuit breakers, argument defaults, result spill, citations — `ask_user` stops being special-cased and becomes a `question` interaction raised through the same seam), **step-end** (budget accounting, telemetry, source/citation merge). Independent tool calls in one assistant turn execute concurrently behind a segment planner (read-only tools always parallel; others when argument targets don't overlap). Chat-specific behavior that survives (knowledge-source badges, upload handling, passthrough tools, clarification caps) is expressed as seam registrations and channel concerns — not as a second loop.

### 5.4 `RunLog` — the ledger underneath

One append-only event stream per run (chat conversation, workflow execution, agent run — same schema), JSONL per run under `contents/data/run-log/` following the `AuditLogService` write pattern (buffered appends, retention, atomic files):

```
run/start        {runId, kind: chat|workflow|agent|subagent|inference, parentRunId?, principal, trigger}
request/header   {step, model, provider, renderedSystemPrompt, toolSchemasHash → toolSchemas, callConfig}
message/user     message/assistant   (content, usage, finishReason)
tool/call        {step, toolId, args}          // logged BEFORE execution
tool/result      {step, toolId, resultPreview, spillRef?, error?, durationMs}
interaction/raised     interaction/answered    // feedback included
budget/checkpoint      budget/exhausted
context/compaction     {shadowedRange, summaryRef, trigger: proactive|overflow}
run/paused       run/resumed        run/end {status, finishReason, usage, cost?}
```

Rules from the harness study: **anything model-visible must be reconstructable from the log** (enforced as a test, §7); tool calls logged before execution so a crash mid-tool is visible; `_stepLogs`, the run-detail SSE stream, and the chat-history endpoint are all *projections* of this ledger. Server-side chat sessions fall out: a chat's RunLog **is** its transcript (the browser keeps localStorage as a cache; the server becomes the source of truth).

### 5.5 `Interaction` — every human touchpoint, one model

One service and one wire shape, generalizing today's checkpoint (which already has 80% of the fields):

```js
Interaction {
  id, runId, step,
  kind: 'question' | 'approval' | 'review' | 'notify',
  origin: 'tool' | 'node' | 'policy' | 'system',
  prompt: { message, options?, inputSchema?, showData? },      // = HumanNodeExecutor's checkpoint fields
  policy: { approverGroups?, expiresAt?, onTimeout: 'fail'|'branch:<value>'|'deny',
            fallback: 'park' | 'deny' | 'default:<value>' },   // behavior with no human attached
  status: 'pending' | 'answered' | 'expired' | 'cancelled',
  answer?: { value, data?, by, at, channel },
}
```

- **`question`** replaces `ask_user` *and* the human node's input-collection use. In chat it renders as today's clarification widget — but the run **pauses** (loop state persisted, like workflow pauses) instead of ending the turn; the answer resumes the same step. Workflows and agents raise the identical kind; an agent can finally *ask*, not only seek approval.
- **`approval`** covers human nodes' approve/reject **and** the per-tool-call gate from the roadmap (P1.4). Decisions: approve / edit-args / reject-with-reason / respond; the answer value doubles as the routing `branch`; approver-group validation moves from `HumanNodeExecutor.resume()` (lines 175–216) into the service.
- **`review`** is the content-first "look at this draft" gate, distinct from approval so verifier loops can consume reviewer comments as gaps.
- **Human→agent events ride the same rails:** `answer`, **`steer`** (new — queue a message into a running loop, delivered at the next step boundary inside an explicit trust marker), `stop` (today's abort, now logged), and **`feedback`** — `POST /feedback` additionally appends `interaction/answered {kind:'feedback', rating, messageId}` to the run's ledger, consumable by verifier loops and evals. Existing feedback storage stays; it gains run linkage.

Delivery is a channel concern: inline when a live channel is bound; parked in the durable pending store (the approvals queue becomes the *interactions* queue); escalated per policy (email/Teams to approver groups, expiry with `onTimeout`). Headless runs declare fallbacks per kind — `deny` for approvals (fail-closed), `park`+notify for questions. **One** answer endpoint (`POST /api/runs/:runId/interactions/:id/answer`); the three existing endpoints are migrated and removed, not aliased forever.

### 5.6 SSE v2 — one event contract, one client reducer

Today `useAppChat.js` alone handles 17 event names (`chunk, thinking, citation, clarification, done, error, image, answer.source, skill.activation, workflow.step, workflow.checkpoint, workflow.result, connected, conversation.id, conversation.title, response.message.id, search.status`), while `useWorkflowExecution.js` and the agent run-detail page each speak their own dialects. SSE v2 replaces all three vocabularies with one typed schema that is a **projection of RunLog events** plus the transport frames:

```
stream/connected · stream/error
run/started · run/ended {status, finishReason, usage}
step/delta {kind: text|thinking|image}        // token stream
step/completed {message, citations, sources}
tool/started · tool/progress · tool/completed
interaction/raised · interaction/answered     // supersedes clarification + workflow.checkpoint + agent.hitl.*
progress/node {nodeId, status}                // workflow/run structure
meta {conversationId?, title?, messageId?}
```

Frontend migration (in scope, same release): one shared **event reducer** module consumed by `useAppChat.js`, `useWorkflowExecution.js`, and the agent run-detail hook; the clarification widget, `HumanCheckpoint.jsx`, and the approvals queue render the *same* `interaction/raised` payload; embedded surfaces (Teams app, Outlook add-in, Nextcloud, browser extension) update against the same reducer. **No dual-emit layer** — this is a clean break shipped as a major release with the deprecation called out in the changelog; the decision is recorded here per the project's backward-compatibility policy. (The OpenAI inference API is exempt: its wire format is OpenAI's contract and is preserved by construction.)

### 5.7 Configuration

One shared `execution` block (budgets, approval rules, interaction policies, context thresholds) referenced from apps, workflow nodes, and agent profiles — replacing three dialects. Absent = current defaults, so existing app JSONs stay valid; a Flyway-style migration maps `hitl.approverGroups` and profile `budgets` into the shared shape.

### 5.8 Explicitly unchanged

The adapter layer (`server/adapters/` + `toolCalling/`) and `RequestBuilder` prompt assembly; the workflow engine's scheduling, checkpointing, and node model; group permissions and feature flags; the OpenAI-compatible wire format of the inference API.

---

## 6. Test-driven development approach

The contracts are written first, as executable artifacts; implementation follows red→green; every cutover stage is complete only when the replaced code is deleted and all suites pass. Grounded in the existing infrastructure — Jest unit/integration (`tests/unit`, `tests/integration` incl. `workflows`, `api`, `models`), per-provider adapter tests with fixtures (`server/tests/{openai,anthropic,google,mistral,bedrock}Adapter.test.js`), the existing agent-loop behavior suites (`agent-budget-loop`, `agent-loop-proactive-compaction`, `agent-audit-trail`, `agent-context-management`, …), cluster tests, and Playwright e2e (`tests/e2e`).

**T1 — Contract tests (written before any implementation).** Zod schemas for `LoopRequest`/`LoopResult`, every RunLog event type, `Interaction`, and every SSE v2 event — plus schema snapshot tests so contract drift is a failing test, not a surprise. These schemas are the spec; PRs that change them change the spec visibly.

**T2 — Provider stream fixtures.** Recorded SSE byte streams per provider (extending the existing adapter fixtures) drive `LLMClient` tests: chunk normalization, tool-call delta accumulation (incl. Gemini `thoughtSignature` round-tripping, Anthropic split usage, Bedrock EventStream framing), retry/failover, abort mid-stream, `collect()` equivalence (collected result ≡ streamed events, property-tested).

**T3 — Loop behavior specs.** The existing agent-loop tests are promoted to the shared `AgentLoop` spec and extended with the chat-side behaviors: budget exhaustion → tool withdrawal → wrap-up turn; round caps; circuit breakers (rate-limit and consecutive-failure); proactive + reactive compaction; abort via signal; parallel segment planning (read-only parallel, overlapping-path sequential); structured output; clarification cap; passthrough tools; knowledge-source accumulation. Plus the **degenerate-run contract**: a one-step run with no server tools behaves exactly like a plain completion; a caller-executed toolset terminates the run with `tool_calls` and provably never executes, compacts, or raises interactions. Every behavior is asserted **once**, against the one loop — that is the point.

**T4 — Surface contract tests.** For each caller in §4, an integration test proving: (a) the surface produces the correct external result (chat SSE v2 stream, workflow node output, agent run state, OpenAI-shape completion incl. tool_calls passthrough, MCP tool result), and (b) **the same scenario emits the same RunLog events across surfaces** — the equivalence test that makes "one loop" verifiable rather than aspirational.

**T5 — The ledger invariant as a test.** For every recorded run fixture: reconstruct each model request purely from the RunLog (`request/header` + derived history) and byte-compare against what `LLMClient` actually sent. This is dsh's "model-visible ⟺ logged" runtime invariant, enforced first as CI.

**T6 — Interaction lifecycle tests.** Question pause → server restart (state reloaded from checkpoint) → answer → same-step resume with a provider-valid transcript (synthesized tool results for superseded calls); approval deny fail-closed in headless/cron contexts; expiry + `onTimeout` routing; approver-group rejection; feedback landing on the ledger.

**T7 — Frontend.** Unit tests for the single event reducer (every SSE v2 event type, plus malformed-input tolerance); component tests for the interaction widgets; Playwright e2e for the five golden flows — chat with tools, clarification pause/answer, chat-embedded workflow with checkpoint, agent run with approval, stop/steer mid-run — run against the real server as today's e2e suite does.

**T8 — Replay/characterization safety net.** Before each caller cutover, record fixtures of the *current* behavior through the RunLog double-write (see §7 stage C0); after cutover, replay the same inputs and diff outcomes. Deviations are either bugs (fix) or documented intentional changes (attached to the stage's PR).

CI wiring: T1–T3 into `test:quick`; T4–T6 into `test:integration`; T7 into `test:e2e`; coverage gate on `server/services/loop/**`. Deletion is enforced too: knip + a lint rule fail the build on imports of the deleted modules and on any provider `fetch` outside `LLMClient`.

---

## 7. Cutover plan — staged, but every stage deletes

Stages exist because the change cannot land as one commit, **not** to let implementations coexist. There are no per-app opt-in flags and no long-lived compatibility layers; each stage ends with the old path removed from the tree, and a stage that cannot delete its target is not done. Sequenced to keep the tree releasable after every stage:

- **C0 — Contracts + seams** (no behavior change): land T1 schemas + `RunLog`/`InteractionService` skeletons; both existing loops double-write to the ledger (this produces the T8 fixtures). The only stage where old and new coexist — and only as writers, never as alternative execution paths.
- **C1 — the degenerate path**: build `LLMClient` (private) + `AgentLoop`'s single-step path against T2/T3; cut over **all** single-shot callers (inference API with caller-executed toolsets, planner/verifier/decision/summarizer/memory-composer, title generation, magic prompt, admin model test, admin translate, admin prompts/agents assists); **delete** `WorkflowLLMHelper`'s private path, `simpleCompletion`, and the proxy's plumbing.
- **C2 — `AgentLoop`**: extract from `PromptNodeExecutor` against T3; cut over workflow prompt/agent nodes and the verifier's adversarial mode; **delete** the in-executor loop.
- **C3 — Chat + composition surfaces**: chat routes (tools, streaming, non-streaming) onto `AgentLoop`; app-as-tool and MCP gateway onto child runs; **delete** `ToolExecutor`'s loop, `StreamingHandler`, `NonStreamingHandler`, and the `InMemorySink` normalization hacks. Server-side chat sessions activate here (the RunLog is already being written).
- **C4 — SSE v2 + frontend**: server emits only the v2 schema; ship the shared reducer and migrate `useAppChat`, `useWorkflowExecution`, run-detail, checkpoint/clarification widgets, and the embedded surfaces; **delete** legacy event emission and the three legacy client dialects. Released as the major version with the breaking-change notice.
- **C5 — Interactions**: `ask_user` → pausing `question`; `human` nodes and the workflow chat bridge delegate to `InteractionService`; feedback gains run linkage; the unified answer endpoint replaces the three bespoke ones, which are **deleted**; the approvals page becomes the interactions queue with notifications.

Operational safety comes from the tests (T4/T5/T8) and normal release discipline (canary deployment, the changelog), not from architectural escape hatches. If ops requires an emergency switch during rollout, it is a release-branch kill switch with a removal date inside the same release cycle — never a per-surface configuration.

## 8. Risks and mitigations

1. **Big-bang per surface.** Mitigated by the T8 replay fixtures (behavior pinned before each cutover), the T4 cross-surface equivalence tests, and stage-sized PRs that keep the tree releasable. The frontend break (C4) is the riskiest step — it ships with the full e2e suite green and the embedded surfaces migrated in the same release train.
2. **Chat pause vs. provider message invariants.** Resuming a paused step re-sends tool_calls with pending results — a known crash class. Mitigation: on resume, synthesize tool results for calls that can no longer complete (Deep Agents' `PatchToolCalls` pattern), covered by T6.
3. **Storage growth.** Request headers per step are large: hash-dedupe unchanged schemas/prompts within a run (one full copy per epoch, dsh's `reason: initial|change` pattern), spill previews for big results, retention from day one.
4. **Privacy.** Server-side chat transcripts are new personal data: follow the audit-log posture (retention, pseudonymization options, admin-scoped access), surfaced to admins before rollout.
5. **Cluster correctness.** Chat pauses add durable per-run state where only workflows have it today; C3 rides the same scheduler-lock + sticky-session model as workflow pauses; the SQLite run store (roadmap P3.13) is the structural fix, not a prerequisite.
6. **Scope discipline.** Still excluded (cheaper after, not dependencies): the subagent primitive, agent scheduling, the execution substrate.

## 9. Success criteria

- Exactly one public entry point (`AgentLoop.run`) for every LLM interaction, with `LLMClient` importable only inside `server/services/loop/**`; `continueWithToolExecution`, `StreamingHandler`, `NonStreamingHandler`, `WorkflowLLMHelper`'s private path, and `simpleCompletion` no longer exist — enforced by knip/lint in CI, not by convention.
- The same scenario run through chat, a workflow node, and an agent run emits identical RunLog event sequences (T4 passes).
- Every model request in every surface is reconstructable byte-for-byte from the ledger (T5 passes).
- A chat with an unanswered question survives server restart and browser reload and resumes correctly; a workflow and an agent profile can raise the same question, answered from the same queue UI.
- The frontend consumes one event reducer; the 17-event chat dialect and the workflow/run-detail dialects are gone.
- Feedback on any message is visible in that run's ledger and consumable by a verifier node.
- The OpenAI-compatible inference API behaves byte-identically at the wire (its golden tests pass unchanged).
