# AgentLoop — the one tool loop

Every tool-using model turn in the server runs through `AgentLoop`
(`server/services/loop/AgentLoop.js`). Workflow prompt/agent nodes and the
tool-enabled verifier already use it; chat, app-as-tool and the MCP gateway
move onto it next (epic stage C3). There is no second loop: a loop behaviour is
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
  kind: 'workflow',         // chat | workflow | agent | inference | utility
  model,                    // resolved model object (see llmClient.resolveModel)
  messages,                 // starting transcript, system message first
  tools,                    // ToolSpec[]: { id, description, parameters, readOnly?, interactive?, passthrough? }
  toolExecution: 'server',  // 'caller' hands tool calls back instead of executing them
  policies: { budgets, tools, context, interactions, approval },
  options: { temperature, maxTokens, responseSchema, nativeWebSearch, thinking… },
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
| `budgets.maxToolRounds`           | 10      | Round cap; the last round is spent on a forced final answer            |
| `budgets.maxTokensPerRun`         | 0       | Run-level token cap across every segment sharing `state.budget` (0 = unlimited) |
| `budgets.maxWallClockMs`          | —       | Wall-clock deadline for the invocation                                 |
| `tools.maxRateLimitFailures`      | 2       | 429/503-style failures before a tool is withheld for the segment       |
| `tools.maxConsecutiveFailures`    | 3       | Consecutive failures (any error) before a tool is withheld              |
| `tools.parallel` / `maxParallel`  | true / 4 | Segment planner: read-only tools and non-overlapping calls run concurrently |
| `context.compactThresholdTokens`  | 16000   | Proactive compaction threshold (old tool/assistant bodies collapse)    |
| `context.compactKeepRecent`       | 6       | Trailing messages kept verbatim when compacting                        |
| `context.maxReactiveAttempts`     | 2       | Retries after a provider "prompt too long" error, each after compaction |
| `interactions.maxQuestions`       | 10      | Clarification cap for interactive tools (question seam)                |

### Result

```js
{
  runId, status,            // completed | paused | aborted | error | budget_exhausted
  content, finishReason,    // finishReason: provider value, or 'budget_exhausted' | 'max_iterations' | 'clarification' | 'tool_passthrough_complete'
  usage, runUsage,          // this segment / the whole run (promptTokens, completionTokens, totalTokens)
  iterations, messages,     // rounds used; final provider-valid transcript
  citations, knowledgeSources, thoughtSignatures, images,
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
| `onChunk(ctx, chunk)`           | Every streamed chunk                                                | Forward to a client                                |
| `stepEnd(ctx, step)`            | After each model turn (`step.result`, `step.usage`, `step.toolCalls`) | Capture grounding metadata, telemetry            |
| `preTool(ctx, info)`            | Before a tool executes                                              | Return `{ handled, message, terminate }` to take the call over |
| `postTool(ctx, info, outcome)`  | After a tool executed                                               | Rewrite `outcome.message`, lift images, add citations / knowledge sources |
| `onHallucinated(ctx, info)`     | Model called an unregistered tool                                   | Record for audit                                   |
| `onCircuitBroken(ctx, info)`    | A tool was withheld                                                 | Record / notify                                    |
| `onCompaction(ctx, info)`       | Transcript was compacted (`trigger: 'proactive' | 'overflow'`)      | Telemetry                                          |

Built-in seams live in `server/services/loop/seams/`:

- `questionSeam` — `interactive: true` tools (today `ask_user`) raise a question
  interaction and pause the segment; a per-conversation cap turns further
  questions into an error the model has to work around.
- `passthroughSeam` — `passthrough: true` tools stream their own answer to the
  user and end the turn.
- `imageLiftSeam` — image payloads in tool results become `message.imageData`.
- `knowledgeSourceSeam` — classifies search / source / grounding tools into the
  knowledge-source badges the chat UI shows.

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
| `compactThresholdTokens`      | `context.compactThresholdTokens`            |
| `compactKeepRecent`           | `context.compactKeepRecent`                 |
| `outputSchema`                | `options.responseSchema`                    |
| `thinking`                    | thinking options                            |

The agent profile's `budgets.maxTokensPerRun` is enforced across the whole run
through `state.data._budget` on the workflow state. Before the loop existed
the profile budgets were read from a context field no caller populated, so
they were never enforced; profiles that set `maxTokensPerRun` or
`maxToolRoundsPerNode` now see them applied.

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
