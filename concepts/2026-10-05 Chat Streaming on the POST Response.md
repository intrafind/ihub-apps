# Chat Streaming on the POST Response

**Status:** Proposal, not implemented
**Scope:** The chat turn transport between the SPA (and the hosts built on it: Office add-in,
browser extension, Nextcloud) and `server/routes/chat/sessionRoutes.js`. Workflow-execution and
agent-run streams are out of scope (see [What stays](#what-stays)).
**Related:**
`concepts/2026-08-26 One Agentic Loop — Unified Runtime for Chats, Workflows and Agents.md`
(§5.6 SSE v2, §10 item 6 "SSE channel keying"),
`concepts/sse-v2-client/2026-09-02 SSE v2 Client Migration.md`,
`concepts/2026-07-28 Round-Robin Worker-Local State Audit.md`, `server/clusterBus.js`, and the
companion proposal `concepts/2026-10-05 MCP Gateway Legacy SSE Transport Retirement.md`.

## Summary

A chat turn today travels over two HTTP requests. The browser first opens
`GET /api/apps/:appId/chat/:chatId` as an SSE stream. Then it POSTs the message to the same
path. The model's output is written to the GET, and the POST replies `{ status: 'streaming' }`.
This is the shape of MCP's legacy HTTP+SSE transport, and it brings the same costs:

- In the default 4-worker cluster, the stream and the turn usually sit in different processes,
  so every token is relayed through the cluster primary.
- Going to several pods would need Redis pub/sub for every chat.
- Each turn uses two connections and waits an extra round trip before it starts.
- There are two ways of reporting errors.
- A 5-minute browser timeout on the POST appears to stop any turn that runs longer than that
  (see [the timeout finding](#the-5-minute-timeout)).

Proposal: do what MCP's Streamable HTTP does and the OpenAI-compatible endpoints here already
do. **The turn streams on its own POST response.** The wire format (SSE), the SSE v2 envelopes,
the parser and the client reducer stay as they are. A GET stream remains, but only for
reconnecting to a turn that is already running: after a reload, from a second tab, or on coming
back to a stored chat.

## How a chat turn streams today

```
Browser                                   Worker A                 Worker B
   │ GET /api/apps/:a/chat/:c  (SSE)  ──────▶│ createSseChannel:
   │                                          │ clients.set(c)  (presence → all workers)
   │◀──── stream/connected {lastSeq} ─────────│
   │ POST /api/apps/:a/chat/:c  {messages} ───────────────────────────▶│ hasChatClient(c)? yes (remote)
   │                                          │                         │ chatService.runTurn → agentLoop.run
   │                                          │◀── sse:event relay ─────│ RunStreamEmitter → routeEnvelope
   │◀──── step/delta, tool/*, … ──────────────│   (B → primary → A)     │   → publish (not local)
   │◀──── run/ended ─────────────────────────│                         │
   │ (closes GET)                             │                         │
   │◀──────────────────────────────── 200 {status:'streaming'} ─────────│ (after the whole turn)
```

1. `useAppChat` puts the message in `pendingMessageDataRef` and calls
   `initEventSource(apps/:appId/chat/:chatId)` (`client/src/features/chat/hooks/useAppChat.js:640`).
   The stream is fetch-based, not native `EventSource`, so Bearer headers and a 401 refresh work
   (`client/src/shared/utils/openSseStream.js`).
2. The GET handler registers the chat in the `clients` presence map and sends `stream/connected`
   (`server/routes/chat/sessionRoutes.js:553`, `server/utils/sseChannel.js`).
3. Only on `stream/connected` does the client POST the message (`useAppChat.js:381` →
   `sendPendingMessage` → `sendAppChatMessage`, an axios call with a 5-minute timeout,
   `client/src/api/client.js:8`).
4. The POST checks `hasChatClient(chatId)`, which also counts streams held by other workers
   (`server/sse.js`). It then awaits `chatService.runTurn`, which awaits the whole agent loop
   (`sessionRoutes.js:1293-1445`, `server/services/chat/ChatService.js`).
5. Each frame goes `RunStreamEmitter` → `routeEnvelope`. If this worker holds the stream it is
   written directly; otherwise it is published on `sse:event` to the worker that does. That
   worker stamps the stream `seq` and writes it (`server/sse.js`, `server/clusterBus.js`).
6. `run/ended` makes the client close the GET. The POST resolves with `{ status: 'streaming' }`
   once the turn is over (`sessionRoutes.js:1445`).

Around this flow sit:

- a 60-second `/status` poll per stream (`client/src/shared/hooks/useEventSource.js:138`),
- a 60-second connect timeout (`useEventSource.js:45`),
- `POST /stop` (`sessionRoutes.js:1513`),
- a 30-second heartbeat comment and a 5-minute inactive-client sweep (`sseChannel.js`,
  `server/serverHelpers.js:52`),
- and, when no stream exists anywhere, a non-streaming branch that answers with JSON on the POST
  (`sessionRoutes.js:1305`).

## What the split costs

**Token relay on the hot path.** `WORKERS` defaults to 4, scheduled round-robin
(`server/config.js:105`, `server/server.js:147-154`). The GET occupies its connection, so the
POST goes out on another one and usually reaches another worker. That worker runs the turn, and
every frame crosses two IPC hops (producer → primary → stream owner), JSON-encoded each time.
`clusterBus.js` describes this cost in its header and notes that going cross-pod needs the same
interface backed by Redis.

**Presence-map correctness.** The split needs three cluster-wide maps: `sse`, `request`, and
`chat-durable` (the last marked `shared`). The comments in `server/sse.js` describe the races
these maps had to be fixed for:

- a stale close handler deleting a fresh reconnect,
- a retraction from one worker removing another worker's durable mark,
- a third worker relaying an abort for a turn it doesn't run.

All of these come from the turn and its stream living in different processes.

**Two connections and an extra round trip per turn.** The GET stays open for the turn, and the
POST stays pending for the turn as well, because it awaits the agent loop. The turn can't start
until the GET's headers and first frame have come back. Under HTTP/1.1 (6 connections per
origin) a compare-mode pair already uses four.

**Two ways of reporting errors.** A failure before the turn starts is reported one of two ways:
as an emitted failed run on the stream, answered with `200 {status:'streaming'}`, when a stream
exists; or as HTTP 400 / `{status:'error'}` when none does (for example the @mention checks at
`sessionRoutes.js:1133-1143`). The client handles both.

### The 5-minute timeout

This was found by reading the code while writing this document. It has not been reproduced.

- The chat POST is sent with axios's `STREAMING_REQUEST_TIMEOUT` of 300,000 ms
  (`client/src/api/client.js:8`, `client/src/api/endpoints/apps.js:57`).
- The server only answers it when the turn is over.
- If a turn runs longer than that, axios rejects with a timeout. `sendPendingMessage` then
  appends "Request timed out…" to the answer and calls `cleanupEventSource`
  (`useAppChat.js:264-307`).
- `cleanupEventSource` aborts the stream and POSTs `/stop`.
- `/stop` calls `abortChatRequest` unconditionally, so it stops stored ("durable") turns as well
  (`sessionRoutes.js:1560`).

`ChatService` says interactive turns are "bounded by their client" and only stored turns get a
30-minute ceiling (`ChatService.js:85-98`). In practice the client bound is this 5-minute POST
timeout, so a long tool chain is cut off at 5 minutes while the user watches it.

This doesn't depend on the redesign. It can be fixed on its own by removing the timeout on this
one call, or by having the server answer the POST as soon as the turn has started. The redesign
removes it structurally.

## Proposal

### Wire contract

```
POST /api/apps/:appId/chat/:chatId
Accept: text/event-stream
Content-Type: application/json
{ messages, modelId, …, messageId }

→ 200 Content-Type: text/event-stream
  event: run/started   data: {v:2, seq, runId, ts, type, data}
  event: step/delta    data: {…}
  …
  event: run/ended     data: {…}
  (response ends)
```

- **Content negotiation, as in Streamable HTTP.** `Accept: text/event-stream` streams the turn on
  this response. `Accept: application/json` keeps today's non-streaming JSON answer, for
  integrations that post without a stream (`sessionRoutes.js:1305` path).
- **Errors before streaming are plain HTTP.** Validation, auth, model access,
  `CLIENT_HISTORY_NOT_ALLOWED` and @mention refusals answer 4xx/5xx JSON before any frame. After
  the first frame, errors are `stream/error` or `run/ended {status:'error'}` frames, as today.
  The `200 {status:'error'}` and `200 {status:'streaming'}` replies go away.
- **The stream ends with its run**: on `run/ended`, or on `run/paused` when the run waits for a
  person, such as a clarification or a workflow checkpoint. The answer to that is a new request,
  and anything that follows is watched through the reconnect stream below.
- **Every frame carries an SSE `id:`** so the reconnect path can resume after the last event the
  client saw (see [Sequence numbers and resume](#sequence-numbers-and-resume)).
- Same heartbeat comment every 30 s, same `X-Accel-Buffering: no` and `Cache-Control: no-cache`
  headers as `createSseChannel` sets today.

### Server

- The worker that accepts the POST runs the turn and writes to its own response. The emitter
  gets a `deliver` function bound to `res` (`RunStreamEmitter` already takes a `deliver` option,
  see `ChatService.js`), so there is no presence lookup and no relay on this path.
- A disconnect is handled where it happens. The handler listens for the **response's** `close`
  event and, if the response hasn't ended, aborts the turn unless it is durable. The request's
  `close` can't be used: on a POST it has already fired once the JSON body parser has read the
  body. `openaiProxy.js:443-452` handles its streamed POST the same way. The turn and the socket
  are in the same process, so this decision is local. The `chat:abort` relay and the
  cluster-wide `chat-durable` mark aren't needed for it.
- `activeRequests` (presence `request`) stays. `/stop`, a superseding turn and steering can
  still arrive on another worker and must reach the turn's worker. `ABORT_CHANNEL` already does
  this.
- The @mention workflow branch streams the bridged workflow progress on the POST instead of
  returning at once. Since the workflow is durable, a dropped POST doesn't cancel it, and the
  client reconnects.

### Client

- `openSseStream(url, { method, body, signal, onEvent })`: the shared transport gains a method
  and a body. Auth headers, the 401 refresh, the `SseHttpError` mapping and `parseSseStream` stay
  the same. The Office add-in, extension and Nextcloud hosts move with it, because they all use
  this module.
- `useAppChat` sends by opening the stream. `pendingMessageDataRef`, the `stream/connected`
  handshake and the axios `sendAppChatMessage` call go away.
- There is no total timeout, only an idle watchdog (for example 90 s without a byte, given the
  30 s heartbeat). This removes the 5-minute cut-off.
- **Stop** aborts the fetch, which is enough for an ephemeral turn. A stored turn survives a
  disconnect by design, so it also POSTs `/stop`, as today.
- **No blind retry of the POST.** A POST starts a turn, so retrying it after a network error
  would start a second one. What happens after a drop depends on the turn:
  - An **ephemeral** turn is aborted by the server when its response closes. The client shows it
    as stopped and neither reconnects nor retries.
  - A **stored** turn keeps running. The client reconnects by `runId`, which arrives in the first
    frame (`run/started`). If the drop came before that frame, the client asks the chat status.
  - The `messageId` the client already sends could also serve as an idempotency key, so a
    retried POST can't start a second turn.
- The 60-second `/status` poll is no longer needed for the client's own turns, since the open
  response shows the turn is alive. It may stay for reconnect streams.

### Reconnecting stays a GET

MCP doesn't need this: its 2026-07-28 revision of Streamable HTTP removed the GET stream and
`Last-Event-ID` resume altogether, because an MCP call is a short request. A stored chat turn
outlives its client by design, so the chat still needs a way back in.

Some cases have no POST of their own to stream on:

- reloading or switching back to a stored chat while its turn is still running,
- a second tab following the same chat,
- workflow progress and a workflow that finished while the client was away (`drainPendingFinish`
  and `replayChatWorkflowProgress`, `sessionRoutes.js:600` and `:654`).

Today `reattachToRun` covers these by replaying the run's ledger
(`GET /api/runs/:runId/events?view=sse`) and then opening the chat GET stream for the live tail
(`useAppChat.js:947`).

The proposal folds this into one endpoint, keyed by run as the One Agentic Loop concept plans
(§10 item 6):

```
GET /api/runs/:runId/stream
Last-Event-ID: <id>          (or ?after=<id>)
→ ledger events after <id>, then the live tail, ending with run/ended
```

- **Access is checked before anything is sent.** The endpoint runs the same checks as today's two
  endpoints: `authorizeRun(runId, req.user)`, as `GET /api/runs/:runId/events` does
  (`server/routes/runs.js:144`), and, for a chat run,
  `authorizeChat(chatId, req.user, { intent: 'read' })`, as the chat GET does
  (`sessionRoutes.js:565`). A caller who fails either check gets a 404 and no event data.
- **No gap between replay and live.** If the ledger were read first and the live subscription
  opened afterwards, an event written in between would reach neither. So the endpoint:
  1. subscribes to the run's live events and buffers them,
  2. notes the ledger's last `seq` and replays the ledger after `<id>` up to that `seq`,
  3. sends the buffered events that follow that `seq`, drops the ones the replay already
     covered, then continues live.

  An event written during the switch then arrives exactly once.
- Closing a reconnect stream never aborts the turn. Only stored turns can be reconnected to, and
  a watcher leaving doesn't mean the turn should end. This is what lets the durable check become
  local.
- The live tail can still be on another worker, because the run is wherever its POST landed. For
  this path only, the existing `sse:event` relay remains. Reconnecting is rare compared with
  sending.
- Across pods there are two options:
  - keep the relay and back it with Redis, as `clusterBus.js` foresees, or
  - tail the run's ledger from shared storage (`contents/data/run-log/`). This works without a
    bus, but only at step granularity, because the ledger has no `step/delta`.

## Sequence numbers and resume

Today:

- The live `seq` counts per **stream** (`chatId`) and is stamped by the worker that owns the
  stream (`stampSeq`, `server/services/loop/RunStream.js`).
- The ledger `seq` counts per **run**.
- The client removes ledger `seq`s before folding replayed events so the two counters don't mix
  (`useAppChat.js:979`).
- The chat surface ignores gaps (`useAppChat.js:377`).

With the turn streaming on its POST, the stream *is* the run. The live stream still carries
`step/delta` frames that the ledger doesn't store, so the two counters still can't be the same
number. Proposal:

- **The SSE `id:` of a frame is the ledger `seq` of the last durable event at or before it.**
  Delta frames repeat the id of the event before them.
- Resuming with `Last-Event-ID: N` replays ledger events after `N`, then continues live.
- What is lost is the partial text of a step that was mid-stream at the drop. It appears in full
  with that step's `step/completed`. Today's reconnect behaves the same way.

## What changes and what stays

| | Today | Proposed |
| --- | --- | --- |
| Wire format | SSE, v2 envelopes | Unchanged |
| Sending a message | GET stream, wait for `stream/connected`, then POST | One POST, streamed back |
| Connections per turn | 2 (GET plus pending POST) | 1 |
| Token path in cluster mode | Relayed when GET and POST hit different workers (usually) | Never relayed |
| Reconnect (reload, other tab) | Ledger replay plus chat GET | `GET /api/runs/:runId/stream` with `Last-Event-ID`; relayed if remote |
| Cross-pod requirement | Redis for every streamed token | Redis or ledger tail for reconnects only |
| Pre-flight errors | 400, `{status:'error'}`, or a failed run on the stream | HTTP status plus JSON |
| Turn length limit (interactive) | 5 min client POST timeout (finding above) | None; idle watchdog only |
| Disconnect → abort decision | Cluster-wide `chat-durable` presence | Local to the turn's worker |
| `/stop`, supersede, steer | `request` presence plus abort relay | Unchanged |
| Non-streaming JSON for integrations | When no stream exists | `Accept: application/json` |

Removed: `pendingMessageDataRef` and the `stream/connected`-then-POST handshake; the
`{status:'streaming'}` reply; the `hasChatClient` decision in the POST; the `sse:event` relay on
the send path; `chat-durable` as a shared presence map; the axios chat POST and its timeout; the
per-turn `/status` poll.

### What stays

- **Workflow-execution and agent-run streams** (`useRunStream`,
  `server/routes/workflow/workflowRoutes.js:1740`, `server/routes/agents/runs.js:541`). These
  runs start with a POST that returns an id and then run in the background, often longer than
  anyone watches. Subscribing with a GET suits that. They share `openSseStream` and gain nothing
  but the new options.
- **The OpenAI-compatible `/v1/chat/completions` and the Responses API** already stream on the
  POST (`server/routes/openaiProxy.js:607`, `server/services/inference/responsesWire.js:166`).
  This proposal brings the chat UI into line with them.
- **The OCR job progress stream** (`server/routes/toolsService/jobRoutes.js`) is untouched.

## Infrastructure notes

- **Proxies.** A streamed POST needs the same treatment as today's GET: no response buffering
  and a read timeout longer than the heartbeat interval. The server already sends
  `X-Accel-Buffering: no`. `docs/production-reverse-proxy-guide.md:238` configures
  `location /ihub/api/chat/stream`, a path that doesn't exist. That section should be corrected
  whichever way this proposal goes.
- **HTTP/2** makes the connection count matter less. It doesn't change the relay or timeout
  problems.
- **Embedded WebViews.** Office (WebView2 / WKWebView) and the extension already read GET
  streams through `fetch` and `ReadableStream`. Reading a POST response the same way needs
  nothing new.

## Migration

1. **Server.** Add the `Accept: text/event-stream` branch to the POST and
   `GET /api/runs/:runId/stream` with `Last-Event-ID`. Write contract tests first:
   - frame order for a plain turn, a tool turn and an @mention workflow,
   - pre-flight errors as HTTP statuses,
   - disconnect aborts an ephemeral turn,
   - disconnect leaves a durable turn running,
   - a dropped response is detected through the response's `close` event,
   - reconnect after `Last-Event-ID` replays without duplicates,
   - an event written during the replay-to-live switch arrives exactly once,
   - a caller without access to the run or its chat gets a 404 and no frame,
   - in a 4-worker cluster test, no `sse:event` relay on the send path.
2. **Client.** `openSseStream` with a method and a body; `useAppChat` send and stop; reconnect
   through the run stream; the idle watchdog. About ten client test files mock `useEventSource`
   (`tests/unit/client/app-chat-*.test.jsx`, `chat-*.test.jsx`, `edit-resend-message.test.jsx`,
   …) and need their transport mock updated. Playwright e2e covers send, stop, reload during a
   stored turn, and compare mode.
3. **Remove the old path.**
   - In code: the `{status:'streaming'}` branch, the handshake, the `chat-durable` presence map,
     the relay on the send path, and the chat-keyed GET once nothing uses it.
   - In docs: the Swagger description of `POST /apps/{appId}/chat/{chatId}`, the proxy guide,
     and a release note.

## Risks

- **Durable semantics.** A dropped POST must leave a stored turn running, and its answer must
  still be stored. The disconnect contract test and the e2e reload test guard this.
- **Browser tabs from before the upgrade.** An old bundle opens the GET and POSTs without the
  new `Accept`. If stage 3 ships in the same release, that POST gets the non-streaming JSON
  answer, which the old client ignores, so the turn shows nothing. Those tabs need a reload.
  Nothing tells a stale tab to reload today (`lazyWithRetry` only retries failed chunk loads).
  *(Decision 1.)*
- **Long-running POSTs through corporate proxies.** The risk is the same as today's long GET.
  The heartbeat keeps bytes flowing for proxies with idle-based timeouts.
- **Scope creep into workflows and agent runs.** They are deliberately out of scope. Their
  GET-subscribe model fits background runs.

## Decisions needed

1. **Clean break or one-release overlap.** Per One Agentic Loop §10.3 the chat API is
   internal-only, so no external caller depends on the old flow; only tabs left open across the
   upgrade do. Recommended: ship stages 1–3 in one release and accept that such a tab needs a
   reload. Per the repo rules, keeping the old path for a release is your call.
2. **Fix the 5-minute timeout now?** As a separate small change, ahead of this work.
   (Recommended: yes, once reproduced.)
3. **Resume granularity.** Is losing the partial text of an in-flight step on reconnect
   acceptable? It matches today's reconnect.
4. **Cross-pod reconnect.** A Redis-backed relay, or a ledger tail on shared storage? This only
   matters once multi-pod is on the roadmap.
5. **Reconnect keying.** A new `GET /api/runs/:runId/stream`, as proposed, or keep the chat-keyed
   GET for reconnecting?
