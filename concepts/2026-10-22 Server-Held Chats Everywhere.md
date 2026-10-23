# Server-Held Chats Everywhere

**Status:** Implemented
**Issue:** [#2947 Migrate to durable chats](https://github.com/intrafind/ihub-apps/issues/2947)
**Related:** `docs/chat-persistence.md`, `concepts/2026-10-05 Chat Streaming on the POST Response.md`

## Problem

A chat turn has two protocols today, and `docs/chat-persistence.md` calls the
split "permanent by design":

| Who                                                         | Transcript lives in | Request carries   |
| ----------------------------------------------------------- | ------------------- | ----------------- |
| Signed-in user, `chatPersistence` on, not incognito          | the server store    | the new message   |
| Everyone else (flag off, anonymous, incognito, compare, canvas, `ephemeral` apps, Outlook with the flag off, "Chat with Results" with the flag off) | the browser (`sessionStorage`) | the whole history |

Every integration (the Outlook pane, the browser extension, Nextcloud, API
callers on the chat route) has to implement both, and has to know which one is
in force before the first message — the pane waits for the platform config, the
web app holds the greeting back, `CLIENT_HISTORY_NOT_ALLOWED` exists only to
catch a client that guessed wrong. A whole route (`/api/chat-handoffs`) exists
only to move a browser-held transcript from the pane into the web app.

The ask: one way. A chat the user wants to be throwaway is still a server-held
chat, just marked temporary so it is not listed and goes away on its own.

## Decision

1. **Every chat turn on `POST /api/apps/:appId/chat/:chatId` is stored.** The
   request carries exactly one message; any longer array is
   `400 CLIENT_HISTORY_NOT_ALLOWED` for every caller. A caller that wants to hold
   the history itself uses the stateless OpenAI-compatible endpoint, which is
   the documented contract for that.
2. **Temporary chats.** A chat document carries `temporary: true` when, at the
   turn that creates it:
   - the request says `ephemeral: true` (incognito toggle, compare panels,
     canvas, an app whose `ephemeral` default seeds the toggle), or
   - the caller cannot keep a history: an anonymous visitor, or
   - the installation keeps no history: `features.chatPersistence` off or
     `platform.chats.enabled: false`.

   A temporary chat is a full chat — the server assembles its history, reload
   and re-attach work, edit/regenerate fork the stored transcript — but it is
   never listed (`GET /api/chats`), never shared, never counted against
   `maxChatsPerUser`, and deleted `platform.chats.temporaryRetentionHours`
   (default 24) after its last activity. The client deletes it as soon as the
   user leaves it (New chat, Clear, switching incognito).
3. **Temporariness is fixed by the chat, not the turn.** Later turns' `ephemeral`
   flag is ignored. The only transition is promotion:
   `PATCH /api/chats/:chatId { "temporary": false }`, allowed for the owner when
   they can keep a history. There is no demotion — switching incognito on in a
   chat that is already saved starts a new temporary chat instead.
4. **Anonymous visitors get a guest identity.** `resolvePrincipal` mints a fresh
   random id per call, so an anonymous chat could never be read back. The first
   anonymous API request is given an HttpOnly cookie `ihubGuest` (32 random
   bytes, `SameSite=Lax`, `Secure` behind HTTPS, 30 days). The chat owner id is
   `guest-<sha256(cookie)>` — the stored id never reveals the cookie. Guests own
   temporary chats only, can read, stop and delete them, and never list.
5. **The feature flag now means "Chat History".** `chatPersistence` keeps its id
   (no flag migration) but decides only whether chats are *kept and listed*.
   With it off every chat is temporary. Admin UI label: "Chat History".
6. **Storage is required for chat.** A chat turn on an installation whose storage
   provider did not come up answers `503 CHAT_STORAGE_UNAVAILABLE` instead of
   silently falling back to a browser-held chat. The default filesystem provider
   needs no configuration.
7. **The run ledger records every chat turn** (`RunLog.isEnabled()` is true
   whenever storage is ready), because a chat answer is materialized from it. A
   temporary chat's runs are deleted with the chat.
8. **Durability follows the chat.** A temporary turn is still aborted when its
   client goes away, as an ephemeral one was; only a kept chat's turn outlives
   the tab. That bounds the token spend for anonymous and incognito traffic to
   what it is today.
9. **Removed:** the `sessionStorage` transcript and project copy, the
   browser-persisted and ephemeral transcript modes in `useChatMessages`, the
   chat hand-off route and store, the "Chat with Results" `sessionStorage`
   seeding, and the 409 `CHAT_PERSISTENCE_OFF` of that endpoint. With history
   off the tab still remembers *which* chat it had per app (an id, not a
   transcript), so `/apps/:appId` reopens it from the store.

## Breaking changes

No compatibility shims (see `CLAUDE.md` → Breaking Changes):

- `POST /api/apps/:appId/chat/:chatId` with more than one message is refused for
  everyone, including `ephemeral: true` callers and installations with the flag
  off. `ephemeral: true` now means "temporary", not "not stored".
- `POST /api/chat-handoffs` and `POST /api/chat-handoffs/claim` are gone.
- `GET /api/chats/:chatId`, its artifacts and `DELETE` answer with history off
  (temporary chats need them) and for guests; the listing still answers
  `503 CHAT_PERSISTENCE_UNAVAILABLE` with history off.
- Every installation now writes chats (and their ledger runs) to storage.

## Premortem

Imagine it is three months later and this change went badly. Why?

| # | What went wrong | Mitigation in this change |
| - | --------------- | ------------------------- |
| 1 | A storage misconfiguration that used to cost only the history now takes chat down entirely. | Boot already logs the provider failure; the turn answers a clear 503 code instead of a generic error; the filesystem default needs nothing. Documented in the operational notes. |
| 2 | Disk fills on a busy public installation: every anonymous visitor now writes a chat and a ledger run. | Temporary chats expire after 24 h (configurable, hourly sweep); the ledger runs go with the chat; the client deletes a temporary chat on leaving it. The existing per-IP rate limit and `maxMessagesPerChat` still apply. |
| 3 | Users who switched on incognito find out their "not saved" chat sat on the server for a day, readable by admins. | UI copy says "Temporary chat — not saved to your history, deleted within a day"; docs say what is kept and for how long; the chat is deleted the moment the user leaves it. |
| 4 | API integrators posting the whole history (as the old hint told them to, with `ephemeral: true`) break on upgrade. | Release note under breaking changes; the 400 hint now points at one-message turns or the stateless OpenAI-compatible endpoint. |
| 5 | Anonymous chats in a cross-site iframe (embeds with third-party cookies blocked) cannot be continued: no guest cookie arrives, so the second turn is "not yours". | The first turn still works; documented limitation. Signed-in embeds (Outlook, Nextcloud, Teams, the extension) authenticate with tokens and are unaffected. |
| 6 | Retention deletes real history because the flag is off. | The age and count rules still run only while history is on, exactly as before; the new rule touches only documents with `temporary: true`. |
| 7 | Temporary chats push real chats out of the listing or out of the per-user cap. | They are excluded from both. They do count towards the 1000-document listing ceiling until they expire — bounded by the 24 h window. |
| 8 | A temporary chat leaks into places a saved chat goes: share links, project pages, the "Recents" badge. | Sharing refuses a temporary chat (409); a temporary chat is never recorded in a project; it never sets the unseen badge in a list it is not in. |
| 9 | Old browser tabs still hold `sessionStorage` transcripts and post whole histories after the upgrade. | The client purges the `ai_hub_chat_messages_*` / `ai_hub_chat_project_*` keys at boot; a stale tab that still posts a long array gets the 400 and reloads into the new client. |
| 10 | The guest cookie lets one anonymous visitor read another's chat. | The cookie is server-minted, 256 bits, HttpOnly; the stored owner is its hash; a request without it never matches a stored guest chat (404). |
| 11 | Compare mode creates N stored chats per submit. | They are temporary; the compare view deletes its panels' chats when it is cleared or closed. |
| 12 | A toggle mid-chat silently drops what the user sees. | Switching incognito on in a saved chat starts a new chat (the saved one stays in the history); switching it off in a temporary chat promotes the chat in place — nothing on screen is lost. |
| 13 | A compliance statement built on "no chat content on disk by default" (`docs/pii-data-handling.md`) is silently false after the upgrade. | The PII doc and the release note say what is stored now, where, and for how long; `temporaryRetentionHours` goes down to one hour for installations that need a minimum. |
| 14 | The run ledger, now on wherever storage is up, records every run (workflows and agents too), not only chat turns. | Its own retention (`runLog.retentionDays`, cleanup on by default) bounds it; the admin Chat History page says why it is recording. Documented in the release note. |
