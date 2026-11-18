---
description: "AgentLoop, the one loop that runs every tool-using model turn."
audience: developer
type: reference
---

# Agent Loop

Every tool-using model turn in the server runs through `AgentLoop`
(`server/services/loop/AgentLoop.js`): workflow prompt/agent nodes, the
tool-enabled verifier, chat (`ChatService`), the app-as-tool gateway and the
MCP `tools/call` surface. There is no second loop: a loop behaviour is
implemented once, tested once (`server/tests/loop/agentLoop.test.js`) and every
caller gets it.

This page is for developers wiring a new caller or adding a loop behaviour.
The model call itself is documented in [LLM Client](llm-client.md); the events
the loop writes are documented in [Run Ledger](run-ledger.md).

## One invocation is one segment

`agentLoop.run(request)` runs the model until it produces a final answer,
raises an interaction, exhausts a budget, or is aborted. Inside a segment the
loop:

1. offers the (not yet disabled) tools and streams one model turn through
   `LLMClient.execute()`;
2. accumulates content, usage, thought signatures and images; lifts the
   Anthropic synthetic `json` tool call into content when a `responseSchema`
   is set;
3. resolves each requested tool (`matchTool`), repairs its arguments
   (`repairToolArguments`: glued objects, missing braces, prose around the
   JSON) and applies schema defaults;
4. runs the calls through the segment planner (`planToolBatches`), appends
   results in the model's original order, and applies the circuit breakers;
5. compacts the transcript when it grows large; forces a final tool-less turn
   when every tool is dead, the run token budget is spent, or the last allowed
   round is reached;
6. returns a `LoopResult`.

A segment never throws for model or tool failures: cancellation returns
`status: 'aborted'`, a provider failure returns `status: 'error'` with the
`LLMError` in `result.error`. Callers decide whether to rethrow.

## Request

```js
const result = await agentLoop.run({
  runId,                    // ledger run this segment belongs to (optional)
  kind: 'workflow',         // chat | workflow | agent | subagent | inference | utility
  model,                    // resolved model object (see llmClient.resolveModel)
  messages,                 // starting transcript, system message first
  tools,                    // ToolSpec[]: { id, description, parameters, readOnly?, interactive?, passthrough? }
  toolExecution: 'server',  // 'caller' hands tool calls back instead of executing them
  policies: { budgets, tools, context, interactions, approval },
  options: { maxTokens, responseSchema, nativeWebSearch, thinking… },
  language,
  signal,                   // AbortSignal
  refs: { executionId, nodeId, chatId, appId, userId, taskId, profileId },
  state: { budget },        // shared run-level { input, output, total }, mutated in place
  meta,                     // opaque caller data forwarded to seams
  seams: [...],             // per-run seams (in addition to loop.use())
  executeTool: async (call, { toolDef, toolId, args, ctx }) => result | toolMessage,
  channel: { onChunk, onToolStart, onToolEnd } // optional streaming sink
});
```

### Policies

Policies are validated against `loopPoliciesSchema`
(`server/services/loop/contracts/loop.js`); omitted fields take these
defaults.

