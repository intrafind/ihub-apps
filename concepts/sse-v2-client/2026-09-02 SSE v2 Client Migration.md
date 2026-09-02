# SSE v2 client migration — how the streaming surfaces work now

Status: implemented (client only, C4 of the "one agentic loop" refactor).
Server side (`server/services/loop/RunStream.js`, `contracts/sseV2.js`) is the
producer; this document describes the consumer so anyone can continue the work.

## 1. Wire contract (what the server sends)

Every stream frame is `event: <type>` + `data: <envelope>` with

```
envelope = { v: 2, seq, runId, ts, type, data }
```

- `seq` is **per stream** and monotonic (a chat stream = one chatId, a workflow
  stream = one executionId). Several runs can share a stream (each chat turn is
  its own runId; child sub-workflows keep their own executionId as runId).
- Event names live in `shared/runEvents.js` (`SSE_V2_EVENTS`), payload schemas
  in `server/services/loop/contracts/sseV2.js` (read-only reference for the
  client). Interactions (clarifications, checkpoints) follow
  `contracts/interaction.js`.
- Re-sync after a gap: `GET /api/runs/:runId/events?after=<seq>&view=sse` →
  `{ runId, after, events: [envelope…], lastSeq }` (ledger projection: no
  `step/delta`, but `step/completed` carries the full content).

## 2. Client building blocks

| File | Role |
| --- | --- |
| `client/src/shared/utils/parseSseStream.js` | Spec-compliant SSE parser over a `ReadableStream`. Frames without `event:` are dispatched as `message`. |
| `client/src/shared/utils/openSseStream.js` | **The one transport.** `openSseStream(url, { signal, onEvent, onOpen })` = fetch + Bearer header (`office_ihubtoken` / `authToken`) + one silent 401 refresh + `parseSseStream`. Also `fetchWithAuthRetry` (re-sync), `toRunEnvelope(name, data, streamId)` (frame → envelope or null) and `syntheticStreamError` (transport failures as `stream/error` envelopes, flagged `synthetic: true`, no `seq`). No native `EventSource` exists in the client any more. |
| `client/src/shared/run/runReducer.js` | **The one reducer.** `createStreamState(streamId)`, `reduceRunEvent(state, envelope)`, `reduceRunEvents`, `foldResyncEvents(state, page, seenSeqs)` + selectors (`getRun`, `getRuns`, `getPendingInteraction`, `getStreamProgress`, `getStreamInteractions`, `isRunFinished`, …). Pure and framework-free. |
| `client/src/shared/run/interactionToCheckpoint.js` | Rebuilds the legacy `checkpoint` object `HumanCheckpoint.jsx` renders from an interaction; `isCheckpointInteraction` / `isClarificationInteraction` tell workflow checkpoints (`source.checkpointId`) from chat `ask_user` questions. |
| `client/src/shared/hooks/useEventSource.js` | Chat transport: opens the chat stream, delivers `onEvent({ type, envelope })`, keeps heartbeat (`checkAppChatStatus`) and `stopAppChatStream` cleanup. Terminal frames = `run/ended` of the turn's run (first top-level `run/started` on the connection) and `stream/error`. |
| `client/src/shared/hooks/useRunStream.js` | Generic run-stream hook: `{ state, connect(url, { streamId, rootRunId }), disconnect(), connected, resync(runId, after), reset(), push(envelope), error }`. `useReducer` over the run reducer; on `state.gap` it re-syncs the affected run and folds the page (dedupe by seq via a `Set` kept in the hook — reducers must stay pure); `closeOnRunEnd` ends the stream on the root run's `run/ended`. Transport failures are NOT folded into the reducer — they surface as `error` / `onError`. |
| `client/src/features/chat/runToMessage.js` | Pure: `projectRunToMessage(run, { fallbackErrorMessage }) → { content, loading, extras }` — every message field `ChatMessage.jsx` renders (thoughts, images, clarification/awaitingInput, workflowCheckpoint, workflowSteps/workflowStep, workflowResult/outputFormat, activeSkills, searchStatus, citations, answerSource, finishReason, ifinderMessageId). |
| `client/src/features/chat/hooks/useAppChat.js` | Folds each envelope into a per-chat `StreamState` (ref), binds the run to the assistant placeholder via `run/started.data.refs.messageId` (fallback: the last placeholder), calls `updateAssistantMessage(messageId, content, loading, extras)` with the projection. Public API unchanged. |
| `client/src/features/workflows/workflowRunProjection.js` | Pure: `projectWorkflowState(streamState, rootRunId, baseState)` → the execution page state (status, currentNodes, completedNodes, failedNodes, errors, history, pendingCheckpoint, completedAt, `_lastIteration`, `data.*`). Child runs are interleaved by seq and folded into the same state. |
| `client/src/features/workflows/hooks/useWorkflowExecution.js` | REST state (`fetchState`) is the base; the live stream (via `useRunStream`, `closeOnRunEnd`) is layered on top with the projection. Same options / return shape as before. |

## 3. Data flow

```
server frame ──parseSseStream──► toRunEnvelope ──► reduceRunEvent ──► projection ──► React state
                                   (null = drop)     (StreamState)   (chat message /
                                                                      execution page)
```

Chat: `useEventSource` → `useAppChat.handleEvent` → `streamStateRef` →
`projectRunToMessage(run)` → `updateAssistantMessage`.

Workflow / agent run: `useWorkflowExecution` → `useRunStream` (`useReducer`)
→ `useMemo(projectWorkflowState(streamState, executionId, baseState))`.

## 4. Behaviour notes (things that are easy to get wrong)

- **Chat gaps are expected.** The server keeps emitting after the client aborts a
  turn, so the next turn's first seq skips ahead. `useAppChat` clears
  `state.gap` after every fold and never re-syncs.
- **Clarification vs. checkpoint pause.** A `run/paused` with a pending
  `question` interaction (no `source.checkpointId`) hands control to the user:
  `loading: false`, `awaitingInput: true`, `processing: false`, no
  `onMessageComplete`. A checkpoint pause of a chat-launched workflow keeps
  `loading: true` (the turn continues once answered) and processing stays on.
  A `run/ended { status: 'paused' }` after a clarification does not reset it.
- **Errors.** A `stream/error` for a known run is appended to the content by the
  projection (`text + '\n\n' + message`); the following `run/ended
  { status: 'error' }` re-projects the same content (idempotent) and never
  calls `onMessageComplete`. Transport errors before a run exists are appended
  by the hook itself with the translated fallback.
- **REST state is authoritative on fetch.** `useWorkflowExecution.fetchState`
  resets the accumulated runs (`reset({ keepConnection, keepSeq })`) so live
  frames layer on the fresh base — exactly what the legacy hook did by
  replacing the whole state. Optimistic updates after `respondToCheckpoint` /
  `cancelExecution` are pushed as local envelopes (`push`) until the server's
  frames arrive.
- **Status derivation.** `deriveWorkflowStatus`: root run `completed` →
  `finishReason` when it is a custom value (`approved`, `rejected`, …) else
  `completed`; `error`/`budget_exhausted` → `failed`; `aborted` → `cancelled`.
  A run the reducer only inferred (no lifecycle frame yet, `lastLifecycleAt ===
  null`) never overrides the REST status.

## 5. Tests

`npm run test:unit` — `tests/unit/client/run-reducer.test.jsx`,
`run-to-message.test.jsx`, `workflow-run-projection.test.jsx`,
`use-app-chat-event-handlers.test.jsx` (the hook end-to-end with a mocked
transport). When adding a new frame type: extend the reducer first, then the
projection(s), then the tests — never interpret event names in a hook or page.
