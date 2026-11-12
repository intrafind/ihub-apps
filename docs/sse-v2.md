# SSE v2 — the one streaming dialect

Every run-scoped stream the server offers speaks the same dialect: the chat
stream (`GET /api/apps/:appId/chat/:chatId`), the workflow execution stream
(`GET /api/workflows/executions/:id/stream`) and the agent run stream
(`GET /api/agents/runs/:id/stream`). Each frame is

```
event: <type>
data: { "v": 2, "seq": 12, "runId": "chat-8f3…", "ts": "2026-09-02T12:00:00.000Z", "type": "<type>", "data": { … } }
```

- `v` is always `2`.
- `seq` is a per-stream monotonic counter, assigned by the worker that
  delivers the stream (frames of one stream may be produced on several
  workers and relayed). A gap tells the client it missed frames (cluster
  relay, reconnect); it then rebuilds the affected run from its ledger,
  `GET /api/runs/:runId/events?view=sse`, which returns the run's events as
  envelopes (no `step/delta` frames — the completed steps carry the full
  content). The ledger's `seq` is the run's own sequence and is never compared
  with the stream's. Every connection is a new sequence epoch: the client
  resets its de-duplication when it (re)connects, and `stream/connected`
  carries the first `seq` of the epoch. A reconnect whose counter does not
  continue the previous one (frames missed while disconnected, a counter that
  restarted after eviction or failover) rebuilds the run from its ledger.
