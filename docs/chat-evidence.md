# Chat Evidence Record

For every stored answer, iHub keeps a record of **what went in and what came out**: the system
prompt, the messages and tool definitions of every model call of the turn, every tool call with its
arguments and full result, the model and its settings, and what the model answered. The record lives
as long as the chat and is deleted with it. Runs without a chat (`/v1/chat/completions`, the
Responses API without a conversation) get the same record.

Design: [`concepts/2026-11-15 Chat Evidence Record and Journal-Only Run Ledger.md`](../concepts/2026-11-15%20Chat%20Evidence%20Record%20and%20Journal-Only%20Run%20Ledger.md)
(issue #3687). This page describes phase 1: the record, its storage, deletion and the read
endpoints. The run ledger is unchanged.

## Switch and limits

`platform.json`, edited on **Admin → Chat History → Evidence record**:

```json
"chats": {
  "evidence": {
    "enabled": true,
    "maxContentBytes": 10485760
  }
}
```

- `enabled` (default `true`): off stops new records, and the read endpoints answer
  `404 EVIDENCE_NOT_RECORDED`. Records stored before stay until their chat is deleted or retention
  removes them (turning it on again makes them readable); the run ledger is unchanged. Turning it
  on applies to answers stored from then on. Migration `V251` writes the defaults.
- `maxContentBytes` (default 10 MB): the cap of one item (one message, tool result, tool
  definition). A larger item is not stored; the record lists it under `truncated` with its hash and
  size. Uploaded documents and pictures are not items: the record refers to their chat file.

Answers stored before the release, or while the switch was off, have no record. Nothing is backfilled.

## What a record holds

```jsonc
{
  "v": 1,
  "chatId": "…", "messageId": "…", "runId": "…", "userId": "…",   // userId as the ledger records it
  "startedAt": "…", "endedAt": "…",
  "journalEnded": true,            // false when the answer was rebuilt after a crash (no run/end)
  "ihubVersion": "…",
  "app": { "id": "…", "config": "sha256:…" },  // the app config in force when the answer was stored
  "model": { "id": "…", "provider": "…", "modelId": "…", "settings": { "temperature": 0.2, "maxTokens": 4096 } },
  "status": "completed",
  "output": { "provenanceId": "…", "contentSha256": "…", "finishReason": "stop", "usage": {…},
              "files": [ { "artifactId": "…", "sha256": "…" } ] },
  "calls": [ {                                 // one per model call, auxiliary calls included
    "step": 0, "segment": "…", "purpose": "…", "requestId": "req-…", "attempt": 2,
    "retries": [ { "attempt": 1, "code": "RATE_LIMITED", "status": 429 } ],
    "model": "…", "provider": "…", "messagesHash": "…", "messageCount": 4,
    "messages": {                              // as the journal records it
      "from": 0,                               // the call this list continues, null for a full list
      "append": [ { "role": "user", "message": "sha256:…",
                    "files": [ { "fileId": "…", "textSha256": "…", "chars": 1234 },
                               { "fileId": "…", "sha256": "…", "bytes": 5678, "page": 3 } ] } ] },
    "incomplete": true,                        // only when the replay does not match messageCount
    "tools": ["sha256:…"],                     // one per tool definition offered
    "config": "sha256:…",                      // callConfig (with the response schema) + snapshots
    "output": "sha256:…",                      // what the call returned (text, tool calls, usage)
    "status": "ok" | "error" | "unknown", "error": { … },
    "startedAt": "…", "endedAt": "…" } ],
  "toolCalls": [ {
    "step": 0, "callId": "…", "toolId": "…", "name": "…", "title": "…",
    "integration": "…", "activityKind": "search", "activityScope": "documents",
    "args": "sha256:…", "result": "sha256:…",
    "resultSource": "spill" | "message" | "preview", "partial": true,
    "resultBytes": 12345, "error": { … }, "durationMs": 120, "startedAt": "…", "endedAt": "…" } ],
  "errors": [ { "step": 2, "code": "…", "message": "…" } ],
  "knowledge": [ { "projectId": "…", "mode": "loaded", "documents": 3 } ],
  "truncated": [ { "sha256": "…", "bytes": 20000000, "truncated": true } ]
}
```

- Every `sha256:<hex>` names a content item: the **canonical JSON** (`storage/canonicalJson.js`) of a
  message, tool definition, tool argument object, tool result or the app configuration. Its SHA-256
  is computed over exactly those bytes, so a reader can verify every item.
- A call's messages are a delta, as in the journal: a full list (`from: null`, the first call and
  calls after a compaction) or the call it continues plus what was added (`append`, possibly empty).
  The full list of call *n* is the list of call `from` followed by `append`. The first call of
  every answer lists the whole history again. Messages are as the ledger records them: a document
  stored as a chat file appears as its `<content … id text_sha256 chars/>` reference, a picture as
  `{ fileId, sha256, bytes }` (see `services/loop/ledgerMessages.js`), and `files` lists those
  references. System messages are the leading `role: "system"` entries. `messagesHash` is the hash
  `LLMClient` computed over the real messages when the call was made; it is copied, not recomputed.
