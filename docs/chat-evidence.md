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

- `enabled` (default `true`): off means no record is written, and the read endpoints answer
  `404 EVIDENCE_NOT_RECORDED`, also for records stored before. Turning it on applies to answers
  stored from then on. Migration `V251` writes the defaults.
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
  "app": { "id": "…", "configSha256": "…" },   // hash of the app config in force when the answer was stored
  "model": { "id": "…", "provider": "…", "modelId": "…", "settings": { "temperature": 0.2, "maxTokens": 4096 } },
  "status": "completed",
  "output": { "provenanceId": "…", "contentSha256": "…", "finishReason": "stop", "usage": {…},
              "files": [ { "artifactId": "…", "sha256": "…" } ] },
  "calls": [ {                                 // one per model call, auxiliary calls included
    "step": 0, "segment": "…", "purpose": "…", "requestId": "req-…", "attempt": 2,
    "retries": [ { "attempt": 1, "code": "RATE_LIMITED", "status": 429 } ],
    "model": "…", "provider": "…", "messagesHash": "…", "messageCount": 4,
    "system": ["sha256:…"],                    // the leading system messages
    "messages": [ { "role": "user", "message": "sha256:…",
                    "files": [ { "fileId": "…", "textSha256": "…", "chars": 1234 },
                               { "fileId": "…", "sha256": "…", "bytes": 5678, "page": 3 } ] } ],
    "tools": ["sha256:…"],                     // one per tool definition offered
    "config": "sha256:…",                      // callConfig + model and options snapshots
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
  "children": [],
  "truncated": [ { "sha256": "…", "bytes": 20000000, "truncated": true } ]
}
```

- Every `sha256:<hex>` names a content item: the **canonical JSON** (`storage/canonicalJson.js`) of a
  message, tool definition, tool argument object or tool result. Its SHA-256 is computed over exactly
  those bytes, so a reader can verify every item.
- A call's messages are the full list the model was sent, rebuilt from the journal, as the ledger
  records them: a document stored as a chat file appears as its `<content … id text_sha256 chars/>`
  reference, a picture as `{ fileId, sha256, bytes }` (see `services/loop/ledgerMessages.js`), and
  `files` lists those references. `messagesHash` is the hash `LLMClient` computed over the real
  messages when the call was made; it is copied, not recomputed.
- A tool result is the full result when the loop spilled it (`resultSource: "spill"`), otherwise the
  tool message the model read in the next call (`"message"`), otherwise the 1,024-character preview
  of the journal (`"preview"`, `partial: true`), e.g. when the run ended right after the tool.
- Tool labels (`title`, `integration`, `activityKind`, `activityScope`, `activityOrigin`) are copied
  from the `tool/call` event; the record never infers them.
- `knowledge` is phase 1: which projects the turn reached and how. The passages themselves are in
  the system prompt.
- Workflow and agent children (`children`) are phase 5 and always empty for now.

## How it is built

`services/chat/evidenceRecord.js` (`buildEvidence`) reads the run's journal
(`RunLog.readEvents`) and replays it: every `request/header` gives a call (`initial` / `change`
carry the full messages, `append` the new ones, `same` none), `request/retry`, `error` and
`message/assistant` complete it, `tool/call` and `tool/result` give the tool calls.

- **Chat answers:** `chatMaterializer.settleAssistantTurn` builds and stores the record after the
  generated artifacts and before the answer is appended, so the answer can carry
  `evidence: { id, sha256 }` (`id` is the message id, `sha256` the etag of the stored record). This
  is the one path every chat answer takes: the normal end, crash recovery (`chatRecovery.js`, where
  `run/end` is not written yet, so `journalEnded` is `false`), transcription turns, workflow results,
  and Responses API turns with a conversation.
- **Runs without a chat:** `recordRunEvidence` is called after the run ended, without being awaited,
  by `/v1/chat/completions` (model and app) and the Responses API without a conversation. Anonymous
  callers get no record.
- **Best effort.** An answer is never refused, delayed beyond the build or lost because of its
  evidence: any failure is logged at error level and the answer is stored without `evidence`. A
  record whose answer was not stored (another writer answered first, the chat is gone) is deleted.

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
blobs once and writes only the missing ones.

## Deletion

- A chat's evidence goes with the chat: `ChatRepository.deleteChat` removes both prefixes
  (`deletePrefix`), so every delete path covers it — the user's delete, `/v1` conversation delete,
  scheduled task delete, the retention sweep (age, count, temporary chats), the deleted user's
  cleanup and the workflow execution chat.
- A message that leaves the transcript (edit, resend, message delete, the message cap) takes its
  record with it. Blobs it shared with other answers stay until the chat goes.
- Run evidence goes with `DELETE /api/runs/{runId}`, the deleted user's cleanup (step
  `runEvidence`) and the chats' age rule (`chats.retentionDays`) in the retention sweep.
- `runLog.retentionDays` does not limit evidence.

## Quota

A chat's evidence counts against its storage limit (`uploads.quotas.maxChatBytes`) together with its
files. The limit is checked before an upload, never before an answer: when it is reached, new
uploads to the chat are refused (`QUOTA_CHAT_BYTES`), and a chat can go over it by its last answers.

## Reading it

Only the owner and admins. A shared chat does not share it (`evidence` is dropped from share
snapshots), and project members cannot read it.

| Endpoint | Who |
| -------- | --- |
| `GET /api/chats/{chatId}/evidence/{messageId}` | the chat owner |
| `GET /api/chats/{chatId}/evidence-content/{sha256}` | the chat owner |
| `GET /api/runs/{runId}/evidence` | the run's caller |
| `GET /api/runs/{runId}/evidence-content/{sha256}` | the run's caller |
| `GET /api/admin/chats/{chatId}/evidence/{messageId}` (and `…/evidence-content/{sha256}`) | admins, audited (`chatEvidence`) |
| `GET /api/admin/runs/{runId}/evidence` (and `…/evidence-content/{sha256}`) | admins, audited (`runEvidence`) |

The record answers with an `ETag` equal to the answer's `evidence.sha256`; content answers are the
item's canonical JSON. Both are `Cache-Control: private, immutable`. Errors: `404
EVIDENCE_NOT_RECORDED` (no record, not yours on the run routes, or the switch is off), `404
NOT_FOUND` (not your chat), `400 BAD_REQUEST` (not a lower-case hex SHA-256).

## Not in phase 1

Legal hold, the `knowledge/passages` event, content-addressed writes at request time, deleting
journals after materialization, and workflow/agent evidence (`children`, `workflow-evidence`) are
later phases of the design.
