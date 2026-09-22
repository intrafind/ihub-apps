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

## Web Search: Research in Several Steps

With web search turned on, the assistant now researches a question in several steps instead of
answering after a single search: it breaks the question into parts, searches several times with
different wording, checks key claims against more than one source and combines the findings into
one answer with source links.

- Applies to every app with web search, whenever web search is on for the conversation. With web
  search off nothing changes.
- Admins can turn it off or replace the instruction with their own text per app under
  **Admin → Apps → Edit App → Web Search → Research in Several Steps**
  (`websearch.researchGuidance`).
- The default **Web Chat** prompt was reworded to match. It is updated on upgrade only where it is
  still the shipped default; a prompt you changed is kept.
- With Gemini's built-in Google Search, the instruction only steers how Gemini uses its own search.
