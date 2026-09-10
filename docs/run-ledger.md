# Run Ledger (RunLog)

The run ledger is an append-only record of every model run — chats, workflow
executions, agent runs, inference API calls and one-off utility calls. Each run
is one event stream that the unified runtime writes while the run is happening:
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

The ledger persists through the [storage provider](storage.md) rather than
writing files of its own. On the default filesystem provider that is:

```
contents/data/
  logs/run/<runId>.jsonl         one event per line: { seq, ts, runId, type, data }
  logs/run/<runId>.blobs/<name>  large payloads referenced by events
  runs/<runId>.json              one summary document per run — the run index
  runs/.owners/<seg>/<runId>     the per-owner index behind it
  interactions/<id>.json         pending and recently settled human interactions
```

Each of those replaces something the ledger used to hand-write under
`contents/data/run-log/`:

| Was                        | Is now                                | Why                                                                         |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `runs/<runId>.jsonl`       | an append-log stream, `run:<runId>`   | one write path, and a later provider can hold it in a database              |
| `index/<YYYY-MM-DD>.jsonl` | one document per run in `runs`        | listing is an owner-indexed read, not a scan of every day file in the range |
| `interactions.json`        | one document per interaction          | a whole file rewritten per worker is how two workers lost each other's      |

**The `runs` namespace is the run index**, and it holds more than the daily
index did: workflow executions and agent runs are recorded there too, so one
namespace answers `GET /api/runs`, *My Executions* and the admin execution
list. Each document carries the run's principal as its owner, so "this user's
runs" never scans. The ledger writes a summary under the same switch as the
rest of the ledger (`runLog.enabled` and the feature flag); workflow and agent
executions get theirs either way, because their registry always recorded them.
Listings are still newest-first and still never include an anonymous run.

**Spill references did not change shape.** An event still refers to a spilled
payload as `{ path: "spill/<runId>/<name>", bytes, sha256, contentType }` —
that string is copied into the tool result the model reads and hashed into
`request/header`, so changing it would change what the model sees. The payload
itself is a blob beside the run's stream; the path is what it always was.

**Without a storage provider nothing moves.** If no provider comes up, the
ledger writes and reads the layout it always had —
`contents/data/run-log/runs/`, `spill/`, `index/` and `interactions.json` — and
behaves exactly as before. That is a supported state, not an error.

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

### Upgrading an installation that already has a ledger

Nothing is converted by hand and nothing is deleted. On the first boot after
the upgrade, one worker — whichever takes the import lock — reads what is
already on disk and writes it into the new namespaces:

| Imported from                                  | Into                       | Bound              |
| ---------------------------------------------- | -------------------------- | ------------------ |
| `run-log/index/<YYYY-MM-DD>.jsonl`             | `runs` documents           | 5000, newest first |
| `workflow-state/execution-registry.json`       | `runs` documents           | shares that bound  |
| `workflow-state/<executionId>/latest.json`     | `workflow-state` documents | 5000, newest first |
| `run-log/interactions.json` (pending only)     | `interactions` documents   | 5000               |

The import is idempotent — a run that already has a document is left alone —
and writes a marker document (`runtime-imports/…`) so later boots
short-circuit. An import interrupted by a crash is finished by the next boot.
Anonymous runs are skipped: they were never listable, and importing them would
spend the bound on runs nobody can ask for.

**The legacy files stay exactly where they are.** They are not moved, emptied
or rewritten; a later release removes them. Until then they are still read:

- a run's *events* are never imported at all — `run-log/runs/<runId>.jsonl` is
  read in place, so a run recorded before the upgrade still opens, still
  re-syncs and still replays;
- `GET /api/runs` merges the `runs` namespace with the per-day index files, the
  namespace winning on any run both describe, so runs past the import bound
  stay listed until retention ages those files out;
- a payload spilled before the upgrade is read from `spill/<runId>/`;
- a workflow checkpoint that was not imported is read from its
  `<executionId>/latest.json` directory.

**What that means for a rollback.** The previous release finds its own files
untouched and runs. What it does not find is anything written *after* the
upgrade: those events, summaries, checkpoints and interactions are in the new
namespaces, which the old code does not read. A rollback therefore loses the
window, not the history. Rolling forward again does not re-run the import —
the marker is already there — but little is lost by that, because the fallbacks
above keep reading the legacy files. The one exception worth knowing: an
execution that already has a state document takes it, so a checkpoint the old
release rewrote during the rollback window is shadowed by the imported copy.

## API

| Method & path                                             | Who                       | Purpose                                                        |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `GET /api/runs?from&to&kind&principalId&limit`            | admin                     | List runs from the run index                                   |
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
answer endpoint. Pending interactions survive a restart (one document per
interaction, written whether or not the ledger feature is enabled); the raise
and the answer are on the run's ledger (`interaction/raised`,
`interaction/answered`).

In a cluster every worker sees every interaction (mutations replicate over the
cluster bus), and an answer is accepted by exactly one worker: the answer
handlers run inside a lease taken on the interaction id, and the first thing
inside that lease is a fresh read of the shared record. A concurrent answer
gets `409 ANSWER_IN_PROGRESS`, a late one `409 NOT_PENDING`, even when that
worker's replica still shows the interaction as pending. The lease replaces
the exclusive `interaction-claims/<id>.json` marker files — and because a lease
is released the moment the critical section ends, the "already answered, do not
resume twice" signal a marker carried as a tombstone is now the stored record
itself, which is why the record had to move into shared storage in the same
change. A settled record is kept as that tombstone for twice the in-memory
grace period and then swept. With no storage provider the marker files are
still what is used. `answer.by` is the
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

- **One store per cluster.** Every worker must reach the same storage provider
  — on the filesystem provider, the same `contents/data/` directory. A run's
  stream is appended by the worker that owns the run, the interaction documents
  are what the workers agree on, and the answer lease and the per-run recovery
  lease are how they take turns. Workers on separate disks would each keep a
  partial ledger and could accept the same answer twice. The filesystem
  provider's leases are advisory and single-machine, so two installations
  pointed at one directory are still not supported; a provider with real
  distributed locks is what changes that.
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

`DELETE /api/runs/:runId` removes the run's events, its spilled payloads, its
summary document and every interaction that references it. On an installation
that still has per-day index files it also writes the tombstone line those
files need, because an append-only index cannot forget a run any other way.

The retention sweep does the same for runs older than `retentionDays`,
including the cascade (their interactions). It judges a run by the last
timestamp on its summary — its end, or its last update — where before it
judged the modification time of the run file; the legacy files it has not
replaced yet are still aged out by modification time, as before. Deleting a
chat conversation or a workflow execution through their own endpoints triggers
the same cascade for the run they belong to. Workflow *state* has a sweep of
its own with its own window — see [Workflows](workflows.md).
