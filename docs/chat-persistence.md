# Chat Persistence (Durable Chats)

A chat is normally a browser object. `sessionStorage` holds the transcript, the
client posts that transcript back on every turn, and the generation is bound to
the tab: closing it aborts the model call mid-answer.

Chat persistence moves the conversation to the server. The transcript becomes
two documents in the [storage provider](storage.md), the server assembles the
history it sends to the model instead of trusting the client's copy, and a turn
that is being stored **keeps running when the browser goes away** — the answer
is written to the chat and is waiting there when the user comes back.

It ships **dark**: nothing is stored until an admin turns the feature on, and
everyone the feature does not cover (anonymous visitors, incognito turns,
installations that leave it off) keeps exactly the behaviour they have today.
That dual mode is permanent by design, not a transition.

> **Both halves ship together.** The server stores the transcript and assembles
> the history it sends to the model; the bundled chat client posts one message
> per turn, reopens a stored chat from the store, and lists what is stored —
> see [The chat history UI](#the-chat-history-ui).

## When a turn is persisted

`services/chat/chatPersistence.isChatPersistenceActive()` is the one place that
decides, and it is evaluated once per request. All of these have to hold:

| Condition                              | Where it comes from                                          |
| -------------------------------------- | ------------------------------------------------------------ |
| `features.chatPersistence` is on       | Admin → Platform → Features ("Durable Chats"), off by default |
| `platform.chats.enabled !== false`     | `contents/config/platform.json`                               |
| a storage provider came up             | `platform.storage` — see [Storage Providers](storage.md)      |
| the caller is authenticated            | anonymous callers never persist (see below)                   |
| the request is not `ephemeral`         | `ephemeral: true` in the chat POST body                       |
| the chat id can be a document key      | `isValidId()`; a headless `agent:<runId>:<hex>` chat cannot   |

Anything short of that and the turn takes the pre-persistence path: the client's
message array is used as-is, nothing is written, and the run still dies with the
client. There is no half-persisted state.

## Enabling

1. **Turn on the feature flag.** Admin → Platform → Features → **Durable
   Chats**, or `"chatPersistence": true` in `contents/config/features.json`. No
   restart needed.
2. **Check `platform.json → chats`.** Migration V095 writes the defaults into
   an existing installation, so the section is already there after an upgrade:

```json
{
  "chats": {
    "enabled": true,
    "retentionDays": 90,
    "maxChatsPerUser": 200
  }
}
```

| Key               | Default | Meaning                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------ |
| `enabled`         | `true`  | Second switch under the feature flag; `false` stops the write path entirely     |
| `retentionDays`   | `90`    | Chats whose last message is older than this are deleted by the daily sweep      |
| `maxChatsPerUser` | `200`   | Chats kept per owner; the oldest beyond the cap are deleted by the same sweep   |

Both retention rules are switched **off** by a value of zero or less — see
[Retention](#retention).

3. **Make sure storage is configured.** Durable chats are the first consumer of
   the storage abstraction. The default filesystem provider needs no
   configuration and writes under `contents/data/`; anything else is set in
   `platform.storage` and requires a restart.

The client learns the outcome from `GET /api/configs/platform`, which reports
`chats: { enabled, persistence }` — `persistence` is the server's own answer to
"is this installation actually storing chats", flag and platform switch and
storage readiness together.

V095 also carries a saved `chatHistoryPreview: true` over to `chatPersistence`,
on the reasoning that an admin who asked for chat history asked for chat
history. An explicit `chatPersistence` setting always wins.

## The chat history UI

With the feature on, a signed-in user's stored chats show up in three places.
All three read the same list (`GET /api/chats`), and none of them exist when
durable chats are off.

- **The sidebar's *Recents* section** — the five most recent chats, above an
  **All chats** link. Collapsed to the icon rail, that same destination sits
  behind a clock icon, so collapsing the sidebar no longer hides the history.
  The number next to *All chats* is how many chats are **loaded**, with a `+`
  when there are more: the listing is cursor-paged and has no cheap total.
- **`/chats`** — the full list, grouped **by date** (Today / Yesterday / Last 7
  days / Older), **by app**, or flat with the most recent first. The search box
  filters the chats that are loaded by title and app name, and **Show older
  chats** pages further back.
- **The start page** — up to three *Pick up where you left off* chips.

The app name, colour and icon on those rows are joined from the apps the viewer
can see; the stored chat carries only an `appId` (see [API](#api)). A chat whose
app was deleted, or whose app the user has lost access to, still lists and still
opens — under a neutral tile and its raw app id.

### Opening and continuing a chat

A chat opens at **`/apps/:appId/c/:chatId`**. Rows are ordinary links, so
middle-click and open-in-new-tab work. The route is the app's normal chat page
with that chat loaded into it: the transcript comes from
`GET /api/chats/:chatId` rather than from the tab's `sessionStorage`, and the
page shows a loading state until it arrives instead of flashing the greeting and
starter prompts of a chat that is not empty. Typing carries straight on — the
turn posts only the new message and the server appends it to what it already
holds.

Reloading a plain `/apps/:appId` restores the conversation as well: the tab
remembers which chat it is in and the transcript is fetched back from the store,
where before it came from browser storage. Clearing the chat, or starting a new
one, drops the chat id from the URL and begins a fresh conversation; nothing is
lost, the previous chat simply stays in the list. A share link built on a chat
page points at the **app**, never at the one stored chat — a recipient does not
own it and could only get a 404 from it.

Editing an earlier message and sending it again rewrites the stored transcript
from that message, the same way it rewrites what is on screen — that is the
`replaceFromMessageId` half of
[The server owns the history](#the-server-owns-the-history). It works on
messages that came back from the store; an exchange produced in the same
session, before any reload, is only truncated locally and stays in the stored
transcript behind the newer answer.

### "Answered while you were away"

A turn that finishes with nobody watching — the tab was closed, the laptop shut
— marks its chat `hasUnseenActivity`. That is the whole point of durable runs,
so the list says so:

- in the sidebar, a dot on the row and an **N new** badge next to *Recents* (a
  dot on the clock icon when the sidebar is collapsed),
- on `/chats`, an amber **New** pill on the chat.

Opening the chat is what clears it — reading it through `GET /api/chats/:chatId`
is what "seen" means.

### Renaming and deleting

Hovering a chat, in the sidebar or on `/chats`, reveals a rename and a delete
button; on `/chats` they are always visible on a touch screen.

- **Rename** turns the title into an input in place. Enter or clicking away
  commits, Escape cancels, and an unchanged or emptied field writes nothing. A
  title set this way is marked as the user's and no later turn derives one over
  it; it is capped at 200 characters.
- **Delete** asks first, in an in-app confirmation, and then erases the chat,
  its transcript and the runs behind it — the cascade described under
  [API](#api). There is no undo. The row disappears immediately and comes back
  with an error message if the call fails.

Chats the user never renames are titled from their first message.

### What never appears in the list

Only stored chats can be listed, so the carve-outs in [Anonymous and ephemeral
chats are never stored](#anonymous-and-ephemeral-chats-are-never-stored) are
exactly the conversations with no history:

- **Signed-out visitors have no history at all** — no *Recents*, no `/chats`.
  Nothing is stored for them, so there would be nothing to list.
- **Incognito chats.** With the ghost toggle under the chat input switched on
  the turn is posted `ephemeral: true`, the transcript stays in the browser as
  it always did, and no trace of it reaches the list.
- **Compare panels and the canvas.** Each panel mints its own chat id and a
  single submit fans out to several of them, so both surfaces send
  `ephemeral: true` too — a comparison never fills the history with half
  conversations.

When the feature is off, or the storage provider did not come up, the UI is not
there at all: no *Recents* section, `/chats` is not found, and the sidebar's
search box goes back to reading "Search apps". The client decides that from the
`chats.persistence` capability in `GET /api/configs/platform`, so an
installation with the flag on but no working store falls back to the ephemeral
experience rather than showing errors.

## What it costs: runs no longer die with the tab

This is the behaviour change to consent to before switching the feature on.

Three separate paths used to abort a running model call when the client went
away: the SSE `onClose` handler, a failed write to the SSE socket, and the
five-minute inactivity sweep that evicts a stream whose heartbeat stopped. All
three now go through `abortChatRequestOnDisconnect()`, which leaves a **durable**
turn — one that is being persisted — running to completion.

That is the point of the feature: the user closes the laptop, comes back, and
the answer is in the chat. It is also a spend change. **Tokens are spent on
answers nobody may ever read.** A user who closes the tab one token into a long
answer is billed for the whole answer, and a user who fires off three questions
and walks away pays for three complete answers. Before this feature those calls
were cancelled at the provider.

What still stops a run:

- **The Stop button.** `POST /api/apps/:appId/chat/:chatId/stop` aborts
  unconditionally — durability only ever protects a run from a *disconnect*.
  The endpoint used to 404 when no SSE client was attached, which is exactly the
  situation durable runs create; it now accepts anything in flight for the chat
  anywhere in the cluster and resolves the run from the chat's stream binding
  or, failing that, the `activeRunId` on the chat document. A durable turn is
  registered for abort whether or not it streams, so Stop reaches a turn posted
  without an SSE stream too. When it finds nothing in flight — the turn ended
  in the meantime — it answers 404 rather than reporting a stop that did not
  happen.
- **The model's own output cap** (`maxOutputTokens`) and the agent loop's round
  cap, unchanged.
- **A server restart**, which is not a graceful stop — see
  [Operational notes](#operational-notes-and-limits).

Only durable turns are protected. An anonymous or ephemeral turn is aborted on
disconnect exactly as before, so the extra spend is bounded to authenticated,
non-incognito chats on an installation that opted in.

## Turning this on also turns on the run ledger

A chat turn is materialized alongside the run's own events, and the ledger is
where a run's user message, assistant message and usage are recorded. So
`RunLog.isEnabled()` now returns true whenever chat persistence is configured,
**regardless of the `runLog` feature flag and even when
`platform.runLog.enabled` is `false`**. The `runLog` flag has correspondingly
lost its "preview" marking.

Enabling chat persistence therefore accepts everything in the
[Run Ledger](run-ledger.md) doc:

- One JSONL file per run under `contents/data/run-log/runs/`, plus spill files
  for large tool results, a daily index and per-run lock files.
- Request headers are recorded, which means the full model-visible message array
  on the first call of each run. Because the server now assembles the history,
  every turn's run carries the whole conversation so far — **a long chat's
  ledger grows roughly with the square of its length**, and it holds the
  message text a second time next to the chat transcript. Budget disk for that,
  or lower `runLog.retentionDays`.
- `runLog.retentionDays` (90 days) and `runLog.cleanupEnabled` govern the
  ledger's own sweep, independently of `chats.retentionDays`. A chat transcript
  outlives the deletion of its runs; a chat deleted through the API or the chat
  sweep takes its runs with it.
- `platform.runLog.identityMode` now decides who owns a chat, not only who owns
  a run. See [Ownership and identity](#ownership-and-identity).

Chat persistence also adds the one ledger event nobody was producing: a real
`message/user` for the human turn. Without it a run recorded every answer and
none of the questions.

## Anonymous and ephemeral chats are never stored

**Anonymous callers never persist**, and this is structural rather than a
policy: `resolvePrincipal` mints a fresh random `anon-<hex>` id on every call,
so a chat stored under one could never be listed or reloaded. Writing it would
only burn disk. An installation running with `anonymousAuth.enabled` gives its
signed-out visitors the unchanged browser-side experience — including runs that
still die with the tab. The `/api/chats` endpoints use `authenticatedOnly`, so
an anonymous caller cannot reach them even when anonymous access is on.

**Ephemeral turns are never stored.** `ephemeral: true` in the chat POST body
suppresses the write for that turn. It is client-asserted and therefore
advisory — it can only ever turn persistence *off*, never on — and an ephemeral
turn is not durable either, so it is aborted on disconnect like any
non-persisted turn. The incognito toggle under the chat input sends it, and so
do the compare panels and the canvas, which mint their own chat ids and fan one
submit out to several of them.

Neither carve-out leaves a trace: no chat document, no transcript, nothing to
delete afterwards.

## The server owns the history

Once a chat is persisted, the conversation's source of truth is the store, not
the browser. The chat POST changes shape:

- The request must carry **exactly one** message, the new one. More than one is
  rejected with `400 { "error": "CLIENT_HISTORY_NOT_ALLOWED" }`. A client can no
  longer rewrite what it already said, or replay a history it edited locally.
- The server reads the stored transcript, drops the bookkeeping (ids, usage,
  errors, attachment descriptors) and empty turns, appends the new message, and
  hands that to the request builder.
- `replaceFromMessageId` truncates the stored history from that message
  (inclusive) before the append — the server-side form of "edit this message and
  regenerate". An id that is not in the history is `400 UNKNOWN_MESSAGE`, never
  a silent append onto the untouched history.
- An app with `sendChatHistory: false` still gets only the new message. Storing
  a transcript must not start feeding it to a one-shot prompt.

Requests that are not persisted keep posting their whole array and take the same
code path they always did.

An `@workflow` mention is a turn like any other: the question is stored before
the workflow launches and the answer — or the failure, or the cancellation — is
stored when the run settles, under the workflow's run id. The launch does not go
through the chat service, so both halves are written by the route.

## Ownership and identity

`chatAuthRequired` authorizes the *app*, never the chat id. That was harmless
while a chat id was a browser-local string; a stored chat is a durable,
guessable resource, so `chatAccess.authorizeChat()` now runs on the chat SSE
`GET`, the chat `POST`, `/stop` and every `/api/chats` route.

- **404 for both unknown and not-yours.** Chat ids are client-minted and
  enumerable; a 403 on someone else's chat would make every endpoint an
  existence oracle.
- **An absent chat is authorized.** A chat nobody has stored yet is not somebody
  else's chat — the caller is about to create it.
- Admins may read any chat, matching `runAccess`.

The owner id is the run principal in `platform.runLog.identityMode` (`default`,
`full` or `pseudonymized`), resolved once at the start of the turn. The mode is
stored **on the chat** next to the owner, and an incoming caller is resolved in
*that* mode — so changing the mode later does not orphan chats that are already
stored. It does affect listing: `GET /api/chats` can only find chats written
under the mode configured right now, so chats written under the old mode drop
out of the list while staying readable by id.

Two identity traps worth knowing before you switch a live installation on:

- In `pseudonymized` mode the owner id is derived from the pepper at
  `contents/.usage-pepper`. Lose or rotate it and every owner id changes — every
  stored chat orphans. Nothing backs it up today.
- Owner ids come from the JWT subject. An OIDC provider that changes a user's
  `sub`, or a proxy-auth email change that mints a new internal user, orphans
  that user's chats.

## Data model

Two documents per chat, both carrying the owner id so the store's per-owner
index can answer "list my chats" without scanning:

```js
// chats/<chatId>
{
  id, ownerId, identityMode,
  appId, modelId,
  title, titleSetByUser,
  createdAt, lastMessageAt,
  messageCount,
  activeRunId,          // the run producing right now, null between turns
  hasUnseenActivity,    // an answer landed with nobody watching
  status,               // 'active' | 'running' | 'error'
  runIds: []            // most recent 200, for the delete cascade
}

// chat-messages/<chatId>
{
  version: 1,
  messages: [
    { id, role, content, ts, runId,
      clientMessageId?, usage?, finishReason?, error?, attachments? }
  ]
}
```

On the filesystem provider that is `contents/data/chats/<chatId>.json` and
`contents/data/chat-messages/<chatId>.json`, with the owner index beside them.

They are split because the chat list reads N metadata documents and zero
transcripts. Folding the messages in would make "show my chats" read every
message the user ever wrote.

Details that matter:

- **Message ids are server-minted** (`crypto.randomUUID()`). The client's own
  exchange id is kept as `clientMessageId` so an optimistic render can be
  reconciled instead of duplicated.
- **Attachments are descriptors** — `{ type, name?, bytes? }`. The base64 payload
  of an upload stays in the request; it is never written into a document that is
  read back for as long as the chat lives.
- **Failures are recorded.** An aborted turn stores its (possibly empty) answer
  with `error: { code: 'ABORTED', … }`, an errored turn with its error code, so a
  truncated answer never reads as a complete one. A turn that paused for a
  clarification stores nothing — the question is an interaction, not a message.
- **`hasUnseenActivity`** is set when the turn finished with no SSE client
  attached, and cleared when the chat is opened through `GET /api/chats/:id`.
  That is how the chat list marks "this one answered while you were away" — see
  [The chat history UI](#the-chat-history-ui).
- **The title** is derived from the first user message — whitespace collapsed,
  80 characters, ellipsis. A title the user set (`titleSetByUser`) is never
  overwritten.
- Every read-modify-write runs under `locks.withLock('chat:<id>')`. Two tabs on
  one chat are ordinary, and an unlocked read-append-write would drop one tab's
  message.

## API

All four endpoints require a real authenticated user (`authenticatedOnly`). The
three that address a chat validate the id before it reaches storage and answer
404 for both an unknown chat and someone else's. All of them are rate limited
with the other public API prefixes (500 requests/minute/IP by default).

| Method & path            | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `GET /api/chats`         | The caller's chats, most recent activity first. `?limit` (default 30, max 100) and `?cursor` |
| `GET /api/chats/:chatId` | `{ chat, messages, version }` — the transcript, and clears `hasUnseenActivity` |
| `PATCH /api/chats/:chatId` | `{ title }` — rename; capped at 200 characters and marked as user-set     |
| `DELETE /api/chats/:chatId` | Erase the chat, its transcript and its runs                             |

`GET /api/chats` returns the chat documents exactly as stored. App name, colour
and icon are joined on the client from the apps list it already holds, so the
endpoint stays independent of app configuration.

`DELETE` cascades: the two documents, then `runLog.deleteRun()` for every id in
the chat's `runIds`, which in turn removes each run's ledger file, its spill
directory and its pending interactions. The chat document is the only place a
chat's runs are written down, which is why it is read before it is deleted.

When durable chats are unavailable — the flag is off, an admin set
`chats.enabled: false`, or the storage provider did not come up — every endpoint
answers `503` with `details.code = "CHAT_PERSISTENCE_UNAVAILABLE"` rather than
404, so a client can tell "not configured" from "not found" and fall back to the
ephemeral experience.

## Retention

A daily sweep applies two rules, both read fresh from `platform.chats` on every
tick so an admin's change takes effect without a restart:

- **Age** — a chat whose last message is older than `retentionDays` (90) is
  deleted.
- **Count** — an owner keeps their `maxChatsPerUser` (200) most recently active
  chats; the rest are deleted, oldest first.

Set either to **zero or less to disable that rule**: `retentionDays: 0` keeps
chats until someone deletes them, `maxChatsPerUser: 0` removes the per-user cap.
Disable both and the sweep skips its scan entirely.

Every removal is the same cascade `DELETE /api/chats/:id` performs, ledger runs
included. The sweep runs once at startup — so a misconfigured retention shows up
in the log at boot rather than a day later — then every 24 hours, on the cluster
singleton worker that already owns the run-ledger cleanup, and never in parallel
with itself.

Setting `chats.enabled: false` **stops** the sweep. Disabling the feature is not
a request to purge what is already stored; delete the documents deliberately if
that is what you want.

## Operational notes and limits

- **A restart mid-turn strands the chat.** A durable run lives in the worker
  that started it. If the process goes away before the turn finishes, no
  assistant message is written and the chat document stays `status: 'running'`
  with a live `activeRunId`. There is no resume; the next turn on that chat
  moves it on.
- **One in-flight turn per chat, still.** Starting a turn on a chat that is
  already producing aborts the first one. Two tabs on the same chat cannot
  corrupt the stored transcript, but they can cut each other off. The aborted
  turn's partial answer is stored next to the question it was answering rather
  than after the newer one, and it does not release the chat — the turn that
  took it over owns `status` and `activeRunId` until it finishes. Durability is
  reference-counted for the same reason: the mark is released when the last
  turn on the chat ends, not the first.
- **Listing is an in-memory sort.** `DocumentStore.list` orders by key and only
  the owner filter is index-backed, so `GET /api/chats` loads the owner's chat
  documents (an indexed directory read plus one small read each), sorts them by
  `lastMessageAt` and pages the result. `maxChatsPerUser` is what keeps that
  bounded, with a hard ceiling of 1000 documents per owner: past it only the
  first 1000 chats in ascending key order are loaded, and because chat ids are
  random uuids that slice has nothing to do with recency — an owner over the
  ceiling has chats the listing cannot see at all until retention brings them
  back under it. This is not a scalable sort; a
  database-backed provider will answer the same call with an index and this code
  should shrink to a query then.
- **The filesystem provider is single-machine.** Its locks are advisory and
  process-local to one host; two installations pointed at one directory are not
  supported. Cluster workers on a shared volume are.
- **Per-worker chat state is still per-worker.** Clarification counts, prompt
  sources and the iFinder conversation mapping live in memory keyed by chat id
  and are not part of what is persisted.
- **Failures are loud but never fatal.** A storage error during materialization
  is logged at `error` and does not fail the turn: the user still gets their
  answer, the operator still sees that it was not stored. A storage provider
  that fails to come up at boot logs one error and leaves chats behaving exactly
  as they did before the feature existed.

## Code map

| File                                        | Responsibility                                              |
| ------------------------------------------- | ------------------------------------------------------------ |
| `server/storage/bootstrap.js`               | Brings the provider up per worker; `getStorage()` may be null |
| `server/services/chat/chatPersistence.js`   | The policy — the only module that decides "is this persisted" |
| `server/services/chat/ChatRepository.js`    | The two documents, their locks, listing and the cascade       |
| `server/services/chat/chatMaterializer.js`  | The only module that writes chat turns                        |
| `server/services/chat/chatAccess.js`        | `authorizeChat()` — 404 for unknown and not-yours             |
| `server/services/chat/chatRetention.js`     | The daily sweep                                               |
| `server/routes/chats.js`                    | The `/api/chats` surface                                      |
| `server/sse.js`                             | The durable-chat registry and the disconnect guard            |

```bash
npm run test:chat
```
