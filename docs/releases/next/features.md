# Features — Unreleased

## Prompt Library: Your Own Prompts, Sharing and Variables

Signed-in users can now write prompts of their own and share them, and every prompt can ask for
the details it needs. Admin-curated global prompts work as before.

- **My prompts:** create a prompt with **New prompt** on the Prompts page, or hover a message you
  sent and choose **Save as prompt**. Prompts are private until you share them. You can duplicate
  any global or shared prompt into your own prompts to adapt it.
- **Sharing:** share a prompt with specific users, with groups, or with everyone signed in, as
  **Can use** or **Can edit**. People with **Can edit** can change the prompt and share it
  further; only the owner and admins can delete it. Removing a share takes the prompt away at once.
- **Variables:** write `{{tone}}`, `{{recipient}}` or any other name in the prompt text. When the
  prompt is used, a short form asks for the values, checks required fields and shows a preview.
  The final text is put into the chat input, not sent. `{{user_name}}`, `{{date}}` and the other
  global variables fill in by themselves, and `{{content}}` marks where your own text goes. Each
  variable can get a label, help text, type, default value and options.
- **Using prompts:** clicking a prompt on the Prompts page opens a chat in its app, or in the
  default app, with the text ready. The page filters by **My prompts**, **Shared with me**,
  **Global** and **Favorites**, and each card shows whether a prompt is global, yours or shared,
  and by whom. The `/` search in the chat lists favorites, recent prompts, your own, shared and
  global prompts.
- **History:** every save is kept as a version that can be viewed and restored.
- **Favorites and recents** are stored with your account and follow you to other browsers and
  devices. What this browser remembered is carried over the first time.
- **Admins:** **Admin → Prompts → User prompts** lists the prompts shared with groups or with
  everyone. Admins can edit, re-share, delete or promote them to a global prompt, which keeps the
  author's name. The same tab holds the settings: turn user prompts off (admins can still look
  after the existing ones), limit the prompts per user and the versions kept, and choose whom users may share with — optionally only members of
  certain groups may share with groups or everyone. Every change is written to the audit log.
- If the account of a prompt's owner is deleted or deactivated, the prompt stays available to
  everyone it was shared with, read-only.

## Web Search: Sources View and Numbered Citations

Answers that used web search now show what was searched and which sources the answer relies on.
A **Searched for “…”** entry under the answer, with the sites' icons, opens a side panel (a sheet
on phones) listing the sources **Cited in this answer** and those **Also considered**. In the
answer itself, each citation is a numbered badge next to the claim it supports.

- Source cards show the site, title, snippet or cited passage, the published date when known, and
  whether the page was read, with the words read.
- Hovering or focusing a badge highlights its paragraph and its card; hovering a card
  highlights every passage citing it. A click or tap opens the panel on that card. Works with
  keyboard and touch.
- The same on every search path: Brave, Staan and Qwant, and native search with Claude, Gemini
  and OpenAI. A link to a page the searches did not return is never shown as a citation.
- The sources are stored with the answer, so reopened and shared chats show them too.
- While web search is on, a highlighted **Web search** chip next to **+** in the input bar says so
  and turns it off in one click.
- In the model picker of a web search app, a globe marks the models web search works with.
- Search tools can now restrict results by age (`freshness`) and to named sites
  (`includeDomains`) on every provider, and results keep their dates and favicons.

## Web Page Reader: Markdown, Long Pages and a Read Limit

The page reader (`webContentExtractor`) returns pages as Markdown, keeping headings, lists, tables
and links instead of one flattened line of text. Long pages and PDFs can be read in parts.

- The reader says when a page was cut and how long it is, and the model reads on from where it
  stopped. PDFs are read beyond page 10, up to the length limit, titled from their metadata.
- New **Max Page Reads per Answer** setting (**Admin → Apps → Web Search**,
  `websearch.maxPageReads`, default 5): once reached, the model answers with what it has, and the
  chat shows the skipped read. The excerpts the search fetches itself do not count.
- Pages are requested in the user's language and cached briefly, so reading a page again costs
  no request.
- The reader is now also offered next to Claude's and OpenAI's native web search, so pasted URLs
  can be opened there too. Gemini's native search still does not allow it.
