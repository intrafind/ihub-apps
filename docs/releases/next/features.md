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

## Scheduled Tasks (Preview)

Users can now save a prompt as a task that runs by itself, as them, in one of their apps: every
weekday at 08:00, once next Tuesday, every two hours, on the last day of the month, or only when
they press **Run now**. Every run becomes its own chat, marked unread until they open it, so
morning digests and weekly reports are waiting when they come in.

- Turn it on under **Admin → Features → Scheduled Tasks** (requires **Durable Chats**). Users then
  find **Scheduled tasks** in the sidebar.
- Schedules: once, interval, daily, weekdays, weekly, monthly (the 29th–31st fall back to the last
  day of shorter months) and cron, in the user's time zone across daylight saving time, with an
  optional start, end and number of runs.
- Runs use the app's tools, integrations, sources and workflows with the owner's current
  permissions. An owner who loses access to the app, model or a tool gets a skipped run and a
  paused task with the reason; an expired integration sign-in shows a **Reconnect** link.
- The task page lists every run with status, duration, reason and a link to its chat. A missed
  slot after a restart runs once as a catch-up, never many times; runs of one task never overlap.
- Tools marked `"requiresApproval": true` pause a run until the owner approves or rejects it, with
  an **Always allow for this task** option that can be revoked later.
- Apps can offer scheduling tools (`schedule_task`, `list_scheduled_tasks`,
  `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`) by listing them in
  their tools. The assistant only proposes a task; the user saves it on a confirmation card.
- **Admin → Scheduled Tasks** shows every user's tasks, lets admins pause, disable or delete them,
  and sets the limits: tasks per user, minimum interval (15 minutes), concurrent runs, catch-up
  window, approval timeout and more.
- A new **Scheduled tasks** group permission decides who may create tasks. The upgrade grants it to
  `admins`, `users` and `authenticated` and denies it to `anonymous`. Custom groups keep what they
  have.
- Run chats do not count toward the per-user chat limit; each task keeps its 20 most recent.

## Workflows: Schedule Triggers Apply Without a Restart

Adding, changing or removing a workflow's schedule trigger now takes effect as soon as the
workflow is saved. Before, schedules were read once at server start and edits needed a restart.
Schedule triggers now run on the same scheduler as scheduled tasks.

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
  (`includeDomains`) on every provider, and results keep their dates and favicons. On Staan the
  age filter is best effort, because its results carry no dates.

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