| Policy                            | Default | Effect                                                                 |
| --------------------------------- | ------- | ---------------------------------------------------------------------- |
| `budgets.maxToolRounds`           | 10      | Round cap; the last round is a forced tool-less final answer (a cap of 1 gets one extra tool-less call)            |
| `budgets.maxTokensPerRun`         | 0       | Run-level token cap across every segment sharing `state.budget` (0 = unlimited) |
| `budgets.maxWallClockMs`          | —       | Wall-clock deadline for the invocation, enforced as an abort signal: it cuts the in-flight model call or tool short (a tool that ignores the signal is abandoned) |
| `tools.maxRateLimitFailures`      | 2       | 429/503-style failures before a tool is withheld for the segment       |
| `tools.maxConsecutiveFailures`    | 3       | Consecutive failures (any error) before a tool is withheld              |
| `tools.parallel` / `maxParallel`  | true / 4 | Segment planner: read-only tools and non-overlapping calls run concurrently |
| `tools.choice`                    | `auto`  | `required` makes the first model call of a turn call a tool; later calls are `auto`. See [Requiring a tool call](tool-calling.md#requiring-a-tool-call) |
| `context.compactThresholdTokens`  | 16000   | Proactive compaction threshold (see [Context compaction](#context-compaction)) |
| `context.strategy`                | `elide` | `elide`: old tool/assistant bodies collapse to previews (lossy). `digest`: old tool batches are condensed into a findings digest |
| `context.compactKeepRecent`       | 6       | `elide`: trailing messages kept verbatim when compacting               |
| `context.compactTargetShare`      | 0.6     | `digest`: compact down to this share of the threshold                  |
| `context.digestKeepRecentBatches` | 2       | `digest`: newest tool batches kept verbatim (the newest is never condensed) |
| `context.maxCompactionsPerRun`    | 4       | `digest`: digests written with the summary model per run; later ones keep calls and sources only |
| `context.summaryTimeoutMs`        | 90000   | `digest`: timeout of one summary call                                  |
| `context.summaryMaxTokens`        | 4096    | `digest`: output tokens of one summary call                            |
| `context.maxDigestChars`          | 24000   | `digest`: characters of one digest as the model reads it               |
| `context.maxRecallsPerRun`        | 20      | `digest`: how often a run may read a condensed result again (`recall_tool_result`) |
| `context.maxReactiveAttempts`     | 2       | Retries after a provider "prompt too long" error, each after compaction |
| `context.spillThresholdBytes`     | 65536   | Tool results above this are stored in the run's spill store (when the ledger persists) and replaced in the transcript by a bounded preview and reference |
| `interactions.maxQuestions`       | 10      | Clarification cap for interactive tools (question seam)                |

### Result

```js
{
  runId, status,            // completed | paused | aborted | error | budget_exhausted
  content, finishReason,    // finishReason: provider value, or 'budget_exhausted' | 'clarification' | 'tool_passthrough_complete'
  usage, runUsage,          // this segment / the whole run (promptTokens, completionTokens, totalTokens)
  iterations, messages,     // rounds used; final provider-valid transcript
  sources, knowledgeSources, integrations, thoughtSignatures, images,   // sources: { items, queries, supports }
  disabledTools, budgetExhausted, budgetReason,   // 'tools_dead' | 'tokens' | 'rounds'
  toolCalls,                // only with toolExecution: 'caller'
  pendingInteraction,       // only with status 'paused'
  error                     // only with status 'aborted' | 'error'
}
```

## Seams

Cross-cutting behaviour is a seam registration, never a second loop. A seam
is an object with any of these hooks; register it for every run with
`loop.use(seam)` or per run with `request.seams`:

| Hook                            | When                                                                | May                                                |
| ------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `preStep(ctx)`                  | Before each model call                                              | Inspect / adjust `ctx.messages`                    |
| `onChunk(ctx, chunk)`           | Every streamed chunk (`chunk.toolCallProgress` is the early signal of a tool call whose arguments are still streaming) | Forward to a client |
| `streamEnd(ctx, { outcome, result? })` | Once per model call, after the last chunk, before `stepEnd` and any tool: `outcome` is `completed` (with the accumulated `result`), `error` (the provider or a later hook failed) or `aborted` (Stop, the run's deadline). It also runs on the paths that never reach `stepEnd` (the loop returns from its `catch`) | Close what `preStep` / `onChunk` opened. A throw is logged, never raised |
| `stepEnd(ctx, step)`            | After each model turn (`step.result`, `step.usage`, `step.toolCalls`) | Capture grounding metadata, telemetry            |
| `preTool(ctx, info)`            | Before a tool executes                                              | Return `{ handled, message, terminate }` to take the call over |
| `postTool(ctx, info, outcome)`  | After a tool executed                                               | Rewrite `outcome.message`, lift images, add knowledge sources |
| `onHallucinated(ctx, info)`     | Model called an unregistered tool                                   | Record for audit                                   |
| `onCircuitBroken(ctx, info)`    | A tool was withheld                                                 | Record / notify                                    |
| `onCompactionStart(ctx, info)`  | A findings digest is about to be written (`compactionId`, `tokensBefore`, `itemsSummarised`, `kinds`) | Tell the user (the summary call takes a while) |
| `onCompaction(ctx, info)`       | Transcript was compacted: the fields of the ledger's `context/compaction` (`compactionId`, `trigger`, `strategy`, `lossy`, `tokensBefore`, `tokensAfter`, `digest`, …) plus `freedTokens` and the new `messages` | Telemetry, rebase a context figure |
| `onAnswer(ctx, info)`           | The model answered without a tool call (`info.stepText` — this step's answer; `info.content` — the run's text so far; `info.canRetry`) | Return `{ handled, retry, error? }` to reject the answer: the loop appends it and the `retry` correction, and the model answers again (only while `canRetry`) |

Built-in seams live in `server/services/loop/seams/`:

- `questionSeam` — `interactive: true` tools (today `ask_user`; every caller
  marks them with `markInteractiveTools`) raise a question interaction and
  pause the segment; a per-conversation cap turns further questions into an
  error the model has to work around. Chat answers the question with the next
  message; a workflow or agent node pauses its execution on a question
  checkpoint and resumes the same step from the answer
  (`services/workflow/questionPause.js`).
- Steer — a `steer` human event (`POST /api/runs/:runId/human-events`) is
  queued for the run's loop (`services/loop/steering.js`) and appended before
  the next model call as a `role: 'user'` message carrying the `[steer]` trust
  marker; the ledger records it as `message/user { synthetic: 'steer' }`.
- `passthroughSeam` — `passthrough: true` tools stream their own answer to the
  user and end the turn.
- `imageLiftSeam` — image payloads in tool results become `message.imageData`.
- `knowledgeSourceSeam` — classifies search / source / grounding tools into the
  knowledge-source badges the chat UI shows.
- `structuredOutputSeam` — checks the final answer (the last step's text, not
  prose written before earlier tool calls; the loop result carries it as
  `answerText`) against an output contract
  (the inference API's JSON Schema validation) and asks for one corrected
  attempt when it does not hold; the ledger records the rejected attempt as a
  recoverable `error` and the correction as `message/user { synthetic: 'nudge' }`.

## Context compaction

A long tool loop fills the model's context: every search result and page read
stays in the transcript. Once the prompt is over
`context.compactThresholdTokens`, the loop compacts it after the step's tool
results are in, before the next model call. The decision uses the provider's
count of the last call plus what was added since (the count holds the tool
definitions); only without one is the transcript estimated, tool definitions
included.

**`digest` (chat turns).** The oldest complete tool batches (an assistant
message with tool calls and its results) are condensed until the prompt is
projected at `compactTargetShare` of the threshold
(`server/services/loop/findingsDigest.js`):

- The assistant messages and their tool calls stay as they are. Seeing its
  own calls keeps the model from running them again, and providers check the
  calls (Gemini signs each one). Only tool-result content changes, so the
  transcript stays valid for every provider.
- Each condensed result becomes a one-line stub with a ref
  (`[condensed result r3 of webSearch: … recall_tool_result {"ref":"r3"}]`).
  The last one also carries the digest, a `<condensed_results>` block: the
  calls that ran (tool, arguments, ok or failed, the sources they returned),
  the facts taken from the results, and what was looked for and not found.
- The calls and sources are built by code. The summary model (the run's
  model, or `request.summaryModel`; a chat turn passes the model set in
  `chats.compaction.modelId`, see
  [Long research turns](chat-persistence.md#long-research-turns)) writes only `FACT | ref | fact | source`
  and `NOTFOUND | ref | …` lines, with thinking off. A fact is kept only if
  its ref is one of the results it was given and its numbers appear in that
  result: a number of four digits or more anywhere in one of the result's
  numbers, a shorter one as a number of its own (single digits are not
  checked). This catches invented figures, not a figure attached to the wrong
  entity or period. A source URL not in the result is dropped from the fact.
  Large inputs are split into chunks the summary model can take; a result cut
  for the summary is marked "partly read for these notes" in the digest. All
  chunks of one compaction get twice `summaryTimeoutMs`.
- The digest stays within `maxDigestChars`: the list of calls takes at most
  40 % of it (sources, then argument length are shortened first), the facts
  the rest. Facts that still do not fit are counted in a closing line, and
  the compaction is marked `lossy` (`digest_truncated`). Text from results
  cannot open or close the block (angle brackets are replaced).
- What is never condensed: the newest `digestKeepRecentBatches` batches,
  results shorter than 1,000 characters, the loop's own tools (skill
  instructions and resources, the tool index) and `ask_user` answers. A
  compaction that would free less than 10 % of the prompt is skipped. When
  the last compaction could not bring the prompt under the threshold (what
  cannot be condensed is that large), the next waits until the prompt has
  grown by another 10 % of the threshold.
- Above 80 % of what the model can take as input — its window less the
  output the call asks for (vLLM counts `maxTokens` against the window) — a
  compaction is urgent: the cooldown does not hold it back, and when the two
  kept batches are what fills the window, only the newest (the one the model
  has not read) is kept.
- A second compaction appends a new digest after the first; a digest is never
  summarised again, so the prompt prefix up to it stays cacheable.
- From the first compaction on, the model is offered `recall_tool_result`
  (`{ ref, offset }`). It returns the original result in 20,000-character
  pages, from memory or, after a resume of the same run, from the run's spill
  store (`archiveRef`); a result that had been spilled is read in full. It
  only reads this run's condensed results, never a path the model names, and
  at most `maxRecallsPerRun` times. A chat turn that continues a paused run
  under a new id (another model after an approval) passes that run as
  `request.archiveRunIds`: its journal is kept while it is paused, and only a
  run of the same chat is read. When the original cannot be reached — the
  ledger does not persist, so there is no spill store to read after a pause —
  the tool says so and the model works with the digest.
- When the summary fails, times out or keeps nothing of results that held
  something, the batches are still condensed, to their calls and sources, and
  the compaction is marked `lossy` with a `fallbackReason` (`summary_failed`,
  `summary_partial`, `summary_empty`). After two failures, or
  `maxCompactionsPerRun` digests, the run goes on with such digests without
  asking the model (`summary_unavailable`, `compaction_limit`). Stop or the
  run's deadline during the summary ends the run as it would mid-step.
- The summary's tokens count toward the run budget (`state.budget`) and are
  reported for the user the turn runs for (usage limits apply); the call has
  no ledger run of its own.

**`elide` (workflows, agent nodes).** Old tool and assistant bodies over 2,000
characters, outside the last `compactKeepRecent` messages, collapse to a
200-character preview. The data is gone; the compaction is recorded as
`lossy`. A condensed result is never collapsed.

**Overflow.** When the provider rejects a prompt as too long, a `digest` turn
first condenses every batch but the newest to its calls and sources, without
a summary call (the results stay readable by ref). Only when that frees
nothing — and in an `elide` turn — are old bodies collapsed (`reactiveKeepRecent`).
The loop then retries, up to `maxReactiveAttempts` times, without charging a
round. It is recorded as `trigger: 'overflow'`, `lossy: true`,
`fallbackReason: 'context_overflow'`.

**What is recorded and shown.** Every compaction writes a `context/compaction`
ledger event with `compactionId`, `strategy`, `lossy`, `tokensBefore`,
`tokensAfter`, `itemsSummarised`, `kinds` (`search` / `fetch` / `tool`, as the
server classifies the tools), the digest (bounded to 8,000 characters; a longer
one is in the spill store as `summaryRef`), `facts`, `droppedFacts`, the
summary `model` and `durationMs`. A chat turn sends `context/compacted` frames
(`running` before the summary call, `completed` after; see
[Streaming Events](streaming-events.md)) and rebases its context figure; the
ledger projects to the same frame, so a re-sync shows it too. The chat shows
the compaction as a row of the answer's activity ("Condensed 9 earlier search
results into notes"), which opens to the notes; a lossy one says that details
may be missing. The stored answer keeps the row; a share keeps that it
happened, without the notes.

## Sources

What a run found is collected by the loop itself, for every caller (see
[Answer Sources](answer-sources.md)): after each tool call it asks
`extractToolSources()` (`server/services/sources/`) for the call's sources —
a declaration in the tool definition, a registered producer (web search,
page reader, iFinder), or the tool's own `sources` / MCP `resource_link`s —
and it reads `chunk.sources` (model adapters such as iAssistant) and
`chunk.groundingMetadata` (provider-run web search) as they stream.
`ctx.addSources(frame, { step, callId, toolId })` merges each report into
`ctx.sources`, writes it to the ledger as `sources/added` and hands it to the
channel (`channel.onSources`), which the chat emits as the SSE frame of the
same name. `LoopResult.sources` is the merged set.

## Callers

### Workflow prompt / agent nodes

`PromptNodeExecutor.executeLLMWithTools()` is a thin adapter: it maps node
config and the run context onto a request, registers the workflow seam
(grounding → citations, hallucinated tools → `_toolErrors` and the step log,
withheld tools → `_circuitBrokenTools` and the run-detail SSE stream) and
supplies `executeToolCall` as the tool executor. Node config knobs:

| Node config                   | Maps to                                     |
| ----------------------------- | ------------------------------------------- |
| `maxIterations`               | `budgets.maxToolRounds` (else the agent profile's `budgets.maxToolRoundsPerNode`, else 10) |
| `parallelToolCalls`           | `tools.parallel` (default **false** for workflow nodes — workflow tools mutate shared run state) |
| `maxRateLimitFailures`        | `tools.maxRateLimitFailures`                |
| `maxConsecutiveToolFailures`  | `tools.maxConsecutiveFailures`              |
| `toolChoice`                  | `tools.choice` (`auto` or `required`; default `auto`) |
| `compactThresholdTokens`      | `context.compactThresholdTokens`            |
| `compactKeepRecent`           | `context.compactKeepRecent`                 |
| `outputSchema`                | `options.responseSchema`                    |
| `thinking`                    | thinking options                            |

The agent profile's `budgets.maxTokensPerRun` is enforced across the whole run
through `state.data._budget` on the workflow state. Before the loop existed
the profile budgets were read from a context field no caller populated, so
they were never enforced; profiles that set `maxTokensPerRun` or
`maxToolRoundsPerNode` now see them applied.

### Chat

`ChatService` (`server/services/chat/ChatService.js`) is the chat adapter:
`prepareChatRequest()` resolves app, model, messages and tools through
`RequestBuilder`; `runTurn()` runs one `kind: 'chat'` segment and projects it
onto the chat SSE dialect; `invokeAppInternal()` runs an app headlessly for the
app-as-tool gateway and MCP `tools/call`. There is no chat-specific model loop:
budgets, tool execution, argument repair, compaction and abort handling are the
loop's.

Chat policies:

| Policy                   | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `budgets.maxToolRounds`  | 50 (`CHAT_MAX_TOOL_ROUNDS`); the last round is a forced tool-less final answer (a cap of 1 gets one extra tool-less call)         |
| `tools.parallel`         | **false** — chat tools have side effects and the client renders tool events in order |
| `tools.choice`           | the app's `toolChoice` (default `auto`) |
| `budgets.maxWallClockMs` | headless invocations only (`invokeAppInternal`, default 180 s)                        |
| `timeoutMs`              | hard timeout per model call (the chat route's `DEFAULT_TIMEOUT`)                      |
| `context`                | `chatContextPolicies(model)`: threshold at 50 % of the model's `contextWindow` (at least 16,000), `strategy: 'digest'` |

Tools execute through
`runTool(toolId, { language, ...args, chatId, user, appConfig })`:
model-provided arguments may override `language` but never `chatId`, `user` or
`appConfig`. Before the tools are offered, `markInteractiveTools()` flags
`ask_user` (and any tool with `requiresUserInput: true`) as `interactive: true`,
so the built-in `questionSeam` takes clarifications over.

Seams a chat turn registers (`server/services/chat/chatSeams.js`), in order:

| Seam                                      | Hooks                 | Adds                                                                                                                                                                              |
| ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledgeSourceSeam`                     | `postTool`, `stepEnd` | Search / source / grounding tools feed the knowledge sources (`tool/completed.knowledgeSource`, `run/ended.knowledgeSources`) and name the connected systems behind `run/ended.answerBasis`                                                  |
| `chatToolSeam`                            | `preStep`, `onChunk`, `streamEnd`, `preTool`, `postTool` | Live `tool/progress` frames while the model writes a call's arguments or shows nothing (`args`, `args.ended`, `model.waiting`; see [Streaming Events](streaming-events.md)), `tool/started` / `tool/completed` frames, `tool_usage` / `tool_error` interaction logs, the error envelope handed back to the model when a tool fails |
| `questionSeam(chatQuestionOptions)`       | `preTool`             | `ask_user` → `interaction/raised` with the persisted interaction; per-chat counter capped at `MAX_CLARIFICATIONS_PER_CONVERSATION`; the run pauses (`run/paused`)                    |
| `passthroughSeam(chatPassthroughOptions)` | `preTool`             | Workflow tools stream their own answer as `step/delta` frames, then `tool/completed`; the turn ends with `tool_passthrough_complete`                                                |
| `imageLiftSeam`                           | `postTool`            | Image payloads in tool results become message image data                                                                                                                          |
| `chatTurnSeam`                            | `preStep`, `stepEnd`, `onCompactionStart`, `onCompaction` | Upload / email knowledge sources on the first step, `chatTelemetry` usage and metrics once per model call, `step/completed` per model call, `context/compacted` frames and the rebased `context/usage` after a compaction |

Streamed chunks go to the channel (`server/services/chat/chatChannel.js`),
which projects them onto `step/delta` (text, thinking, image), `tool/progress`
(grounding, search status) and `meta` frames through the run's
`RunStreamEmitter` → `sse.js` (see [Streaming Events](streaming-events.md)). `ChatService`
emits the run frames itself: `run/started`, `run/paused`, `stream/error`
(payload from `chatErrors.describeChatError()`) and `run/ended`.

**Headless mode.** `runTurn({ streaming: false })` — a POST without an open SSE
connection — and `invokeAppInternal()` (app-as-tool gateway, MCP `tools/call`)
register the question seam with `headless: true`: tools still execute, but
nobody can answer a question, so `ask_user` gets a `NO_USER_AVAILABLE` error
result instead of pausing the segment. The non-SSE POST answers with
`{ messageId, model, content, finishReason, usage }`; `invokeAppInternal()`
runs a `kind: 'subagent'` segment and returns
`{ status, finalMessage, toolCalls, sources, usage, finishReason, model }`.

### Degenerate runs

- `tools: []` → exactly one model call; the result is the completion.
- `toolExecution: 'caller'` with tool calls → the loop returns `toolCalls`
  (parsed arguments) with `finishReason: 'tool_calls'` and never executes,
  compacts or asks. This is how the OpenAI-compatible inference API and MCP
  clients that run their own tools use the loop.

## Testing a caller

Use `fakeLlmClient` (`server/tests/helpers/fakeLlmClient.js`) to script the
model: it turns a `complete(params)` function into an object that also
satisfies the streaming `execute()` entry point the loop uses. Inject a loop
with a spy seam to observe compaction or tool events:

```js
const llmClient = fakeLlmClient(async ({ messages, options }) => ({ content: 'done', toolCalls: [] }));
const agentLoop = new AgentLoop({ llmClient }).use({ onCompaction: (ctx, info) => seen.push(info) });
const executor = new PromptNodeExecutor({ llmClient, agentLoop });
```
