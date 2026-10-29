# Breaking Changes — Unreleased

## Sources Are Now Projects

Sources are replaced by **projects**: a container for documents, links and instructions that apps,
workflows and agents draw on. The upgrade converts every source into an admin project with the
same id, so apps, workflows and agents keep their knowledge without any manual step. Only an id
that starts with `prj_` or is longer than 50 characters is renamed (`legacy-…`, logged); the apps,
workflows and agents that use it are updated too, but anything outside iHub that names such a
source by its id has to be changed by hand. In the admin area, **Sources** is now **Projects**. What a project can do is described under Features.

What changes for configuration and integrations:

- **Config files:** the `sources` list on apps, workflows, workflow steps, planner task templates
  and agent profiles is now called `projects`. A former prompt source becomes
  `{ "id": "…", "mode": "context" }` (always in the prompt), a former tool source
  `{ "id": "…", "mode": "tools" }` (searched when needed). The upgrade rewrites shipped and existing
  files. There are no aliases: a file you import later that still says `sources` is rejected by
  validation.
- **Tools:** the `source_<id>` tools are gone. Anything that links a project gets the tools
  `knowledge_search`, `knowledge_read` and `knowledge_list` instead. Reword system prompts that tell
  the model to call "the source tool" or to pass a `section`. The shipped iHub Support Bot prompt
  is updated automatically if you did not customise it.
- **Placeholders:** `{{sources}}` and `{{source}}` are renamed to `{{projects}}` by the upgrade. A
  prompt without the placeholder gets the projects block appended, as before.
- **Admin API:** `/api/admin/sources*` is replaced by `/api/admin/projects*`. The file-editing
  routes `/api/admin/sources/:id/files` are replaced by
  `PUT /api/admin/projects/:id/items/:itemId/text`.
- **MCP gateway:** resources are `ihub://project/<id>` instead of `ihub://source/<id>`.
- **Feature flag and admin page switch:** `sources` and `admin.pages.sources` are now `projects`
  and `admin.pages.projects`; their values are carried over.
- **Files:** the files under `contents/sources/` (and the shipped FAQ, meeting knowledge base and
  iHub documentation) are imported into encrypted project storage at the first start. Each copy
  under `contents/sources/` is deleted once its project item shows as ready. The six shipped
  `intrafind-website-*` sources end up as one `intrafind-website` project, and the apps that linked
  them are re-pointed (sources you changed are left as separate projects).
- `config/sources.json` is kept as `config/sources.json.migrated` for reference and is no longer
  read.

