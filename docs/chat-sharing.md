# Chat Sharing

A stored chat can be handed to other people as a **read-only link**. The
recipient sees the conversation as it was when it was shared, the tool
activity and citations that came with it, and can view or download the
artifacts it produced. They cannot type into it, edit it, rate it or continue
it.

Sharing rides on [Chat Persistence](chat-persistence.md): only a durable chat
can be shared, because a link needs something stored to point at. It ships
**dark** behind its own feature flag, and an administrator decides which
audiences an installation offers.

## Three audiences

| Mode            | Who can open the link                                   | Sign-in    |
| --------------- | ------------------------------------------------------- | ---------- |
| `users`         | Only the users the owner picked from the user database  | required   |
| `authenticated` | Anyone who has the link and an account here             | required   |
| `public`        | Anyone who has the link                                 | none       |

- **Specific users** are picked by name or e-mail from the user database
  (`contents/config/users.json`, which holds local accounts and the external
  OIDC/LDAP/NTLM users that have signed in before). Someone who has never
  signed in is not in that database and cannot be picked; share with
  _anyone signed in_ instead. Recipients are **not notified** — they find the
  chat under **Shared with me** on the `/chats` page, or get the link from the
  owner.
- **Public** links open without a sign-in, also on an installation that has
  anonymous access switched off. Creating one shows a warning the owner has to
  acknowledge: anyone with the link can read the conversation and download
  its generated files until the link is revoked or expires, the link can be
  forwarded, and it must not carry internal or personal data. Public pages
  are sent with `X-Robots-Tag: noindex, nofollow`.

The owner may always open their own link in every mode, to check what they
are about to send, and an administrator may read any link the way they may
read any chat. Neither of those opens counts as a view.

## What is shared — and what is not

A share is a **snapshot**. The messages are copied when the link is created,
and the link never shows anything newer: later turns, and an earlier message
that was edited and regenerated, stay in the live chat only. For a newer state
the owner creates another link.

| Included                                                        | Not included                                         |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| User and assistant messages, tool activity, sources, citations  | Messages sent after the share, edits made after it   |
| **Artifacts** the shared messages produced (generated images)   | Artifacts of later turns or edited-away exchanges    |
| The name, type and size of an uploaded file                     | **The uploaded file itself** — it is never stored    |

