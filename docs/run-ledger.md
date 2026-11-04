# Run Ledger (RunLog)

The run ledger is an append-only record of every model run — chats, workflow
executions, agent runs, inference API calls and one-off utility calls. Each run
is one event stream that the unified runtime writes while the run is happening:
which model saw which messages (`request/header`), what came back
(`message/assistant`), tool calls and results, retries, compactions, budget
checkpoints, interactions raised and answered, and how the run ended.

It is the single source of truth behind run detail pages, re-sync of live
streams, audit, cost accounting and support debugging ("what exactly did the
model see?").

## Enabling

**The ledger records whenever a [storage provider](storage.md) is up** — as the default
filesystem provider normally is. Every chat is stored server-side and
a chat answer is read back from its run's events, so the ledger cannot be
switched off while chats are stored: neither the `runLog` feature flag nor
`platform.runLog.enabled: false` stops it then (see
[Chat Persistence](chat-persistence.md#stored-chats-turn-on-the-run-ledger)).
The flag and the switch only matter on an installation where no storage provider
came up.

1. The `runLog` feature flag is on by default (Admin → Platform → Features, or
   `features.runLog` in `contents/config/features.json`) and keeps the
   ledger on even without a storage provider. Set it to `false` to opt out
   where no storage provider is up.
2. Optionally tune `platform.json → runLog` (also editable under Admin →
   Observability → Chat History):

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
| `enabled`             | `true`    | Second switch under the feature flag; `false` keeps the in-memory event stream (live views) but writes nothing to disk — ignored while a storage provider is up |
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

Releases before 5.5.2 hand-wrote this under `contents/data/run-log/`
(`runs/<runId>.jsonl`, `spill/<runId>/`, `index/<YYYY-MM-DD>.jsonl`,
`interactions.json`). Nothing reads those files any more; migration `V224`
carries them into the namespaces above once (see [Upgrading](#upgrading-an-installation-that-already-has-a-ledger)).

| Was                        | Is now                                | Why                                                                         |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `runs/<runId>.jsonl`       | an append-log stream, `run:<runId>`   | one write path, and a later provider can hold it in a database              |
| `index/<YYYY-MM-DD>.jsonl` | one document per run in `runs`        | listing is an owner-indexed read, not a scan of every day file in the range |
| `interactions.json`        | one document per interaction          | a whole file rewritten per worker is how two workers lost each other's      |

**The `runs` namespace is the run index**, and it holds more than the daily
index did: workflow executions and agent runs are recorded there too, so one
namespace answers `GET /api/runs`, *My Executions* and the admin execution
list. Each document carries the run's principal as its owner, so "this user's
runs" never scans. The ledger always writes a summary, because the storage
provider is always up.
Listings are still newest-first and still never include an anonymous run.

**Spill references did not change shape.** An event still refers to a spilled
payload as `{ path: "spill/<runId>/<name>", bytes, sha256, contentType }` —
that string is copied into the tool result the model reads and hashed into
`request/header`, so changing it would change what the model sees. The payload
itself is a blob beside the run's stream; the path is what it always was.

**There is no mode without a storage provider.** The provider is mandatory (the
filesystem provider is the default); if it cannot start, the server does not
start. See [Storage](storage.md).

Event types are defined in `shared/runEvents.js` and validated by the Zod
contracts in `server/services/loop/contracts/runLogEvents.js`
(`run/start`, `run/end`, `run/paused`, `run/resumed`, `segment/start`,
`request/header`, `request/retry`, `message/user`, `message/assistant`,
`tool/call`, `tool/result`, `tool/disabled`, `interaction/raised`,
`interaction/answered`, `budget/checkpoint`, `budget/exhausted`,
`context/compaction`, `sources/added`, `error`). `sources/added` records what a
tool call, a model adapter or provider search found (see
[Answer Sources](answer-sources.md)); a re-sync replays it as the SSE frame of
the same name.

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

Installations that last ran a release before 5.5.2 hold their runtime records as
files. Migration `V224` (`server/migrations/V224__import_legacy_runtime_stores.js`)
reads them once, on the first start after the upgrade, and writes them into the
storage provider; the migration runner records it as done, so later starts do
not look at the files again.

| Imported from                                  | Into                       |
| ---------------------------------------------- | -------------------------- |
| `run-log/index/<YYYY-MM-DD>.jsonl`             | `runs` documents           |
| `workflow-state/execution-registry.json`       | `runs` documents           |
| `workflow-state/<executionId>/latest.json`     | `workflow-state` documents |
| `run-log/runs/<runId>.jsonl`                   | the run's `run:<runId>` stream |
| `run-log/spill/<runId>/<name>`                 | blobs beside that stream   |
| `run-log/interactions.json` (pending only)     | `interactions` documents   |

At most 50,000 runs and workflow states are carried over, newest first; a
truncation is logged as a warning. The import never overwrites a record that
already has a document, skips anonymous runs (they were never listable), and
leaves the old files where they are — they are not read afterwards, so an
operator may delete `contents/data/run-log/` and the `<executionId>/` directories
under `contents/data/workflow-state/` once the upgrade is confirmed. An
installation whose server already ran the former boot-time importers keeps
their markers (`runtime-imports/…`), and the migration honours them rather than
importing a second time, which would bring back records deleted since.

**What that means for a rollback.** The previous release finds its own files
untouched and runs. What it does not find is anything written *after* the
upgrade: those events, summaries, checkpoints and interactions are in the new
namespaces, which the old code does not read. A rollback therefore loses the
window, not the history.

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
  backoff (five attempts) before it gives up and keeps its live view. With the
  ledger off (no storage provider and `features.runLog` off) there is nothing
  to read back; the client rebuilds its view from the events
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
