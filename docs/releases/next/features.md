# Features — Unreleased

## Admin: Chat History Page

Admins can now configure and monitor durable chats and the run ledger in **Admin → Observability →
Chat History**, without editing `platform.json`.

- **Status** shows each condition that decides whether chats are stored (Durable Chats feature,
  chat storage switch, storage provider) and whether the run ledger is recording.
- **Stored chats** shows chats, messages, users with chats, recent activity, top apps and top
  users — plus how many chats the next retention sweep would remove and how many are at or near
  the per-chat message limit.
- **Settings** cover chat retention (days, chats per user, messages per chat) and the run ledger
  (enabled, identity mode, retention, daily cleanup, advanced write settings). Changes apply
  without a restart, except the ledger flush interval, and every save is audit-logged.
- **Run retention now** applies the saved rules immediately instead of waiting for the daily
  sweep, after a confirmation.
- The page warns before switching the identity mode to or from pseudonymized, because chats stored
  before the switch drop out of their owners' history lists.
