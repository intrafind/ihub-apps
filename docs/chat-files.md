# Chat and Scheduled-Task Files

Files users attach to a chat or to a scheduled task are stored by the server, so the assistant keeps
reading them on every later turn, after a reload and on other devices. The design is in
[`concepts/chat-files/README.md`](../concepts/chat-files/README.md).

The files of earlier turns go back to the model in full only while they fit a quarter of the
context window. An older file is named in the prompt but not repeated, and the model reads it
with the `chat_files_read` tool when it needs it (see
[What earlier turns give the model](chat-persistence.md#what-earlier-turns-give-the-model)).

## What is stored

Every file has a metadata document, the extracted text, optional page images (scanned PDFs) and
optionally the original. Scopes:

| Scope  | Belongs to                               | Original TTL                | Removed with                  |
| ------ | ---------------------------------------- | --------------------------- | ----------------------------- |
| `chat` | a chat (uploads, e-mails, meetings, pages, tool results) | `originalRetentionDays`     | the chat, or the file         |
| `task` | a scheduled task definition              | none (kept while it exists) | the task, or the file         |
| `user` | a user of the Inference API (`/v1/files`) | `originalRetentionDays`     | `DELETE /v1/files/:id`        |

## In the UI

- **Composer.** A file is uploaded in the background as soon as it is attached (not when the message is
  sent) and the message then names it by id. In `client_text_only` mode only the text the browser
  extracted is uploaded.
- **Attachment chips.** Each chip under the composer says what the assistant gets from the file: the
  characters of text extracted from a document, the page images sent instead for a scan without a text
  layer, the size an image is sent in; once the server stored the file it also says when only the text is
  kept or the text was shortened. A file that came from a cloud storage or an integration (such as an
  iFinder document opened from a link) has buttons to **download the original** and, for a document,
  **the extracted text** as `<name>.txt`; a local file is the user's own already and has none.
- **Files drawer.** The chat header's button opens the **Files** drawer with two tabs, **Uploaded**
  (what the user and the add-ins put into the chat, including e-mails, meetings and pages) and
  **Generated** (see [Artifacts](artifacts.md#the-artifacts-panel)). Each uploaded file shows its type,
  size, pages and storage state (original saved, original removed, text only), a preview of the text
  the assistant reads, and the actions **Download original**, **Download text** and **Delete file**. A
  file chip under a message opens the file in the drawer. In the Outlook task pane, while a mail is
  being written, **Attach to email** attaches the file to it.
- **Task editor.** A scheduled task's form has an **Attached files** section to upload and remove
  files. Files from a connected system with `refreshOnRun` are set through the API; if a refresh
  fails, the run uses the last stored version and says so (see
  [Scheduled Tasks](scheduled-tasks.md#attached-files)).
- **E-mail attachments.** The same attachment is stored once per chat: a second copy with the same
  name and content (byte hash, or text hash when no original is kept) is recognised and not stored
  again.
- **Large tool results.** A binary file a tool returns is moved out of the model's context into the
  chat's files before it is logged, so a large result never reaches the transcript as base64.

## Platform settings (`platform.uploads`)

Edited in **Admin → Chat history → Uploaded files**.

| Setting                       | Default        | Meaning                                                                                  |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `enabled`                     | `true`         | Store uploaded files on the server                                                       |
| `storageMode`                 | `original_and_text` | `original_and_text`, `server_text_only` or `client_text_only` (app override: `app.uploads.storageMode`) |
| `originalRetentionDays`       | `14`           | Days an original is kept; `0` keeps it as long as the chat. The text stays with the chat |
| `evictOldestOriginalsOnQuota` | `true`         | When a user or the server is full, drop the oldest chat originals before refusing        |
| `quotas.maxFileBytes`         | 25 MB          | One file                                                                                 |
| `quotas.maxChatBytes` / `maxChatFiles` | 100 MB / 25 | One chat or one task                                                                  |
| `quotas.maxUserBytes`         | 1 GB           | One user (chats, tasks, API files)                                                       |
| `quotas.maxServerBytes`       | 50 GB          | The whole server                                                                         |
| `quotas.maxApiFiles` / `maxApiBytes` | 200 / 1 GB | One Inference API user's files (`/v1/files`, scope `user`); they do not use the per-chat limits |

The server-wide total is a counter document in the `chat-files` storage namespace, adjusted with a
compare-and-set on every put, delete and original discard, so several server instances sharing one
storage enforce `maxServerBytes` together. It is recounted from the file documents when it is missing,
older than five minutes, or when an upload comes within 10 % of the limit.

Zero or less switches a limit off. A refused upload answers `413` (`QUOTA_FILE_BYTES`,
`QUOTA_CHAT_FILES`, `QUOTA_CHAT_BYTES`, `QUOTA_API_FILES`, `QUOTA_API_BYTES`, `QUOTA_USER_BYTES`) or `507` (`QUOTA_SERVER_BYTES`).

## HTTP API

- `POST /api/chats/:chatId/files`, `POST /api/scheduled-tasks/:taskId/files`: a multipart `file`, or
  JSON with `text`, `pageImages`, base64 `data`, or `source`.
- `GET /api/chats/:chatId/files`, `GET .../files/:fileId` (`?format=text` for the text,
  `?download=1` to download the original — without it the original is served inline; `410 ORIGINAL_DISCARDED` when only the text is kept), and
  `DELETE .../files/:fileId`. The same under `/api/scheduled-tasks/:taskId/files`.
- A chat message names stored files with `fileIds`; `fileData` still works and is stored from the
  message.
- `GET /api/shares/:shareId/files[/:fileId]`: what a share lets viewers open. Creating a share takes
  `uploadedFilesAccess` (`none` by default, `extracted_text`, `original`) and `sharedFileIds`.

### Files from connected systems

```json
{ "source": { "kind": "nextcloud", "ref": { "providerId": "nc", "path": "/Documents/brief.docx" }, "refreshOnRun": true } }
```

`kind` is `nextcloud`, `office365`, `google-drive` or `ifinder-document`; `ref` is the one the
project items use. The server downloads the file with the user's stored credentials. On a task file
`refreshOnRun` fetches it again at the start of every run with the task owner's credentials.

## Using a file in the document skills

The model sees `id="…"` and `can_use_as_template="true"` on the file's `<content>` tag.

- `create_docx({ templateFileId, templateMode })`: `styles_only` (default when the file has no
  `{{content}}` marker), `fill_placeholders`, `append`.
- `create_pptx({ templateFileId, templateMode })`: `styles_only` (default) or `append`.
- `create_pdf({ templateFileId, fillFormFields, flattenForm })`: fills the form fields in place;
  without `fillFormFields` the new document is printed on the file as letterhead.
- `create_xlsx({ sourceFileId })`: keeps the workbook and replaces or adds the sheets given.

An app that pins a `documentTemplate` keeps it unless it sets `allowUserTemplateUploads: true`.

## Inference API, MCP and A2A

- **Inference API:** `/api/inference/v1/files` (`POST`, `GET`, `GET /:id`, `GET /:id/content`,
  `DELETE /:id`) stores files per user; `file_id` works in `/v1/responses` (`input_file`) and
  `/v1/chat/completions` (`file` parts). Inline files, `.xlsx` and scanned PDFs included, go through
  the same extraction as uploads. A file in a `/v1/responses` conversation turn is stored in the
  chat, so the web UI and API turns on the same chat see each other's files.
  `POST /v1/conversations/{id}/items` (and `POST /v1/conversations` with `items`) take `input_file` /
  `file` parts with `file_data` or `file_id` on user items the same way; the files are stored in the
  conversation and named on the item (`attachments`).
- **MCP client:** binary `resource` and `image` blocks a tool returns are stored in the chat and
  appear in the Files drawer; the model sees `{ fileId, name, mimeType, bytes }` instead of base64.
- **MCP server:** `app__*` and `workflow__*` tools take optional `files` (`name`, `mimeType`,
  `data` base64 or `text`). `app__*` tools return generated files and pictures as MCP `resource` and
  `image` blocks. `workflow__*` tools return the workflow's answer only: a workflow run has no output
  path for generated files (its result is the `output`, text or JSON; no workflow node hands files to
  the run), so none are returned.
- **A2A:** the server accepts inbound `FilePart`s (`bytes` or an https `uri`), advertises file types
  on the Agent Card and returns generated files as `FilePart` artifacts. The A2A tools take
  `fileIds` to forward chat files and store the files a remote agent returns.
