# One Agentic Loop — Unified Runtime for Chats, Workflows and Agents

**Date:** 2026-08-26 (revised 2026-08-27: full cutover, no coexisting implementations, TDD-first)
**Status:** Concept / design proposal
**Decision recorded:** The unification only succeeds if *everyone* uses the same loop. Therefore this is **not** a lift-and-delegate refactor that leaves old paths alive: every caller is changed, every old implementation is **deleted**, the SSE contract is redesigned and the frontend migrated with it, and the whole effort is driven test-first.
**Related:** `concepts/2026-08-26 Agent Harness Comparison — DeepSeek Harness, Hermes, Deep Agents vs iHub.md` (combines roadmap items P0.1 RunLog, P0.2 server-side sessions, P1.4 approval seam, P2.10 chat-loop parity)
**Tracking:** epic #2233 with stage sub-issues #2234 (C0) · #2235 (C1) · #2236 (C2) · #2237 (C3) · #2238 (C4) · #2239 (C5)
**Sources:** `server/services/chat/{ToolExecutor,StreamingHandler,NonStreamingHandler,ChatService,appToolsGateway}.js`, `server/services/workflow/executors/{PromptNodeExecutor,HumanNodeExecutor,VerifierNodeExecutor,PlannerNodeExecutor,DecisionNodeExecutor}.js`, `server/services/workflow/WorkflowLLMHelper.js`, `server/routes/openaiProxy.js`, `server/tools/{askUser,workflowRunner}.js`, `server/actionTracker.js`, `client/src/features/chat/hooks/useAppChat.js`, `client/src/features/workflows/hooks/useWorkflowExecution.js`, `tests/` + `server/tests/`

---

## 1. Executive summary

