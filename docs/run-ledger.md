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
and whenever they change (hash-deduplicated in between), the tool schemas, the
call configuration and a hash of the provider request body. The
`server/services/loop/replay/reconstruct.js` check rebuilds the request from
these fields and verifies the hash — the ledger is complete enough to replay.

## API

| Method & path                                             | Who                       | Purpose                                                        |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `GET /api/runs?from&to&kind&principalId&limit`            | admin                     | List runs from the daily index                                 |
| `GET /api/runs/:runId`                                    | owner or admin            | Run metadata                                                   |
| `GET /api/runs/:runId/events?after=<seq>&limit=<n>`       | owner or admin            | Read events (re-sync a live stream from a sequence number)     |
| `DELETE /api/runs/:runId`                                 | owner or admin            | Delete the run, its spill files and its interactions (cascade) |
| `GET /api/runs/:runId/interactions`                       | owner or admin            | Interactions of a run                                          |
| `POST /api/runs/:runId/interactions/:interactionId/answer`| owner, approver or admin  | Answer a question / approval / review                          |
| `GET /api/interactions/pending`                           | authenticated             | Queue of interactions the caller may answer                    |

Ownership is decided by the recorded principal in the current identity mode;
an anonymous run is readable by whoever presents its random id.

## Deleting data

`DELETE /api/runs/:runId` removes the run file, its spill directory and every
interaction that references it, and writes a tombstone to the index so the run
no longer appears in listings. The retention sweep does the same for runs
older than `retentionDays`. Deleting a chat conversation or a workflow
execution through their own endpoints triggers the same cascade for the run
they belong to.
