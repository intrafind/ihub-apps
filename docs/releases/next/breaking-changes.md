# Breaking Changes — Unreleased

## Sources are now Projects

Admin-configured sources have become **admin projects**: the knowledge an admin links to apps,
workflows and agents, kept as encrypted text with per-document search. Every entry of
`config/sources.json` is migrated to `contents/projects/<id>.json` with the same id and one item
of the source's kind, so apps, workflows and agents keep their knowledge. The admin pages are now
**Projects**.

- The `sources` list on apps, workflows, workflow nodes, planner task templates and agent
  profiles is renamed to `projects`. A prompt source becomes `{ "id": "…", "mode": "context" }`
  (always in the prompt), a tool source `{ "id": "…", "mode": "tools" }` (reachable through the
  knowledge tools). There are no aliases: a configuration that still says `sources` is rejected
  by validation.
- The `source_<id>` tools are gone. Apps, workflow nodes and agents that link a project get the
  tools `knowledge_search`, `knowledge_read` and `knowledge_list` automatically. System prompts
  that told the model to call "the source tool" or to pass `section` should be reworded; the
  shipped iHub Support Bot prompt is updated by migration when it was not customised.
- The `{{sources}}` and `{{source}}` placeholders are renamed to `{{projects}}` by migration; a
  prompt without the placeholder gets the projects block appended, as before.
- The admin API `/api/admin/sources*` is replaced by `/api/admin/projects*`. The file-editing
  routes under `/api/admin/sources/:id/files` are replaced by
  `PUT /api/admin/projects/:id/items/:itemId/text`, which replaces the stored text of an
  uploaded, written or migrated document.
- The MCP gateway exposes `ihub://project/<id>` resources instead of `ihub://source/<id>`.
- The feature flag `sources` and the admin page switch `admin.pages.sources` are renamed to
  `projects`; their values are carried over.
- Files under `contents/sources/` (and the shipped FAQ, meeting knowledge base and iHub
  documentation) are imported into encrypted project storage at the first start. The copy under
  `contents/sources/` is deleted once its project item shows as ready; the consolidated
  documentation is refreshed from the shipped defaults whenever it changes.
- `config/sources.json` is kept as `config/sources.json.migrated` for reference and is no longer
  read.

**Before upgrading:** back up `contents/`. The migration is forward-only. If you deploy several
instances, every instance needs the same `TOKEN_ENCRYPTION_KEY` (or the same
`contents/.encryption-key`) and a shared volume, or the same storage provider, for
`contents/data/blobs/project-files`. After the start, check **Admin → Projects**: every migrated
item should show as *ready*; a *failed* item names the file it could not import.

## Every chat is stored on the server; temporary chats replace browser-only chats

Chats no longer live in the browser. Every conversation — signed in or anonymous, incognito,
compare mode, canvas, apps marked `ephemeral`, the Outlook add-in and the browser extension — is
held by the server, which assembles the history for the model. A chat the user does not want kept
is a **temporary chat**: stored the same way, so a reload or a lost connection no longer loses it,
but never listed in the history or shareable, and deleted a day after its last activity or as
soon as the user leaves it.

- The **Durable Chats** feature is now called **Chat History**. It decides whether chats are
  *kept* in a history; with it off — the default — every chat is temporary.
- Anonymous visitors own their chats through an HttpOnly guest cookie (`ihubGuest`). Their chats
  are always temporary. An anonymous chat embedded in a cross-site iframe that blocks third-party
  cookies cannot be continued after its first turn.
- Switching incognito on in a saved chat starts a new temporary chat; switching it off in a
  temporary chat saves that chat to the history. The toggle only appears where the history is on.
- New setting **Admin → Chat History → Temporary chats (hours)**
  (`platform.chats.temporaryRetentionHours`, default 24, at least 1), checked hourly. Kept chats
  follow the existing retention rules, which still only run while the history is on.
- `POST /api/apps/:appId/chat/:chatId` accepts exactly one message for every caller. Posting the
  whole conversation — including with `ephemeral: true`, which used to keep a turn out of storage —
  is refused:

  > 400 CLIENT_HISTORY_NOT_ALLOWED

  `ephemeral: true` on a chat's first turn now creates a temporary chat. Clients that hold the
  conversation themselves should use the stateless OpenAI-compatible API
  (`/api/inference/v1/chat/completions`).
- A turn answers `503 CHAT_STORAGE_UNAVAILABLE` when the storage provider did not come up, instead
  of falling back to a browser-only chat.
- `GET` and `DELETE /api/chats/:chatId` (and a chat's artifacts) work for temporary chats and for
  guests; `PATCH /api/chats/:chatId { "temporary": false }` keeps a temporary chat. The listing
  still needs the history.
- `POST /api/chat-handoffs` and `POST /api/chat-handoffs/claim` are removed: **Open in web app**
  in Outlook opens every chat by its address.
- The run ledger now records whenever storage is up, for every run, because chats are rebuilt from
  it. Its own retention (`runLog.retentionDays`) applies.

**Before upgrading:** chat content is now written to `contents/data/` on every installation, at
least for the temporary-chat window — review data-protection statements that relied on "no chat
content on disk" and lower **Temporary chats (hours)** if needed. Update integrations that post the
full message history to the chat route to send one message per turn, or move them to the
OpenAI-compatible API. Budget disk for chats and the run ledger.
