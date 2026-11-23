---
description: "The append-only record of every model run and what it is used for."
audience: developer
type: reference
---

# Run Ledger

The run ledger is an append-only record of every model run — chats, workflow
executions, agent runs, inference API calls and one-off utility calls. Each run
is one event stream that the unified runtime writes while the run is happening:
which model saw which messages (`request/header`), what came back
(`message/assistant`), tool calls and results, retries, compactions, budget
checkpoints, interactions raised and answered, and how the run ended.

It is the journal behind run detail pages, re-sync of live streams, cost
accounting and support debugging ("what exactly did the model see?"). For chat
turns and `/v1` runs it is kept only while the run is active: 15 minutes after
such a run ended, its journal is deleted and the [evidence record](chat-evidence.md)
is the lasting account (see [Journals of finished runs](#journals-of-finished-runs)).

## Enabling

**The ledger records whenever a [storage provider](storage.md) is up** — as the default
filesystem provider normally is. Every chat is stored server-side and
a chat answer is read back from its run's events, so the ledger cannot be
switched off while chats are stored: neither the `runLog` feature flag nor
`platform.runLog.enabled: false` stops it then (see
[Chat Persistence](chat-persistence.md#stored-chats-turn-on-the-run-ledger)).
Because the storage provider is mandatory, the flag and the switch no longer
change anything on a running installation.

1. The `runLog` feature flag is on by default (Admin → Platform → Features, or
   `features.runLog` in `contents/config/features.json`).
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
| `retentionDays`       | `90`      | Run summaries (and the journals of workflow and agent runs) older than this are deleted by the daily sweep. Keep it at or above `chats.retentionDays` — see below |
| `cleanupEnabled`      | `true`    | Turn the sweep off to keep run summaries forever (or to run your own). Journals of finished chat and `/v1` runs are deleted either way |
| `flushIntervalMs`     | `2000`    | Buffered appends are flushed to disk at this interval (and on run end / shutdown)                                      |
| `spillThresholdBytes` | `65536`   | Tool results and assistant content above this size are stored as separate spill files and referenced from the event    |

**`retentionDays` and chat retention.** `retentionDays` applies to run
summaries, and to the journals of workflow and agent runs; the journals of
finished chat and `/v1` runs are gone after 15 minutes (see
[Journals of finished runs](#journals-of-finished-runs)). Deleting a chat (by a user or by the
chat retention sweep) deletes its runs, so runs never outlive their chat by
much. The reverse is not true: the run sweep removes runs by their own age,
also those of a chat that is still kept. Set `runLog.retentionDays` at least
as high as `chats.retentionDays` (both 90 by default) so a kept chat does not
refer to runs that are gone; a higher value only keeps the runs of
non-chat work (workflows, agents, scheduled tasks) longer, and costs disk —
on a busy installation the run history can be the largest part of
`contents/data`.

## Journals of finished runs

The ledger is the **journal of active runs**. Once a chat turn or a `/v1/chat/completions` /
Responses run has ended and its content is kept elsewhere — the answer stored in the chat with its
[evidence record](chat-evidence.md), or the run's own evidence record — its journal (the
`run:<runId>` stream and its spill blobs) is deleted after a **grace period of 15 minutes**. The run
summary in `runs` stays until `retentionDays`, gets `journalDeletedAt`, and keeps answering run
access, `GET /api/runs/:runId` and the admin run list.

| Run kind                                   | Journal after the run ended                        |
| ------------------------------------------ | -------------------------------------------------- |
| `chat` (chat turns, Responses app turns)   | deleted after 15 minutes, once the chat released the run |
| `inference` (`/v1/chat/completions`, Responses model calls) | deleted after 15 minutes, once the chat (a Responses conversation) released the run |
| any kind that ended `paused` (approval, clarification) | kept while paused: the answer continues the same run (see [below](#deployment-assumptions)), which then ends and is deleted 15 minutes later like any chat run; a pause nobody answers keeps its journal until `retentionDays` |
| `workflow`, `agent`, everything else       | kept until `retentionDays` (their evidence is not recorded yet) |

**This does not depend on `chats.evidence.enabled`.** With evidence off, the journal of a finished
chat or `/v1` run is deleted all the same, and nothing of what went into the answer is kept beyond
the stored answer itself. Nor does it depend on `cleanupEnabled`, which only governs the summaries.

**Why 15 minutes.** A reloaded chat whose document still shows the run as active replays its
journal (`reattachToRun`); within the grace period the replay still finds `run/end` and settles.
A run whose chat still holds it as the active run (its process died before the answer was
stored) keeps its journal until crash recovery has settled it.

**How the sweep finds them.** Each worker remembers the chat and inference runs that ended on it
and, once a minute, deletes the journals of those that ended more than 15 minutes ago — one
summary read per run, nothing scanned, so the cost follows the run rate, not the number of retained
summaries. What no worker took (a worker that died within the grace period, journals kept before
the upgrade) is picked up by the daily retention walk, which reads every summary anyway and keeps
only those it can act on, so summaries whose journal is already gone do not use up its scan bound.
One walk deletes at most 2,000 journals; a larger backlog after the upgrade is worked off over
several days, 2,000 per walk (the walk runs at start-up and daily, and **Admin → Chat History →
Run retention now** runs one on demand, joining a walk already in progress).

**What reads a journal, and what it gets afterwards.**

| Reader | After the journal is deleted |
| ------ | ---------------------------- |
| `GET /api/runs/:runId/events` (reattach, live gap re-sync) | `404 JOURNAL_NOT_KEPT`; read the evidence instead (`GET /api/chats/{chatId}/evidence/{messageId}`, `GET /api/runs/{runId}/evidence`). The client only calls it for active runs |
| `GET /api/runs/:runId` | the summary; `seq` is `0` |
| Run access (owner check) | the summary, as before |
| Evidence record builder | runs right after the answer is stored, inside the grace period |
| Crash recovery (`chatRecovery.js`) | only for runs that never ended or whose chat still holds them — journals that are kept |
| "Has the run ended?" (stop, clarification end, recovery) | answered from the summary |
| Feedback on an old answer (`POST /api/feedback`) | the ledger event is not written; the feedback itself is stored as before |
| `POST /api/runs/:runId/human-events` | `404 JOURNAL_NOT_KEPT` |

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
`interactions.json`). Nothing reads those files any more; migration `V219`
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
request body. Replaying the deltas rebuilds every request's messages; the
[Chat Evidence Record](chat-evidence.md) does exactly that when an answer is
stored, and keeps the result with the chat. `messagesHash` is copied into the
record as computed at the call, not re-verified, and the record's `app.config`
is the app configuration in force when the answer was stored.

### Upgrading an installation that already has a ledger

Installations that last ran a release before 5.5.2 hold their runtime records as
files. Migration `V219` (`server/migrations/V219__import_legacy_runtime_stores.js`)
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
| `GET /api/runs/:runId/events?cursor=<c>&limit=<n>`       | owner or admin            | Read events (re-sync a live stream); the response is `{ runId, items, nextCursor }`, the cursor standing for the last raw sequence the page read; a page that read nothing has `nextCursor: null`. `404 JOURNAL_NOT_KEPT` for a finished chat or `/v1` run whose journal was deleted |
| `DELETE /api/runs/:runId`                                 | owner, or admin (audited) | Delete the run, its spill files and its interactions (cascade) |
| `GET /api/runs/:runId/interactions`                       | owner or admin            | Interactions of a run                                          |
| `POST /api/runs/:runId/interactions/:interactionId/answer`| owner, or approver group  | Answer a question / approval / review                          |
| `POST /api/runs/:runId/human-events`                      | owner; `stop` also admin (audited) | Deliver a `steer`, `stop` or `feedback` event into the run |
| `GET /api/interactions/pending`                           | authenticated             | Queue of interactions the caller may see: their own, those of their approver groups, and for an admin all of them. An admin sees more than an admin may answer |

### Who may do what with a run

Every route in the table above names what it is about to do, and the answer depends on it. The
same check decides for the chat routes that answer an approval or a question, for
`POST /api/feedback` and for the approval of an MCP app view's call. Two older groups of routes
are not covered; see [Routes with their own check](#routes-with-their-own-check).

| The caller wants to                              | Owner | Admin who is not the owner | Holds only the id of an anonymous run |
| ------------------------------------------------ | ----- | -------------------------- | ------------------------------------- |
| read the run, its events and its interactions    | yes   | yes                        | yes                                   |
| stop the run                                     | yes   | yes, written to the audit log | no                                 |
| delete the run                                   | yes   | yes, written to the audit log | no                                 |
| rate an answer (`feedback`)                      | yes   | no                         | no                                    |
| answer a question or an approval                 | yes   | only for a run that belongs to no person | no                      |
| send a message into the running answer (`steer`) | yes   | no                         | no                                    |

A refusal is `403 FORBIDDEN`; for a `steer` it is `403 RUN_STEER_FORBIDDEN`. A run nobody recorded
is `404 NOT_FOUND` for every caller.

- **The owner** is the principal recorded on the run, resolved in the identity mode the run was
  written in. A message into a running answer is sent in the owner's name, so it also needs the
  write right on the run's chat, and for an agent run the person who triggered it does not count:
  they read, stop and answer it, and do not send a message into it.
- **An anonymous run** has a random principal nobody can present again. Its owner is the browser
  session that owns the run's chat: the request must carry the guest cookie the chat was started
  with. Whoever holds the run id can still read the run and see that it waits for an answer, and
  nothing more. A run of an anonymous caller that has no stored chat has no owner; only an admin
  stops or deletes it.
- **An admin** reads every run, and stops or deletes it; both are written to the audit log
  (Admin → Audit Log, resource `run`) when the run is not the admin's own. The entry of a stop
  says whether anything was stopped: a stop sent to a run that had already ended is recorded as
  "Admin sent a stop to a run that is not their own; nothing was running", and
  `details.effect` names what was stopped (`null` for nothing). An admin does not answer
  an approval or a question of another user's run, because the approved call would run with that
  user's rights, and does not send a message into it. Two kinds of interaction an admin still
  answers: those that name an approver group (the group's members and admins answer them), and
  those of a run that belongs to no person, which is an agent run under the agent's own identity
  or a workflow run started by a trigger. Nobody else could answer the latter, and the answer
  continues the run with that identity's rights, not with a user's.
  `GET /api/interactions/pending` and Admin → Agents → Pending Approvals & Questions still list
  every pending interaction for an admin, also those only their owner answers; the answer to
  such a one is `403 FORBIDDEN`. The list carries no marker yet for which entries the caller
  may answer.

#### Routes with their own check

These rules hold where the routes ask the run access check. Two groups of routes were there
before it, decide on their own and are **not** covered:

| Routes | What an admin can still do there | Audit log |
| ------ | -------------------------------- | --------- |
| `POST /api/workflows/executions/:executionId/_cancel`, `POST .../_restart`, `DELETE /api/workflows/executions/:executionId` | cancel, restart (run again) and delete another user's workflow run | no entry |
| `POST /api/agents/runs/:runId/_cancel`, `POST /api/agents/runs/:runId/_resume` | cancel and resume an agent run they did not trigger | no entry |

The admin pages for workflow runs and agent runs use these routes. So a statement such as "an
admin stop is written to the audit log" is true for `POST /api/runs/:runId/human-events` and
`DELETE /api/runs/:runId`, and not for a cancel from those pages.

A run that is
known only to the worker that started it (persistence off) is described by
that worker over the cluster bus, so the request may land on any worker; an
interaction is authorized from the principal recorded on it, so it stays
answerable after a restart even when its run is no longer in memory (an
interaction of an anonymous run carries an `anonymous` marker and the chat id
for the same reason). Workflow
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
worker's replica still shows the interaction as pending. Because a lease
is released the moment the critical section ends, the "already answered, do not
resume twice" signal is the stored record itself: a settled record is kept as
that tombstone for twice the in-memory grace period and then swept. `answer.by` is the
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
supersedes a clarification settles only interactions whose run the sender
owns — a chat id alone does not let anyone settle another user's question, and
neither do admin rights.

## Human events

`POST /api/runs/:runId/human-events` records a `human/event` on the ledger:

| `kind`     | Body                                      | Effect                                                                                       |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `steer`    | `{ message }`                             | Delivered into the running loop at its next step boundary as a `[steer]`-marked user message (queued on the worker that owns the run, relayed there in a cluster; `effect: steer_queued` / `steer_relayed`); without an active loop it is recorded only |
| `stop`     | –                                         | Aborts the run: a chat run's active model call (and any workflow it launched), or the engine cancels the execution (relayed to the worker running it in a cluster). Only the run currently producing on its chat is aborted; a `stop` on a run that has ended, or that is no longer bound to the chat's stream, is recorded without a side effect |
| `feedback` | `{ rating?, message?, messageId? }`       | Recorded; the chat feedback form sends the same event through `POST /api/feedback` (`runId`) |

Who may send which kind: `steer` and `feedback` only the owner of the run, `stop` the owner and
an admin (see [Who may do what with a run](#who-may-do-what-with-a-run)). Three rules apply to
`steer` alone:

- **A message is never the answer to an approval.** While the run has a pending approval the
  event is refused with `409 RUN_NOT_ACTIVE`; nothing is recorded or queued and the approval
  stays pending. It is answered where it is shown.
- **30 per minute.** One caller sends at most 30 `steer` events per minute, over all runs; the
  next one answers `429 RATE_LIMITED` with a `Retry-After` header. Refused attempts count too.
  `stop` and `feedback` are never limited by it. The count is kept per signed-in user (per
  address for a caller who is not signed in) and is shared by the server processes of one
  server (`WORKERS`); several servers behind a load balancer each keep their own count.
- **Only the owner.** Anyone else, an admin included, gets `403 RUN_STEER_FORBIDDEN`.

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
- **Gap re-sync needs the ledger.** It works for active runs only: the journal
  of a finished chat or `/v1` run is deleted 15 minutes after it ended. A client that reconnects to a live stream
  fills the gap from `GET /api/runs/:runId/events`, retrying a failed read with
  backoff (five attempts) before it gives up and keeps its live view. The ledger
  is always on while the storage provider is up, so gap re-sync always has
  something to read back.
- **The stream format does not depend on the flag.** SSE v2 (`docs/streaming-events.md`)
  is the only chat / workflow / run stream; the ledger flag decides what is
  persisted, not what is sent.
- **A paused chat turn continues its run.** A chat turn that stops for a
  clarification (`ask_user`) or a tool approval records `run/end` with status
  `paused` (the run summary says `paused`). When the next chat message
  answers it, that turn **continues the same run**: `run/resumed`
  (`interactionId`, `pausedMs`) follows the pause and `interaction/answered`,
  the summary is `running` again (`endedAt` cleared), the sequence goes on
  after the last event, and the run ends with an ordinary `run/end` whose
  `usage` counts the whole turn. One answer is one run, so its journal and the
  [evidence record](chat-evidence.md) built from it hold everything: the
  calls before the pause, the answer, and the rest. A turn can pause more
  than once; each answer continues the same run. A replay shows the paused
  `run/end` as `run/paused`, not as the end of the run.
  - **From any worker.** `RunLog.continueRun` asks a worker that still owns
    the run's sequence (it paused the run less than a minute ago) to hand it
    over (`runlog:release`: it flushes and lets go); otherwise the sequence
    continues from the persisted journal under the per-run lock, which is
    also what happens after a restart. A continuation waits (at most 1.5 s)
    until the turn that paused has stored its part and released the chat —
    the card appears before that — and gets a run of its own if it has not,
    or if the worker that owns the run does not answer.
  - **When the turn gets a run of its own instead** (as every turn did
    before): the journal is gone (deleted, `journalDeletedAt`) or has no `run/start`, the run is not paused
    any more (continued or ended already), or it is not a chat run of the
    same chat and app started with the same model. The paused run then keeps
    its `run/end` with status `paused`. There is no age limit: a run is
    continuable while its journal exists.
  - **Unanswered questions still end on their own.** A clarification that is
    superseded by another message or expires, or one answered outside the chat
    (the answer endpoint), ends its run (`finishReason`
    `clarification_superseded` / `clarification_expired` /
    `clarification_answered`); an answer given in the chat is left to the
    turn that continues the run.
- **`runLog.enabled` defaults to `true`.** Migration V085 adds the block to an
  existing `platform.json`; like every migration it is forward-only.

## Deleting data

`DELETE /api/runs/:runId` removes the run's events, its spilled payloads, its
summary document and every interaction that references it.

The retention sweep does the same for runs older than `retentionDays`,
including the cascade (their interactions). It judges a run by the last
timestamp on its summary — its end, or its last update. Deleting a
chat conversation or a workflow execution through their own endpoints triggers
the same cascade for the run they belong to. Workflow *state* has a sweep of
its own with its own window — see [Workflows](workflows.md).
The journals of finished chat and `/v1` runs go much earlier, 15 minutes after
the run ended — see [Journals of finished runs](#journals-of-finished-runs).
