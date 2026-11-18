# Chat turns streamed on their own POST: implementation notes

Status: implemented behind the `chatPostStream` feature (default off). The user-facing contract is in
`docs/streaming-events.md` ("A chat turn on its own POST", "Re-attaching mid-step"); this note is
for whoever continues the work.

## Why

Before, every chat message needed two connections: the browser opened the chat's GET stream, then
POSTed the message, and under several server workers the turn's frames were relayed over the
cluster bus to whichever worker held the GET. Streaming the turn on the POST itself halves the
connections and keeps the frames in the worker that produces them.

## Decisions taken

- A: negotiation by `Accept: text/event-stream` on the existing POST, named explicitly and
  preferred over JSON (q-values respected; `*/*` or `text/*` alone stay JSON). Without it the POST
  is unchanged.
- B: cross-pod Stop, live re-attach and partial resume without sticky sessions are a known limit.
- C: client flag `chatPostStream` in `server/featureRegistry.js`, default off. The server always
  accepts. Surfaces without `PlatformConfigProvider` (Office add-in, browser extension) read the
  flag as off and stay on GET + JSON POST.
- D: both paths stay, no deprecation, no shim.
- E: partial resume by snapshot; caps 256 KB unfinished text / 512 KB thinking per run (characters,
  cut separately; a completed step's text no longer counts); thinking of completed steps kept; SSE
  `id: {runId}:{rseq}` lines written, `Last-Event-ID` ignored (re-attach uses `resumeRun`).
- F: a GET on the same chat while a POST stream is open (second tab, re-attach while the POST
  socket is half-open) gets every frame too (fan-out in `routeEnvelope`), not the POST evicted:
  eviction would ping-pong between two tabs.

## Where things are

| Piece | File |
| --- | --- |
| POST sink (`postStreams`), fan-out in `routeEnvelope`, `openChatPostStream` handle | `server/sse.js` |
| `hasChatClient` counts a POST stream (status, workflow finish stash, stop) | `server/sse.js` |
| Commit point, `lateRefusalFrames`, `wantsEventStream`, `clientConnected` | `server/routes/chat/sessionRoutes.js` (POST) |
| `closeOn: res` (a POST's `req` closes once its body is read) | `server/utils/sseChannel.js` |
| `rseq` per run, `flushStream` export | `server/services/loop/RunStream.js` |
| Partial text/thinking store (emit observer, only frames with `rseq`) | `server/services/loop/partialRunState.js` |
| Resume request `chat:resume` (ledger first, then snapshot) | `server/services/chat/chatResume.js` |
| GET `resumeRun` / `afterLedgerSeq`, held live frames, `writeStreamStart` | `sessionRoutes.js` (GET), `sse.js` |
| Client transport (POST + JSON fallback, `onChunk`) | `client/src/shared/utils/openSseStream.js`, `parseSseStream.js` |
| `startTurn` (accept timeout, idle timeout, drop vs refusal), `rseq` dedup | `client/src/shared/hooks/useEventSource.js` |
| `openTurn`, `handleSendError`, `sendErrorOf`, drop → `resumeDroppedTurn` → `reattachToRun` | `client/src/features/chat/hooks/useAppChat.js` |
| Friendly error texts, `expireSession` (shared with the axios client) | `client/src/api/utils/apiErrors.js` |

## How a turn's POST stream behaves

- Each request gets its own handle (`write`, `isOpen`, `hasEnded`, `end`). The route's late
  refusal writes through it, so an older turn's error never lands on a newer turn's stream. Frames
  a turn emits are still routed by chat id, like on the GET.
- A late refusal is `stream/error` (built from `toErrorResponse`, like the problem+json body) then
  `run/ended { status: 'error' }`, unless the stream already carried that run's `run/ended`
  (ChatService emitted the failed run itself).
- Client: an accepted POST that stays silent for 60 s (twice the heartbeat) or whose read breaks is
  a drop. A temporary chat keeps what was drawn and shows "connection lost"; a kept chat
  re-attaches and redraws the same message, and puts the drawn answer back if the replay has
  nothing.

## Tests

- `server/tests/chat-post-stream.test.js` (jest): JSON mode unchanged, Accept negotiation, frames on
  the POST, no `sse:event` unless a GET exists, fan-out to a local and a remote GET, `/status` and
  `hasChatClient` during the turn, refusals problem+json in both modes, late refusals, a newer
  turn's stream untouched by an older turn's failure, temporary vs durable close.
- `server/tests/chatResume.test.js` (jest, real ledger): a step completing after the client's
  replay and between snapshot and ledger read; partial-state caps.
- `server/tests/chatResumeCluster.test.js` (forked workers): re-attach mid-step on another worker,
  one request and one reply.
- `tests/unit/client/chat-post-stream.test.jsx`: flag on/off, ack retry, approval, clarification,
  Stop, drops (temporary, empty replay, server-stopped, idle, broken read), refusal texts and 401.

## Known limits and next steps

- Switch the flag default to on after the load-test measurements.
- Optional: cross-pod control plane (Redis-backed bus, or an ingress hash on the chat id).
- A frame written to a POST socket that is dead but not yet closed is lost unless a GET is attached;
  the transcript re-read at the end of the turn is the authority.
- `postStreams` is not in the inactive-client sweep; the response's own close removes it.