Uploads deserve the explicit note: a stored message carries an attachment
only as `{ type, name, bytes }` (see
[Chat Persistence](chat-persistence.md#the-data-model)), the payload stays in
the request that carried it. The viewer therefore shows _Attachment not
included: plan.pdf_ where the owner saw the file.

Artifacts are **not copied**. The artifact store is write-once and keyed per
chat ([Artifacts](artifacts.md)), so the snapshot records the artifact ids its
messages carry, and the share routes serve exactly those ids out of the
chat's scope. Everything else in the scope answers 404 through the share.

## Limits, tracking and revocation

Every link can carry an **expiry** and a **maximum number of opens**. A link
past either behaves exactly like a revoked one.

**Views are tracked.** Every successful open by someone other than the owner
or an admin increments the link's counter, records when it happened and — for
a signed-in viewer — who opened it. For a `users` share the owner sees per
recipient whether and when they opened it. Artifact views and downloads do
not count.

**Revoking** is immediate: `DELETE /api/shares/:shareId` by the owner (or an
administrator from Admin → Chat History) closes the link, and the record stays
in the owner's list marked _Revoked_. Deleting the chat deletes its shares and
their snapshots, as does the retention sweep.

A viewer cannot tell the reasons apart. Unknown, revoked, expired and used-up
links all answer **404** and show one _This link is no longer available_
page. The single other answer is **401** for an anonymous visitor on a link
that needs a sign-in — the client then sends them to the login page and back.

Creating a share, creating a public share and revoking one are written to the
audit log (Admin → Audit Log, `resource: chatShare`).

## Enabling

1. Turn on **Durable Chats** and **Chat Sharing** under Admin → Platform →
   Features (or `"chatPersistence": true, "chatSharing": true` in
   `contents/config/features.json`). No restart needed.
2. Check **Admin → Observability → Chat History → Chat sharing**. The section
   edits `platform.json → chats.sharing` with validation and shows whether
   links can currently be created. Migration V128 writes the defaults into an
   existing installation:

```json
{
  "chats": {
    "sharing": {
      "enabled": true,
      "allowUsers": true,
      "allowAuthenticated": true,
      "allowPublic": true,
      "defaultExpiryDays": 0,
      "maxExpiryDays": 0,
      "maxViewsCap": 0
    }
  }
}
```

| Key                  | Default | Meaning                                                                                   |
| -------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `enabled`            | `true`  | Second switch under the feature flag; `false` stops new links and closes existing ones     |
| `allowUsers`         | `true`  | Offer links addressed to picked users                                                     |
| `allowAuthenticated` | `true`  | Offer links for anyone signed in                                                          |
| `allowPublic`        | `true`  | Offer public links; the usual switch to turn off on an installation that must not leak    |
| `defaultExpiryDays`  | `0`     | Expiry a new link gets when the owner picks none; `0` means none                          |
| `maxExpiryDays`      | `0`     | Longest expiry an owner may pick; with a cap, _never_ is no longer offered; `0` = no cap  |
| `maxViewsCap`        | `0`     | Most opens an owner may allow; with a cap, _unlimited_ is no longer offered; `0` = no cap |

The caps are enforced server-side on create, whatever the form sent. The
client learns the effective settings from `GET /api/configs/platform`, which
reports `chats.sharing: { enabled, modes, defaultExpiryDays, maxExpiryDays,
maxViewsCap }` and hides what is not offered.

The same admin page shows how many shares exist, in which state and for which
audience, lists the newest ones, and lets an administrator revoke any of them.

## Using it

- **Share chat** in the header of a durable chat (`/apps/:appId/c/:chatId`)
  opens the dialog: pick the audience, the recipients for a `users` share, an
  expiry and an open limit, acknowledge the warning for a public link, and
  copy the URL. Below the form every link of this chat is listed with its
  state, its opens and — per recipient — whether it was opened, each with a
  **Revoke** button.
- The link is `/share/<id>`. The page renders outside the application shell,
  so it works for a visitor who has no account, and carries the app's name and
  icon, the chat title, a _Read-only_ badge and, for a public link, a banner
  saying so.
- **Shared with me** on `/chats` lists the `users` shares addressed to the
  signed-in viewer, with a _New_ badge until they open one.

## API

| Method & path                                    | Who        | Purpose                                                   |
| ------------------------------------------------ | ---------- | --------------------------------------------------------- |
| `POST /api/chats/:chatId/shares`                 | owner      | Create: `{ mode, recipients?, expiresAt?, maxViews?, showOwnerName? }` |
| `GET /api/chats/:chatId/shares`                  | owner      | This chat's shares with their state and view counts       |
| `GET /api/shares/with-me`                        | signed in  | `users` shares addressed to the caller that still open    |
| `GET /api/shares/:shareId`                       | per mode   | The snapshot and the display fields; counts as a view     |
| `GET /api/shares/:shareId/artifacts`             | per mode   | Descriptors of the artifacts the snapshot references      |
| `GET /api/shares/:shareId/artifacts/:artifactId` | per mode   | The bytes; `?download=1` sets `Content-Disposition: attachment` |
| `DELETE /api/shares/:shareId`                    | owner/admin| Revoke                                                    |
| `GET /api/users/lookup?q=`                       | signed in  | Recipient picker: at most ten `{ id, name, email }`, never the caller |
| `GET /api/admin/chat-history/shares`             | admin      | The newest shares across the installation                 |
| `DELETE /api/admin/chat-history/shares/:shareId` | admin      | Revoke any share                                          |

The owner routes answer `503 CHAT_SHARING_UNAVAILABLE` while sharing is off or
storage is down; the viewer routes answer 404. Creating a share authorizes the
chat with **write** intent, so an administrator reading a chat for support
cannot publish it.

A viewer's response carries only what the page renders: never the chat id,
the owner's id or e-mail, the other recipients or the per-view log.

## Storage

Three documents per share, in the [storage provider](storage.md):

```
chat-shares/<shareId>               mode, recipients, limits, counters, revokedAt
chat-share-messages/<shareId>       the frozen transcript
chat-share-recipients/<shareId>.<h> one marker per recipient of a `users` share
```

The share document is filed under the **chat id** as its document owner, so
the owner's list and the delete cascade are index reads; the recipient
markers are filed under the recipient's user id, so _Shared with me_ is one
too. The share id is `shr_` plus 24 random bytes (192 bits) in base64url — a
capability in `public` mode, and never derived from the chat id, which is
client-minted and enumerable.

## Code map

| File                                                | What it holds                                               |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `server/services/chat/chatSharing.js`               | Policy: settings, allowed modes, caps, share state          |
| `server/services/chat/ChatShareRepository.js`       | The three documents, views, revoke, cascade                 |
| `server/services/chat/chatShareAccess.js`           | Who may open a link                                         |
| `server/routes/chatShares.js`                       | The routes above                                            |
| `server/routes/admin/chatHistory.js`                | Settings, stats, admin list and revoke                      |
| `client/src/features/chat/components/ShareChatModal.jsx` | The share dialog                                       |
| `client/src/features/chat/pages/SharedChatPage.jsx` | The read-only page at `/share/:shareId`                     |
| `client/src/auth-gate/auth-gate.js`                 | Lets `/share/*` load without a sign-in; the server decides  |
| `server/tests/chat-persistence-shares.test.js`      | Access matrix, snapshot, allow-list, limits, cascade        |