- A tool call is identified by its step and call id (providers reuse ids across steps). Its result
  is the full result when the loop spilled it (`resultSource: "spill"`), otherwise the tool message
  the model read in the first call after it (`"message"`), otherwise the 1,024-character preview of
  the journal (`"preview"`, `partial: true`), e.g. when the run ended right after the tool.
- An `error` event belongs to the call of its step; it marks that call failed only if the call had
  no answer.
- Tool labels (`title`, `integration`, `activityKind`, `activityScope`, `activityOrigin`) are copied
  from the `tool/call` event; the record never infers them.
- `knowledge` is phase 1: which projects the turn reached and how. The passages themselves are in
  the system prompt.

## How it is built

`services/chat/evidenceRecord.js` (`buildEvidence`) reads the run's journal
(`RunLog.readEvents`) and replays it: every `request/header` gives a call (`initial` / `change`
carry the full messages, `append` the new ones, `same` none), `request/retry`, `error` and
`message/assistant` complete it, `tool/call` and `tool/result` give the tool calls. A run whose
journal has no `request/header` gets **no record**: the record is built from the run ledger, so a
run that was not recorded (the ledger off, which stored chats never allow) has none.

- **Chat answers:** `chatMaterializer.settleAssistantTurn` stores the answer and releases the run as
  before, then starts `recordChatEvidence` in the background, never awaited. The record is keyed by
  the chat and the stored answer's message id; the answer itself carries no pointer. This is the one
  path every chat answer takes: the normal end, crash recovery (`chatRecovery.js`; `journalEnded`
  says whether `run/end` was there), transcription turns, workflow results, and Responses API turns
  with a conversation. A guest's chat or the anonymous principal's gets no record.
- **Runs without a chat:** `recordRunEvidence` runs in the background after the run ended (after
  the structured-output check; a rejected answer is recorded with status `error`, an accepted one
  with its provenance), for `/v1/chat/completions` (model and app, once per run) and the Responses
  API without a conversation. Anonymous callers get no record. The record is written only while
  the run's summary still exists, so a run deleted meanwhile gets none. These responses carry the
  run id in an **`X-Run-Id`** header, which is what `GET`/`DELETE /api/runs/{runId}…` take.
- **Chat answers** are written only while the chat and the answer are still stored (checked under
  the evidence lock).
- **Off the answer path.** An answer is never refused, delayed or lost because of its evidence. A
  failed write is logged at error level; a process that dies between storing the answer and writing
  the record leaves that answer without one. A write that finds the chat gone writes nothing.

## Storage

`services/chat/ChatEvidenceRepository.js`, on the storage provider:

| Namespace               | Kind     | Key                                   | Owner           |
| ----------------------- | -------- | ------------------------------------- | --------------- |
| `chat-evidence`         | document | `<scope(chatId)>__<scope(messageId)>` | the chat owner  |
| `chat-evidence-content` | blob     | `<scope(chatId)>__<sha256>`           | –               |
| `run-evidence`          | document | `<runId>`                             | the caller      |
| `run-evidence-content`  | blob     | `<scope(runId)>__<sha256>`            | –               |

`scope(id)` is the first 32 hex characters of sha256(id). Content is stored **once per chat**: a
system prompt or history message sent in many calls is one blob. Writing a record lists the chat's
blobs once and writes only the missing ones, eight at a time. An item above `maxContentBytes` is
hashed but never kept. Record writes, content sweeps and the chat's evidence delete take the lock
`evidence:<scope(chatId)>`, so they never interleave.

## Deletion

- A chat's evidence goes with the chat: `ChatRepository.deleteChat` removes both prefixes
  (`deletePrefix`) after the chat document, outside the chat lock, so every delete path covers it —
  the user's delete, `/v1` conversation delete, scheduled task delete, the retention sweep (age,
  count, temporary chats), the deleted user's cleanup and the workflow execution chat. A failure
  there is logged; a re-delete sweeps what is left.
- An answer that leaves the transcript (edit, resend, message delete, the message cap) takes its
  record with it, in the background; then the chat's blobs that no remaining record names are
  removed (mark and sweep).
- Run evidence goes with `DELETE /api/runs/{runId}`, the deleted user's cleanup (step
  `runEvidence`, which also removes chat evidence filed under the user that a failed chat delete
  left behind) and `chats.retentionDays` in a daily sweep — also while the chat history is off,
  since these runs are no chat history.
- Deletes wait at most 5 seconds for the evidence lock; a delete that cannot get it is logged and
  a later delete or sweep finishes it.
- `runLog.retentionDays` does not limit evidence.

## Quota

A chat's evidence counts against its storage limit (`uploads.quotas.maxChatBytes`) together with its
files, for a user's upload (`POST /api/chats/{chatId}/files`) only — files stored during an answer
(tool output, MCP, A2A) are not checked against it. The limit is checked before an upload, never
before an answer: when it is reached, new uploads to the chat are refused (`QUOTA_CHAT_BYTES`), and
a chat can go over it by its last answers. When the evidence usage cannot be read, the upload is
refused rather than let through.

## Reading it

Only the owner and admins. A shared chat does not share it (its messages name no record), and
project members cannot read it.

| Endpoint | Who |
| -------- | --- |
| `GET /api/chats/{chatId}/evidence/{messageId}` | the chat owner |
| `GET /api/chats/{chatId}/evidence-content/{sha256}` | the chat owner |
| `GET /api/runs/{runId}/evidence` | the run's caller |
| `GET /api/runs/{runId}/evidence-content/{sha256}` | the run's caller |
| `GET /api/admin/chats/{chatId}/evidence/{messageId}` (and `…/evidence-content/{sha256}`) | admins, audited (`chatEvidence`) |
| `GET /api/admin/runs/{runId}/evidence` (and `…/evidence-content/{sha256}`) | admins, audited (`runEvidence`) |

The record answers with its document etag as `ETag`; content answers are the item's canonical
JSON with its SHA-256 as `ETag`. Both are `Cache-Control: private, no-cache`: a record or blob can
be deleted, so a cache revalidates. A guest or the anonymous principal reads no evidence. Errors: `404
EVIDENCE_NOT_RECORDED` (no record, not yours on the run routes, or the switch is off), `404
NOT_FOUND` (not your chat), `400 BAD_REQUEST` (not a lower-case hex SHA-256).

## Not in phase 1

Legal hold, the `knowledge/passages` event, content-addressed writes at request time, deleting
journals after materialization, and workflow/agent evidence (`children`, `workflow-evidence`) are
later phases of the design.

> ponytail: a record write and an upload's quota check list the chat's evidence (O(records and
> blobs of the chat)). Keep a per-chat counter or index if long chats make it show up.
