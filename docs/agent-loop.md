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
5. shortens the long argument values of a failed tool call once the model has
   called that tool again (`elideRetriedCallArguments`: only the newest attempt
   is replayed in full), compacts the transcript when it grows large; forces a
   final tool-less turn
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
  tools,                    // ToolSpec[]: { id, description, parameters, sideEffect?, readOnly?, interactive?, passthrough? }
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
| `tools.parallel` / `maxParallel`  | true / 4 | Segment planner: whether calls of one model step may run concurrently, and how many at once |
| `tools.parallelMode`              | `targets` | Which calls may share a batch. `targets`: read-only tools (the stamped `readOnly`, a read by declaration), and calls whose arguments do not overlap. `readOnly`: only calls of tools that are a read by declaration (`isTrustedReadOnly`, see [Tool Approval](tool-approval.md#for-developers)), and only when every call of the step is one; any other call makes the step run one call at a time, in the model's order. A chat turn uses `readOnly` |
| `tools.choice`                    | `auto`  | `required` makes the first model call of a turn call a tool; later calls are `auto`. See [Requiring a tool call](tool-calling.md#requiring-a-tool-call) |
| `context.compactThresholdTokens`  | 16000   | Proactive compaction threshold (see [Context compaction](#context-compaction)) |
| `context.strategy`                | `elide` | `elide`: old tool/assistant bodies collapse to previews (lossy). `digest`: old tool batches are condensed into a findings digest |
| `context.compactKeepRecent`       | 6       | `elide`: trailing messages kept verbatim when compacting               |
| `context.compactTargetShare`      | 0.6     | `digest`: compact down to this share of the threshold                  |
| `context.digestKeepRecentBatches` | 2       | `digest`: newest tool batches kept verbatim (the newest is never condensed) |
| `context.maxNotesShare`           | 0.4     | `digest`: share of the model's input (window less output cap) the findings of all digests of a run may take together; the calls-and-sources digest that ends it can go past it |
| `context.maxCompactionsPerRun`    | 12      | `digest`: digests written with the summary model per run; later ones keep calls and sources only |
| `context.summaryTimeoutMs`        | 90000   | `digest`: timeout of one summary call                                  |
| `context.summaryMaxTokens`        | 4096    | `digest`: output tokens of one summary call                            |
| `context.maxDigestChars`          | 24000   | `digest`: characters of one digest as the model reads it; at least 2000 |
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
| `mayTakeOver(ctx, info)`        | Before the calls of a step are grouped (`parallelMode: 'readOnly'`); synchronous, without effects | Return `true` when this seam's `preTool` may take the call over (hold it for an approval, put a question, end the turn). Such a call never runs beside another one. Every seam whose `preTool` can return `handled` has this hook |
| `preTool(ctx, info)`            | Before a tool executes                                              | Return `{ handled, message, terminate }` to take the call over |
| `postTool(ctx, info, outcome)`  | After a tool executed                                               | Rewrite `outcome.message`, lift images, add knowledge sources |
| `onHallucinated(ctx, info)`     | Model called an unregistered tool                                   | Record for audit                                   |
| `onCircuitBroken(ctx, info)`    | A tool was withheld                                                 | Record / notify                                    |
| `onCompactionStart(ctx, info)`  | A findings digest is about to be written (`compactionId`, `tokensBefore`, `itemsSummarised`, `kinds`) | Tell the user (the summary call takes a while) |
| `onCompaction(ctx, info)`       | Transcript was compacted: the fields of the ledger's `context/compaction` (`compactionId`, `trigger` (`proactive`, `overflow`, `retried_call`), `strategy`, `lossy`, `tokensBefore`, `tokensAfter`, `digest`, …) plus `freedTokens` and the new `messages` | Telemetry, rebase a context figure |
| `onSteerApplied(ctx, info)`     | A message the person sent into the run was read, before the model call of its step (`info.id`, `info.step`, `info.text`, `info.by`, `info.at`) | Tell the reader and store it (the chat: `steer/applied` and a stored user message) |
| `onAnswer(ctx, info)`           | The model answered without a tool call (`info.stepText` — this step's answer; `info.content` — the run's text so far; `info.canRetry`) | Return `{ handled, retry, error? }` to reject the answer: the loop appends it and the `retry` correction, and the model answers again (only while `canRetry`) |

Built-in seams live in `server/services/loop/seams/`:

- `questionSeam` — `interactive: true` tools (today `ask_user`; every caller
  marks them with `markInteractiveTools`) raise a question interaction and
  pause the segment; a per-conversation cap turns further questions into an
  error the model has to work around. Chat answers the question with the next
  message; a workflow or agent node pauses its execution on a question
  checkpoint and resumes the same step from the answer
  (`services/workflow/questionPause.js`).
- Steer — a `steer` human event of the run's owner (`POST /api/runs/:runId/human-events`) is
  queued for the run's loop under the id the route minted (`services/loop/steering.js`) and
  appended before the next model call as a `role: 'user'` message carrying the `[steer]` trust
  marker; the ledger records it as `message/user { synthetic: 'steer', steerId, text, by }` and
  the seams are told (`onSteerApplied`). The marker is rendered from the message's metadata
  (`_origin: 'person'`, `_steerId`); the literal `[steer]` in a tool result is rewritten to
  `(steer)` before the model reads it, and so is a workflow's answer to a question
  (`questionPause.answeredToolContent`). A workflow answer carries `_steer` but no `_steerId`, so it
  is never reported as a message of the person. A queued message can be removed until it is read
  (`DELETE /api/runs/:runId/human-events/:id`); a `mode: 'afterwards'` message is not read at a
  step, and what waits when the run ends is the leftover its surface sends as the next turn or
  drops; a run that is not a chat turn drops it when its `run/end` is recorded (see
  [Run ledger, Human events](run-ledger.md#human-events)).
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
  result, compared by value whatever the separators ("1.234,5" = "1,234.5",
  never "5.1" = "51"); a dotted date is read as day, month and year. A whole
  number with a scale word also counts written out ("5,100 billion" for
  "5,100,000,000,000"), never as part of a longer number ("1,200" is not
  "1,200,000"); single digits are not checked. This catches invented
  figures, not a figure attached to the wrong entity or period. A source URL
  not in the result is dropped from the fact. Large inputs are split into
  chunks the summary model can take, one call each. A result over the spill
  threshold, a preview in the transcript, is read in full from the run's spill
  store for the summary. A result cut for the summary, or whose original
  cannot be read, is marked "partly read for these notes" in the digest
  (an unreadable original makes the compaction `lossy`, `summary_partial`). All chunks
  of one compaction get twice `summaryTimeoutMs` together, and no call runs
  past that. A chunk whose answer stopped at the output limit makes the
  compaction `lossy` (`summary_partial`).
- `maxNotesShare` is the budget for the findings kept in digests: all digests
  of a run together take at most that share of what the model takes as input,
  counted in tokens, and a new digest gets what is left. Two cases end it:
  - The notes are already used up: the digest keeps calls and sources only,
    and no summary call is made.
  - The summary was written, but even at its smallest size it would take more
    than is left: its findings are dropped and the digest keeps calls and
    sources only. That summary call has been made and counts toward usage.

  Either way the run then wraps up, as more results could not be kept. The
  calls-and-sources digest itself can go past the budget: it is what replaces
  the results, and the run stops gathering after it.
- The digest stays within `maxDigestChars` (at least 2,000) and within what
  the condensed results held less their stubs, and it must free tokens too
  (a repetitive result can count fewer tokens than shorter notes): it is made
  smaller until it does, at the smallest down to its calls and sources. A
  compaction never makes the transcript longer; results too short to leave
  room for the smallest digest, in characters or in tokens, are not
  condensed. The list of calls takes at most
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
  has not read) is kept. When even that leaves the prompt above the line, the
  newest batch is condensed too: the answer needs the room more than the raw
  pages, and their facts are in the notes.
- When the projection kept the newest batch and the digest came out larger
  than projected, leaving the prompt above the line, a second pass condenses
  the newest batch too: a run wraps up only once nothing is left to condense.
- Still above that line after condensing, the run **wraps up**
  (`context/compaction.wrapUp`): tools that gather more (activity `search` or
  `fetch`, and native web search) are withdrawn for the rest of the run, the
  tools that produce the answer's files and `recall_tool_result` stay, and the
  model is told once (`CONTEXT_WRAP_UP_NUDGE`) to write its complete answer
  from the notes, with figures only from the notes or a result read back. A
  call the model still makes to a withdrawn tool (a search it saw earlier in
  the turn) is refused with `tool_withdrawn`, not run. A run whose prompt is
  above the line with nothing left to condense wraps up the same way.
- The summary model is told what to keep under all circumstances, in this
  order, and writes its lines in that order (when the notes are cut, the end
  goes first): everything the task asks for (each requested figure and
  attribute, per entity), every other figure about a named entity, and a
  `NOTFOUND` line for what the task needs and a result lacks. It never fills
  a gap; the digest and the wrap-up tell the answering model to say a missing
  figure is not available instead of supplying it from memory.
- The summary model is told the room its lines have, in characters (what the
  digest leaves after its calls and sources, shared among the chunks), so it
  drops the least important lines itself instead of losing the end. It writes
  densely: one line per entity and result, its facts as label and value
  (`NVIDIA (NVDA): market cap 5.1 trillion USD; P/E 45.2`), no sentences.
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
  run of the same chat is read. Each run segment records these runs
  (`segment/start.archiveRunIds`), so a recall follows a chain of pauses back
  — the same id continued again, or new ids one after another — up to 8 runs.
  When the original cannot be reached — the ledger does not persist, so there
  is no spill store to read after a pause, or retention removed the journal —
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
`fallbackReason: 'context_overflow'`. When neither frees anything, the long
arguments of earlier failed tool calls are shortened (the newest failed call
keeps its own, and every error stays in its result). As a last resort, when
the call offered tools, the loop answers without them: the tool list leaves
the prompt, the model is told to write its complete answer from the notes
(`CONTEXT_FULL_NUDGE`), and the turn ends with an answer instead of an
error.

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
| `parallelToolCalls`           | `tools.parallel` (default **false** for workflow nodes — workflow tools mutate shared run state). The mode stays `targets`; the feature `parallelToolCalls` of chats does not apply to workflow nodes. In `targets`, "read-only" is the tool's stamped `readOnly`, which is a read by declaration (`isTrustedReadOnly`): a node that sets `true` batches two calls of iHub's own read tools (`read_memory` and `read_inbox`, for example) since they declare `read`, where it ran them one after the other before |
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
onto the chat SSE dialect. An app that runs without a client (called as a tool,
through MCP `tools/call` or by an A2A agent) runs on the [run service](#run-service).
There is no chat-specific model loop:
budgets, tool execution, argument repair, compaction and abort handling are the
loop's.

Chat policies:

| Policy                   | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `budgets.maxToolRounds`  | 50 (`CHAT_MAX_TOOL_ROUNDS`); the last round is a forced tool-less final answer (a cap of 1 gets one extra tool-less call)         |
| `tools.parallel`         | **false**: one call at a time. With the feature `parallelToolCalls` on and a model that does not opt out (`parallelToolCalls: false` in the model file): **true** with `parallelMode: 'readOnly'` and `maxParallel: 4` (`chatToolPolicies`), for a chat turn and for an app that runs as a tool. See [Read-only tool calls side by side](tool-calling.md#read-only-tool-calls-side-by-side-preview) |
| `tools.choice`           | the app's `toolChoice` (default `auto`) |
| `budgets.maxWallClockMs` | runs without a client only (the [run service](#run-service), default 180 s)           |
| `timeoutMs`              | hard timeout per model call (the chat route's `DEFAULT_TIMEOUT`)                      |
| `context`                | `chatContextPolicies(model)`: threshold at 50 % of the model's `contextWindow` (at least 16,000), `strategy: 'digest'` |

Tools execute through the [tool runner](#tool-runner): model-provided
arguments may override `language` but never `chatId`, `user`, `appConfig` or
any other key of iHub's context. Before the tools are offered, `markInteractiveTools()` flags
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
connection — registers the question seam with `headless: true`: tools still
execute, but nobody can answer a question, so `ask_user` gets a
`NO_USER_AVAILABLE` error result instead of pausing the segment. The non-SSE
POST answers with `{ messageId, model, content, finishReason, usage }`.

### Run service

`RunService.run(spec, host)` (`server/services/run/RunService.js`) runs an app
without a client: an app called as a tool (`appToolsGateway.js`), an app called
through MCP `tools/call` or by an A2A agent (`mcp/appInvoker.js`). The caller
builds a run spec (`appRunSpec`) with a frozen run context (`RunContext.js`)
and hands a host (`hosts/HeadlessHost.js`) that receives what the run
produces.

- **Context.** `createRunContext` freezes the context all the way down (the
  principal, its groups and permission sets, the grant): a seam that tries to
  change `ctx.meta.run` throws a `TypeError`. A context cannot be built for a
  principal without resolved permissions; `principalResolver.resolvePrincipal`
  refuses one (`PRINCIPAL_UNRESOLVED`) and takes the admin flags away for every
  origin other than `person`. `unattended` is true for every origin other than
  `person` and for every principal that is not a person's account (an OAuth
  client, a personal API key, a service account); `isUnattendedCaller` in
  `utils/toolApproval.js` reads it.
- **Refusals.** Before the model is called the service refuses a spec without a
  context it built (`RUN_CONTEXT_INVALID`) and an app the principal may not open
  (`APP_NOT_PERMITTED`), and writes each refusal to the audit log. The callers
  that refuse before they reach the service (the app-as-tool gateway, the MCP
  and A2A app invoker, the MCP handler) write theirs too
  (`PRINCIPAL_UNRESOLVED`, `APP_NOT_PERMITTED`).
- **Seams.** `seamProfiles.build({ interactions: 'none', host, bindings })`
  returns the seams in order: `approval` (headless, fallback `deny`),
  `question` (headless), `passthrough`, `image-lift`, then the host's
  (`headless-tool-outputs`, `app-invoke-collector`). A call that needs approval
  is refused with `APPROVAL_REQUIRED_NO_USER` and never becomes a pending
  approval.
- **Grant.** The run is granted the tools it offers its model, the tools tool
  search can load and the web search fallback; every call goes through the
  tool runner with `toolContext.run`, which re-checks the grant.
- **Policies.** Those of a chat turn (`chatToolPolicies`, `chatContextPolicies`,
  50 rounds), a wall-clock deadline of 180 s and 120 s per model call unless the
  context's `budget` says otherwise (the MCP gateway: 60 s per model call).
- **Result.** A `kind: 'subagent'` segment; the host returns
  `{ status, finalMessage, toolCalls, sources, usage, finishReason, model, generatedFiles, images }`.
- **Nesting.** An app called as a tool runs one level below its caller
  (`childRunContext`, `depth` 1) and is offered no app tools of its own; the
  caller's integration scopes apply where the called app uses the same
  integrations (`assemble/fromApp.js`).

### Tool runner

Every tool call of a chat turn, of an app that runs as a tool (on the
[run service](#run-service)), of the passthrough seam, of the MCP gateway (`tools/call` of an integration tool and
of a workflow) and of an inbound A2A task that starts a workflow goes through
`ToolRunner.execute(call, { toolId, toolDef, args, signal, toolContext })`
(`server/services/run/ToolRunner.js`). The runner applies the checks below,
builds the tool's parameters from the call's arguments and the trusted
`toolContext`, and dispatches: an `app__<id>` call to the app-as-tool gateway,
everything else to `runTool` (`server/services/tools/runTool.js`), which keeps
the checks of the tool kinds themselves. `toolContext` says what the caller
vouches for: `origin` (`chat`, `subagent`, `mcp`, `a2a`), who decides the
approval (`approval`: `seam`, `refuse` or `caller`), the `principal` the tool
runs as (a user object today; a service account an admin chooses has the same
shape), the chat, the app, the language, the scopes, and for a workflow the
upload and whether the chat is stored. The display fields of a call (`title`,
`integration`, `activityKind`, `activityOrigin`) come from `toolDisplayOf`
alone; the runner logs every call with them.

The frozen legacy workflow executors (`PromptNodeExecutor`, `ToolNodeExecutor`)
still call `runTool` themselves and get none of these guarantees.
`server/tests/run/runToolAllowList.json` lists them with their reason and the
issue that removes them (#3784); `server/tests/run/runToolCallers.test.js`
fails for any other `runTool(` call outside `server/services/run/`.

| Check (test in `server/tests/run/toolRunner.checks.test.js`) | Before the runner | With the runner |
| --- | --- | --- |
| `tool-id-valid`: the tool id is a safe id | `runTool`, so every path | The runner, before any dispatch, on every path |
| `resolved-tool`: only a tool the caller resolved from what it offers runs | The loop (an unregistered name never reaches `executeTool`), the legacy prompt node (`matchTool`), the MCP SDK registry | Every path: a call without the caller's definition for that id is refused (`TOOL_NOT_RESOLVED`) |
| `approval-decided`: who decides the approval of a call is stated | Implicit per path | Every caller states `approval`; a call without it is refused (`TOOL_APPROVAL_UNDECIDED`) |
| `approval-refused-nobody`: a gated tool where nobody can approve is refused (`APPROVAL_REQUIRED_NO_USER`) | The approval seam (headless chat, app as a tool), the MCP gateway | The approval seam for loop callers (unchanged, first seam); the runner for `approval: 'refuse'` (the MCP gateway, same rule and text; `server/tests/mcpToolUserContext.test.js` drives the gateway's `tools/call` with a gated tool) |
| `page-read-cap`: page reads per turn (`websearch.maxPageReads`) | Chat turn, app as a tool | The runner, opt-in through `toolContext.pageReads`; chat turn and app as a tool pass it |
| `reserved-keys-caller`: an external caller's arguments never carry iHub's context | MCP gateway, A2A | The runner for `argsFrom: 'caller'` (MCP, A2A) |
| `reserved-keys-model`: a model's arguments never carry iHub's context, except a parameter the tool's own schema declares (not for a workflow, an app or a passthrough call) | Chat and app as a tool overrode `user`, `chatId`, `appConfig`, `integrationScopes`, `turnSkills`; the passthrough seam also dropped `runId`, whatever the tool declared | Chat, app as a tool and passthrough drop every reserved key (`passthrough`, `runId`, `_fileData` and `_chatHistory` too); a passthrough call drops them even where the tool declares them |
| `trusted-context`: the caller's context is set after the arguments | Each path its own set | One builder; each caller passes the set it passed before |
| `language`: a model may name the language of its call; for an external caller, the language the caller vouches for wins when it sets one | Chat, app as a tool (default); A2A (fixed); the MCP gateway set none, so a client's `language` argument reached the tool | The same, by `argsFrom` and `toolContext.language` (the MCP gateway still sets none) |
| `argument-repair`: raw model arguments are repaired | The loop, the legacy prompt node | The loop; the runner for a caller that hands only the raw call |
| `app-tool-routing`: an `app__` call goes to the app-as-tool gateway (permission, feature and nesting guards) | `runTool` (chat, without the abort signal), the legacy prompt node (with it) | The runner, with the caller's abort signal: a stopped answer stops the app it called. The model's arguments become the app's message and variables; the scopes, the timezone and the calling run travel beside them, never as an app variable (#3925) |
| `abort-signal`: the caller's abort signal reaches integration tools | Chat, app as a tool | Every caller that has one; the passthrough seam passes it now |
| `display`: the display fields come from `toolDisplayOf` | Loop events of chat and app as a tool | The same events; every call through the runner is logged with them, MCP and A2A included |
| `tool-exists`, `workflow-access`, `system-skill-permission`, `skill-usable` | `runTool` and the workflow runner, on every path | Unchanged, reached through the runner on every path |

A call of a run on the run service carries its run context
(`toolContext.run`); the runner then uses the context's principal as the
identity and re-checks the grant on every call. A refusal throws
`TOOL_NOT_GRANTED` and is written to the audit log (action `execute`, resource
`tool`, result `failure`; `details.runId` is the run that made the call,
`details.parentRunId` the run that started it). The context carries the
principal's permissions as they were when the run started: a grant withdrawn
from a group applies to the next run (or MCP session), while a disabled or
removed installation is refused on the next call. The rows below are tested in
`server/tests/run/toolRunner.grant.test.js`. Callers with a run context: an app
that runs as a tool (and its passthrough calls), the MCP gateway (`tools/call`
of an integration and of a workflow) and an A2A task that starts a workflow.
Chat turns and scheduled runs get the same checks when they move onto the run
service.

| Check (test in `server/tests/run/toolRunner.grant.test.js`) | Before | With a run context |
| --- | --- | --- |
| `run-context-valid`: the run context is one the run service built | - | A copy or a look-alike is refused (`RUN_CONTEXT_INVALID`) |
| `tool-grant`: the tool is one the run was granted | The MCP gateway (the tool was registered for the session) | Every call; no grant grants nothing |
| `integration-grant`: the installation still exists and is enabled, the principal's groups grant it, the run may reach it | The MCP gateway at call time; `runIntegrationTool` | The runner, before the tool and before the approval check; it reads the installation as the tool listing does (`installedIntegrationService.get`), so an always-installed built-in such as `ihub` counts as installed and enabled |
| `app-grant`: the principal may open the app of an `app__` call | The gateway (`isAppInvocationAllowed`, which let a principal without permissions through) | The runner, and the gateway, which now fails closed |
| `directory-grant`: a people directory is one the principal may use | The MCP gateway; the directory runner | The runner, on the frozen run principal (fails closed for an unknown directory) |

One check stays with the MCP gateway: the token scope (`mcp:tools:call`,
`mcp:workflows:run`).

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
