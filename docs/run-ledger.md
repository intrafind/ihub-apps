# Run Ledger (RunLog)

The run ledger is an append-only record of every model run — chats, workflow
executions, agent runs, inference API calls and one-off utility calls. Each run
is one JSONL file that the unified runtime writes while the run is happening:
which model saw which messages (`request/header`), what came back
(`message/assistant`), tool calls and results, retries, compactions, budget
checkpoints, interactions raised and answered, and how the run ended.

It is the single source of truth behind run detail pages, re-sync of live
streams, audit, cost accounting and support debugging ("what exactly did the
model see?"). It ships **dark**: nothing is persisted until an admin turns the
feature on.

## Enabling

1. Turn on the `runLog` feature flag (Admin → Platform → Features, or
   `features.runLog: true` in `contents/config/platform.json`).
2. Optionally tune `platform.json → runLog`:

```json
{
  "runLog": {
    "enabled": true,
    "identityMode": "default",
    "retentionDays": 90,
    "cleanupEnabled": true,
    "flushIntervalMs": 2000,
    "spillThresholdBytes": 65536
  }
}
```

| Key                   | Default   | Meaning                                                                                                                |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `true`    | Second switch under the feature flag; `false` keeps the in-memory event stream (live views) but writes nothing to disk |
| `identityMode`        | `default` | What is recorded about the acting user — see below                                                                     |
| `retentionDays`       | `90`      | Runs older than this are deleted by the daily sweep                                                                    |
| `cleanupEnabled`      | `true`    | Turn the sweep off to keep runs forever (or to run your own)                                                           |
| `flushIntervalMs`     | `2000`    | Buffered appends are flushed to disk at this interval (and on run end / shutdown)                                      |
| `spillThresholdBytes` | `65536`   | Tool results and assistant content above this size are stored as separate spill files and referenced from the event    |

## Identity modes

| Mode            | Recorded principal                                                                       |
| --------------- | ---------------------------------------------------------------------------------------- |
| `default`       | The user id only — no name, email or groups                                              |
| `full`          | Id, name, email, groups and agent flag (for deployments that need full attribution)       |
| `pseudonymized` | A stable salted hash of the user id (`usr_<16 hex>`); the same user is always the same id |

Anonymous users never get a listable run: their runs are keyed by a random id
(`anon-<32 hex>`) that only the client holding it can read, and they are
excluded from the run index.

## Storage layout

```
contents/data/run-log/
  runs/<runId>.jsonl          one event per line: { seq, ts, runId, type, data }
  spill/<runId>/<name>        large payloads referenced by events
  index/<YYYY-MM-DD>.jsonl    one line per run start / end / delete (for listing)
  interactions.json           pending and answered human interactions
```

Event types are defined in `shared/runEvents.js` and validated by the Zod
contracts in `server/services/loop/contracts/runLogEvents.js`
(`run/start`, `run/end`, `run/paused`, `run/resumed`, `segment/start`,
`request/header`, `request/retry`, `message/user`, `message/assistant`,
`tool/call`, `tool/result`, `tool/disabled`, `interaction/raised`,
`interaction/answered`, `budget/checkpoint`, `budget/exhausted`,
`context/compaction`, `error`).

`request/header` carries the exact model-visible messages on the first request
(`messages`), only the appended ones when a tool loop grows the context
(`messagesDelta`, `reason: append`), and the whole array again when the history
was rewritten (`reason: change`, e.g. after a compaction); an identical repeat
carries just the hash. It also records the tool schemas and the model / option
snapshot when they change, the call configuration and a hash of the provider
request body. The `server/services/loop/replay/reconstruct.js` check replays
the deltas, rebuilds every request from these fields and verifies the hashes —
the ledger is complete enough to replay, and a tampered context is reported as
a mismatch.

## API

| Method & path                                             | Who                       | Purpose                                                        |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `GET /api/runs?from&to&kind&principalId&limit`            | admin                     | List runs from the daily index                                 |
| `GET /api/runs/:runId`                                    | owner or admin            | Run metadata                                                   |
| `GET /api/runs/:runId/events?after=<seq>&limit=<n>`       | owner or admin            | Read events (re-sync a live stream from a sequence number); the response carries `lastSeq` and `nextAfter`, the last raw sequence the page read, as the paging cursor |
| `DELETE /api/runs/:runId`                                 | owner or admin            | Delete the run, its spill files and its interactions (cascade) |
| `GET /api/runs/:runId/interactions`                       | owner or admin            | Interactions of a run                                          |
| `POST /api/runs/:runId/interactions/:interactionId/answer`| owner, approver or admin  | Answer a question / approval / review                          |
| `POST /api/runs/:runId/human-events`                      | owner or admin            | Deliver a `steer`, `stop` or `feedback` event into the run     |
| `GET /api/interactions/pending`                           | authenticated             | Queue of interactions the caller may answer                    |

Ownership is decided by the recorded principal in the current identity mode;
an anonymous run is readable by whoever presents its random id (its
interactions carry an `anonymous` marker, so the same holds for answering them
after a restart). A run that is
known only to the worker that started it (persistence off) is described by
that worker over the cluster bus, so the request may land on any worker; an
interaction is authorized from the principal recorded on it, so it stays
answerable after a restart even when its run is no longer in memory. Workflow
executions and agent runs are runs too (run id = execution id): when the
ledger does not know one (persistence off), the launching principal — or, for
agent runs, the human who triggered the run — is authorized through the
execution registry.

## Interactions

Every human touchpoint is one model, the **interaction** (`kind` `question` |
`approval` | `review` | `notify`, `origin` `tool` | `node` | `policy` |
`system`), raised through `InteractionService` and answered through the one
answer endpoint. Pending interactions survive a restart (`interactions.json`,
written whether or not the ledger feature is enabled); the raise and the answer
are on the run's ledger (`interaction/raised`, `interaction/answered`).

In a cluster every worker sees every interaction (mutations replicate over the
cluster bus), and an answer is accepted by exactly one worker: before the
answer handlers run, the answering worker creates an exclusive claim marker
(`interaction-claims/<id>.json`) on the shared filesystem. A concurrent answer
gets `409 ANSWER_IN_PROGRESS`, a late one `409 NOT_PENDING`, even when that
worker's replica still shows the interaction as pending. `answer.by` is the
actor in the run's identity mode (the pseudonymized hash when the run was
recorded that way, `anonymous` for anonymous users), never a raw user id.

