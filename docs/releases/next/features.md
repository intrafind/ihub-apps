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

## Web Search: Research in Several Steps

With web search turned on, the assistant now researches a question in several steps instead of
answering after a single search: it breaks the question into parts, searches several times with
different wording, checks key claims against more than one source and combines the findings into
one answer with source links.

- Applies to every app with web search, whenever web search is on for the conversation. With web
  search off nothing changes.
- A chat answer can now use up to 25 rounds of tool calls instead of 10, so there is room to search
  several times and still open the most relevant pages.
- Admins can turn it off or replace the instruction with their own text per app under
  **Admin → Apps → Edit App → Web Search → Research in Several Steps**
  (`websearch.researchGuidance`).
- The default **Web Chat** prompt was reworded to match. It is updated on upgrade only where it is
  still the shipped default; a prompt you changed is kept.
- With Gemini's built-in Google Search, the instruction only steers how Gemini uses its own search.

## iFinder search results are about half the size

Every iFinder search hit used to carry the raw API document and the raw hit metadata alongside the
fields already mapped out of them, so each result shipped the same values two to three times. On a
49-hit search those two fields alone were 48% of the response. They are gone, and fields the source
has no value for are now left out instead of being sent as `null`.

- Agents, workflows and MCP clients fit roughly twice as many results in the same context budget
- A document whose source reports no file size no longer shows a made-up "0 B" in the citation
  panel and the admin source test
- `iFinder_getContent` likewise no longer echoes the raw document and raw API metadata
- Custom integrations that read `rawDocument`, `rawHitMetadata` or `rawApiMetadata` off an iFinder
  response should switch to the mapped fields of the same name — `title`, `file`, `score`,
  `teasers` and the rest are unchanged
