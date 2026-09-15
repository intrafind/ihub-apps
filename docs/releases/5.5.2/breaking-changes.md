# Breaking Changes — 5.5.2

## Durable Chats Change What `POST /api/apps/:appId/chat/:chatId` Accepts

This one is **opt-in**: it applies only once an admin enables the **Durable Chats**
(`chatPersistence`) feature, which is off by default and is not turned on by any migration.

With it on, the server owns the conversation for an authenticated caller on a turn that is not
`ephemeral`. The request must then carry **only the new message** — a `messages` array of more
than one element is refused with HTTP 400 and `CLIENT_HISTORY_NOT_ALLOWED`, with a `details.hint`
naming both ways forward. The server reads the prior turns back out of the store, which is what
lets a conversation survive a reload, a new device or a lost connection, and what stops a client
rewriting what it already said.

The first-party UI does this already and needs no change. Third-party integrations that post the
whole history — the shape [`docs/oauth-api-examples.md` §3g](../../oauth-api-examples.md) showed —
have two options:

- **Post only the new message.** The conversation is then stored and reloadable, which is the
  point of the feature.
- **Send `"ephemeral": true`** and keep posting the whole array as before. That turn is not
  stored, and the endpoint behaves exactly as it did in 5.4.

Anonymous callers, ephemeral turns and installations with the feature off are unaffected.

**Before enabling:** check any integration that posts conversation history against one of the two
options above. Turning the feature off restores the old behaviour for every caller.
