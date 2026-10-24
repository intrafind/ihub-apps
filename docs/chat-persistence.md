# Chat Persistence (Chat History)

Every chat lives on the server. The transcript is two documents in the
[storage provider](storage.md), the server assembles the history it sends to the
model instead of trusting a client's copy, and a client posts one message per
turn. There is no browser-held chat any more: no `sessionStorage` transcript, no
second protocol for "chats that are not stored".

What varies is whether a chat is **kept** or **temporary**:

- A **kept** chat is listed in its owner's history (*Recents*, `/chats`, the
  Outlook pane), can be reopened on any device and shared, follows the history
  retention rules — and its turn **keeps running when the browser goes away**:
  the answer is written to the chat and is waiting there when the user comes
  back.
- A **temporary** chat is stored the same way — a reload, a re-attach, an edit
  and a regenerate all work — but it is never listed or shared, and it is
  deleted `chats.temporaryRetentionHours` (24 by default) after its last
  activity, or at once when the user starts a new chat, clears it or switches
  incognito. Its turn stops when nobody is left to read it, like the ephemeral
  turn it replaces.

The **Chat History** feature (`chatPersistence`) decides whether chats can be
kept at all. It ships **off**: without it every chat is temporary.

> **One protocol.** Every surface — the web app, the Outlook pane, the browser
> extension, Nextcloud, an integration on the chat route — posts the new
> message and lets the server hold the rest. A caller that wants to send the
> whole conversation itself uses the stateless
> [OpenAI-compatible API](openai-compatible-api.md) instead.

## How a chat is stored

`services/chat/chatPersistence.resolveChatStorage()` is the one place that
decides, and only the turn that **creates** a chat consults it. A chat is kept
when all of these hold, and temporary otherwise:

| Condition                              | Where it comes from                                           |
| -------------------------------------- | ------------------------------------------------------------- |
| `features.chatPersistence` is on       | Admin → Platform → Features ("Chat History"), off by default  |
| `platform.chats.enabled !== false`     | `contents/config/platform.json`                                |
| a storage provider came up             | `platform.storage` — see [Storage Providers](storage.md)       |
| the caller is signed in                | an anonymous visitor's chats are always temporary (see below)  |
| the request is not `ephemeral`         | `ephemeral: true` in the chat POST body                        |

A chat stays what it was created as: a later turn's `ephemeral` is ignored, and
`PATCH /api/chats/:chatId { "temporary": false }` is the one way from
temporary to kept (there is none back). Without a storage provider no chat can
be stored, and the chat POST answers `503 CHAT_STORAGE_UNAVAILABLE` rather
than a conversation nobody could continue.

## Enabling

1. **Turn on the feature flag.** Admin → Platform → Features → **Chat
   History**, or `"chatPersistence": true` in `contents/config/features.json`.
   No restart needed. Chats are stored either way; this is what lets them be
   kept.