1. **iHub runs three divergent LLM loops and several loop-adjacent call paths.** The chat tool loop (`ToolExecutor`, hard cap 10 sequential iterations), the workflow/agent loop (`PromptNodeExecutor.executeLLMWithTools`, budget-driven with microcompaction and circuit breakers), the no-tools `StreamingHandler`/`NonStreamingHandler` pair, `WorkflowLLMHelper`'s direct adapter calls (used by planner/verifier/summarizer/memory-composer), and the OpenAI-compatible inference proxy (`routes/openaiProxy.js`). Every improvement lands in one of them and skews the rest.
2. **Human interaction exists as four disconnected mechanisms** — `ask_user` (ends the chat turn, discards in-flight loop state), `human` nodes (durable pause with approver groups and branch routing), the workflow-in-chat checkpoint bridge, and message feedback (stored, invisible to the running loop) — with four data shapes, three answer channels, and no shared audit trail.
3. **The proposal: two public layers, one rule — `LLMClient` is the only way to reach a provider, `AgentLoop` is the only tool loop.** `LLMClient` is a **public**, individually testable request primitive (streaming-native; "non-streaming" is a collected stream, not a second code path): it owns adapter selection behind a model id, per-model throttling (absorbing `requestThrottler`), retry/failover, a canonical error taxonomy, usage-bucket normalization, and it **always** writes the `request/header` ledger event — a standalone call without a runId gets a lightweight auto run envelope, so audit uniformity survives direct use. Being public makes it the anchor for an **adapter conformance matrix**: one scenario suite run against every adapter. `AgentLoop.run()` sits on top as the only tool-executing loop and reaches providers exclusively through `LLMClient`. Agentic surfaces (chat, workflow prompt/agent nodes, agent runs, app-as-tool, MCP gateway) use the loop; bare completions (inference API, planner/verifier/summarizer/titles, admin model test, translate, magic prompt) may call `LLMClient` directly. `ToolExecutor`'s loop, both handlers, `WorkflowLLMHelper`'s private path, and `simpleCompletion` are **deleted**, not wrapped — CI fails on any provider completion call outside `LLMClient`.
4. **The SSE contract is redesigned once (v2) and the frontend moves with it — a clean break, decided.** Today the chat client alone consumes 17 ad-hoc event names, with different vocabularies again in the workflow-execution and agent-run views. SSE v2 is one typed event schema (a projection of RunLog events) consumed by **one** client-side event reducer shared by chat, workflow, and run-detail surfaces. No dual-emit compatibility layer; embedded surfaces (Teams, Outlook add-in, Nextcloud) migrate in the same major release — and the chat SSE/API is confirmed **internal-only** (§10.3), so no backward compatibility is owed to anyone. The one deliberately unchanged wire contract is the inference API — it is OpenAI-shaped by definition; only its implementation moves.
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
| 4 | OpenAI-compatible inference API | `routes/openaiProxy.js` (models + chat completions incl. tool calls, streamed and collected, with disconnect-abort) | Thin OpenAI wire adapter over **`LLMClient`** directly: the API passes a model id and messages; the client resolves the model, verifies the key, and hides all adapter specifics. Client-defined tools are part of the completion result (`finish_reason: tool_calls`) — never executed server-side. Each call gets an auto run envelope `kind: 'inference'`. External wire contract unchanged: OpenAI-shaped by definition, streamed chunks included | The proxy's private request/streaming plumbing |
| 5 | Workflow `prompt`/`agent` nodes | `PromptNodeExecutor.executeLLMWithTools` | `AgentLoop.run` (this loop is the *control-policy donor* — see §10 on merging the chat loop's stream-edge handling) | The in-executor copy of the loop |
| 6 | Planner / verifier / decision / summarizer / memory-composer / title generation (`agents/runtime/titleGenerator.js`) / magic prompt | `WorkflowLLMHelper.executeStreamingRequest`, ad-hoc adapter calls | **`LLMClient.execute`** directly — bound to the **parent runId** as purpose-tagged segments when they serve a run (compaction summarizer, titles, verifier scoring), auto-enveloped standalone calls otherwise; the verifier's tool-enabled adversarial mode is a full `AgentLoop` run | `WorkflowLLMHelper`'s private path — its retry/option-allowlist logic *becomes* `LLMClient` |
| 7 | Agent runs | Profile → workflow → node executors | Unchanged shape; inherits the loop through #5/#6 | — |
| 8 | App-as-tool / `ChatService.invokeAppInternal` | Full chat pipeline replayed against `InMemorySink` | Child `AgentLoop.run` (headless channel, frozen principal + policies, `parentRunId` link) | `InMemorySink`'s response-shape normalization hacks (ChatService.js:127–169) |
| 9 | MCP gateway (apps/workflows as tools) + A2A `tasks/send` | `invokeAppNonStreaming` → chat pipeline | Same child-run path as #8 | Bespoke invocation glue |
| 10 | Chat-embedded workflows | `workflowRunner` bridging engine events onto chat SSE | Unchanged trigger; its event bridge becomes a RunLog→SSE-v2 projection instead of hand-mapped events | Hand-mapped event translation |
| 11 | Internal/admin utility calls: admin **model test** (`routes/admin/models.js:459`), admin **translate** (`routes/admin/translate.js`), admin prompts/agents assists (`routes/admin/{prompts,agents}.js`), **magic prompt** (`routes/magicPromptRoutes.js`) | `simpleCompletion` in `server/utils.js:501` — a **fourth** private LLM path | `LLMClient.execute`, auto-enveloped `kind: 'utility'` or `'diagnostic'` — which makes the admin "test model" click an *auditable* diagnostic call with the standard error taxonomy for free | `simpleCompletion` |

Three clarifications keep this honest. First, **both layers are public, with one rule each**: `LLMClient` is the only way to reach a provider (a lint/CI guard, see §8, fails the build on any direct adapter/completion call or provider fetch elsewhere — generic HTTP like `HttpNodeExecutor`'s `throttledFetch` use is unaffected), and `AgentLoop` is the only tool-executing loop, itself reaching providers exclusively through `LLMClient`. Callers pass a model id; model resolution, key verification (`ApiKeyVerifier`), adapter selection, per-model throttling, and retry all live behind `LLMClient`. Second, direct `LLMClient` use never escapes the ledger: every call logs `request/header`, and a call without a `runId` gets a lightweight auto run envelope — audit uniformity is a property of the client, not caller discipline. Third, the deliberate exclusions: `ModelDiscoveryService` (provider `/models` **metadata**), the transcription endpoint (`routes/modelRoutes.js`, audio-model calls), and voice STT/TTS token minting are not chat completions and stay outside both layers — stated here so nobody force-fits them later.

---

## 5. Design

### 5.1 Two public layers, one rule each

**`LLMClient` is the only way to reach a provider; `AgentLoop` is the only tool loop.** Agentic surfaces call the loop; bare completions call the client directly. The loop itself reaches providers exclusively through the client, so the wire behavior is one code path either way. Runs are standalone (`kind: chat|workflow|agent|inference|utility|diagnostic`) or bound to a parent (`parentRunId` for subagent/app-as-tool children; purpose-tagged segments on the *same* runId for auxiliary calls like the compaction summarizer or title generation, so ledgers stay coherent instead of exploding into micro-runs). A toolset marked `execution: 'caller'` at the loop level returns tool_calls as the run result instead of executing them (kept for A2A-style external orchestrators; the inference API gets the same effect natively from the client).

### 5.2 `LLMClient` — the public request primitive

`server/services/loop/LLMClient.js`, absorbed from `WorkflowLLMHelper` + the fetch/parse plumbing duplicated across `ToolExecutor`, the handlers, and `simpleCompletion`. Public and individually testable — its contract is deliberately rich, because everything downstream keys off it:

- **Adapter opacity:** callers pass a model id; resolution, key verification, adapter selection, and provider quirks are behind the client.
- **Throttling:** per-model concurrency/delay moves here from `requestThrottler` — one enforcement point instead of five call sites.
- **Canonical error taxonomy:** `CONTEXT_WINDOW_EXCEEDED | RATE_LIMITED | CONTENT_POLICY | EMPTY_RESPONSE | TIMEOUT | NETWORK | PROVIDER_ERROR` — circuit breakers, microcompaction retries, and failover all key off these codes instead of scattered string matching (the dsh adapter-contract pattern).
- **Usage normalization:** provider usage shapes normalized into canonical buckets (input/output/cache-read/reasoning) — the substrate for budgets and cost accounting.
- **Ledger by construction:** every call logs `request/header` and opens the OTel GenAI span; a call without a `runId` gets a lightweight auto run envelope.
- **Fixture recording:** an env-gated record mode captures sanitized provider byte streams as test fixtures (secrets redacted) — this is how the conformance matrix (§6 T2) grows from real traffic.

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

Rules from the harness study: **anything model-visible must be reconstructable from the log** (enforced as a test, §7); tool calls logged before execution so a crash mid-tool is visible; `_stepLogs`, the run-detail SSE stream, and the chat-history endpoint are all *projections* of this ledger. Server-side chat sessions fall out: a chat's RunLog **is** its transcript (the browser keeps localStorage as a cache; per §10.3 the *client-owned conversation stays authoritative* for building the next turn in phase 1 — the ledger is the audit record and pause substrate).

**Privacy by design (decisions in §10.3):** one log per chat/run, so erasure is a file delete with a cascade (spill files, artifact references, registry/index entries). Actor identity is recorded per the platform's ledger identity mode — `full` (incl. PII), `default` (**user id only, no PII**), or `pseudonymized` (salted user-id hash à la `UserFingerprint`). Anonymous sessions run under a random server-side id: stored, answerable via possession of the session-bound id, never listable or reloadable as history. Per-kind policy for high-QPS `inference` runs is deferred.

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

**T2 — The adapter conformance matrix.** Because `LLMClient` is public, it gets its own first-class suite: **one parameterized scenario set × every adapter** (openai, anthropic, google, mistral, vllm/local, bedrock, openai-responses, iassistant-conversation). Scenarios: plain text stream; tool-call delta accumulation (incl. Gemini `thoughtSignature` round-tripping, Anthropic split usage, Bedrock EventStream framing); parallel tool calls in one turn; structured output (`responseSchema`); images and thinking deltas; usage frames; each canonical error (429 → `RATE_LIMITED`, overflow → `CONTEXT_WINDOW_EXCEEDED`, content policy, empty response, network); abort mid-stream; `collect()` equivalence (collected result ≡ streamed events, property-tested). Two tiers: **offline** recorded fixtures run in CI always (evolving today's per-provider `server/tests/*Adapter.test.js` scripts into the one matrix), and an **optional live smoke tier** (nightly / on demand, cheap models, keys from CI secrets) that catches provider wire drift the fixtures can't. Fixtures are dated and re-recordable via the client's record mode.

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
- **C1 — `LLMClient` + the conformance matrix**: build the public client against T2 (matrix green across all adapters before any caller moves); cut over **all** single-shot callers (inference API incl. streamed golden tests, planner/verifier/decision/summarizer/memory-composer, title generation, magic prompt, admin model test, admin translate, admin prompts/agents assists); **delete** `WorkflowLLMHelper`'s private path, `simpleCompletion`, and the proxy's plumbing. Per-model throttling moves into the client here.
- **C2 — `AgentLoop`**: extract from `PromptNodeExecutor` against T3; cut over workflow prompt/agent nodes and the verifier's adversarial mode; **delete** the in-executor loop.
- **C3 — Chat + composition surfaces**: chat routes (tools, streaming, non-streaming) onto `AgentLoop`; app-as-tool and MCP gateway onto child runs; **delete** `ToolExecutor`'s loop, `StreamingHandler`, `NonStreamingHandler`, and the `InMemorySink` normalization hacks. Server-side chat sessions activate here (the RunLog is already being written).
- **C4 — SSE v2 + frontend**: server emits only the v2 schema; ship the shared reducer and migrate `useAppChat`, `useWorkflowExecution`, run-detail, checkpoint/clarification widgets, and the embedded surfaces; **delete** legacy event emission and the three legacy client dialects. Released as the major version with the breaking-change notice.
- **C5 — Interactions**: `ask_user` → pausing `question`; `human` nodes and the workflow chat bridge delegate to `InteractionService`; feedback gains run linkage; the unified answer endpoint replaces the three bespoke ones, which are **deleted**; the approvals page becomes the interactions queue with notifications.

Operational safety comes from the tests (T4/T5/T8) and normal release discipline (canary deployment, the changelog), not from architectural escape hatches. If ops requires an emergency switch during rollout, it is a release-branch kill switch with a removal date inside the same release cycle — never a per-surface configuration.

## 8. Risks and mitigations

1. **Big-bang per surface.** Mitigated by the T8 replay fixtures (behavior pinned before each cutover), the T4 cross-surface equivalence tests, and stage-sized PRs that keep the tree releasable. The frontend break (C4) is the riskiest step — it ships with the full e2e suite green and the embedded surfaces migrated in the same release train (the chat SSE/API is internal-only per §10.3, so no customer communication is required).
2. **Chat pause vs. provider message invariants.** Resuming a paused step re-sends tool_calls with pending results — a known crash class. Mitigation: on resume, synthesize tool results for calls that can no longer complete (Deep Agents' `PatchToolCalls` pattern), covered by T6.
3. **Storage growth.** Request headers per step are large: hash-dedupe unchanged schemas/prompts within a run (one full copy per epoch, dsh's `reason: initial|change` pattern), spill previews for big results, retention from day one.
4. **Privacy.** Server-side chat transcripts are new personal data — governed by the §10.3 decisions: identity modes (`full`/`default` user-id-only/`pseudonymized`), one-file-per-run erasure with cascade, retention per kind, admin-scoped access, and anonymous runs never reloadable. Works-council/DSGVO review still applies before default-on in employee-facing deployments.
5. **Cluster correctness.** Chat pauses add durable per-run state where only workflows have it today; C3 rides the same scheduler-lock + sticky-session model as workflow pauses; the SQLite run store (roadmap P3.13) is the structural fix, not a prerequisite.
6. **Scope discipline.** Still excluded (cheaper after, not dependencies): the subagent primitive, agent scheduling, the execution substrate.

## 9. Success criteria

- Exactly one provider gateway (`LLMClient`, public, conformance-tested against every adapter) and exactly one tool loop (`AgentLoop`, which reaches providers only through it); `continueWithToolExecution`, `StreamingHandler`, `NonStreamingHandler`, `WorkflowLLMHelper`'s private path, and `simpleCompletion` no longer exist, and no provider completion call exists outside `LLMClient` — enforced by knip/lint in CI, not by convention.
- The adapter conformance matrix runs the same scenario set against every adapter in CI (offline fixtures), with a live smoke tier available; a new provider adapter is not done until the matrix passes.
- The same scenario run through chat, a workflow node, and an agent run emits identical RunLog event sequences (T4 passes).
- Every model request in every surface is reconstructable byte-for-byte from the ledger (T5 passes).
- A chat with an unanswered question survives server restart and browser reload and resumes correctly; a workflow and an agent profile can raise the same question, answered from the same queue UI.
- The frontend consumes one event reducer; the 17-event chat dialect and the workflow/run-detail dialects are gone.
- Feedback on any message is visible in that run's ledger and consumable by a verifier node.
- The OpenAI-compatible inference API behaves byte-identically at the wire (its golden tests pass unchanged).

## 10. The comprehensive check — what we forgot, assumed, and haven't asked

A deliberate pre-mortem over the whole concept (verified against the code, not speculative). Items here either changed the sections above or must be decided before C0.

### 10.1 Scope we had forgotten (now folded in)

1. **The request throttler.** `throttledFetch` (per-model concurrency/delay, `server/requestThrottler.js`) is used by all five LLM call sites — it must move *into* `LLMClient` as the single enforcement point (§5.2). Generic non-LLM HTTP users (`HttpNodeExecutor`, web tools) keep the plain helper; the CI guard targets provider *completion* calls, not all HTTP.
2. **The error taxonomy.** Circuit breakers, microcompaction retries, and failover today key off scattered string matching. The canonical error codes are now part of `LLMClient`'s contract (§5.2) — without this, T3's loop behaviors are untestable across providers.
3. **Compare mode.** `compareMode` is client-driven: the SPA fires two parallel chat requests. Under the new model that is simply two runs rendered on one view — but SSE v2's client reducer must support multiple concurrent run streams per surface, and the e2e suite (T7) gains a compare-mode flow.
4. **The iAssistant conversation provider is an external-history exception.** `iassistant-conversation` keeps conversation state in the external iFinder system (`ConversationApiService`/`ConversationStateManager`) — history is *not* derivable from our ledger for that provider. The loop needs an external-conversation source concept, or iAssistant is documented as a ledger-visible but externally-threaded surface. Decide in C1 (it is one of the matrix adapters).
5. **Regenerate / edit / local deletion in the chat client.** `useChatMessages`/`ChatMessage` support regenerate and edit; localStorage history can diverge from what the server saw. Resolution recorded in 10.3 Q2: phase 1 keeps the client-authoritative conversation; the ledger is an append-only *record of what happened* (a regenerate is a new segment superseding the old, an edited message is a new user message event), never the source the next turn is built from.
6. **SSE channel keying.** Today's streams are keyed by `chatId` (chat) and `executionId` (workflows/agents), including the cluster presence maps in `clusterBus`. SSE v2 standardizes on `runId` — the presence-map and sticky-session plumbing migrates in C4, and this is real work, not renaming.
7. **The openaiProxy streams to external clients** with disconnect-abort logic (`openaiProxy.js:253`). The golden wire tests (T4) must cover streamed chunk sequences and the disconnect→upstream-abort path, not only collected responses.
8. **Out-of-scope boundaries stated once:** voice STT/TTS (websocket + token minting), the transcription endpoint (`routes/modelRoutes.js`, audio models), and `ModelDiscoveryService` (`/models` metadata) are not chat completions and stay outside both layers. Image *generation inside chat* stays in scope (an image chunk kind in the stream pipeline).

### 10.2 Assumptions made explicit — one corrected

1. **"PromptNodeExecutor is the richer loop" is only half-true — corrected.** It is richer in *control policies* (budgets, compaction, circuit breakers). The chat loop is richer in *stream-edge handling*: JSON-repair of malformed tool arguments, tool-call delta accumulation quirks (empty-fragment merging, Gemini `thoughtSignature` preservation), image-bearing tool results lifted into vision follow-ups, passthrough tool streaming, knowledge-source accounting. The extraction is therefore the **union of both loops, seeded from both test suites** — treating either as "the donor" and the other as disposable would regress real behavior.
2. **We assume all SSE consumers ship with the product** (SPA, Teams app, Outlook add-in, Nextcloud, browser extension). If any customer has built against the chat SSE stream or embeds an old client, the C4 clean break needs customer communication and a documented deprecation — verify before C4, not after (see 10.3 Q1).
3. **JSONL files scale until the P3 SQLite run store** — accepted for C0–C5 with retention from day one; revisit if inference-API volume says otherwise (10.3 Q5).
4. **Buffered ledger writes may lose the last ~5s on a crash** (the AuditLogService pattern). Acceptable *because resume correctness lives in workflow/pause checkpoints, not the ledger* — the ledger is the audit record. Stated so nobody later builds resume logic on top of it.
5. **Byte-exact replay (T5) is achievable** — probably, but localized prompts/tool schemas vary by request language and some adapters inject timestamps. Fallback criterion: semantic equivalence with an explicit, versioned list of permitted normalizations. Decide when T5 first fails, not silently.

### 10.3 The pre-C0 decision list — decided 2026-08-27

1. **Chat SSE/API contract: internal-only — decided.** No external customers consume the chat SSE or the internal chat API; no backward compatibility is required. The C4 clean break proceeds as planned with only the product's own surfaces (SPA, Teams, Outlook, Nextcloud, extension) migrating in the release.
2. **Conversation state: client-authoritative in phase 1 — decided.** The client-owned conversation remains authoritative for what the next turn is built from; the server-side ledger is the audit record and the pause/resume substrate. Server-authoritative sessions are a separate, later decision with its own API change.
3. **Ledger privacy and erasure — decided.** (a) The ledger records **no PII by default — only user ids**. Three platform-configurable identity modes: `full` (principal incl. PII such as name/email), `default` (**stable user id only, no PII**), `pseudonymized` (salted hash of the user id — aligned with the existing `UserFingerprint` mechanism — so an admin cannot identify a person at a glance). The modes govern platform-recorded identity fields; message bodies can inherently contain PII a user typed, which is governed by retention and deletion, not by the mode. (b) **One log per chat/run**, so user-requested deletion is a file delete — with a cascade over the run's spill files, artifacts references, and registry/index entries.
4. **Anonymous mode — decided.** Anonymous sessions get a **random server-side id**; the run is stored in the backend and a paused interaction is answerable by possession of that session-bound id — but **history can never be listed or reloaded** for anonymous users (losing the id ends access; acceptable).
5. **Per-kind ledger policy for high-QPS inference — deferred.** Marked for later; C1 ships with the standard policy and revisits when inference volume warrants it.
6. **Process discipline during the cutover — still open.** Once C0 lands: a "no new features on legacy loops" freeze (otherwise C1–C3 fight merge conflicts forever), stage-sized PRs, and who staffs/owns the effort and the release train for the C4 major version.

### 10.4 Failure modes and mitigations (beyond §8)

1. **Duplicate side effects on resume.** A paused-then-resumed step must never re-execute tool calls that already ran (a posted Jira comment cannot be un-posted). The pause state persists per-call execution bookkeeping (`tool/call` logged before execution gives the ledger view; the pause record carries completed-call ids), and resume executes only the remainder. Covered by a dedicated T6 case.
2. **Abort races.** Double-abort, abort mid-tool, abort between step and persist: the loop's contract is synthetic error results for skipped calls plus a typed `aborted` end — never truncation. Property-test with fault injection around every await point in the loop (T3).
3. **SSE ordering across cluster relays.** Chunks relayed via `clusterBus` between workers must not reorder or silently drop: SSE v2 envelopes carry a per-run sequence number so the client reducer detects gaps and can re-sync from the ledger (`GET .../runs/:id/events?after=seq`). This also gives reconnect-resume for free.
4. **Unbounded buffering.** `collect()` and child-run result assembly inherit `InMemorySink`'s job with explicit caps (size + time), returning a spill reference instead of an OOM.
5. **Wall-clock fairness on chat pauses.** Chat questions must suspend deadline clocks exactly as workflow pauses do today (`WorkflowEngine` resume restores a fresh deadline) — otherwise "user thinking time" burns chat budgets.
6. **Provider wire drift.** Fixtures freeze yesterday's provider behavior; the nightly live smoke tier exists to catch tomorrow's. When it fires, the fix is a re-recorded fixture plus an adapter change reviewed against the matrix — never a caller-side workaround (that is how the old divergence started).
7. **Localization-dependent prompts.** Tool schemas and system prompts are localized per request language — request headers legitimately differ by language. Fine for audit; flagged so KV-cache work (roadmap P3.14) and replay normalization account for it.
