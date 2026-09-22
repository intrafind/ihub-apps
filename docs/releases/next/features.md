# Features — Unreleased

## Web Search: The Model Can Open and Read Pages

Apps with web search can now open a page, not just search. When web search runs through Brave,
Staan or Qwant, the model also gets a page reader. It uses it to read a search result in full, or
a URL the user pasted, where before it only saw short excerpts of the top results.

- Works for web pages and PDFs. The same protection against internal and private addresses applies.
- It is offered automatically. No app changes are needed. To turn it off, disable the
  **Web Page Reader** tool (`webContentExtractor`) under **Admin → Tools**.
- It is not added when the model's own native search (Gemini, OpenAI, Claude) handles the request.
- 
## Chat: See What the Web Search Did

Answers that searched the web now show what they searched for and what they found. A panel above
the answer lists each search query, the sources it returned and which of those pages were read,
along with any other tools the turn called.

- Open while the answer streams, so users can follow the search live ("Searching for …",
  "Reading dwd.de"); collapsed to a one-line summary ("Searched the web · 2 searches · 12 sources ·
  4 pages read") once the answer is complete.
- Covers the built-in web search tools (Brave, Qwant, Staan), knowledge-source lookups and the
  queries of provider web search (Google Search grounding, Anthropic web search).
- Pages that could not be fetched are marked, and failed searches are shown as failed.
- 
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