2. **Check the settings in Admin → Observability → Chat History.** The page
   edits `platform.json → chats` (and the run ledger's `runLog` block) with
   validation, and shows which of the conditions above currently holds.
   Migration V097 writes the defaults into an existing installation, so the
   section is already there after an upgrade:

```json
{
  "chats": {
    "enabled": true,
    "retentionDays": 90,
    "maxChatsPerUser": 200,
    "maxMessagesPerChat": 2000,
    "temporaryRetentionHours": 24
  }
}
```

| Key                  | Default | Meaning                                                                          |
| -------------------- | ------- | -------------------------------------------------------------------------------- |
| `enabled`            | `true`  | Second switch under the feature flag; `false` makes every new chat temporary     |
| `retentionDays`      | `90`    | Chats whose last message is older than this are deleted by the daily sweep       |
| `maxChatsPerUser`    | `200`   | Chats kept per owner; the oldest beyond the cap are deleted by the same sweep    |
| `maxMessagesPerChat` | `2000`  | Messages kept in one chat; the oldest are dropped on write once a chat is over it |
| `temporaryRetentionHours` | `24` | Hours a temporary chat outlives its last activity; checked every hour      |

The first three limits are switched **off** by a value of zero or less — see
[Retention](#retention). `temporaryRetentionHours` cannot be: a temporary chat
always expires, and a value of zero or less falls back to 24. Migration V179
writes it into an existing installation. What a turn *produced* is stored separately and
configured separately, under `platform.artifacts` — see
[Artifacts](artifacts.md).

3. **Make sure storage is configured.** Chat is the first consumer of the
   storage abstraction, and it does not work without it. The default
   filesystem provider needs no configuration and writes under
   `contents/data/`; anything else is set in `platform.storage` and requires a
   restart.

The client learns the outcome from `GET /api/configs/platform`, which reports
`chats: { persistence, temporaryRetentionHours }` — `persistence` is the
server's own answer to "does this installation keep a chat history", flag and
platform switch and storage readiness together.

An installation that had the old `chatHistoryPreview` flag on does **not** get
the chat history automatically. That flag gated a sidebar list drawn from sample
data, so enabling it said nothing about storing real conversations on the
server; the upgrade logs a warning naming this switch and leaves it off until
an admin turns it on.

## Admin → Chat History

Admin → Observability → **Chat History** (`/admin/chat-history`) is where an
administrator configures and reviews stored chats and the run ledger:

- **Status** — each condition from [How a chat is stored](#how-a-chat-is-stored)
  on its own (feature flag, `chats.enabled`, storage provider), plus whether the
  ledger is recording and whether it is only recording because stored chats
  need it.
- **Stored chats** — kept chats, temporary chats (counted on their own and left
  out of every other figure), messages, users with chats, activity in the last
  24 hours and 7 days, status breakdown, oldest and latest activity, and the top
  apps and users by chat count. Counted from chat metadata only; no transcript
  is read.
- **Next retention sweep** — how many chats the saved rules would remove by age
  and by the per-user limit, and how many chats are at or near the message
  limit. Computed with the same rules the sweep applies.
- **Run ledger** — recorded runs by kind and status.
- **Settings** — `platform.chats` (including the temporary-chat window) and
  `platform.runLog` (enabled, identity mode,
  retention, daily cleanup, spill threshold, flush interval). Changes apply
  without a restart, except `runLog.flushIntervalMs`. Only changed values are
  written, and every save is audit-logged.
- **Run retention now** — applies the saved rules immediately instead of waiting
  for the sweep, under the same guards: expired temporary chats always go, kept
  chats only follow the history rules while the history is on, and the ledger
  is only swept while its cleanup is enabled.

The page warns before a switch to or from `pseudonymized` identity mode, since
that changes the owner id chats are listed under (see
[Ownership and identity](#ownership-and-identity)).

API: `GET /api/admin/chat-history`, `PUT /api/admin/chat-history/settings`,
`POST /api/admin/chat-history/retention/run` (body `{ "target": "chats" | "ledger" | "all" }`).

## The chat history UI

With the feature on, a signed-in user's kept chats show up in three places.
All three read the same list (`GET /api/chats`), and none of them exist when
the chat history is off.

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
- **The Outlook add-in** (and the browser extension's side panel, which shares
  it) — a *Chat history* page and three *Recent chats* on its start page; see
  [In the Outlook add-in](#in-the-outlook-add-in).

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

Opening an app — a plain `/apps/:appId` — always starts a new chat; the
previous one is a click away in the list. As soon as the first message is sent,
the URL switches to `/apps/:appId/c/:chatId` (replacing the history entry), so a
reload keeps the conversation and fetches it back from the store. Without the
chat history there is no list to find a chat in again, so the tab remembers
*which* chat it had per app — its id, never its transcript — and `/apps/:appId`
reopens it from the store. Clearing the chat, or starting a new one, drops the
chat id from the URL and begins a fresh conversation: a kept chat simply stays
in the list, a temporary one is deleted on the way out. The app share link built on a
chat page points at the **app**, never at the one stored chat — a recipient does
not own it and could only get a 404 from it. Handing the conversation itself to
someone is a different thing, with its own audiences, limits and a frozen copy:
see [Chat Sharing](chat-sharing.md).

Editing an earlier message and sending it again rewrites the stored transcript
from that message, the same way it rewrites what is on screen — that is the
`replaceFromMessageId` half of
[The server owns the history](#the-server-owns-the-history). It works on any
message, whether it came back from the store or was sent a moment ago in this
same session: a hydrated message is addressed by its stored id, and one made in
the open session by the exchange id it was sent with, which the store keeps as
`clientMessageId`. Regenerating the answer you just got is the common case, and
without the second form it would leave the superseded exchange in the stored
transcript and grow the conversation by one discarded round per retry.

A chat reopens **the way you left it set up**. The websearch toggle, the tools
you enabled, the style, the output format and the model come
back from the chat rather than from the app's defaults, so a chat you had
turned websearch on for does not quietly answer the next question without it.
Only what the chat actually recorded is restored; everything else falls back
to the app's defaults, and the model is only re-selected if the app still
allows it.

**Reopening a chat mid-answer re-attaches to the turn.** The run may still be
generating — it outlives the browser that started it — so the page replays
what the run ledger already holds and then follows the live stream, rather
than showing the question and waiting. When the turn ends the transcript is
re-read from the store, which is the authority on what the answer finally was.

Leaving a kept chat — opening another one, or closing the tab — does
**not** cancel its turn. That is the whole promise of the feature: the answer
keeps being written and is there when you come back. Only the Stop button
cancels a turn, and it is deliberately unconditional so that it reaches a turn
whose client is already gone. A temporary chat still stops on leaving, or a
generation nobody will ever read would keep billing tokens — but the server does
that when it sees the connection close; the browser never sends a stop of its
own.

### "Answered while you were away"

A turn that finishes with nobody watching — the tab was closed, the laptop shut
— marks its chat `hasUnseenActivity`. That is the whole point of durable runs,
so the list says so:

- in the sidebar, a dot on the row and an **N new** badge next to *Recents* (a
  dot on the clock icon when the sidebar is collapsed),
- on `/chats`, an amber **New** pill on the chat.

Opening the chat is what clears it — reading it through `GET /api/chats/:chatId`
is what "seen" means.

### Still working

A chat is in the list from the moment its turn starts, not from the moment its
answer lands: the client reloads the list on the turn's `run/started` frame,
which the server only sends once the question is stored. For an ordinary answer
that is a few seconds; for a workflow started with `@workflow` it can be many
minutes, and a user who left the chat meanwhile would otherwise never see it
until a reload. While the chat's `status` is `running` the row says so — a
spinner in the sidebar, a **Running** pill on `/chats`.

A chat whose run died with its process — a restart in the middle of a long
workflow — would stay `running` for ever. Listing it or opening it settles it
instead; see [Operational notes](#operational-notes-and-limits).

### Renaming and deleting

Hovering a chat, in the sidebar or on `/chats`, reveals a rename and a delete
button; on a touch screen, where nothing hovers, both are always visible.

- **Rename** turns the title into an input in place. Enter or clicking away
  commits, Escape cancels, and an unchanged or emptied field writes nothing. A
  title set this way is marked as the user's and no later turn derives one over
  it; it is capped at 200 characters. What the row then shows is what the
  server stored, not what was typed — the title is normalized (whitespace
  collapsed, length capped) on the way in.
- **Delete** asks first, in an in-app confirmation, and then erases the chat,
  its transcript and the runs behind it — the cascade described under
  [API](#api). There is no undo. The row disappears immediately, everywhere it
  is listed, and comes back with an error message if the call fails.

Chats the user never renames are titled from their first message.

### In the Outlook add-in

The Outlook task pane reads the same list with its own sign-in token, and it
stores its chats the same way: a conversation started in the pane is a stored
chat like one started in the browser — kept, with the chat history on, so it
shows up in *Recents* and on `/chats` — and it opens in the web app too. The
pane only learns whether chats are kept once `GET /api/configs/platform` has
answered, so an app left open in the pane waits for that answer before it shows
the chat.

Two ways into the history:

- **Chat history** in the pane's menu (start page, apps list and chat) — the
  chats grouped by date, searchable by title and app name, paged with **Show
  older chats**. Its back button returns to the chat it was opened from.
- **Recent chats** at the bottom of the pane's start page — the three most
  recent chats, with an **All chats** link to the page above.

Picking a chat opens it in the pane under its own app. The transcript is
fetched from the store, a turn that is still running is re-attached to, and
the chat's settings (model, tools, websearch) and app variables come back with
it — the same steps as `/apps/:appId/c/:chatId`. Typing carries on from there, with the email
that is open **now** as context. That is the point: a conversation from earlier
in the day — in the browser or in the pane — can inform the reply being
written.

The pane lists only chats whose app it offers. A chat can only be continued
through its own app, so a chat of an app the add-in's
[Available Apps](outlook-add-in.md#step-5--optional-restrict-what-the-add-in-can-access)
leave out, or one the user lost access to, is left out rather than listed as a
dead end. It is still on `/chats`. When the latest chats are mostly in such
apps, the pane reads a few older pages on its own to fill its lists, and past
that leaves it to **Show older chats**.

What is stored for a pane turn is what the store keeps for any turn: what the
user typed, the names of attached files and the answer. The open email reaches
the model as `hostContext` and is not written to the transcript — so a later
turn in that chat, in the pane or in the browser, does not get the earlier
email again. In the pane, the email that is open when the turn is sent goes
with it.

An app marked [`ephemeral`](apps.md) starts temporary chats in the pane too, as
in the web app: they are stored, but never reach the history.

**Open in web app** in the pane's chat menu opens the chat on screen at
`/apps/:appId/c/:chatId` in the browser — the route above, so the web app
fetches, re-attaches and continues it exactly as it would a chat from its own
history. It is the same stored chat under its `office-<uuid>` id, kept or
temporary, not a copy, and it opens with the browser's web session, so for the
user who owns it (or an admin, as any stored chat).
The entry stays greyed out until the server has accepted the chat's first
turn. The pane does not re-read a chat
that was continued in the browser; reopening it from the history does. See
[the Outlook guide](outlook-add-in.md#open-in-web-app).

Opening a different email still starts a new chat in the pane (see
[the Outlook guide](outlook-add-in.md)), and **Restore previous chat** fetches
the one it set aside from the store. With the chat history off the pane's chats
are temporary and it has no history.

### What never appears in the list

Only kept chats are listed, so the [temporary chats](#temporary-chats-and-guests)
are exactly the conversations with no history:

- **Signed-out visitors have no history at all** — no *Recents*, no `/chats`.
  Their chats are stored under a guest identity, as temporary chats.
- **Incognito chats.** With the ghost toggle under the chat input switched on,
  a new chat is created with `ephemeral: true` — a temporary chat — and the
  composer says so. Switching the toggle on in a chat that is already kept
  starts a new, temporary chat (the kept one stays in the history); switching
  it off in a temporary chat keeps that chat, transcript and all. The toggle is
  only offered where there is a history to keep a chat in.
- **Compare panels and the canvas.** Each panel mints its own chat id and a
  single submit fans out to several of them, so both surfaces start temporary
  chats — a comparison never fills the history with half conversations — and a
  compare panel deletes its chat when it is cleared or closed.
- **Every chat, while the history is off.** There is no *Recents* section,
  `/chats` is not found, and the sidebar's search box goes back to reading
  "Search apps". The client decides that from the `chats.persistence`
  capability in `GET /api/configs/platform`, so an installation with the flag
  on but no working store does not show errors either.

## What it costs: runs no longer die with the tab

This is the behaviour change to consent to before switching the feature on.

Three separate paths used to abort a running model call when the client went
away: the SSE `onClose` handler, a failed write to the SSE socket, and the
five-minute inactivity sweep that evicts a stream whose heartbeat stopped. All
three now go through `abortChatRequestOnDisconnect()`, which leaves a **durable**
turn — one of a kept chat — running to completion.

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
  happen. It is also the *only* thing in the UI that stops a turn: opening
  another chat, reconnecting, timing out, sending a follow-up and leaving the
  page release this tab's stream (`detachEventSource`) without asking the server
  to stop, because a persisted turn whose client is gone is precisely the turn
  durability is for. The request carries the control that sent it (`source`),
  and the run records it — see [Who stopped a turn](#who-stopped-a-turn).
- **The model's own output cap** (`maxOutputTokens`) and the agent loop's round
  cap, unchanged.
- **A server restart**, which is not a graceful stop — see
  [Operational notes](#operational-notes-and-limits).

### Who stopped a turn

Every abort of a turn carries a cause (`server/services/chat/abortCause.js`),
passed as the reason of the turn's `AbortController` and relayed to the worker
running it: what stopped it (`user_stop`, `run_stop`, `task_run_cancelled`,
`task_deleted`, `task_disabled`, `chat_deleted`, `user_deleted`, `superseded`,
`client_disconnected`, `client_evicted`, `api_client_closed`, `lease_lost`), the
actor (a user, an administrator or the system), the code path that decided and
the control that asked, the worker, and the time. An abort without a cause is
recorded as `unknown`.

The cause is on the ledger's `run/end` and on `run/ended`, on the stored
assistant message (`error: { code: 'ABORTED', message, cause }`), on a scheduled
run's `reason.cause`, and in one server log line per stop (`Chat stop requested`,
`Aborted request`) that also has the request's IP and user agent — those two are
never stored. The actor id goes through the identity mode of what was stopped
(the chat's, the task's, the run's), so a pseudonymized chat or task never
carries a raw user id. When the person who stopped it is the owner, the cause
says so (`actor.owner`), so the owner reads "you" even where the id is a
pseudonym the browser cannot match to its own.

A shared chat keeps only the explanation of a stop (`kind` and `message`): the
actor, the code path and the worker stay with the owner, in the snapshot and in
what a viewer receives. A follow-up message supersedes a turn still running on
another worker of a cluster; the relayed abort names the moment the new turn
started, so a late arrival never cancels it.

Only kept chats' turns are protected. A temporary chat's turn — an anonymous
visitor's, an incognito one, any while the history is off — is aborted on
disconnect exactly as before, so the extra spend is bounded to authenticated,
non-incognito chats on an installation that opted in.

## Stored chats turn on the run ledger

A chat turn is materialized alongside the run's own events, and the ledger is
where a run's user message, assistant message and usage are recorded. So
`RunLog.isEnabled()` returns true whenever a storage provider is up — every
chat is stored, kept or temporary — **regardless of the `runLog` feature flag
and even when `platform.runLog.enabled` is `false`**. The ledger then records
every run, not only chat turns. The `runLog` flag has correspondingly lost its
"preview" marking.

Every installation therefore accepts everything in the
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
  sweep takes its runs with it — a temporary chat's runs go when it expires.
- `platform.runLog.identityMode` now decides who owns a chat, not only who owns
  a run. See [Ownership and identity](#ownership-and-identity).

Stored chats also add the one ledger event nobody was producing: a real
`message/user` for the human turn. Without it a run recorded every answer and
none of the questions.

## Temporary chats and guests

**A temporary chat is a chat like any other**, with `temporary: true` on its
document. The turn that creates it decides, from
[How a chat is stored](#how-a-chat-is-stored); nothing changes it afterwards
except `PATCH /api/chats/:chatId { "temporary": false }`, which keeps it — for
an owner who can keep a history: a signed-in user on an installation with the
Chat History feature on. A guest's chats are always temporary. Until then,
sharing it answers 409 `CHAT_TEMPORARY` and so does moving it into a project.
It is:

- **never listed** — `GET /api/chats` filters it out, the project page does not
  show it even when it runs in a project (it still gets the project's
  knowledge), and it sets no unseen badge anywhere;
- **never shared** and never counted against `maxChatsPerUser`;
- **deleted** `chats.temporaryRetentionHours` after its last activity by the
  hourly sweep — whether or not the history is on — and straight away when the
  user leaves it in the web app (New chat, Clear, a compare panel cleared or
  closed, a new canvas chat);
- readable by its owner by id (`GET /api/chats/:chatId`), which is what lets a
  reload, a re-attach and "Open in web app" work; and by an admin, like any
  stored chat, until it is gone.

`ephemeral: true` in the chat POST body is what asks for one. It is
client-asserted and therefore advisory — it can only ever make a new chat
temporary, never keep one. The incognito toggle sends it, and so do the compare
panels, the canvas and every surface of an app marked `ephemeral`.

**Anonymous visitors own their chats through a guest identity.** The run
principal cannot do it: `resolvePrincipal` mints a fresh random `anon-<hex>` id
on every call, on purpose. Instead, the first API request of an anonymous
visitor that carries no guest cookie gets one — `ihubGuest`, 32 random bytes,
HttpOnly, `SameSite=Lax`, `Secure` behind HTTPS, kept 30 days
(`services/chat/chatOwner.js`). A guest's chats are stored under
`guest-<sha256 of the cookie>`, so neither the document nor a log line carries
the secret, and a request without the cookie matches no guest chat (404).
Guests own temporary chats only: they can read, stop and delete their own, and
never list. The realtime transcription WebSocket reads the same cookie off its
upgrade request.

One limitation: an anonymous chat inside a cross-site iframe whose browser
blocks third-party cookies gets no guest cookie back, so its second turn is
somebody else's chat. The turn answers `404` with
`code: "GUEST_COOKIE_MISSING"` — the request came without a guest
cookie and the chat exists — and the chat UI says why. Signed-in embeds
(Outlook, Nextcloud, Teams, the browser extension) authenticate with tokens and
are unaffected.

## The server owns the history

Every chat's source of truth is the store, not the browser. The chat POST has
one shape:

- The request must carry **exactly one** message, the new one. More than one is
  rejected with `400 { "error": "CLIENT_HISTORY_NOT_ALLOWED" }`, whatever the
  caller, the chat history setting or `ephemeral` say. A client can no longer
  rewrite what it already said, or replay a history it edited locally.
- The server reads the stored transcript, drops the bookkeeping (ids, usage,
  errors, attachment descriptors) and empty turns, appends the new message, and
  hands that to the request builder.
- `replaceFromMessageId` truncates the stored history from that message
  (inclusive) before the append — the server-side form of "edit this message and
  regenerate". It matches either the stored message id or the `clientMessageId`
  the message was stored under, because a client only learns the stored id by
  hydrating and a turn it sent a moment ago has never been through that. An id
  that matches neither is `400 UNKNOWN_MESSAGE`, never a silent append onto the
  untouched history.
- An app with `sendChatHistory: false` still gets only the new message. Storing
  a transcript must not start feeding it to a one-shot prompt.
- `sendChatHistory: false` in the body says the same thing for one turn — the
  viewer's "Include chat history in requests" setting. A turn posts one message
  either way, so it needs a field. Like the app-level flag it can only ever
  remove history, never add it.

An `@workflow` mention is a turn like any other: the question is stored before
the workflow launches — and before its `run/started` frame, as for an ordinary
turn — and the answer, or the failure, or the cancellation, is stored when the
run settles, under the workflow's run id, with the steps the workflow went
through (see [What a turn did](#what-a-turn-did)). The launch does not go
through the chat service, so both halves are written by the route. The chat is
named after the question without the mention, or after the workflow for a bare
mention.

The mention only starts a workflow the app lists (`app.workflows`) and the
caller's groups grant — the same rule the composer's picker applies
(`services/workflow/workflowAccess.mentionAccess`). A workflow the caller may
not run leaves the mention as ordinary text; one the app does not list is
refused with `WORKFLOW_UNAVAILABLE`.

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
- Admins may read any chat, matching `runAccess`. Ownership is checked first:
  an admin opening their own chat is its owner reading it (the unseen badge
  clears), and only a read of somebody else's chat rests on the bypass — that
  one never clears the owner's badge, because the owner has not seen anything.

The owner id is the run principal in `platform.runLog.identityMode` (`default`,
`full` or `pseudonymized`), resolved once at the start of the turn — or, for an
anonymous visitor, its [guest identity](#temporary-chats-and-guests). The mode is
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
  settings,             // how the chat is being answered — see below
  variables?,           // the app variables the chat was given — see below
  title, titleSetByUser,
  createdAt, lastMessageAt,
  messageCount,
  activeRunId,          // the run producing right now, null between turns
  hasUnseenActivity,    // an answer landed with nobody watching
  status,               // 'active' | 'running' | 'error'
  temporary?,           // true for a chat that is not kept — see Temporary chats
  runIds: [],           // most recent 200, for the delete cascade
  origin,               // { createdVia: 'ui' | 'responses-api' | 'scheduled-task',
                        //   clientId?, authMode?, taskId?, runId?, taskName? }
  // Chats made through the inference API's Conversations API also carry:
  metadata?,            // the conversation's caller-defined key/value pairs
  binding?              // 'app' | 'model' — what the first response bound it to
}

// chat-messages/<chatId>
{
  version: 1,
  messages: [
    { id, role, content, ts, runId,
      clientMessageId?, usage?, finishReason?, error?, attachments?, artifacts?,
      mcpApps?, sources?,
      // inference API turns: on a user message the variables it was rendered
      // with and the rendered text the model saw; on an answer the validated
      // structured output and the model identifier that produced it
      variables?, renderedContent?, output?, model? }
  ]
}
```

On the filesystem provider that is `contents/data/chats/<chatId>.json` and
`contents/data/chat-messages/<chatId>.json`, with the owner index beside them.
What a turn produced lives in its own store under the scope
`{ type: 'chat', id: chatId }` — see [Artifacts](artifacts.md).

They are split because the chat list reads N metadata documents and zero
transcripts. Folding the messages in would make "show my chats" read every
message the user ever wrote.

Details that matter:

- **Message ids are server-minted** (`crypto.randomUUID()`). The client's own
  exchange id is kept as `clientMessageId` so an optimistic render can be
  reconciled instead of duplicated.
- **`settings` is a closed set, and it merges.** Each turn records how it was
  answered — `style`, `outputFormat`, `sendChatHistory`, the
  three `thinking*` fields, `enabledTools`, `websearchEnabled`,
  `imageAspectRatio`, `imageQuality` — and nothing else: these arrive in a
  request body and are read back for the life of the chat, so an open-ended
  blob would let a client store anything under a key the server never checks.
  Values of the wrong type are dropped rather than coerced, strings are capped
  at 64 characters and `enabledTools` at 64 entries. A turn merges over what
  earlier turns recorded, because a surface only sends the toggles it
  surfaces: flipping websearch must not erase the style the chat was started
  with. `modelId` is kept alongside rather than inside, since it has its own
  field.
- **`variables` is the app's variables, and it replaces.** A turn that sends
  variables sends the whole set — an app's variables panel does so on every
  message, a [start form](apps.md#start-form) once — and that set replaces the
  stored one. A turn that sends none gets the stored set for the system prompt,
  which is how a follow-up after a start form, or a chat reopened later, keeps
  the values it was started with; the app's `prompt` template is not rendered
  into such a turn. Reopening the chat puts the values back in the variables
  panel. Names must be valid variable names, values are stored as text capped
  at the message length, at most 50 of them; the field is absent until a turn
  sets it. The inference API's Conversations API keeps a conversation's
  variables in the same field, so a chat carries its values between the chat
  UI and the API.
- **Attachments are descriptors** — `{ type, name?, bytes? }`. The base64 payload
  of an upload stays in the request; it is never written into a document that is
  read back for as long as the chat lives.
- **So is what a turn produced** — `{ id, kind, mimeType, bytes }`, with the
  payload in the shared artifact store. See [Artifacts](artifacts.md).
- **What an answer found is stored with it** — `sources: { items, queries }`:
  every web page, document and record the turn's searches, page reads, tools,
  iAssistant or provider search reported, in the one shape of
  [Answer Sources](answer-sources.md), and what the turn searched for — at
  most 100 sources (passages capped at 4,000 characters) and 30 queries, 256 KB
  per answer, passages dropped first when that is exceeded. The citation
  markers are part of the stored text (Google's are written into it when the
  answer is stored), so a reopened chat draws the same sources panel, citation
  badges and actions. Documents are fetched again with the reader's own
  permissions. A share carries only the public sources — see
  [Chat Sharing](chat-sharing.md#what-is-shared--and-what-is-not).
- **Answers stored before the sources contract** kept their documents in
  `citations` and their web sources in `webSearch`. Neither is read any more:
  such answers keep their text and links, without a sources panel, and a share
  never carries `citations`.
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
- **Chats made through the API are ordinary chats.** A conversation of the
  inference API's [Conversations API](openai-compatible-api.md#conversations-api)
  is a chat of its caller (for an OAuth client, the client), listed in the chat
  history with `origin.createdVia: 'responses-api'`. Unlike a UI turn, which
  supersedes a turn still running, an API turn on a busy chat is refused
  (`409`).

## API

The listing and `PATCH` require a real authenticated user (`authenticatedOnly`).
Reading one chat, its artifacts and `DELETE` take `authRequired` instead, so an
anonymous visitor reaches the temporary chats of its guest identity — and
nothing else. Those that address a chat validate the id before it reaches
storage and answer 404 for both an unknown chat and someone else's. All of them are rate limited
with the other public API prefixes (500 requests/minute/IP by default).

| Method & path            | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `GET /api/chats`         | The caller's kept chats, most recent activity first. `?limit` (default 30, max 100) and `?cursor` |
| `GET /api/chats/:chatId` | `{ chat, messages, version }` — the transcript, and clears `hasUnseenActivity` |
| `GET /api/chats/:chatId/artifacts` | What this chat's turns produced, newest first, as descriptors |
| `GET /api/chats/:chatId/artifacts/:artifactId` | The bytes of one artifact, as its own media type |
| `PATCH /api/chats/:chatId` | `{ title }` — rename; capped at 200 characters and marked as user-set. `{ temporary: false }` — keep a temporary chat (there is no way back; not combinable with `projectId` or `attachedProjectIds`) |
| `DELETE /api/chats/:chatId` | Erase the chat, its transcript and its runs                             |

`GET /api/chats` returns the chat documents exactly as stored. App name, colour
and icon are joined on the client from the apps list it already holds, so the
endpoint stays independent of app configuration.

`DELETE` cascades: the two documents, every artifact of the chat, then
`runLog.deleteRun()` for every id in the chat's `runIds`, which in turn removes
each run's ledger file, its spill directory and its pending interactions. The
chat document is the only place a chat's runs are written down, which is why it
is read before it is deleted.

When the chat history is unavailable — the flag is off, an admin set
`chats.enabled: false`, or the storage provider did not come up — the listing
and `PATCH { temporary: false }` answer `503` with
`details.code = "CHAT_PERSISTENCE_UNAVAILABLE"` rather than 404, so a client can
tell "not configured" from "not found" and hide the history. Reading, the
artifacts, `DELETE` and every other `PATCH` (rename, projects) answer as long as
storage is up: they are what temporary chats need.

## What a turn produced

A picture the model drew used to survive nothing: the client stripped the
payload before writing the transcript to `sessionStorage` — an image is
megabytes and the quota is a few — so navigating away left the answer with an
empty space where the image had been. A stored chat keeps them.

It is not stored here. Anything a turn produces that is content in its own
right goes to the shared **[artifact store](artifacts.md)** under the scope
`{ type: 'chat', id: chatId }` — the same store a workflow's report or an
agent's output belongs in — and the message keeps only a descriptor:

```js
{ id: '7f3c…', kind: 'image', mimeType: 'image/png', bytes: 1483204 }
```

That is what keeps opening a chat fast: the transcript a later turn re-reads
and re-hashes carries descriptors, not megabytes, and the bytes are fetched per
artifact when the message is rendered.

What this chat is responsible for:

- **Recording the descriptors.** `chatMaterializer.storeGeneratedArtifacts`
  turns the loop's `summary.images` into artifacts of kind `image` and puts the
  descriptors on the assistant message. One the policy refuses is still
  described, as `{ kind, mimeType, bytes, unavailable }`, and the chat shows a
  note in its place — dropping it silently would leave the viewer who watched
  three pictures appear and came back to two unable to tell a discarded
  artifact from one the model never produced.
- **Saying when they go.** They are emptied with the chat, and dropped when the
  messages naming them leave the transcript — an edit that rewrites history
  from a message, or `maxMessagesPerChat` pushing one out.
- **Authorizing them.** `GET /api/chats/:chatId/artifacts[/:artifactId]` runs
  the same `authorizeChat` as the transcript, so an artifact id is never a
  capability on its own.

Caps, kinds, media types and the master switch are the store's, not the chat's:
see [Artifacts](artifacts.md).

Every chat is stored, so every chat keeps its pictures — a temporary chat's go
with it when it expires.

## What a turn did

A stored answer used to keep its text and nothing of how it came about, so a
user coming back to a chat — or anyone reviewing it later — could not tell which
searches ran, what they found, which tools were called or which steps a
workflow went through; and the badge under a web-search or iFinder answer read
"Based on AI knowledge". Live, all of that is on screen beside the answer. The
stored answer now carries the same thing as `activity`:

```js
{
  toolActivity: { items: [{ kind: 'search', scope: 'web', query, status, sources, details, durationMs, … }] },
  searchSummary: { queries, totalHits, rounds, applications, sources },  // iAssistant
  activeSkills: [{ name, description }],
  answerSource: { sources: ['websearch', 'ifinder'] },                    // the badge (`['llm']`: the model's own knowledge)
  workflowSteps: [{ nodeName, nodeType, status }],
  workflowResult: { status, executionId, workflowName },
  outputFormat: 'markdown'
}
```

It is one projection for both moments. `shared/run/runActivity.js` builds it
from a run's state, and `shared/run/runReducer.js` folds a run's SSE v2 frames
into that state — the client for the live message, the server for the stored
one (`services/chat/runActivity.js` taps `RunStreamEmitter.emit`, which every
frame passes whether or not a browser is connected). The reopened answer
therefore shows what the live one showed, in the same components.

- **Recorded:** the turns of a persisted chat, and the workflow runs a tool
  started inside them. The answer text, reasoning and pictures are not — the
  transcript and the [artifact store](artifacts.md) hold those.
- **Bounded** before it is stored (`boundStoredActivity`): 100 calls, 50 sources
  per call, 200 workflow steps (the last ones), 2000 characters per value and
  256 KiB in all, past which the full text of long arguments goes first.
- **Shared chats** carry it without anything a call found or read with the
  owner's permissions — the reason a share keeps only public sources. Only the public
  web searches (Brave, Qwant, Staan, a model's own web search) keep their hits;
  every other call keeps its name, query and status (`shareableActivity`),
  pages read by the page reader included, as it can reach intranet hosts on the
  SSL whitelist.
- **The workflow result links its execution.** A finished workflow in the chat
  links to `/workflows/executions/:id`, which keeps every step and its output.
  In the other direction, a chat-launched execution records its chat on its
  ledger run (`refs.chatId`, `refs.appId`), so **My Executions** and the
  execution page link back to the chat.

The badge is what the server named on `run/ended` (see
[SSE v2](sse-v2.md#a-chat-turn-on-the-wire)), never inferred in the browser from
the rest of the message: answers stored before this existed have no `activity`
and show no badge, because nothing recorded what they were based on.

**Chat with Results** on a finished execution creates a stored chat the same
way (`POST /api/workflows/executions/:executionId/chat/:appId`): the execution's
input is the question, its output the answer, read from the execution rather
than posted by the browser, with the workflow result attached. The chat has a
turn of its own, so deleting it does not cascade to the execution.

## Retention

A sweep applies three rules, all read fresh from `platform.chats` on every tick
so an admin's change takes effect without a restart:

- **Temporary** — a temporary chat whose last activity is older than
  `temporaryRetentionHours` (24, at most 720) is deleted. Checked every hour,
  whether or not the history is on, and it never touches a kept chat.
- **Age** — a kept chat whose last message is older than `retentionDays` (90)
  is deleted.
- **Count** — an owner keeps their `maxChatsPerUser` (200) most recently active
  kept chats; the rest are deleted, oldest first. Temporary chats count against
  no quota.

The age and count rules are the history rules: they run at most once a day.

Set either to **zero or less to disable that rule**: `retentionDays: 0` keeps
chats until someone deletes them, `maxChatsPerUser: 0` removes the per-user cap.
Disable both and the sweep skips its scan entirely.

Chats a [scheduled task](scheduled-tasks.md) run created
(`origin.createdVia: 'scheduled-task'`) do **not** count toward
`maxChatsPerUser` — a task that runs every quarter hour would otherwise push its
owner's own conversations out. They have their own cap instead: each task keeps
its newest `scheduledTasks.maxRunChatsPerTask` (20) run chats. The age rule
applies to them like to any other chat.

Every removal is the same cascade `DELETE /api/chats/:id` performs, ledger runs
included. No rule removes a chat a turn is still producing into, here or on
another worker; one a restart left `running` with nothing behind it expires as
usual. The rule is judged again under the chat's lock right before the delete,
so a chat kept, written to or started since the scan stays. The sweep runs once at startup — so a misconfigured retention shows up
in the log at boot rather than later — then every hour, on the cluster
singleton worker that already owns the run-ledger cleanup, and never in parallel
with itself.

Turning the chat history off (the feature, or `chats.enabled: false`) **stops**
the history rules. Disabling the feature is not a request to purge what is
already kept; delete the documents deliberately if that is what you want.
Temporary chats keep expiring either way.

## Operational notes and limits

- **A restart mid-turn interrupts the turn.** A durable run lives in the worker
  that started it. If the process goes away before the turn finishes, nothing
  writes its answer, and the chat stays `status: 'running'` with an
  `activeRunId` no process holds. There is no resume. Listing or opening such a
  chat settles it (`services/chat/chatRecovery.js`): it stores an answer with
  the error `RUN_INTERRUPTED` and whatever the run's ledger still knows of what
  it did — the tool calls and what they found; the live-only frames such as
  workflow steps are not in the ledger — appends the missing `run/end` to the
  ledger, and releases the chat. An `@workflow` turn is closed by what its
  execution says: one paused at a human checkpoint is still continued from its
  execution page, so the chat says it is waiting for input and its run stays
  open; a completed one's answer is delivered from the execution; a cancelled
  one is stored as stopped. Once a waiting workflow is continued and ends, the
  next open of the chat puts its answer — or its failure or stop — in place of
  "waiting for input" (`deliverResumedWorkflows`), ahead of anything asked
  after it. Chat-launched executions left running are marked failed by the
  boot-time orphan sweep, as they are never resumed — unless another worker
  still runs them (its chat bridge or ledger run is present there). A run counts
  as dead only when no worker holds it: its ledger run is neither open nor
  recently ended on this worker nor owned by another, no request, durable turn
  or bridged workflow is in flight for the chat, and it claimed the chat more
  than two minutes ago. The liveness signals are those of one host: two
  installations sharing one store are not supported (see the filesystem
  provider below), and recovery would treat the other host's live runs as dead.
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
- **Failures are loud.** A storage error during materialization is logged at
  `error` and does not fail the turn: the user still gets their answer, the
  operator still sees that it was not stored. A storage provider that fails to
  come up at boot logs one error, and every chat turn then answers
  `503 CHAT_STORAGE_UNAVAILABLE` until it is fixed — there is no browser-held
  fallback to degrade to.

## Code map

| File                                        | Responsibility                                              |
| ------------------------------------------- | ------------------------------------------------------------ |
| `server/storage/bootstrap.js`               | Brings the provider up per worker; `getStorage()` may be null |
| `server/services/chat/chatPersistence.js`   | The policy — the only module that decides kept or temporary   |
| `server/services/chat/chatOwner.js`         | Who owns a chat: the run principal, or an anonymous guest     |
| `server/services/chat/ChatRepository.js`    | The two chat documents, their locks, listing and the cascade  |
| `server/services/artifacts/ArtifactRepository.js` | What a turn produced — see [Artifacts](artifacts.md)    |
| `server/services/chat/chatMaterializer.js`  | The only module that writes chat turns                        |
| `server/services/chat/runActivity.js`       | Records what a turn did and bounds it for storage             |
| `shared/run/runActivity.js`                 | The activity projection, shared with the live client view     |
| `server/services/chat/chatRecovery.js`      | Settles chats whose run died; delivers continued workflows    |
| `server/services/workflow/executionChat.js` | Chat with Results: a stored chat about an execution           |
| `server/services/chat/chatAccess.js`        | `authorizeChat()` — 404 for unknown and not-yours             |
| `server/services/chat/chatRetention.js`     | The daily sweep                                               |
| `server/routes/chats.js`                    | The `/api/chats` surface                                      |
| `server/sse.js`                             | The durable-chat registry and the disconnect guard            |

```bash
npm run test:chat
```