- `runId` is the run the event belongs to. A chat turn is one run (the server
  mints it and announces it with `run/started`, whose `data.refs` carries
  `chatId`, `appId` and the client's `messageId`); a workflow execution is one
  run whose id is the execution id; child sub-workflows keep their own
  execution id as `runId`, so several runs can share one stream. Stream-level
  frames (`stream/*`) carry the id the client subscribed with.

The contracts live in `shared/runEvents.js` (names) and
`server/services/loop/contracts/sseV2.js` (Zod payloads); the producer is
`server/services/loop/RunStream.js`; the client folds every frame through one
reducer, `client/src/shared/run/runReducer.js`.

## Frame types

| Type                   | Payload                                                                                                                       | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `stream/connected`     | `{ runId, lastSeq, protocol: 2 }`                                                                                             | Subscription established                                                      |
| `stream/error`         | `{ code, message, details?, retryable, isContextWindowError? }`                                                               | The run failed; always followed by `run/ended { status: 'error' }`            |
| `run/started`          | `{ kind, model?, parentRunId?, refs }`                                                                                        | A run began (`kind`: chat, workflow, agent, subagent, inference, utility)     |
| `run/ended`            | `{ status, finishReason, usage?, context?, knowledgeSources?, answerBasis?, toolName?, output?, cause?, error? }`                       | Terminal frame of a run                                                       |
| `run/paused`           | `{ reason: interaction \| manual \| system, interactionId? }`                                                                  | The run waits (a question, an approval)                                       |
| `run/resumed`          | `{ interactionId? }`                                                                                                          | The run continues                                                             |
| `step/delta`           | `{ step, kind: text \| thinking \| image, content?, image?, meta? }`                                                           | Streamed answer output of model step `step`                                   |
| `step/completed`       | `{ step, content, toolCalls, finishReason, usage?, sources?, groundingMetadata? }`                                             | A model step finished (`sources`: the knowledge-source names of the step)     |
| `tool/started`         | `{ step, callId, toolId, name, args, execution }`                                                                             | A tool call begins (`execution`: server, caller, clarification, passthrough)  |
| `tool/progress`        | `{ phase, message?, data?, step?, callId?, toolId? }`                                                                         | Free-form progress (see phases below)                                         |
| `tool/completed`       | `{ step, callId, toolId, name, resultPreview, error?, durationMs?, knowledgeSource? }`                                        | A tool call finished; `resultPreview` is bounded                              |
| `sources/added`        | `{ step?, callId?, toolId?, items, queries?, supports? }`                                                                     | What a tool call, a model adapter or provider search found (see below)        |
| `context/usage`        | `{ contextWindow, inputTokens, maxOutputTokens, source: provider \| estimate, step? }`                                         | How full the model's context window is, as the server counts it (see below)   |
| `interaction/raised`   | `{ interaction }`                                                                                                             | A human touchpoint (question, approval, review) — see `contracts/interaction.js` |
| `interaction/answered` | `{ interactionId, kind, answer }`                                                                                             | The touchpoint was answered                                                   |
| `progress/node`        | `{ executionId?, nodeId, nodeName?, nodeType?, status, iteration?, progress?, output?, error? }`                              | Workflow node progress (also chat-launched workflows)                         |
| `meta`                 | `{ conversationId?, title?, messageId?, responseMessageId?, chatId?, executionId?, extra? }`                                   | Surface metadata that is not run semantics                                    |

### `tool/progress` phases

| Phase                          | Emitted by                                  | `data`                                                  |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------- |
| `skill.activation`             | chat turn (slash command, `activate_skill`) | `{ skillName, skillId, activatedBy, description }`      |
| `search.status`                | iAssistant conversation adapter             | provider payload                                        |
| `grounding`                    | Google Search grounding                     | grounding metadata                                      |
| `search`                       | Brave web search                            | `{ query, provider }`                                   |
| `fetch.loading` / `fetch.parsing` / `fetch.extracting` | `read_url`   | `{ url, status, type? }`                                |
| `ifinder_search` / `ifinder_content` / `ifinder_download` | iFinder tools        | `{ query? \| documentId, searchProfile, … }`             |
| `agent.*`                      | agent runtime (workflow / agent streams)    | the former internal event payload (task queue, plan, artifacts, inbox, memory, skills, hallucinated tools …) |
| `args`                         | chat turn, while a tool call's arguments stream | `{ name, title?, integration?, activityKind?, outputKind?, argBytes, elapsedMs, occurrence? }` (first frame and every 5th after it), otherwise `{ argBytes, elapsedMs }`; frame also carries `step`, `callId`, `toolId` |
| `args.ended`                   | chat turn, when that model call ends        | `{ outcome, argBytes, elapsedMs }`; frame also carries `step`, `callId`, `toolId` |
| `model.waiting`                | chat turn, while the model shows nothing    | `{ elapsedMs, reasoning? }`; frame also carries `step` |

### Tool calls and silence while the model writes (`args`, `args.ended`, `model.waiting`)

A tool call such as `create_web_artifact` carries a whole file in its arguments,
and a model needs a minute or more to write it. The loop runs no tool before the
call is finished, so `tool/started` comes late. These three phases fill the gap.
They are **live only**: the stored-activity allow-list (`RECORDED_PROGRESS_PHASES`
in `server/services/chat/runActivity.js`) keeps them out of stored chats and the
run ledger, and `tool/started` / `tool/completed` are unchanged. They are sent
on the chat stream only (the chat's `chatToolSeam`); workflow and agent runs do
not send them. Logic and every timing: `server/services/chat/toolArgProgress.js`.

`args` announces a call while its arguments are still streaming:

- **Which calls.** The call name must resolve to a tool the loop offered that the
  server runs and the chat shows: never an unknown or hallucinated name,
  `activate_skill` and the other loop tools, `ask_user`, a passthrough (workflow)
  tool or a caller-executed tool. A creator (a built-in tool that declares what
  it makes, `outputKind`: the document, file, archive and web-artifact tools) is
  announced as soon as its name and call id are known; any other tool, a system
  skill tool that makes nothing such as `preview_pdf` included, only once its
  arguments are still streaming 1.5 s after its name was seen, so a fast search
  never flickers.
- **Call id.** `callId` is the id `tool/started` and `tool/completed` will carry:
  the first id the provider sent for the call (the OpenAI-compatible and vLLM
  converters keep it even when a server repeats or changes the id with later
  fragments). Nothing is sent before the provider has sent the id.
- **First frame** (the announcement): `name` (the name the model called),
  `title` / `integration` / `activityKind` as on `tool/started` (from
  `utils/toolDisplay.js`), `outputKind` for the built-in creators (`webArtifact`,
  `document`, `presentation`, `workbook`, `pdf`, `file`, `archive`; decided on the
  server, `undefined` for every other tool), `argBytes`, `elapsedMs`, and
  `occurrence` (only when 2 or more: how many calls of this tool the turn has
  announced). **Most later frames carry `argBytes` and `elapsedMs` only**: merge
  them into what the first frame said, do not replace it. **Every 5th frame
  repeats the display fields**, because the run ledger does not replay `args`
  frames: a client that attaches mid-call (a reload) has missed the first one and
  draws the row from the next repeat, at most 5 s later.
- **`argBytes`**: UTF-8 bytes of the raw argument JSON received so far, escapes
  counted as sent (a little more than the finished file). Absolute, never
  decreases. **`elapsedMs`**: since the call's first fragment.
- **No argument text** is in any of these frames.
- **Throttle.** At most one `args` frame per call per second, at least one every
  2 s while fragments flow; at most 130 frames and 40 KB per call over 120 s.

`args.ended` closes every announced call exactly once, from `streamEnd` (see
[Agent loop](agent-loop.md)), before `step/completed` and before any
`tool/started`. `data.outcome`:

| Outcome     | Meaning                                                                                         | What follows                                                        |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ready`     | The finished call exists and its arguments parse (or the loop repaired them)                    | `tool/started` for the same `callId`, or, for a gated call, `interaction/raised` (no `tool/started`) |
| `invalid`   | The arguments could not be read as JSON at all                                                  | The loop still runs the call with `{}`: `tool/started`, `tool/completed` with an error |
| `truncated` | The model hit its output limit inside the arguments (`finishReason: length`)                    | As `invalid` where the loop could read the call; nothing where the provider never finished it |
| `dropped`   | The finished list has no such call (or no name), so the loop will not run it                    | Nothing                                                             |
| `aborted`   | Stop, the run's deadline or a provider error ended the model call                               | `stream/error` or `run/ended`                                       |

A `tool/started` for the call always wins over an earlier `args.ended`. A `ready`
call that never gets a `tool/started` (the approval gate took it over, the run
paused or ended first, an earlier call of the batch ended the turn) simply has
no further frame: the client closes a row that is still preparing when the run
ends.

`model.waiting` is the line for a model that shows nothing: after 3 s without
visible output (answer text, an image, an announced tool row), then once a
second until something is shown or the model call ends. `elapsedMs` is the time
since the last visible output (the client derives its clock from it, not from
when the frame arrived). `reasoning: true` means the model streamed reasoning
(shown or not) since then, so the chat can say "Thinking" instead of "Waiting
for the model". Reasoning does not restart the clock. The line works for every
provider, also one that sends nothing until the finished call. It stands down
while an announced row is open and there is no end frame: the client drops the
line when answer text, an image, `args` or `tool/started` arrives.

Early signal per provider: OpenAI-compatible (Chat Completions), vLLM,
Anthropic, OpenAI Responses and Bedrock expose the call while it streams
(`chunk.toolCallProgress`, see `server/adapters/toolCalling/toolCallProgress.js`);
Gemini and Mistral send calls whole and get the waiting line only, as does a
vLLM tool-call parser that buffers upstream.

### `sources/added`

Everything a run found — the pages a web search returned or the page reader
read, the documents an iFinder tool or iAssistant found, what any tool, MCP
server or app invoked as a tool reported — arrives in one frame type, in the
one shape of [Answer Sources](answer-sources.md): `items` are normalized
sources, `queries` what was searched for, `supports` Google Search
grounding's passages with the URLs each rests on (for citation markers).

Frames only ever add. The client folds them with the same `mergeSources`
the server uses for the stored answer (`shared/sources/sourceSet.js`); a
frame with a `callId` is also the list of that tool call's own sources,
which the activity panel above the answer shows. The event is written to the
run ledger too, so a re-sync replays it.

Sources are taken from the tool's *full* result on the server
(`server/services/sources/`): the preview of a web search result is cut at
4 KB, which a search that extracted page content exceeds on its first hit.
Provider-run web search reports its queries as `webSearchQueries` on the
grounding metadata as well (Google natively; Anthropic's `web_search` queries
are mapped onto the same field), which the activity panel shows.

### `context/usage`

How full the model's context window is. The server owns the transcript, so
it reports the figure: a research turn that reads pages fills the window with
tool results the client never holds. The frame goes out before every model
call (the transcript as that call will find it) and after every reply
(`source: provider`: the prompt the provider counted for that call plus its
answer). Between two provider counts, what the transcript grew by — the
reply, tool results — is estimated, so the figure rises as soon as a page is
read, not one model step later. `inputTokens` is input only;
`maxOutputTokens` is the model's output reserve, which the client adds for
the remaining capacity.

`run/ended` carries `context` too, but not the last live state: it is what
the *next* turn will send — the prompt the turn started from (system prompt,
history, the question) plus the answer. Later prompts are built from the
stored messages (role and content), so the tool calls and results of a
finished turn are not replayed and must not count against the next turn. The
stored assistant message keeps that figure (`message.context`), so a reopened
chat shows it. Reasoning tokens are left out of the figure after a reply: they
are billed as output but never become part of the transcript. The frame itself is live only and is not written to the run ledger.
The composer's context counter (`ChatInput`) starts from the latest
`message.context` and estimates only what came after it — the pending input
and the messages not yet answered. A chat without one (a fresh chat, a chat
stored before this existed, an app that sends no history) is estimated on
the client alone.

### `meta.extra`

| Key               | Emitted by                          | Value                                                  |
| ----------------- | ----------------------------------- | ------------------------------------------------------ |
| `workflow`        | chat-launched workflow bridge       | `{ status, workflowName, outputFormat, error? }`        |
| `planCreated`     | workflow planner                    | the plan                                               |
| `checkpointSaved` | workflow engine                     | `true`                                                 |

## A chat turn on the wire

```
stream/connected            once per connection
run/started                 { kind: 'chat', model, refs: { chatId, appId, messageId } }
tool/progress               phase skill.activation (only when a skill was pre-activated)
tool/progress               phase model.waiting (live only, while the model shows nothing)
step/delta …                text / thinking / image deltas of step 1
tool/progress               phase args / args.ended (live only, while a tool call's arguments stream)
tool/started                the model called a tool
tool/completed              its (previewed) result
step/completed              step 1 summary, then step 2 deltas …
run/ended                   { status: 'completed', finishReason: 'stop', usage, knowledgeSources }
```

A clarification (`ask_user`) ends the turn with `interaction/raised`
(kind `question`) → `tool/completed` → `run/paused { reason: 'interaction' }`;
the user's answer arrives as the next chat message (or through
`POST /api/runs/:runId/interactions/:id/answer`; the interaction is persisted). A passthrough tool (a
workflow launched from chat) streams its answer as `step/delta` frames and ends
with `run/ended { finishReason: 'tool_passthrough_complete', toolName }`. A
failure is `stream/error` followed by `run/ended { status: 'error' }`; a stop
or disconnect is `run/ended { status: 'aborted', finishReason: 'connection_closed', cause }`.
`cause` says who stopped the run and from where: `{ kind, message, at, actor: { type, id?, owner? },
origin: { via, source?, worker? }, related? }` with `kind` one of `user_stop`, `run_stop`,
`task_run_cancelled`, `task_deleted`, `task_disabled`, `chat_deleted`, `user_deleted`,
`superseded`, `client_disconnected`, `client_evicted`, `api_client_closed`, `lease_lost` or
`unknown`. The same object is on the ledger's `run/end`. Only a person's Stop (or the server)
ends a turn: a client that merely leaves or reconnects sends nothing.

`run/ended.answerBasis` is what the answer is based on, and the only thing the
chip under the answer reads (see [Answer Sources](answer-sources.md#what-users-see)):
`[{ kind, label? }]`, one entry per kind of source the answer used and one per
connected system. `kind` is `project`, `web`, `ifinder`, `iassistant`,
`documents` (sources an admin configured), `integration` (with its `label`,
for example `Jira`; an MCP server or remote agent as well), `email`, `file`,
`audio`, or `model` when the answer used none of them (its own knowledge), which
then stands alone. The server decides it; the client maps no tool id. A project
counts only when it `contributed` (see `knowledge/scope` below). A passthrough
answer is the tool's output, not the model's, so it lists only the kinds it used
and has none when that is nothing; a workflow's answer is named by its workflow
result. The server names the basis on an answered turn, including a stopped one
that had already written part of its answer; a turn that failed, paused for a
question or was stopped before it wrote anything carries none, and the client
shows no chip. The ledger's `run/end` keeps the same list, so a replayed turn
shows the same chip, and the stored message keeps it as `answerBasis`.

`knowledge/scope` lists the projects of the turn. Each has `contributed`: its text
went into the prompt, or a search or read of the turn returned its documents. It is
sent when the turn starts, with what went into the prompt, and again before
`run/ended` when a search then made a searched project contribute; the later frame
replaces the earlier one.

`run/ended.knowledgeSources` stays the list of the ledger and analytics:
`websearch`, `ifinder`, `project`, `sources`, `iassistant`, `grounding`,
`email`, `file`, `audio` — or `llm` when the model answered from none of them.
`project` is the chat's project knowledge, in the prompt or found by a
`knowledge_*` call; `sources` is what an admin configured.
`tool/completed.knowledgeSource` and `step/completed.sources` are per-tool and
per-step detail, not the answer's basis.

## A workflow run on the wire

```
stream/connected
run/started                 { kind: 'workflow', refs: { executionId, workflowId, startNodes } }
progress/node               status running → completed per node (output = the node result)
tool/progress               phase agent.task.created / agent.plan.updated / … on agent runs
interaction/raised          a human checkpoint (kind approval | review | question) + run/paused
interaction/answered        + run/resumed once the checkpoint is answered
run/ended                   { status: completed | error | aborted, finishReason, output, error? }
```

## Client

`useRunStream` (`client/src/shared/hooks/useRunStream.js`) opens the stream
(fetch + `parseSseStream`, Bearer token for the Office add-in, 401 refresh),
validates `v === 2`, folds every frame with `reduceRunEvent` and re-syncs on a
`seq` gap. Surfaces project the resulting `StreamState` onto their view:
`features/chat/runToMessage.js` builds the assistant message,
`features/workflows/workflowRunProjection.js` builds the execution page state.
No surface interprets event names on its own.