| Touchpoint                              | Raised by                                  | Answered by                                                                                                  |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Chat clarification (`ask_user`)         | the chat turn's question seam (`origin: tool`, `source.chatId`) | the next chat message (`clarificationResponse.questionId`, channel `chat`) or the answer endpoint; unanswered ones expire after 24 h or are cancelled by the next message |
| Workflow `human` node checkpoint        | `HumanNodeExecutor` (`origin: node`, `source.checkpointId`, id = checkpoint id) | the answer endpoint (`channel` `run_page` / `queue` / `chat`): `checkpointResume` validates the option, routes the branch and resumes the execution before the answer is persisted |
| Agent HITL approval                     | same as above with `policy.approverGroups` from `profile.hitl.approverGroups` | same; the service enforces the approver groups (admins may always answer)                                                                |
| Workflow / agent question (`ask_user` inside a prompt or agent node) | the node's question seam (`origin: tool`, `source.checkpointId` + `nodeId`): the execution pauses on a question checkpoint with the node's loop transcript persisted (`_pausedLoops`), parked in the queue without a timeout | the answer endpoint (run page, chat, queue; free text, number or options, skippable when the model allowed it): the execution resumes the same node, which continues its loop with the answer as the `ask_user` result |

The answer body is `{ value?, data?, decision?, reason?, skipped? }`. It is
validated server-side against the prompt: the options, the prompt's
`validation` rules (`pattern`, and `min` / `max` as numeric bounds for a
`number` question, selection count for `multi_select`, text length for
`text`), the `inputSchema` of a form, and the skip permission. A pattern runs
under a hard timeout on a length-bounded answer, so a pathological pattern
supplied by a model cannot stall the server. A rejected
answer (invalid option or value, missing required form field, unauthorized
approver, execution no longer paused on this checkpoint) returns 4xx with a
`code` and leaves the interaction pending. A chat message that answers or
supersedes a clarification settles only interactions whose run the sender may
access — a chat id alone does not let anyone settle another user's question.

## Human events

`POST /api/runs/:runId/human-events` records a `human/event` on the ledger:

| `kind`     | Body                                      | Effect                                                                                       |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `steer`    | `{ message }`                             | Delivered into the running loop at its next step boundary as a `[steer]`-marked user message (queued on the worker that owns the run, relayed there in a cluster; `effect: steer_queued` / `steer_relayed`); without an active loop it is recorded only |
| `stop`     | –                                         | Aborts the run: a chat run's active model call (and any workflow it launched), or the engine cancels the execution (relayed to the worker running it in a cluster). Only the run currently producing on its chat is aborted; a `stop` on a run that has ended, or that is no longer bound to the chat's stream, is recorded without a side effect |
| `feedback` | `{ rating?, message?, messageId? }`       | Recorded; the chat feedback form sends the same event through `POST /api/feedback` (`runId`) |

The chat stop button records a `stop` event on the run bound to the chat
stream; answers are recorded as `interaction/answered`, not as human events.
`by` follows the run's identity mode like `answer.by`.

Appends made on behalf of a request (answers, human events) may land on a
worker that does not own the run. They are routed to the worker that owns the
run's sequence (the one that started or resumed it); when no worker owns it any
more, the sequence continues from the persisted ledger under a per-run lock
file (`locks/`), so two recovering workers never allocate the same number.

## Deployment assumptions

- **One filesystem per cluster.** Every worker must see the same
  `contents/data/run-log/`: a run file is appended by the worker that owns the
  run, each worker rewrites `interactions.json` from its own replicated view,
  and the answer claim markers (`interaction-claims/`) and recovery lock files
  (`locks/`) are how workers agree. Workers on separate disks would each keep a
  partial ledger and could accept the same answer twice.
- **Gap re-sync needs the ledger.** A client that reconnects to a live stream
  fills the gap from `GET /api/runs/:runId/events`, retrying a failed read with
  backoff (five attempts) before it gives up and keeps its live view. With `features.runLog` off
  there is nothing to read back; the client rebuilds its view from the events
  it receives from then on.
- **The stream format does not depend on the flag.** SSE v2 (`docs/sse-v2.md`)
  is the only chat / workflow / run stream; the ledger flag decides what is
  persisted, not what is sent.
- **Paused chat runs end on their own.** A chat turn that asks a clarification
  leaves its run paused; the run ends (`run/end` with `finishReason`
  `clarification_answered` / `clarification_superseded` /
  `clarification_expired`) when the next message answers or supersedes the
  question, or when it expires. The answer feeds the next turn, a new run.
- **`runLog.enabled` defaults to `true`.** Migration V085 adds the block to an
  existing `platform.json`; like every migration it is forward-only.

## Deleting data

`DELETE /api/runs/:runId` removes the run file, its spill directory and every
interaction that references it, and writes a tombstone to the index so the run
no longer appears in listings. The retention sweep does the same for runs
older than `retentionDays`, including the cascade (their interactions). Deleting a chat conversation or a workflow
execution through their own endpoints triggers the same cascade for the run
they belong to.
