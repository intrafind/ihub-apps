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

## Voice Input: Platform-Wide Defaults

Admins can now choose the dictation service and the transcription model once, under
**Admin → Voice Input → Defaults**, instead of configuring every app.

- **Dictation service (microphone button):** Browser, Azure Speech or vLLM Realtime. Every app
  whose Speech Recognition Service is **Platform default** follows it, including later changes.
- **Transcription model (recording):** used for recordings and audio/video uploads in apps that
  enable transcription without choosing a model.
- Apps that select a service or model of their own keep it. A new **Browser (Web Speech API)**
  choice pins an app to the browser whatever the default.
- If the default names a backend that is not enabled, apps following it keep using the browser,
  and the admin page warns about it.
- Nothing changes on upgrade: the default starts as the browser, which is what "Default" meant
  before.

## Voice Input: Test Microphone, Dictation and Recording From the Admin Page

**Admin → Voice Input** has a new **Test voice input** panel. The tests run in the admin's own
browser with their microphone, on the same path users take in a chat, against the saved
configuration.

- **Microphone check:** a live input level meter and the device name, with no speech service
  involved.
- **Live dictation:** pick Browser, Azure Speech or vLLM Realtime plus a language and mode, then
  speak. Shows the text as it arrives and how long the first words took.
- **Recording:** record up to 60 seconds and transcribe it with any enabled transcription model.
  Shows the transcript and timings, or the error including the server's reason.
- **Azure Speech** gets a **Test connection** button that checks the key and region from the
  server.
- The vLLM Realtime **Test connection** now explains a redirect: an endpoint behind a proxy that
  only accepts TLS is reported as "use wss:// instead of ws://" rather than a bare HTTP 308.
  
## Admin: System Resources and Low-Disk Warnings

A new **Admin → System Resources** page shows how much CPU, memory and disk space the server is
using, so a small installation notices a filling disk before saving chats, uploads and
configuration starts to fail.

- **Disk space** for each filesystem holding the contents, data, uploads, log and temp
  directories: free and total space, the directories on it, and a status. Status is **Running low**
  from 80 % used and **Critical** from 90 %.
- **Host** CPU and memory, including container limits when iHub runs in Docker or Kubernetes.
- **Server processes**: CPU, memory, heap and event-loop delay for each process. With several
  workers (`WORKERS`), the primary and every worker are listed, and a worker that does not answer
  is flagged.
- When a disk reaches 80 % used, **every admin page** shows a banner, and the server log gets a
  `warn` line (`error` at 90 %). The log line repeats hourly while the disk stays full, and an `info`
  line follows once it recovers, so installations where nobody opens the admin UI still see it in
  their logs.
- The Admin **Overview** shows the free space in a **Disk space** row under *Platform status*.
- The page is hidden together with the other system pages when `admin.pages.system` is `false`.

## Start Forms: Message Field and Model Selection

The form an app can start its chats with now takes the user's own text and lets them choose the
model, two things only the chat input offered before. Apps like the Translator, whose prompt works
on the user's text, can now be used with a form even when uploads are off.

- **Message field:** every start form has one: the chat input's text, on the form. It fills the
  prompt's `{{content}}` (the text to translate, for example), or follows the filled-in prompt
  when the template has no `{{content}}`. It is optional and shows the app's message placeholder.
  Before, the field only appeared when the chat was opened with text.
- **Model selection:** when the app lets users pick the model, the model selector sits next to the
  send button, so the first message already goes to the chosen model. The selected model's hint
  is shown on the form, and an **Important Notice** has to be acknowledged before sending, as in
  the chat input. In compare mode each panel keeps its own model picker.
- Works in the web app, the Outlook add-in and the browser extension.

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
