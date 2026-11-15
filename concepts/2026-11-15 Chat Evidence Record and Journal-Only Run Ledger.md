# Chat Evidence Record and Journal-Only Run Ledger

Status: proposal · 2026-11-15 · issue #3687 · follows the load-test findings in #3631 and PRs #3684, #3685, #3686

## Why

Enterprise customers have to prove, for any answer, **what went in and what came out**: which
passages the model saw, which tools it called with which arguments and what they returned, which
model and settings were used, and what it answered. The answer must be explainable as long as the
chat exists.

Today that evidence is split between two stores, and neither has all of it:

| | Chat (`chats`, per answer) | Run ledger (`data/logs/run`, per run) |
|---|---|---|
| Answer text, usage, finish reason | ✓ | partial (deltas) |
| `provenance` (output id, content hash) | ✓ | – |
| `sources`, `answerBasis` | ✓, ≤ 256 KB | grounding per step |
| `activity` (tool calls, searches, workflow steps) | ✓ but slimmed: no result previews, no file bytes, texts cut at 2,000 chars, ≤ 100 tool items, ≤ 256 KB (`runActivity.js` `slim` / `boundStoredActivity`) | ✓ results as preview + spill |
| System prompt incl. project excerpts | – | ✓ in `request/header`, every model call |
| Message history sent to the model | – | ✓ in `request/header`, every model call (references for chat files since #3684) |
| Lifetime | `chats.retentionDays`, `maxChatsPerUser`, user delete | `runLog.retentionDays` (separate setting; `cleanupEnabled: false` keeps it forever), chat delete cascade |

Problems:

1. **No complete record.** The chat lacks the prompt and full tool results. The ledger lacks
   nothing important, but it is not tied to the chat's lifetime. The two retentions are
   configured independently, so the evidence can expire before the answer, or outlive it.
2. **The ledger is the largest store and grows the fastest.** `request/header` repeats the full
   history and system prompt on every model call. In the load lab the ledger was ~14× the size of
   the chats (1.4 GB per run before #3684, 347 MB after). Nothing in production reads
   `request/header`.
3. **Finished runs are kept for no runtime reason.** The ledger is needed while a run is active:
   - reattaching after a reload (`GET /api/runs/:id/events?view=sse`, `useAppChat.reattachToRun`);
   - rebuilding a crashed turn (`chatRecovery`, `rebuildRunActivity`);
   - re-syncing a workflow view (`useRunStream`);
   - access checks for live runs (`runAccess`).

   Once the answer is materialized, the chat is the authority (`chatMaterializer` stores from the
   in-memory outcome, not from the ledger).

## Goals

- Every stored answer has an **evidence record** that, together with the chat, shows the exact
  model input and output of every model call of the turn, every tool call with its full
  arguments and result, and the passages and files that went in.
- Content is **stored once**: a system prompt, a passage, a file or a history message used by many
  calls of a chat is stored one time and referenced by its SHA-256.
- The evidence **lives and dies with the chat**: same retention, deleted by the same cascade.
- The run ledger becomes a **journal of active runs** and is deleted once the turn is stored.
- Workflow and agent executions carry the same record.

## Non-goals

- Tamper evidence (hash chain, signatures, WORM storage). The content hashes make it possible
  later; not part of this.
- Re-running a model call from the evidence.
- Changing what the chat UI shows. `activity` and `sources` stay as they are, for display.
- An export format (PDF, JSON bundle). It can be built on top.

## Design

### 1. Where the evidence lives

Not in the chat document. The chat document is read whole every time a chat opens and is kept
small on purpose. The evidence goes into two new namespaces of the storage provider:

- **`chat-evidence`** (documents): one document per answer, key `<chatId>/<messageId>`. The
  prefix index from #3686 (`KEY_PREFIX_SEGMENTS`: 1) makes "all evidence of a chat" a read of one
  directory.
- **`chat-evidence-content`** (blobs): content addressed **per chat**, key
  `<chatId>/<sha256>`. A system prompt, passage, tool result or history message is written once
  per chat, however often it is sent.

The assistant message carries no pointer: the record is keyed by the chat and the answer's message
id, and holds the message id and the hash of the answer's content (`output.contentSha256`). This
keeps the record off the answer path (implementation review, phase 1).

**Switch.** `platform.chats.evidence.enabled` (default `true`) turns the record off for the whole
installation. Off means no evidence documents and blobs are written and the read endpoints return
404 `EVIDENCE_NOT_RECORDED`. The journal is still deleted after materialization (section 4), so an
installation with evidence off keeps no record of what went in. The admin page says so next to
the switch. Turning it on applies to answers stored from then on.

**Existing data.** No backfill. Answers stored before the release, or while evidence was off, have
no `evidence` field, and the read endpoints return 404 `EVIDENCE_NOT_RECORDED` for them. Their
ledgers expire by the old `runLog.retentionDays` rule.

> ponytail: deduplication is per chat, not global. The same app system prompt is stored once per
> chat, not once per installation. In exchange, deleting a chat is a prefix delete, with no
> reference counting and no garbage collector. Move to global addressing with a mark-and-sweep
> only if measurements show system prompts dominate.

### 2. What the record holds

```jsonc
{
  "v": 1,
  "chatId": "…", "messageId": "…", "runId": "…", "userId": "…",
  "startedAt": "…", "endedAt": "…",
  "ihubVersion": "5.7.0",
  "app": { "id": "…", "config": "sha256:…" },         // the resolved app config when the answer was stored
  "model": { "id": "…", "provider": "…", "settings": { "temperature": 0.2, "maxTokens": 4096, "thinking": "…" } },
  "output": { "provenanceId": "…", "contentSha256": "…", "finishReason": "stop", "usage": { … },
              "files": [ { "artifactId": "…", "sha256": "…" } ] },
  "calls": [                                          // one per model call (step), retries included
    { "step": 0, "attempt": 1, "messagesHash": "…",   // the hash LLMClient computes today
      "system": "sha256:…",
      "messages": [ { "role": "user", "content": "sha256:…",
                      "files": [ { "fileId": "…", "sha256": "…", "page": 3 } ] } ],
      "tools": ["sha256:…"],                          // the tool definitions offered
      "status": "ok" | "error", "error": { … } }
  ],
  "knowledge": [                                      // what the knowledge scope put into the prompt
    { "projectId": "…", "mode": "loaded" | "searched", "documentId": "…", "passage": "sha256:…" }
  ],
  "toolCalls": [
    { "step": 0, "callId": "…", "toolId": "…", "integration": "…", "activityKind": "…",
      "args": "sha256:…", "result": "sha256:…", "resultBytes": 12345,
      "error": { … }, "startedAt": "…", "endedAt": "…", "childRunId": "…" }
  ],
  "children": [ { "runId": "…", "evidence": "<chatId>/<id>" } ]   // workflows started by a tool
}
```

- Every `sha256:` value is a blob in `chat-evidence-content` under the chat.
- Stored chat files are referenced by `fileId` + hash, as #3684 already does in the ledger, and
  not copied. Content without a chat file behind it (audio, pages rendered by a workflow, `/v1`
  images) is stored as a blob.
- `tool/started` already carries `integration`, `activityKind` and the title from
  `toolDisplay.js`. The record copies those fields and never infers them.
- No truncation: completeness is the point. One protective limit,
  `chats.evidence.maxContentBytes` (default 10 MB per item). Above it, the record keeps the hash
  and size and marks `truncated: true`. An item is one tool result, one passage or one message.
  Uploaded documents are not items: the record refers to their chat file and does not copy them.
  So the cap only applies to text that tools fetched or the model produced, and 10 MB is not
  expected to be reached.

### 3. How it is built: the journal is the source

The record is built at **materialization, from the run's journal**. The same code builds it for
a normal end and for crash recovery, because `chatRecovery` already reads the journal of a run
whose process died.

Write path while the run is active:

1. `LLMClient._recordRequestHeader` writes the system prompt, each message and the tool
   definitions into `chat-evidence-content` (put-if-absent by hash). The journal's
   `request/header` keeps **only the references**. This replaces #3684's per-call references with
   per-message hashes; history sent again costs one hash lookup instead of one copy.
2. Tool results that today spill to the run's spill directory spill into
   `chat-evidence-content` instead, so they are already where they will stay. Small results that
   stay inline in `tool/completed` are written there at materialization.
3. The knowledge scope planner records the passages it put into the prompt in a new journal
   event `knowledge/passages`: project, document and passage hash. Today only the rendered system
   prompt shows them.

At the end (`chatMaterializer`):

1. Store the answer and release the run, as before.
2. In the background (never awaited): read the run's journal, fold it into the evidence record
   and write the record. A process that dies between the append and this write leaves the answer
   without a record; the failure of a write is logged. A run whose journal has no model call (the
   ledger off) gets no record.
3. Mark the run materialized.

A call's messages mirror the journal: `{ from, append }`, the earlier call of the record whose
list it continues and the messages it added.

> ponytail: the first call of each answer still lists the whole history (O(history) references per
> answer). A cross-answer `from` would need the previous answer's record.

A run that is **not** a turn of a stored chat (`/v1` completions, headless agent calls without a
chat) gets the same evidence record, set up like a chat. It is stored in `run-evidence`
(documents, key `<ownerId>/<runId>`) and `run-evidence-content` (blobs, key `<runId>/<sha256>`).
It follows the chat rules: `chats.retentionDays`, the legal hold and deletion of the owner's data.
A temporary chat, including any chat while history is off, keeps its evidence like a kept chat
does: it goes with the chat after `temporaryRetentionHours`, unless a legal hold applies.

### 4. The ledger becomes a journal

After the answer and its evidence are stored, the journal of the run (its stream and spill
directory) is deleted after a **grace period of 15 minutes**. The run summary stays until
`runLog.retentionDays`. It is small, and run access and the admin run list use it.

Why a grace period: `reattachToRun` reads the journal of a run the chat document still shows as
active. If the run ends and the journal is deleted between those two reads, the replay gets a
404, never sees `run/ended`, and the client attaches to a stream that will not end. With a grace
period, the replay finds `run/ended` and settles as it does today.

> ponytail: the deletion is a sweep over materialized summaries older than 15 minutes, on the
> existing ledger cleanup timer, not a timer per run. A crashed worker's runs are picked up the
> same way.

Behavior that changes (decided: clean cut, no deprecation period): `GET /api/runs/:id/events`
returns 404 for a run that finished more than 15 minutes ago, where today it returns events for
`runLog.retentionDays`. The client only calls it for active runs. Admins and API users who read
finished runs this way use the evidence endpoints instead. The change ships with an entry in
`docs/releases/next/breaking-changes.md`.

### 5. Workflows and agents

Each LLM node and agent step is already its own run with `parentRunId`. Its evidence record is
built the same way and stored:

- for an `@mention` or tool-started workflow inside a chat: in the chat's evidence, listed under
  `children` of the turn;
- for a standalone execution: in a `workflow-evidence` namespace keyed
  `<executionId>/<runId>`, deleted with the execution by `workflowRetention` and the execution
  delete.

The execution state document (`WorkflowStateRepository`) gets the list of its node evidence ids,
the same way a chat message gets `evidence`.

### 6. Retention and deletion

- **Kept chat:** evidence is deleted by `deleteChatWithCascade`, the chat retention sweep (age
  and count rules) and a user's delete, as a prefix delete of `chat-evidence/<chatId>/` and
  `chat-evidence-content/<chatId>/`.
- **Temporary chat:** goes with the chat after `temporaryRetentionHours`, also under a legal hold
  (section 7).
- **Deleted user account:** the background cleanup that already removes a deleted user's chats
  (`startUserCleanup`) removes their evidence with them. A held user's chats and evidence stay
  (section 7).
- **`runLog.retentionDays`** no longer limits any evidence. It only applies to run summaries.
- **Deleting a single message** (edit, resend) deletes its evidence document, then a mark-and-sweep
  of the chat's blobs removes those no remaining record names. Record writes, sweeps and the chat
  delete take the lock `evidence:<scope(chatId)>`, so they never interleave.

### 7. Legal hold

There are two admin settings under `platform.chats.legalHold`. Adding the defaults needs a config
migration.

```jsonc
"legalHold": {
  "keepUserDeleted": false,   // a user's delete hides the chat; it is removed by retention
  "users": [], "groups": []   // held principals: nothing of theirs is deleted
}
```

- **`keepUserDeleted`:** a user's delete of a chat, message or run marks it `deletedAt` and does
  not remove it. The owner no longer lists or reads it (404). Admins can still read it. The
  retention rules remove it later as if it had not been deleted. The count rule
  (`maxChatsPerUser`) does not count hidden chats.
- **Held users and groups:** nothing owned by a held principal is deleted, whether by the user,
  retention, the count rule or the deletion of the user account. Hidden is the most a delete
  does. **Temporary chats are the exception:** they are deleted after `temporaryRetentionHours`
  under a hold too. Users choose a temporary chat to have it gone.
  Releasing the hold lets the normal rules run again on the next sweep.
- The hold covers everything the evidence refers to: the chat document, the evidence documents
  and blobs, the **chat files** (documents are referenced, not copied) and generated artifacts.
- Setting or releasing a hold, and every admin read of held or hidden data, is written to the
  audit log.
- **Who:** admins (`adminAuth`). A separate compliance role can come later.
- **Erasure requests:** the product shows no notice and has no override. A user's delete under a
  hold hides the chat; whether a hold outweighs an erasure request is the operator's decision,
  outside iHub.

There is no soft delete today (`deleteChatWithCascade` removes everything at once), so
`deletedAt` and the filter in listings and reads are new. All chat and run deletion paths go
through `chatDeletion.js` and the retention sweeps, so the check sits in those two places.

### 8. Reading the evidence

Decided: the owner and admins can read the evidence; nobody else can.

- `GET /api/chats/{chatId}/messages/{messageId}/evidence`: the owner. Content references stay
  hashes. `GET /api/chats/{chatId}/evidence-content/{sha256}` returns one blob. The same pair
  exists for runs without a chat under `/api/runs/{runId}/evidence`.
- `GET /api/admin/chats/{chatId}/messages/{messageId}/evidence` (and the run variant): admins,
  including hidden chats under a legal hold, written to the audit log.
- A shared chat does **not** share its evidence. It contains the app's system prompt and raw tool
  results the recipient may not be allowed to see.
- Errors follow `docs/api-guidelines.md` (problem+json, registry codes).

### 9. Size, quota and storage backends

- **Quota:** evidence counts against the chat's storage limit (`chats.uploads.quotas.maxChatBytes`),
  together with the chat's files. Referenced documents are counted once, as chat files. When the
  limit is reached, new uploads to the chat are refused as today. Answers are never refused or
  stored without their evidence: the limit is checked before an upload, not before an answer, so
  a chat can go over it by its last answers.
- **Originals expire before the chat.** `uploads.originalRetentionDays` (14) and
  `evictOldestOriginalsOnQuota` remove an uploaded original while its text stays with the chat.
  The record therefore refers to the extracted text the model received (file id, text hash,
  page), which lives as long as the chat; the original is evidence only while it exists. Under a
  legal hold neither rule removes originals.
- **Storage backends:** deletion is a prefix delete (`chat-evidence/<chatId>/`,
  `chat-evidence-content/<chatId>/`). Every storage provider must implement it, with a
  conformance test, before phase 1 ships.

### 10. Performance

Expected direction, to be measured in the load lab before the ledger deletion ships:

- Writes per model call: the new user message, new tool results and an unchanged-prompt hash
  check, instead of the full history (#3684 already removed the file copies).
- Steady-state disk: chats + evidence instead of chats + 90 days of ledger. The ledger itself
  drops to the active runs, roughly concurrency × run size.
- One journal read per answer at materialization, from the page cache.

## Plan

Each phase is shippable on its own.

1. **Evidence record from the journal.** New namespaces (chat and run evidence), the record
   builder in the materializer and crash recovery, the `evidence` field on the message, the
   delete cascade, the owner and admin read endpoints. The ledger is unchanged, so this only
   adds data. Tests: record contents for a turn with history, a document, a picture, a tool
   call, a workflow child, an error and retry; a `/v1` run; crash recovery; cascade, including
   the user-account cleanup. `chats.evidence.enabled`, the quota count and the prefix delete
   conformance test for every storage provider.
2. **Legal hold.** `chats.legalHold` with a migration for the defaults, `deletedAt` hiding, the
   checks in `chatDeletion.js` and the retention sweeps (chats, temporary chats, run evidence,
   chat files, artifacts, user-account cleanup), audit log entries, admin UI to manage held users
   and groups. Tests: every deletion path against a held user and with `keepUserDeleted`;
   temporary chats of a held user are still deleted.
3. **Content-addressed writes.** `request/header` and spills write into the evidence content
   store, and the journal holds only references. Add the `knowledge/passages` event. Load lab:
   ledger growth and event-loop delay vs #3684.
4. **Journal only.** The grace-period sweep deletes the journals of materialized runs.
   `runLog.retentionDays` applies to summaries only. Docs: `docs/run-ledger.md`,
   `docs/storage.md`, the breaking-changes entry for `GET /api/runs/:id/events`.
5. **Workflows and agents.** Node and step evidence, `workflow-evidence`, the execution delete,
   retention and the legal hold.
6. **Load lab** at 800 users on aged data: disk growth per hour, ELD, overhead, compared with
   today.

## Acceptance criteria

- For any stored answer or run, the evidence and its blobs reproduce byte for byte the system
  prompt, messages, tool definitions and tool results sent to and received from the model in
  each call. `messagesHash` in the record matches the hash computed when the call was made.
- Every passage that came from a project is listed with project, document and passage hash.
- Without a hold, deleting a chat (user, retention, cascade) leaves no evidence document or blob
  of it.
- With `keepUserDeleted`, a user's delete hides the chat from the owner, and an admin can still
  read it and its evidence until retention removes it. Nothing of a held user is removed by any
  path, chat files included.
- Only the owner and admins can read evidence. A shared chat's recipient cannot.
- After phase 4, a finished run leaves no journal stream or spill directory after the grace
  period, and `GET /api/runs/:id/events` returns 404 for it. Reload during a running answer
  still reattaches. A crash mid-run still yields the answer and its evidence.
- Load lab: no regression in ELD or overhead against the merged #3684–#3686 baseline, and lower
  disk growth.

## Decisions (2026-11-15)

1. **Retention:** evidence has the same retention as the chat and is deleted with it.
2. **Legal hold:** yes — `keepUserDeleted` plus held users and groups (section 7).
3. **Runs without a chat:** get evidence set up like chats (section 3).
4. **`GET /api/runs/:id/events` for finished runs:** clean cut, no deprecation period.
5. **Access:** the owner and admins.
6. **`maxContentBytes`:** 10 MB per item. Documents are referenced, not counted.
7. **Existing data:** no backfill. Only answers stored after the release have evidence.
8. **Erasure vs hold:** no notice or override in the product.
9. **Deleted user accounts:** their chats and evidence are deleted, unless the user is held.
10. **Who sets a hold:** admins, for now.
11. **Temporary chats:** deleted under a hold too.
12. **Quota:** evidence counts against the chat's storage limit.
13. **Storage backends:** every provider implements the prefix delete.
14. **Switch:** evidence can be turned off (`chats.evidence.enabled`).

## Open questions

- Should a legal hold also be settable on a single chat, not only on users and groups?
- **Export (undecided).** Direction under discussion: an admin export of everything (or of the
  held principals), produced in the background and split into one zip per user, like the data
  export of consumer AI products. Each zip holds the user's chats, evidence documents, blobs and
  referenced files with a manifest of hashes. Not part of phases 1–6.
