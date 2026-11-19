---
description: "The one event-stream dialect every run-scoped stream of the server speaks."
audience: developer
type: reference
---

# Streaming Events

Every run-scoped stream the server offers speaks the same dialect: the chat
stream (`GET /api/apps/:appId/chat/:chatId`, or the chat POST itself, see
[A chat turn on its own POST](#a-chat-turn-on-its-own-post)), the workflow execution stream
(`GET /api/workflows/executions/:id/stream`) and the agent run stream
(`GET /api/agents/runs/:id/stream`). Each frame is

```
event: <type>
data: { "v": 2, "seq": 12, "runId": "chat-8f3…", "ts": "2026-09-02T12:00:00.000Z", "type": "<type>", "data": { … } }
```

- `v` is the envelope format version and is always `2`. There is no other
  format and no compatibility mode: the stream events used before 5.4.23
  were removed, not kept as a fallback.
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
| `stream/connected`     | `{ runId, lastSeq, protocol: 2 }`                                                                                             | Subscription established; on a chat turn's own POST also `durable` (see below) |
| `stream/error`         | `{ code, message, details?, retryable, isContextWindowError? }`                                                               | The run failed; always followed by `run/ended { status: 'error' }`            |
| `run/started`          | `{ kind, model?, parentRunId?, refs }`                                                                                        | A run began (`kind`: chat, workflow, agent, subagent, inference, utility)     |
| `run/ended`            | `{ status, finishReason, limitReachedIn?, usage?, context?, knowledgeSources?, answerBasis?, toolName?, output?, cause?, error? }`                       | Terminal frame of a run. `limitReachedIn` (`reasoning` \| `answer`) can be set when `finishReason` is `length`: the thinking used the whole output limit, or the answer was cut off. Absent when the cause is unknown (no answer and no reasoning token count from the provider) |
| `run/paused`           | `{ reason: interaction \| manual \| system, interactionId? }`                                                                  | The run waits (a question, an approval)                                       |
| `run/resumed`          | `{ interactionId? }`                                                                                                          | The run continues                                                             |
| `step/delta`           | `{ step, kind: text \| thinking \| image, content?, image?, meta? }`                                                           | Streamed answer output of model step `step`                                   |
| `step/completed`       | `{ step, content, toolCalls, finishReason, usage?, sources?, groundingMetadata? }`                                             | A model step finished (`sources`: the knowledge-source names of the step)     |
| `tool/started`         | `{ step, callId, toolId, name, args, execution }`                                                                             | A tool call begins (`execution`: server, caller, clarification, passthrough)  |
| `tool/progress`        | `{ phase, message?, data?, step?, callId?, toolId? }`                                                                         | Free-form progress (see phases below)                                         |
| `tool/completed`       | `{ step, callId, toolId, name, resultPreview, error?, durationMs?, knowledgeSource? }`                                        | A tool call finished; `resultPreview` is bounded                              |
| `sources/added`        | `{ step?, callId?, toolId?, items, queries?, supports? }`                                                                     | What a tool call, a model adapter or provider search found (see below)        |
| `context/usage`        | `{ contextWindow, inputTokens, maxOutputTokens, source: provider \| estimate, step? }`                                         | How full the model's context window is, as the server counts it (see below)   |
| `context/compacted`    | `{ compactionId, step, status: running \| completed, trigger, strategy?, lossy, fallbackReason?, wrapUp?, tokensBefore?, tokensAfter?, itemsSummarised, kinds?, digest?, digestTruncated?, facts?, durationMs? }` | Earlier tool results were condensed or shortened to free context (see below)  |
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
  it makes, `outputKind`: the document, file, archive, web-artifact and dashboard tools) is
  announced as soon as its name and call id are known; any other tool, a system
  skill tool that makes nothing such as `preview_pdf` included, only once its
  arguments are still streaming 1.5 s after its name was seen, so a fast search
  never flickers.
- **Call id.** `callId` is the id `tool/started` and `tool/completed` will carry:
  the first id the provider sent for the call (the OpenAI-compatible and vLLM
  converters keep it even when a server repeats or changes the id with later
  fragments). Nothing is sent before the provider has sent the id.
- **First frame** (the announcement): `name` (the name the model called),
  `title` / `integration` / `activityKind` / `activityOrigin` as on `tool/started` (from
  `utils/toolDisplay.js`), `outputKind` for the built-in creators (`webArtifact`,
  `dashboard`, `document`, `presentation`, `workbook`, `pdf`, `file`, `archive`; decided on the
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

### `context/compacted`

Earlier tool results were condensed into a findings digest, or shortened
(`lossy: true`), to free the model's context (#3819; see
[Context compaction](agent-loop.md#context-compaction)). A digest takes a
summary call, so a chat turn sends `status: running` before it and
`completed` once the transcript changed; both carry the same `compactionId`.
`kinds` counts the results by activity kind as the server classified their
tools; `digest` is the digest as the model reads it, bounded to 8,000
characters (`digestTruncated`). The ledger's `context/compaction` projects to
the `completed` frame, so a re-sync (`view=sse`), a resumed stream and a
rebuilt activity show it too. `wrapUp: true` says the prompt stayed near the
window after condensing: the turn stopped searching and answers from the notes.
Journal entries written before compactions had
an id project to nothing. The chat shows it as a `compaction` row of the
answer's activity, placed by time among the tool calls. A `context/usage`
frame with the rebased figure follows the `completed` frame.

### `meta.extra`

| Key               | Emitted by                          | Value                                                  |
| ----------------- | ----------------------------------- | ------------------------------------------------------ |
| `workflow`        | chat-launched workflow bridge       | `{ status, workflowName, outputFormat, error? }`        |
| `planCreated`     | workflow planner                    | the plan                                               |
| `checkpointSaved` | workflow engine                     | `true`                                                 |


## Where a Tool Call Looked

`activityOrigin`, `resultCount`, `readOutcome` and `places` are optional and additive; a client keeps working when
one is missing and never works them out from a tool id or a provider. The old `activityScope`
(`web` or `documents`) is gone: where a call looked is `activityOrigin`.

- `tool/started`, the `args` progress frames and the ledger `tool/call` carry `activityOrigin`:
  `project | web | ifinder | iassistant | documents | integration`, the kinds of the footer's
  `answerBasis` (`activityOriginOf` in `utils/toolDisplay.js` reads the tool's declared category,
  [`activity`](tool-calling.md#what-a-tool-is-in-the-chat-activity)). Absent when the tool declares no
  origin and is no connected system. `read_url` declares `web`; an integration is named by `integration`.
  `activityKind` (`search | fetch | tool`) comes from the same declaration, never from the tool id.
  `tool/started` and the ledger `tool/call` may also carry `publicHits: true` when what the call found
  is on the open web (a web search run by a shipped engine): a shared chat keeps those hits and drops
  the hits of every other call.
- `tool/completed` and the ledger `tool/result` may carry `resultCount` (hits a search returned, `0`
  included; absent when unknown, so an empty source list is never "no results") and `readOutcome`
  (`opened`: a page or document read delivered text; `empty`: it completed without, for example
  `read_url` with an `offset` at the end of the page). They carry `activityOrigin` for a call whose
  origin only the result tells (`chat_sources_read` recalling sources of one origin).
- `tool/completed` and the ledger `tool/result` may also carry `places`: where the call looked, by
  name, `[{ name, ownership? }]` (at most 10, names of at most 120 characters, `ownership` is `user`
  or `admin`). A project search or read names its projects; an iFinder tool names its search
  profile (an admin's configuration, so `admin`). The tool reports them beside its result
  (`reportToolCallPlaces`), so the model reads nothing more, and the server decides: a client
  never works a name out from a source or a tool id. Absent when the server names none. A row
  shows the names; the stored activity keeps them, and a share keeps only the `admin` ones.
- `skill.activation` `activatedBy`: `user | app | model | chat` (`chat`: kept from an earlier message).
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
`documents` (kept for chats stored before admin-configured sources became projects; no new answer carries it), `integration` (with its `label`,
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

## A chat turn on its own POST

A client can also read a turn from the request that sends it, without opening
the GET first: `POST /api/apps/:appId/chat/:chatId` with
`Accept: text/event-stream`. The type has to be named and preferred over JSON
(q-values count); a wildcard alone (`*/*`, `text/*`) is not enough. Without it
the POST answers exactly as before (`{ status: 'streaming', chatId }` once the
turn has ended, frames on the GET).

- **Before the turn starts** every refusal keeps its status and
  `application/problem+json` body: authentication, validation, an unknown chat,
  `CLIENT_HISTORY_NOT_ALLOWED`, `AI_ACKNOWLEDGEMENT_REQUIRED` (428),
  `CHAT_STORAGE_UNAVAILABLE` (503) and the rest. The SSE headers go out only
  once the turn is committed (its run is named).
- **After that** the answer is `200 text/event-stream`: `stream/connected`, then
  the same frames as on the GET (tool progress, the wait for outdated documents,
  a workflow a tool launched), ending after the turn's `run/ended` or
  `run/paused`. The stream numbers its own `seq` from its `stream/connected`. A
  preparation failure is the failed run (`run/started`, `stream/error`,
  `run/ended`). A refusal or failure after the commit point is a `stream/error`
  frame with the `code` and message its problem+json body would have (a 5xx
  message only when it is safe to show) and `details.status`, then
  `run/ended { status: 'error' }` of the turn's run, then the end.
- An `@workflow` mention is still answered with JSON; its frames come over the
  GET, which backfills what it missed when it connects.
- Closing the response stops a temporary chat's turn (cause
  `client_disconnected`, via `POST stream closed`); a kept chat's turn keeps
  running and is stored, like a closed GET.
- The frames of such a turn are written by the worker that holds the POST, so
  they never cross the cluster bus. The 30-second `: heartbeat` comment keeps
  proxies from timing out a long turn; the SPA counts a POST that stays silent
  for 60 seconds as dropped and re-attaches.
- Its `stream/connected` carries `durable`: `true` when the turn outlives the
  connection (a kept chat), `false` when closing the response stops it (a
  temporary chat, including one the server made temporary itself: an anonymous
  user, no chat history). A client decides on it whether a dropped stream can
  be re-attached to.
- The POST carries the frames of its own turn only: the turn's run, frames of
  the chat itself, and runs started while it is the chat's current POST (a
  child of an older turn's run excepted). An older turn still running on the
  chat after a newer POST took over (superseded) is not written to the newer
  one.
- A GET opened on the same chat meanwhile (a second tab, or a client that
  re-attached while its old POST socket is half-open) gets every frame too, in
  this worker or relayed to the worker holding it. Only then does a POST
  turn's traffic cross the bus.
- While the POST is open the chat counts as connected: `/status` answers
  `active: true` with `processing`.

Every frame a turn emits carries `rseq`, a counter per run assigned where the
frame is produced, and is written with an SSE `id: {runId}:{rseq}` line. The
stream `seq` stays as described above. The server ignores `Last-Event-ID`: a
client re-attaches with `resumeRun` (below).

### Re-attaching mid-step

The ledger has no `step/delta` frames and no thinking. A client that re-attaches
to a running turn (a reload, a second tab, a POST stream that broke) replays the
ledger, then opens the GET with `?resumeRun={runId}&afterLedgerSeq={last ledger seq replayed}`.
The worker producing the run answers, before the stream goes live, with:

1. the ledger events after `afterLedgerSeq`, read after a flush;
2. the run's partial state as ordinary `step/delta` frames: the thinking of
   every step so far and the text of each step that has not completed, minus
   the text of a step the ledger above completed (at most 256 KB of unfinished
   text and 512 KB of thinking per run; past either a `…` marks where it was
   cut and the transcript re-read at the end fills it in).

The ledger comes first so that a step that completed after the client's replay
is completed before the next step's text is appended.

Live frames of that run numbered at or below the snapshot are dropped, so
nothing is doubled; the client additionally drops a frame whose `rseq` it has
already seen on the connection. Across workers this is one bus request and one
reply per re-attach (`services/chat/chatResume.js`).

Known limits without sticky sessions across pods: Stop reaches a turn only on
its own pod, a re-attach on another pod gets the ledger but neither the partial
text nor the live tail, and `/status.processing` is per pod.

The SPA uses the POST stream when the `chatPostStream` feature is on
(Admin → Features); turning it off takes effect on the next message. The
surfaces that run without the platform configuration (the Office add-in, the
browser extension) always use the GET and the JSON POST. Should they ever use
the POST stream: a 401 on it does not expire the main app's session while a
host sign-in is registered (`setSseAuthProvider`), as the API client's
interceptor skips `_isOfficeRequest`.

A POST that gets no answer at all (a proxy's 502/504 while the server is still
preparing the turn, a network failure, no headers within 300 seconds) may have
started the turn anyway. The SPA then reads the chat: if it is `running`, it
re-attaches to its `activeRunId` instead of reporting a failure, so a retry does
not run the turn twice. A re-attached turn re-reads the stored transcript once
it has settled.

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
