# Chat Turn Abort Attribution

Issue: [#2830](https://github.com/intrafind/ihub-apps/issues/2830) — opening a running scheduled
run's chat and waiting leaves the run `cancelled`.

## Problem

Every way a chat turn can be stopped ends in the same place: `controller.abort()` on the
`AbortController` that `ChatService.runTurn` registered in `activeRequests[chatId]`. The turn then
ends `aborted`, and what is recorded says nothing about why:

| Where it lands                        | What it says today                                        |
| ------------------------------------- | --------------------------------------------------------- |
| Scheduled run (`taskExecution.js`)    | `cancelled`, `ABORTED` "The run was stopped"              |
| Stored assistant message              | `ABORTED` "Turn stopped before it finished."              |
| Ledger `run/end`                      | `status: aborted`, `finishReason: connection_closed` (always) |
| Server log                            | `Aborted request {chatId}` — no actor, no cause           |

So a cancelled scheduled run cannot be traced back to the Stop button, a superseding turn, a lease
loss, a deleted chat or a client that decided on its own to call `POST …/chat/:chatId/stop`.

The last of these is a design problem in itself. The client calls the stop endpoint
(`stopAppChatStream`) — the unconditional abort that exists for the Stop button — from paths that
only mean "this tab no longer listens":

- `useEventSource.cleanupEventSource()` — used by the heartbeat idle check, the connection timeout,
  `sendMessage` before every new turn, and stream errors.
- `useEventSource.initEventSource()` — stops whatever stream it replaces.
- `useEventSource` unmount teardown — for ephemeral chats.
- `AppCanvas` unmount → `cancelGeneration()`.

For a durable turn (stored chat, scheduled run) each of these kills a run the server was told to
keep alive. They are the prime suspects for #2830.

## Goals

1. **Only a user or the backend stops a turn.** The client never sends a stop on its own; leaving,
   switching, timing out or reconnecting only detaches the browser.
2. **Every abort carries a cause**: what stopped it, who, from where, and when.
3. **The cause is visible** where people look: the scheduled run, the stored chat message, the
   ledger, the server log.

## Design

### 1. The abort cause

One shape, created at the place that decides to stop, passed as the abort reason
(`controller.abort(cause)` → `signal.reason`):

```js
{
  kind: 'user_stop',            // see table below
  message: 'Stopped from the chat',
  at: '2026-10-15T10:42:07.120Z',
  actor: { type: 'user', id: '<resolved actor id>' },   // type: 'user' | 'admin' | 'system'; id absent for 'system'
  origin: {
    via: 'POST /api/apps/:appId/chat/:chatId/stop',     // code path that decided
    source: 'stop-button',      // client surface, when a client asked (optional)
    worker: '<hostname>:<pid>'  // which process decided
  },
  related: { runId: '…' }       // e.g. the superseding run, the scheduled task (optional)
}
```

`actor.id` goes through the existing `resolveActorId(user, { mode })`, so pseudonymous identity
modes are respected the same way the ledger's `human/event` stop already is. Request IP and user
agent go to the server log only, never into stored documents.

A small module, `server/services/chat/abortCause.js`, builds causes
(`abortCause(kind, { user, req, via, source, related })`), normalizes an unknown `signal.reason`
into `{ kind: 'unknown' }`, and maps a cause to a user-facing message.

### 2. Cause kinds and their call sites

| `kind`               | Actor  | Call site                                                                   |
| -------------------- | ------ | --------------------------------------------------------------------------- |
| `user_stop`          | user   | `POST /api/apps/:appId/chat/:chatId/stop` (`sessionRoutes.js`)             |
| `run_stop`           | user   | `POST /api/runs/:runId/stop` (`routes/runs.js`)                             |
| `task_run_cancelled` | user   | `cancelRun` → `stopActiveRun` (`taskService.js`)                            |
| `task_deleted`       | user   | `deleteTask` → `stopActiveRun`                                              |
| `task_disabled`      | admin  | admin disable → `stopActiveRun`                                             |
| `chat_deleted`       | user   | `DELETE /api/chats/:chatId`, `DELETE` inference conversation                |
| `user_deleted`       | admin  | `userDeletion.js`                                                           |
| `superseded`         | system | `ChatService.runTurn` aborting the previous turn (`related.runId` = new run) |
| `client_disconnected`| system | SSE close / failed write → `abortChatRequestOnDisconnect` (ephemeral only)  |
| `client_evicted`     | system | inactivity sweep (`serverHelpers.js`, ephemeral only)                      |
| `api_client_closed`  | system | `openaiProxy.js`, `inference/responses.js` `res.on('close')`                |
| `lease_lost`         | system | scheduled run lost its lease (`taskExecution.js`)                          |

### 3. Plumbing

- `sse.js`: `abortChatRequest(chatId, cause)` and `abortChatRequestOnDisconnect(chatId, cause)`;
  the cluster relay publishes `{ chatId, cause }` on `chat:abort`, so the worker running the turn
  aborts with the cause decided on another worker. Every abort logs one structured line
  (`Chat turn abort requested`, with cause, plus IP/user agent when there is a request).
- The direct `activeRequests.get(chatId)?.abort()` calls (`openaiProxy.js`, `responses.js`,
  `serverHelpers.js`, `ChatService` supersede, `taskExecution.js` compose step) go through the same
  helper or pass a cause to `abort()`.
- `ChatService.runTurn`: when the loop ends `aborted`, read `controller.signal.reason`, normalize
  it, and put it on the outcome (`outcome.abortCause`). No change to `AgentLoop` is needed — the
  turn owns the controller.

### 4. Where the cause is recorded

- **Ledger and stream** — an optional `cause` (`abortCauseSchema`, in `runLogEvents.js`) on
  `runEndData` and on the SSE `runEndedData`, carried through every hop: `ChatService._endLedgerRun`
  → `RunLog.endRun` (which picks its fields explicitly) → the ledger store, the live `run/ended`
  frame and the replay projection (`projectLedgerEvent`), and kept by the client's run reducer.
  The existing `human/event` stop record stays. Covered by the contract snapshot, a replay
  projection test and `docs/sse-v2.md`. (`finishReason` stays `connection_closed`: see the
  implementation notes.)
- **Stored chat message** — `chatMaterializer.messageError` stores
  `{ code: 'ABORTED', message: <cause message>, cause }`; the chat shows e.g. "Stopped by you at
  10:42" or "Stopped: replaced by a newer message".
- **Scheduled run** — `taskExecution.js` finishes with
  `reasonOf('ABORTED', <cause message>, now, { cause })`; the lease-loss path records `lease_lost`
  itself. The task page and run banner render it via `reasonText` (new translated strings per
  kind, en + de) — "Cancelled · stopped from the chat by you · 10:42".
- **Audit log** — user- and admin-initiated stops (`user_stop`, `run_stop`, `chat_deleted`, task
  cancel/disable) are already audited or get a `logAudit` entry; system causes do not.

### 5. Client: never stop on its own

`useEventSource` splits its teardown into two:

- `detach()` — abort the local fetch, clear timers, report "not processing here". No network call.
- `stop(source)` — `POST …/stop` with `{ source }`. Called only from `cancelGeneration`, i.e. the
  Stop button (and the compare/office equivalents).

Changes:

- `cleanupEventSource`, the prior-stream replacement in `initEventSource`, the heartbeat idle
  check, the connection timeout and the unmount teardown all `detach()`.
- `sendMessage` no longer stops the previous turn; the server supersedes it (cause `superseded`).
- `AppCanvas` unmount detaches instead of `cancelGeneration()`.
- Ephemeral turns still end when nobody listens: closing the SSE connection is what the server's
  `req.on('close')` → `abortChatRequestOnDisconnect` already reacts to, and the inactivity sweep is
  the backstop. The client-side stop on unmount was redundant with that.
- `stopAppChatStream(appId, chatId, { source })` sends the surface (`stop-button`, `compare`,
  `office`, `voice`) so `origin.source` is filled.

## Tests

- Server: cause propagation through `abortChatRequest` (local and relayed), `runTurn` outcome and
  `run/end`, stored message error, scheduled-run reason for `user_stop`, `superseded`,
  `lease_lost`, `task_run_cancelled`.
- Server: a durable scheduled run survives an SSE connect + disconnect while running (reproduces
  #2830 on the server side).
- Client: no `stopAppChatStream` on heartbeat idle, timeout, stream replacement, chat switch,
  unmount (durable and ephemeral) or `sendMessage`; exactly one on `cancelGeneration`, with its
  source. Update `chat-switch-teardown.test.jsx` and `chat-reattach.test.jsx`, which assert today's
  behaviour.
- E2E (optional): open a scheduled run's chat mid-run and wait; the run ends `succeeded`.

## Release notes and docs

- `docs/releases/next/` entry via `/document-feature`: runs and chats now say who stopped them;
  opening a running scheduled run no longer cancels it.
- `docs/sse-v2.md` for the `cause` on `run/ended`.
- No config migration (no config files change). No breaking API change: `cause` is an optional
  field, and the stop endpoint keeps its contract (the `source` body field is optional).

## Decisions

1. **"Clear chat" on a running stored chat stays a stop.** It is an explicit user action, so it
   sends the stop request (source `clear-chat`; `voice` for the voice command).
2. **Only the user id is stored as the actor** (through the run's identity mode). The client shows
   "you" to that user and the id to administrators; no display name is saved.

## Implementation notes

Where the build differs from the design above:

- The abort reason is an `AbortError` carrying the cause (`error.abortCause`), not a bare object.
  `fetch` rejects with whatever a signal was aborted with, and the loop recognises an abort by the
  error's name.
- `run/ended.finishReason` stays `connection_closed` for every abort — the client reads it to show
  the retry control — and the cause rides beside it as `cause`.
- `POST /v1/responses` keeps its own `turn_aborted` answer; its aborts carry a cause but it does not
  store one.
- The client keeps the name `cancelGeneration` for the Stop path and adds `detachEventSource` /
  `stopEventSource` to `useEventSource`; `cleanupEventSource` is gone. `AppCanvas` no longer
  cancels on unmount — the hook's teardown detaches.
