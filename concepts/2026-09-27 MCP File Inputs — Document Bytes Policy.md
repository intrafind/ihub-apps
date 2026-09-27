# MCP File Inputs — Document Bytes Policy

Follow-up to #2543 (MCP tools receive chat attachments). Fixes two review
findings about documents carrying their raw bytes (`base64` data URL) in every
chat request.

## Problem

#2543 made the uploader attach a `base64` data URL to **every** uploaded
document (up to the app's document size limit), so an MCP tool with a
`format: "file"` parameter can receive the real PDF.

- **Finding A (medium).** The chat POST grew by ~1.37x of every document, even
  in apps without any file-input tool. Several documents or a raised document
  limit pushed the body past `requestBodyLimitMB` (default 50) → 413 on sends
  that used to work.
- **Finding B (low).** The document base64 also rode into workflow state via
  `_fileData` (chat seam → `server/tools/workflowRunner.js` → `initialData`),
  doubling every checkpoint and hitting `MAX_STATE_SIZE` (50 MB) for large PDFs.

## Decisions

1. **Signal for "the app has a tool with file inputs".** The chat client
   already calls `GET /api/tools?appId=<id>` (tools menu,
   `ChatInputActionsMenu`). MCP tools come back as the full tool objects,
   including `_mcp.fileInputs` (set by `McpServerConnection.listTools`). That is
   the most reliable signal the client has; no server change was needed.
   Matching of `app.tools` references mirrors `server/utils/toolSelection.js`
   (tool id, MCP server id, function-style base id).
2. **Two checkpoints on the client.**
   - *Upload time* (`ChatInput` → `UnifiedUploader`): bytes are read only when
     the **app's tool set** offers a file-input tool. `enabledTools` is not
     used here, so a user who enables the tool after uploading still has bytes.
   - *Send time* (`AppChat.handleSubmit`): bytes are dropped unless a
     file-input tool is **enabled for this turn** (same filter the server
     applies to `enabledTools`), and the budget is applied again.
3. **Budget.** 60% of `platformConfig.requestBodyLimitMB` (exposed by
   `/api/configs/platform`; default 50 → 30 MB of base64) for all documents of
   one message. Earlier documents keep their bytes first; a document that
   does not fit is sent as text only. The upload never fails because of it.
   Applied in `UnifiedUploader`'s `onSelect` wrapper (covers every
   `ChatInput` user, incl. Office/Canvas/StartPage) and at send time in
   `AppChat`.
4. **Unknown = no bytes.** Until the tools list has loaded, or when it fails
   (tools feature off, 403), documents are text only — the pre-#2543 behaviour.
5. **Server: workflows never get document bytes.** `withoutDocumentBytes`
   (`server/services/mcp/mcpFileInputs.js`) strips `base64` from every entry
   that is not `image`/`audio`. Applied in the chat passthrough seam
   (`chatSeams.js`, `params._fileData`) and in `workflowRunner.js` (the single
   entry into workflow state, which also covers the `@workflow` mention route
   in `sessionRoutes.js`). Images and audio keep their base64 — they had it
   before #2543 and `PromptNodeExecutor` reads image base64.

## Files

| File | Role |
| --- | --- |
| `client/src/features/upload/utils/documentBytes.js` | Pure helpers: budget, `offersFileInputTool`, `capDocumentBytes`, `applyDocumentBytesPolicy` |
| `client/src/features/chat/hooks/useDocumentBytesPolicy.js` | Hook: fetches the app's tools, returns `{ attachBytes, budget }` |
| `client/src/features/upload/components/UnifiedUploader.jsx` | New props `includeDocumentBytes` (default `false`), `documentBytesBudget` |
| `client/src/features/chat/components/ChatInput.jsx` | Passes the upload-time policy to the uploader |
| `client/src/features/apps/pages/AppChat.jsx` | Applies the send-time policy to the selection |
| `server/services/mcp/mcpFileInputs.js` | `withoutDocumentBytes` |
| `server/services/chat/chatSeams.js`, `server/tools/workflowRunner.js` | Strip document bytes from `_fileData` |

## Tests

- `tests/unit/client/document-bytes-policy.test.jsx` — helpers, uploader
  (no bytes by default, bytes with a file-input tool, budget cap), hook
  (fetch, disabled tool, failed request).
- `server/tests/loop/chatTurn.test.js` — passthrough workflow `_fileData`
  carries no document base64; image upload unchanged.
- `server/tests/mcp/fileInputs.test.js` — `withoutDocumentBytes`.

## Open points / ideas

- Other senders than `AppChat` (Office add-in) only get the upload-time checks
  (app tool set + budget), not the per-turn `enabledTools` check.
- The `StartWorkflowModal` uploader no longer attaches document bytes (default
  `includeDocumentBytes=false`) — same as before #2543.