**Before upgrading:** back up `contents/`. The conversion only works forwards. If you run several
instances, they all need the same `TOKEN_ENCRYPTION_KEY` (or the same `contents/.encryption-key`)
and shared storage for `contents/data/blobs/project-files`, or the same storage provider. After
the first start, open **Admin → Projects**: every converted item should show as *ready*. A
*failed* item names the file it could not import. See [Projects](../../projects.md#migration-from-sources).

## Every Chat Is Stored on the Server; Temporary Chats Replace Browser-Only Chats

Chats no longer live in the browser. Every conversation is held by the server, whether the user is
signed in or anonymous, and in incognito, compare mode, canvas, apps marked `ephemeral`, the
Outlook add-in and the browser extension alike. A reload or a lost connection no longer loses a
chat.

A chat the user does not want to keep is a **temporary chat**. It is stored the same way but never
appears in the chat history, cannot be shared, and is deleted once it has been idle for the
retention period (24 hours by default). Starting a new chat or clearing the chat deletes it right
away.

What changes:

- **Durable Chats is now called Chat History.** It decides whether chats are *kept* in a history.
  With it off, every chat is temporary.
- **Incognito:** switching it on in a saved chat starts a new temporary chat; switching it off in a
  temporary chat saves that chat to the history. The toggle only appears where the history is on.
- **New setting:** **Admin → Observability → Chat History → Temporary chats (hours)**
  (`platform.chats.temporaryRetentionHours`, default 24, 1–720). A chat that is still receiving an
  answer is never removed. Kept chats follow the existing retention rules.
- **Anonymous visitors** own their chats through an HttpOnly cookie (`ihubGuest`), and their chats
  are always temporary. An anonymous chat embedded in a cross-site iframe that blocks third-party
  cookies can only answer its first message; the second one fails with `404 GUEST_COOKIE_MISSING`,
  and the chat explains why.
- **Chat API:** `POST /api/apps/:appId/chat/:chatId` accepts exactly one new message per call.
  Posting the whole conversation, including with `ephemeral: true`, is refused with
  `400 CLIENT_HISTORY_NOT_ALLOWED`. `ephemeral: true` on the first message now creates a temporary
  chat. Clients that keep the conversation themselves should use the stateless OpenAI-compatible
  API (`/api/inference/v1/chat/completions`).
- If the storage provider did not start, a message fails with `503 CHAT_STORAGE_UNAVAILABLE`
  instead of falling back to a browser-only chat.
- `GET`, `PATCH` and `DELETE /api/chats/:chatId` (and a chat's artifacts) work for temporary chats
  and for anonymous visitors. `PATCH /api/chats/:chatId { "temporary": false }` keeps a temporary
  chat; that, and the chat list, need the history to be on.
- `POST /api/chat-handoffs` and `POST /api/chat-handoffs/claim` are removed. **Open in web app** in
  Outlook now opens every chat by its address.
- **Run ledger:** it now records every run whenever storage is available, anonymous runs included,
  because chats are rebuilt from it. The `runLog` setting no longer switches it off. Deleting a
  chat, by hand or by retention, deletes its runs too. Only admins can list runs (`GET /api/runs`).
- **iAssistant:** the separate "resume conversation" on the chat page is gone; reopening the stored
  chat brings the conversation back.

**Before upgrading:** chat content is now written to `contents/data/` on every installation, at
least for the temporary-chat period. Review data-protection statements that relied on "no chat
content on disk", and lower **Temporary chats (hours)** if needed. Update integrations that post the
full message history to the chat route so they send one message per call, or move them to the
OpenAI-compatible API. Plan disk space for chats and the run ledger: anonymous traffic is limited
only by the per-IP rate limit (`rateLimit.publicApi`), the message size and count limits and the
temporary-chat period, so a public installation should keep the rate limit and the period tight.
See [Chat Persistence](../../chat-persistence.md).

## Scheduled Tasks: Run Retention Now Deletes the Run's Chat as Well

The periodic clean-up of scheduled-task runs (`runRetentionDays`, default 90) now deletes the chat
of a run together with its run record. Before, it removed only the record and left the chat to the
chat retention rules. Installations that keep chats longer than 90 days will therefore lose
scheduled-run chats once they reach that age.

**Before upgrading:** if you want to keep run history and its chats longer, raise
`runRetentionDays` under **Admin → Scheduled Tasks**, or set it to `0` to keep them indefinitely.

## Chat History, Run Ledger, Marketplace and Scheduled Tasks Are On by Default

Chat History, the Run Ledger, the Marketplace and Scheduled Tasks are no longer preview features
and are switched on out of the box. They no longer appear under **Preview** in **Admin → Platform →
Features**: Chat History, Marketplace and Scheduled Tasks are listed under **Content**, the Run
Ledger under **Platform**.

What changes on upgrade:

- **An installation that never set one of these flags gets the feature.** Signed-in users now have
  a chat history, so their conversations are kept for 90 days (`platform.chats.retentionDays`) and
  at most 200 chats per user (`platform.chats.maxChatsPerUser`) instead of being temporary. The
  **Marketplace** appears in the admin sidebar, and users in the built-in `admins`, `users` and
  `authenticated` groups can create scheduled tasks.
- **A flag that was saved is kept.** If an admin switched a feature off or on, that choice still
  applies.
- **Chat Sharing stays off** until an admin turns it on.

**Before upgrading:** if you do not want one of these features, switch it off under **Admin →
Platform → Features** (or set `chatPersistence`, `runLog`, `marketplace` or `scheduledTasks` to
`false` in `contents/config/features.json`) before the first start. Scheduled Tasks needs Chat
History, so switching Chat History off also hides Scheduled Tasks.

## The iFinder Document Actions App Is Removed

The `ifinder-document-actions` app is gone; **iFinder Search** (`ifinder-search`) replaces it. The
upgrade deletes the app file from `contents/apps/`, and the Parliamentary Questions Analyzer now
hands its questions to iFinder Search (`rendererConfig.iAssistantAppId`).

Groups that list `ifinder-document-actions` in their app permissions, and links or bookmarks to
`/apps/ifinder-document-actions`, have to be changed by hand.

## Updates: Unsigned Update Archives Are Refused

In-place updates of binary installations (Admin → Updates and `--update`) now install only release
archives signed by a key iHub trusts. Official releases are signed. Archives you build yourself, or
older archives without a signed manifest or checksum file, are refused with "The archive's origin
cannot be verified".

**Before upgrading:** if you install self-built binaries, sign them and add your public key to
`update.trustedPublicKeys` in `platform.json` (see [Update Signing](../../update-signing.md)), or
set `update.allowUnsigned: true` to allow unsigned archives after a typed confirmation. The update
*into* this release is still performed by your current version and is not signature-checked; verify
that download with `gh attestation verify <archive> --repo intrafind/ihub-apps`.
