# Chat turns streamed on their own POST: implementation notes

Status: phases 1 to 4 of the design implemented on `perf/post-stream`. The design itself (traced on
RC13) is summarised here; the user-facing contract is in `docs/streaming-events.md`
("A chat turn on its own POST", "Re-attaching mid-step").

## Decisions taken

- A: negotiation by `Accept: text/event-stream` on the existing POST. Without it the POST is unchanged.
- B: cross-pod Stop, live re-attach and partial resume without sticky sessions are a known limit.
- C: client flag `chatPostStream` in `server/featureRegistry.js`, default off. Server always accepts.
- D: both paths stay, no deprecation, no shim.
- E: partial resume by snapshot; caps 256 KB text / 512 KB thinking per run (characters); thinking of
  completed steps kept; SSE `id: {runId}:{rseq}` lines written.

## Where things are

| Piece | File |
| --- | --- |
| POST sink (`postStreams`, tried first in `routeEnvelope`), `openChatPostStream` | `server/sse.js` |
| Commit point, late-refusal frame, `clientConnected` | `server/routes/chat/sessionRoutes.js` (POST) |
| `closeOn: res` (a POST's `req` closes once its body is read) | `server/utils/sseChannel.js` |
| `rseq` per run, `flushStream` export | `server/services/loop/RunStream.js` |
| Partial text/thinking store (emit observer) | `server/services/loop/partialRunState.js` |
| Resume request `chat:resume` (local or one bus round trip) | `server/services/chat/chatResume.js` |
| GET `resumeRun` / `afterLedgerSeq`, held live frames, `writeStreamStart` | `sessionRoutes.js` (GET), `sse.js` |
| Client transport (POST + JSON fallback) | `client/src/shared/utils/openSseStream.js` |
| `startTurn`, `rseq` dedup per connection | `client/src/shared/hooks/useEventSource.js` |
| `openTurn`, `handleSendError`, drop → `resumeDroppedTurn` → `reattachToRun` | `client/src/features/chat/hooks/useAppChat.js` |

## Tests

- `server/tests/chat-post-stream.test.js` (jest): JSON mode unchanged, frames on the POST, bus spy
  shows no `sse:event`, refusals problem+json in both modes, late refusal, temporary vs durable close.
- `server/tests/chatResumeCluster.test.js` (forked workers): re-attach mid-step on another worker,
  full text and thinking once, one request and one reply.
- `tests/unit/client/chat-post-stream.test.jsx`: flag on/off, ack retry, approval, clarification,
  Stop, drop → re-attach, `@mention` JSON answer.

## Known limits and next steps

- Phase 5: switch the flag default to on after the measurement runs (section 8 of the design).
- Phase 6 (optional): cross-pod control plane (Redis-backed bus, or an ingress hash on the chat id).
- While a POST stream is open, live frames go to it, not to a GET on the same chat in the same
  worker; a second tab gets the snapshot, then the end via the transcript re-read.
- A frame written to a POST socket that is dead but not yet closed is lost to a re-attached GET; the
  transcript re-read at the end is the authority.
