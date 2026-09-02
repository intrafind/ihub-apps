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
- `seq` is a per-stream monotonic counter. A gap tells the client it missed
  frames (cluster relay, reconnect); it re-syncs from
  `GET /api/runs/:runId/events?after=<seq>&view=sse`, which returns the same
  envelopes projected from the run ledger (no `step/delta` frames — the
  completed steps carry the full content).
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
| `run/ended`            | `{ status, finishReason, usage?, knowledgeSources?, toolName?, output?, error? }`                                            | Terminal frame of a run                                                       |
| `run/paused`           | `{ reason: interaction \| manual \| system, interactionId? }`                                                                  | The run waits (a question, an approval)                                       |
| `run/resumed`          | `{ interactionId? }`                                                                                                          | The run continues                                                             |
| `step/delta`           | `{ step, kind: text \| thinking \| image, content?, image?, meta? }`                                                           | Streamed answer output of model step `step`                                   |
| `step/completed`       | `{ step, content, toolCalls, finishReason, usage?, citations?, sources?, groundingMetadata? }`                                 | A model step finished                                                         |
| `tool/started`         | `{ step, callId, toolId, name, args, execution }`                                                                             | A tool call begins (`execution`: server, caller, clarification, passthrough)  |
| `tool/progress`        | `{ phase, message?, data?, step?, callId?, toolId? }`                                                                         | Free-form progress (see phases below)                                         |
| `tool/completed`       | `{ step, callId, toolId, name, resultPreview, error?, durationMs?, knowledgeSource? }`                                        | A tool call finished; `resultPreview` is bounded                              |
| `interaction/raised`   | `{ interaction }`                                                                                                             | A human touchpoint (question, approval, review) — see `contracts/interaction.js` |
| `interaction/answered` | `{ interactionId, kind, answer }`                                                                                             | The touchpoint was answered                                                   |
| `progress/node`        | `{ executionId?, nodeId, nodeName?, nodeType?, status, iteration?, progress?, output?, error? }`                              | Workflow node progress (also chat-launched workflows)                         |
| `meta`                 | `{ conversationId?, title?, messageId?, responseMessageId?, chatId?, executionId?, extra? }`                                   | Surface metadata that is not run semantics                                    |

### `tool/progress` phases

| Phase                          | Emitted by                                  | `data`                                                  |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------- |
| `skill.activation`             | chat turn (slash command, `activate_skill`) | `{ skillName, description }`                            |
| `search.status`                | iAssistant conversation adapter             | provider payload                                        |
| `citation`                     | iAssistant conversation adapter             | `{ references, resultItems }`                           |
| `grounding`                    | Google Search grounding                     | grounding metadata                                      |
| `search`                       | Brave web search                            | `{ query, provider }`                                   |
| `fetch.loading` / `fetch.parsing` / `fetch.extracting` | `webContentExtractor`   | `{ url, status, type? }`                                |
| `ifinder_search` / `ifinder_content` / `ifinder_download` | iFinder tools        | `{ query? \| documentId, searchProfile, … }`             |
| `agent.*`                      | agent runtime (workflow / agent streams)    | the former internal event payload (task queue, plan, artifacts, inbox, memory, skills, hallucinated tools …) |

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
step/delta …                text / thinking / image deltas of step 1
tool/started                the model called a tool
tool/completed              its (previewed) result
step/completed              step 1 summary, then step 2 deltas …
run/ended                   { status: 'completed', finishReason: 'stop', usage, knowledgeSources }
```

A clarification (`ask_user`) ends the turn with `interaction/raised`
(kind `question`) → `tool/completed` → `run/paused { reason: 'interaction' }`;
the user's answer arrives as the next chat message. A passthrough tool (a
workflow launched from chat) streams its answer as `step/delta` frames and ends
with `run/ended { finishReason: 'tool_passthrough_complete', toolName }`. A
failure is `stream/error` followed by `run/ended { status: 'error' }`; a stop
or disconnect is `run/ended { status: 'aborted', finishReason: 'connection_closed' }`.

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
