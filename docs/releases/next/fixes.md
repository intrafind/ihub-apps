# Fixes — Unreleased

## Revoking an OAuth Connection Now Sticks, and Several Small Stores Stop Losing Changes

Disconnecting an OAuth client, deleting a user or revoking a client while one of its refresh tokens was being
exchanged for a new one could be undone: the exchange stored a fresh 30-day token after the revoke had found
nothing to delete. The old token now stays in the store until the new one replaces it in one locked step, so a
revoke arriving in between deletes it and no new token is issued (the client gets `invalid_grant`). A server crash
in the middle of an exchange no longer loses the connection either: the old token works again after two minutes.

The same class of lost update is closed in the OAuth consent store (grants, revokes and "last used" stamps could
overwrite each other, and an unreadable file was replaced by an empty one), the agent memory and inbox files
(concurrent runs of one agent passed the same version check and overwrote each other), marketplace installs,
updates and removals and the registry list (two at once lost one entry, leaving its files untracked), the
integration connection status, the anonymised-usage pepper (two workers starting together could each use their
own), stored user tokens (now written atomically, mode 0600) and the feedback retention cleanup (atomic rewrite).
After a restart of one worker, workflow runs that are still live on another worker are no longer marked failed or
resumed a second time. No action is needed after the upgrade.

## Saving Two Admin Settings Pages at Once No Longer Loses One of Them

Almost every admin page that stores a setting (CORS, SSL, SSRF allow-list, rate limits, LLM timeouts, logging,
audit log, chat history, proxy, usage limits, scheduled-task and user-skill/prompt settings, the Office add-in,
browser extension and Nextcloud embed switches, the first-run setup, the generic platform settings page, and
rolling back a platform change) read all of `platform.json`, changed its own section and wrote the whole file
back. When two admins saved different pages within a fraction of a second, or two workers did, one of the
saves was silently reverted — including security settings and the "setup configured" flag. The "refresh client
cache" button could also lose clicks, because it counts them in the file.

All of these now change the file as it is stored, in one locked step, so every section survives. The Office
add-in, browser extension and Nextcloud embed pages no longer rebuild the file from the server's cache either:
that cache could lag another worker's save (reverting it) and holds `${ENV}` placeholders already expanded, which
were then written to disk as literal values. Secrets in `platform.json` are still encrypted on save exactly as
before. No action is needed after the upgrade.

## Server Startup No Longer Reads the Whole Workflow History

On every start, one worker read every stored workflow run in full (`contents/data/workflow-state`) to find
the few that were still unfinished, and once more to repair execution records. With a large history this
took more than a gigabyte of memory within seconds of the start and could get the container killed for
running out of memory before it served a request. The server now keeps a small index of the unfinished runs
(`contents/data/workflow-active`) and reads only those; the repair of execution records runs once and is not
repeated. A run waiting for an approval stays resumable however old it is.

Listing stored data without its content — the daily workflow cleanup, counting a user's chats, listing
configuration — no longer reads each stored document in full either: every document under `contents/data`
now records its checksum and size at the start of its file, and those listings read only that part.

The first start after the upgrade does two one-time steps: migration V247 rewrites every document under
`contents/data` once to add the checksum and size (logged as "Document envelopes: upgraded N …"; on a large
installation this takes a few seconds), and the server builds the index of unfinished runs ("Built the index of
unfinished workflow executions"). A document that turns up later without the checksum — restored from a backup
taken before the upgrade, or written by an older release after a rollback or on a shared volume — is read
normally and upgraded the first time it is read (logged once per listing as "Read documents stored without etag
and size; upgraded them in place").

## Uploaded Pictures Keep Their Original Bytes When No Resize Is Needed

Every picture a user attached was re-encoded to JPEG in the browser, which dropped its embedded provenance
(C2PA, XMP) and part of an invisible watermark such as SynthID, for example when someone re-uploaded a
generated image to edit it. A JPEG, PNG, WebP or GIF within the resize limit and under 4 MB is now sent as it
is. Larger pictures are still resized, and other types are still converted.

## Project Web Pages and HTML Files Read Like read_url

A project's web page item and an HTML file in a project were read by code of their own next to the
page reader that `read_url` and web search use. They now share it: the same fetch, the same
extraction and the same page cache, so a page reads the same wherever it is opened. Visible changes:

- An HTML file longer than 400,000 characters keeps its Markdown structure (headings, lists, tables)
  to its end. Past the page reader's 400,000-character cap it used to be re-read by a second
  converter that dropped the links; the text is now cut only at the project's limit.
- A host that blocks automated access (bot protection) is remembered for the chat that hit it, not
  for every project web page item at once.

## Attaching More Files No Longer Duplicates the Ones Already Attached

Selecting files in the file dialog, confirming, and then opening the dialog again to add more attached
the first files twice: 5 files plus 2 more gave 12 attachments instead of 7. Only the newly selected
files are added now. Files picked from cloud storage stay attached next to local files.

## Rating a Chat Answer Works Again

Sending a star rating or comment under an answer failed with "Some of the entered data is not valid"
and nothing was saved. The chat now sends only the chat, message and run; for an iAssistant answer
the server works out the iFinder conversation and message id itself and still forwards the rating to
iFinder, addressed to the answer that was rated. `POST /api/feedback` no longer reads
`conversationId` or `ifinderMessageId` from the request body; the server ignores them if a client
still sends them. Ratings given on iAssistant answers from before this update are stored but are not
forwarded to iFinder.

## Share Is Always Offered When You Open a File From the Chat

Opening a generated picture or a file from the answer that has just produced it showed the viewer
without **Share**; it only appeared after opening the same file from **Files**. The viewer now offers
Share wherever sharing is allowed. A file that is still being saved to the chat is shared through its
stored copy; if that copy is not there yet, the viewer says so and Share works a moment later.

## The Azure Speech Key Stays Encrypted When Other Settings Are Saved

The Azure Speech subscription key is kept encrypted in `platform.json`, but the server holds it
decrypted. Several admin actions save `platform.json` from that copy: switching the Office add-in, the
browser extension or the Nextcloud embed on or off or saving their settings, and the CORS, SSL,
SSRF, logging, audit log, chat history, scheduled tasks, usage and skills pages. Each of them wrote the
key into the file as plain text. Every save of `platform.json` now encrypts the key again, and a key
that was already written in plain text is encrypted by the next save of any of those pages.

## Cookie Settings Can Be Saved Again

**Admin → System → Cookie settings** sent its save with a request method the server does not accept, so
the change was refused, and the server would not have stored the setting even then. Both are fixed: the
page now sends only the cookie settings, as the Tool approval page does, and they are kept like every
other platform setting.

## Three Loose Ends of the Error Response Conversion

- Downloading an agent artifact whose file cannot be read (it vanished after the check, a disk fault)
  answers a 500 instead of an unhandled stream error that could take the process down.
- Revoking an OAuth connection reads the client and user id from the path once; a literal `%` in an id
  used to be decoded a second time.
- The Teams sign-in recognises a deactivated account by an error code, not by the wording of its message.

## Google API Key No Longer Appears in Server Logs

The Gemini adapter used to send the API key as a `?key=` query parameter on the request URL, so a
provider error (quota, 4xx, 5xx) could write the key into the server logs. The key is now sent in
the `x-goog-api-key` header instead, for chat requests and for the setup wizard's API key check.
No configuration change is needed.

## Admin Saves Are Visible on Every Worker Straight Away; Models No Longer Lose Updates

With several workers (four by default), a read right after an admin save usually still showed
the old value, because the worker that answered had not reloaded yet. In a test with four
workers, 71 of 80 reads right after saving a model returned the old value. A save now returns
once the other workers have the change (at most one second; a worker that is restarting only
delays that one save), so the model list, an edited model and the next save all see it.

The same gap could undo a change. Enabling, disabling or deleting models, and giving a model the
default flag, rewrote the cached copy of another model, which could be the version before a save
made a moment earlier. In the same test, an update followed by disabling the default model was
lost every time. These actions now start from the stored model files, and an older cache reload
can no longer overwrite a newer one.

## Usage Menu, Limits & Quotas and Usage Reports Show the Same Numbers

Each model call is now captured in one place, which both counts it against the user's limits and
stores the usage record. Before, the two were written separately and could differ: calls made by
agent steps and workflow nodes appeared in the usage reports but never in the **My usage** menu or
on the **Limits & quotas** tab, and a read at the wrong moment could miss counts that were just
being saved. The menu and the limits page still show pre-summed numbers, so they stay fast.

Their "today" follows the reset schedule configured for limits, while the reports use UTC days.

**One-time reset:** on the first start with this version, every user's usage-limit counters are set
to zero (`data/quota-usage.json` is deleted), because the old counters missed calls the reports had
and cannot be reconciled with them. Budgets and limits are unchanged, and the usage reports keep
their history.

## Deadlocked Workflow Runs Now Fail Instead of Hanging

A workflow run whose remaining steps can never start (for example a step that depends on one that
is not part of the workflow) used to stay in **Running** forever without any message. The run now
ends as **Failed** with a "Workflow deadlocked" error naming the blocked steps.

## Shared Chats and Files Get a Descriptive Title

The title of a shared link — in the browser tab, the link preview, **Shared with me** and your list
of links — is now a name people recognise instead of an empty or technical one.

- A shared **chat** is named after the chat; a chat that was never titled takes its first question.
- A shared **file** is named after the conversation and the file ("Bakery landing page – page.html"),
  not just `page.html`. A file without a name takes the chat's name.

Links created before this version keep the title they were given.

## Integration Action Details Are Readable and Say What They Are For

The details panel of an integration action (opened with **Details** on the integration's page)
had no margin: texts, fields and buttons touched the panel's edge, and the three settings
dropdowns were squeezed side by side so their labels were cut off. The panel now has proper
spacing, and the settings are stacked with a one-line explanation each.

The panel also says what it is for. An introduction at the top explains that an action is one
thing the AI model can ask the connected system to do, and that here you control what the model is
told, how iHub treats the call (read or write, where the data goes, whether a person must
approve) and can run it once to test it. Each section has a short lead-in sentence, and field
names are set apart from their values.

## Audit Log Shows Each Person Under One Name

The **Actor** column of the audit log showed a person's name for their sign-in and an internal id
such as `user_3633d1e2_…` for everything they did afterwards, most visibly for users signed in with
OIDC (Microsoft, Google, …). The same person also appeared twice in the **Actor** filter. Every
entry, including ones recorded before this release, now shows the user's current display name.
Search still finds an entry by the raw id, and hovering over the name shows it.

The resource an entry is about now opens with a click: the app, model, prompt, group, user,
project, integration or OAuth client opens its admin page, and other types open their list page.
The actor's name links to their user page. The CSV export has a new `actorId` column next to
`actor`.

## Skill Files Load When the Assistant Leaves Out the Skill Name

When the assistant read a file bundled with a skill (for example the pattern guide of the
**web_artifacts** skill) and named only the file, the read failed with "skill_name and file_path
parameters are required" and the assistant went on without the guide. The skill is now taken from
the file's path, among the skills active in the chat and then the ones the app offers. Only when
two skills bundle a file of that name does the assistant still have to say which one it means.

## Admin Sidebar in German

With German as the interface language, the admin sidebar showed most section and page names in
English, for example "AI Workspace", "Access & Identity", "Users" or "Backup & Restore". All
sections and pages of the sidebar are now translated.

## API Documentation on Windows

On a server running on Windows, the API documentation at `/api/docs` listed no endpoints: the
route files were looked up with Windows path separators, which the file search does not accept.
All three documents (Chat & General, Admin, OpenAI compatible) now list their endpoints on
Windows too.

## Accessibility: Keyboard and Screen Reader Fixes in the Admin and Chat

Drawers, switches and a few buttons now work the same way with the keyboard and with a screen
reader.

- **Drawers:** the change history drawer (the **History** button on the edit pages) and the
  marketplace item detail take keyboard focus when they open, keep Tab inside, close on Escape and
  return focus to the control that opened them. Screen readers announce the marketplace detail as a
  dialog named after the item. The rollback confirmation on top of the history drawer can be reached
  with the keyboard, and Escape cancels it.
- **Switches:** every on/off switch is one shared control that screen readers announce with its
  name and state. Many had no name before, among them **Enable PWA**, a workflow's **Enabled**, the
  switches of the app editor's **Web Search** and **iAssistant** sections, the SSL and CORS
  settings, the **Status** column of the user list and **Show technical details** of workflows.
  Clicking the label text now toggles them, and the MCP gateway, OAuth, SSL, CORS and user switches
  use the same indigo colour as the others.
- **Workflow editor:** for a workflow file without an `enabled` setting, the first click on the
  **Enabled** switch did nothing. It now turns the workflow off.
- **Chat + menu:** the message-context switches of the browser extension (**Include page**) are
  menu entries now, reached with the arrow keys like the tools. A tool's switch is no longer an
  extra, unnamed Tab stop inside its menu entry.
- **Button names:** the language selector, the account menu in the sidebar and the admin search
  button are named by the text they show (WCAG 2.5.3 Label in Name), for example "Select language:
  EN" instead of "Select language". Speech-input users can activate them by reading the text on the
  button.

## MCP Servers over WebSocket Honor the SSL Whitelist

An MCP server reached over `wss://` with a certificate from a private CA failed with "unable to
verify the first certificate", even when its host was listed in **SSL → Domain whitelist** with
**Ignore invalid certificates** on. WebSocket MCP servers now follow the whitelist like every other
outbound connection; hosts that are not whitelisted are still verified.

## OpenAPI Tools: Array Parameters

Array query parameters of OpenAPI tools declared in `form` style are now sent as the document
says (repeated by default, comma-joined for `explode: false`) instead of always comma-joined,
which some APIs reject. `spaceDelimited` and `pipeDelimited` arrays are still sent comma-joined.
A tool may also set `openapi.arrayStyle` to `json-list`.

## Scheduled Tasks: "Schedule this…" Keeps the Chat's Tools

"Schedule this…" on a chat message opened the task form with the chat's iFinder and MCP server
tools switched off, and saving the task failed with "The app does not offer: iFinder". A chat
names these tools by their integration or server (`iFinder`, an MCP server id), a task by the
tools themselves. The form now switches on exactly the tools the chat had on and saves them; when
the chat had every tool on, the task keeps the app's defaults.

## Chat: A Skill Used Several Times Shows Once Above the Answer

When a skill was activated more than once in an answer — started with `/name` and loaded again by
the model, or loaded in several rounds — its icon appeared once per activation above the answer.
Each skill now appears there once.

- The answer's thought chain lists every activation as a **Used skill** row, in order with the
  searches and tool calls, saying whether you started it or the model loaded it.
- Answers saved before this fix show each skill once as well.

## Marketplace: Downloads Stay Off Internal Addresses

A registry's catalog could make the iHub server fetch from any address, including internal ones
such as the cloud metadata endpoint: an item, a skill's companion files and redirects were
downloaded wherever the catalog pointed. The server now fetches from the registry's own host (also
on a private address, so registries inside the company network keep working), from
`api.github.com` and `raw.githubusercontent.com` for a registry on GitHub, and from any other host
only when it has a public address.

- Every redirect is checked again, at most 5 are followed, and a redirect to another host gets
  none of the registry's credentials (between the GitHub hosts they are kept).
- A refused download fails with a message that names the host, for example:

  > Marketplace fetch from '169.254.169.254' refused: the host is not the registry's own host
  > and not a public address (IP 169.254.169.254 is private)

- A private registry whose items or companion files live on another internal host than its
  catalog has to serve them from the catalog's host.

See [Marketplace → Security](../../marketplace.md#security).

## Answer Badge: "Based on Connected Systems" for Integration and MCP Answers

Answers built from an MCP server, a remote agent or an integration such as a people directory
were badged "Based on AI knowledge", although the data came from that system; a Jira search was
badged "Based on web search". They now show **Based on connected systems**.

- Web search engines (Brave, Qwant, STAAN) keep "Based on web search", iFinder keeps "Based on
  iFinder documents".
- A call that only returned an error does not count, and iHub's own tools (asking the user,
  scheduled tasks) do not either.

## Importing Models from Azure OpenAI

**Import from URL** now accepts the URL copied from Azure, such as
`https://<resource>.openai.azure.com/openai/responses?api-version=…`, and reads the model list
from `/openai/v1/models`. Azure lists the models a resource offers, not its deployments, and calls
a model by its deployment name; the import dialog therefore has a **Deployment name** field for
each selected model. If the pasted URL carries an `api-version` and the API type is OpenAI
Responses, the imported models keep that `…/openai/responses?api-version=…` URL.

## Workflows Continue as Their Own User After a Person Answers

A workflow or agent run that paused for a `human` step or a question now continues as the user (or
agent) it started with. Before, the steps after the answer ran as the person who answered, with
their groups and their connected accounts — although anyone in an approver group could be the one
answering. Who answered is now documented on the answer and in the run's history: their id,
display name, the approver groups that let them answer, and the time.

**Workflows and agent runs that are paused when you upgrade must be started again.** They do not
record who they run as, so they cannot be continued after an answer: they stop with
`EXECUTION_PRINCIPAL_UNKNOWN` ("started before this version; start it again").

## Wide Tables in Generated PDFs Stay on the Page

Tables with many columns, or with a long word such as a URL, ran off the right edge of generated
PDFs, so the last columns were cut off. The columns are now sized from the text, and the table
always fits the page.

- Columns share the width in proportion to their text, and none is narrower than its longest word.
- A table with too many columns for the normal cell padding uses tighter padding, then a smaller
  font, down to 6.5 pt.
- A word that cannot fit its column at all, such as a long URL, is broken inside the column instead
  of shrinking the whole table.
- Tables a model lays out with its own column widths keep them.

## Your Messages Keep Their Line Breaks in the Chat

A long, structured prompt (headings, lists, indented code, blank lines) was shown as one run-on line
in your own message bubble. Messages now keep their line breaks and indentation, also when a file or
image is attached. The model always received the text with its structure; only the display changed.

## iFinder: "Sign with iHub's OIDC Key Pair" States Its iFinder-Side Prerequisite

The hint under **Sign with iHub's OIDC key pair** suggested the option works on its own. It does
not: iFinder must first be configured to trust iHub as a JWT issuer through its JWKS endpoint
(`/.well-known/jwks.json`), otherwise the connection fails with an unexplained `401`. The hint in
the iFinder integration editor and the keyless setup guide now state this prerequisite.

## Default Groups Can No Longer Be Deleted or Lost

The built-in groups `admins`, `users`, `anonymous` and `authenticated` are required for permission
resolution, yet the admin UI still offered Delete and an editable ID for `admins` and `users`.

- The Delete action is now hidden and the ID locked for all four default groups.
- A migration restores any default group that was already deleted, with its original inheritance.
  Groups that still exist, including your customizations, are left untouched.

## Default Group Inheritance Is Now a Complete Chain

Only `authenticated` inherited from `anonymous`; `users` and `admins` had no parent. The shipped
default is now `admins` → `users` → `authenticated` → `anonymous`, matching the documentation.
A migration adds the two missing links to existing installations. A group that already declares
`inherits` (even an empty list) is left as you configured it.

## OIDC Sign-In Cookie Is Marked Secure Behind an HTTPS Reverse Proxy

The session cookie set after an OIDC sign-in did not look at the request, so behind a TLS-terminating
proxy it was issued without the `Secure` flag unless `USE_HTTPS=true` was set. It now follows the
request protocol (`X-Forwarded-Proto`) like the cookie of every other sign-in method.

## MCP, A2A and Integration Calls Block More Internal Addresses

The private-address check used by MCP servers, A2A agents, OpenAPI tools and HTTP integrations
missed several internal ranges, so a hostname resolving to one of them was not refused. It now uses
the same check as workflow HTTP nodes.

- Newly blocked: carrier-grade NAT (`100.64.0.0/10`, e.g. Tailscale), multicast and reserved
  (`224.0.0.0/4`, `240.0.0.0/4`) and IPv6 forms of internal IPv4 addresses such as
  `::ffff:7f00:1`.
- A server that legitimately lives in one of these ranges must be listed in its `allowedHosts` or
  in `ssrf.allowedHosts` in `platform.json`; the existing allow-lists work as before.
- The integration diagnostics flag the same addresses as private.

## A Group Named `admin` No Longer Grants Admin Rights in a Few Places

The built-in administrator group is `admins`. A group called `admin` (singular) was still treated as
an administrator when listing workflows, reading agent runs and artifacts, answering approvals and
as the fallback when `groups.json` cannot be read. Only `admins` and the `adminAccess` permission
grant admin rights now. If you created a group named `admin`, give it `adminAccess` under
**Admin → Groups** or move its members to `admins`.

## An Admin's API Keys and Agents No Longer Pass Admin-Only Checks

A personal API key, an OAuth token that acts for a user, or an agent that carried an administrator's
groups was refused by the admin pages but still counted as an administrator when reading other
users' agent runs and artifacts, chats and MCP catalogs. There is now one admin rule,
decided once per request: only a signed-in person in a group with `adminAccess` is an
administrator. The anonymous user, OAuth clients, API keys, tokens acting for a user and agents
never are, whatever groups they carry.

- Calls that relied on an admin's API key to read other users' runs or artifacts now get `403`;
  use the admin sign-in instead.
- If `groups.json` cannot be read, requests now fail instead of guessing admin rights from group
  names.

## Web Page Reader Reports Bot-Protection Blocks Instead of "Authentication Required"

When a website blocks automated access with a bot-protection service (Akamai, Cloudflare, Imperva,
DataDome, PerimeterX or Sucuri), the page reader (`read_url`) used to report every 401/403 as
**Authentication required**, which pointed admins and the model in the wrong direction. It now
tells the cases apart:

- **Blocked by bot protection** (`BOT_PROTECTION`): names the service, for example _Blocked by bot
  protection (Akamai) – the site does not allow automated access (HTTP 403)_. The model receives a
  non-retryable result with the host and the instruction not to retry or try other URLs on that
  host, and to tell you the page could not be read and suggest uploading it or using the search
  snippets. A host that blocked a chat is not requested again in that chat.
- **Authentication required** (`AUTH_REQUIRED`): only for a real login request, a 401 or a 403 that
  carries a `WWW-Authenticate` header.
- **Access denied** (`ACCESS_DENIED`): any other 403, with the status in the message.

Web searches that read the result pages (`extractContent`) mark such a result with
`contentExtracted: false` and `extractionErrorCode: "BOT_PROTECTION"`, so the model can still use its
title and description. The project URL crawler stops at a host that blocks it and reports the host
instead of failing page by page.

The server log records the status, the detected service and its reference id (for example the
Akamai `Reference Error`) for every refused page read, so the cause can be found without
reproducing the request. Bot protection is only detected, never bypassed.

## URL Test Agrees With Preview for Internal Hosts

When you add a web page as a source, the **Test** button refused an internal host with "Access to
private/internal addresses is not allowed (host did not resolve to any IP)" while **Preview** read
the same page. Both now follow the same rule:

- A host listed in `ssl.domainWhitelist` or in the platform's SSRF allowlist (`ssrf.allowedHosts`,
  **Admin → Security**) is trusted: Test and Preview skip the private-address check for it, like
  the other outbound features that honor the allowlist. Every redirect is still checked on its own,
  so a trusted host cannot forward the request to an unlisted internal address.
- A short or internal name that only the operating system can resolve (an `/etc/hosts` entry or a
  search domain, such as `if-wiki`) is now found. Before, only the DNS servers were asked. The
  addresses it returns are held to the same private-address rule, so this does not open anything
  by itself.
- A name nothing can resolve is reported as "could not be resolved" and names the two settings
  above, instead of pointing at private addresses.

## Admin: Test Panels Keep Keyboard Focus on Narrow Screens

On a narrow window the test panel of the app editor covers the editor, but keyboard focus stayed on
the button behind it: Tab moved through editor controls that could not be seen, and Escape did
nothing. On narrow screens the panel is now a dialog: focus moves into it and stays there, Escape
closes it, and focus goes back to the **Test** button.

- The test panels of integrations (**Test in chat**) and of projects (**Try in chat**) behave the
  same.
- Beside the editor on wide screens nothing changes.

## Single Sign-On: A Failed Sign-In Shows a Message Instead of the Same Login Screen

When the sign-in at the identity provider (OIDC, for example Microsoft Entra ID) could not be
completed, the browser came back to the login screen without any explanation, so clicking the
provider button seemed to do nothing. Typical causes are a new user while self-registration is
off, or a sign-in request that could not be verified. The login screen now says that the sign-in did
not complete and asks the user to try again or to contact the administrator.

- The reason is written to the server log, and to the browser console for support.
- After a failed sign-in the login screen no longer sends the browser straight back to the
  provider, also when automatic redirect is configured.

## iFinder Search: A Search With No Hits Is Retried With Fewer Words, Not More

After a search found nothing, the model often searched again with the same words plus more —
"vacation policy" returned 0 hits, so it tried "vacation policy company". iFinder's search profiles
require all of up to three words, so the longer query was certain to fail as well. The model now widens instead: it drops words, tries synonyms and
the other language (German/English), or joins alternatives with an explicit OR.

- A search with no hits now tells the model which retries can work, including whether a filter is
  what excluded everything. It suggests another search profile only when the chat has not fixed
  one.
- The model knows how iFinder combines the words of a query: all of up to three words must match,
  and from four on one in four may be missing. To narrow a result it uses filters, phrases or an
  explicit AND rather than more words.
- The same guidance is in the **ifinder-search** skill, the iFinder search action's model guidance
  and the prompt of the **iFinder Search** app.
- Installations that kept the shipped iFinder Search app prompt get the new wording on upgrade. A
  prompt an admin changed is left as is; the upgrade log names it.

## App Generator Creates Apps That Use Integrations

The app generator (the creation wizard's **Generate with AI** step) wrote apps with a `tools` list, a
field apps no longer have, so generated apps offered no tools. The generator now lists the installed
integrations in its brief and answers with `integrations`; the wizard turns the answer into the
app's `integrations` bindings (only installations that exist are kept). Migration V231 updates the
stored `app-generator` prompt: it drops the `actions` example and the `tools` answer field and adds
the fields the wizard applies; the rest of an edited prompt is left alone.

## Privacy Link in the FAQ, and OAuth Connection Counts

The default FAQ page linked its privacy policy to `/page/privacy`, a URL that does not exist (pages
are served under `/pages/{pageId}`); the link now points to `/pages/privacy`, in English and German.
New installations get the corrected text; an existing FAQ page keeps its own copy, so change the link
there if you use it. **Admin → OAuth** showed no connection count and **Admin → Users → View** no
OAuth connections for a user, because both read a list key the server no longer sends.

## Base Path Installations: Chats Started From the Start Page Open in the App

On an installation under a base path (for example `/ihub`), sending a message from the start page's
chat input led to `/ihub/ihub/apps/<app>`, a page that does not exist, instead of the app's chat.
The same happened when a link opened an app with settings in the address (`?model=`, `?style=`,
`?var_…`) or with a document ("Open in App"). The chat now opens in the app and the message is
sent.

## Chat Input: The Upload Button Shows for Apps With Web Search

On a desktop, an app whose only quick action was file upload (no magic prompt, no microphone)
showed no paper clip when it also offered web search; turning on magic prompt made it appear. The
browser extension's side panel, with its "Include page" option, had the same problem when opened
wide. The paper clip now shows in both cases.

## Base Path Installations: The Logo Shows When Its URL Holds the Base Path

On an installation under a base path (for example `/ihub`), a header logo URL that already started
with the base path (`/ihub/uploads/assets/logo.png`, the address the browser shows) was requested as
`/ihub/ihub/…`, so the logo in the sidebar, the header, the start page and the sign-in screen did
not load behind a reverse proxy that forwards the prefix. Such URLs are now used as they are, as
are `data:image/…` logos, which were not shown on any installation. `/uploads/assets/logo.png`
keeps working as before.

## Web Search: Answers No Longer End With a Second List of Sources

Some models, especially smaller and local ones, ended web search answers with their own
**Quellen:** or **Sources:** list, right above **Cited in this answer**, so the same sources showed
twice. The **Web Chat** prompt asked them to *"Always cite your sources with URLs"*, which they
read as "add a list of sources".

- The prompt and the built-in research guidance now ask for the source right after each
  statement. The source instruction the server adds names the list (*Sources*, *Quellen*,
  *References*) and asks the model not to write one, for every search path.
- If a model writes such a list anyway, the finished answer leaves it out. This applies only when
  the list is clearly a list of sources: at the very end of the answer, after a short heading or a
  horizontal rule, with every line linking one of the answer's sources. Every source in it is
  listed under **Cited in this answer**. **Copy** and exports keep the text as the model wrote it.

**Migration:** on the first start with this version, `contents/apps/web-chat.json` gets the new
prompt in the languages where it is still the shipped default. A prompt you changed stays as it
is. If you wrote your own, avoid asking for "sources with URLs" or a list of sources: the chat
lists them.

See [Web Tools → Sources and Citations](../../web-tools.md#sources-and-citations).

## Chat: The Sources Panel Opens Once

On phones, the backdrop behind the **Sources** panel was darker than intended, and screen readers
found two identical **Sources** dialogs. The chat keeps a phone and a desktop layout of each answer
on the page, and both opened their own panel on top of each other. The panel now opens once, from
whichever layout is shown.

## Projects: iFinder Documents With Several Titles Can Be Added

Picking an iFinder document in a project's **Add item** dialog and clicking **Add** did nothing
for a document whose index entry carries more than one title; the browser console showed
`TypeError: (t.name || "").trim is not a function`. The dialog now shows and names the item after
the document's first title, and the document is added.

## Projects: HTML Files Keep Only the Page's Content, Not Its Menus

An HTML file added to a project — uploaded, or picked from OneDrive / SharePoint or Google Drive —
was read as the whole page: skip links, menus, page trees, breadcrumbs and footers (on a saved
Confluence page, about half of the text) ended up in the project and in every answer drawn from it.
HTML files are now read like a web page added by URL: only the main content is kept, with its
headings, lists, tables and links.

## Windows Sign-In Works With the Former "Negotiate" Setting

With **Authentication Type** set to **Negotiate** in the NTLM settings, no Windows user could sign
in: every attempt failed with 400 Bad Request. iHub asked the browser for Negotiate (Kerberos), but
its Windows sign-in only understands NTLM. The setting is removed and iHub always asks for NTLM;
migration V234 deletes `ntlmAuth.type` from `platform.json`, so affected installations sign in with
NTLM again without any change.

- Kerberos is not supported by iHub's Windows sign-in. For Kerberos single sign-on, put a reverse
  proxy that handles Kerberos in front of iHub and use proxy authentication, or sign in through an
  identity provider with Windows single sign-on (ADFS, Keycloak, Entra ID) via OIDC.
- The NTLM documentation now explains how the sign-in is checked by the domain controller and which
  domain controller settings (LDAP signing, channel binding, NTLM restrictions) affect it.

## Sources Panel: A Refused Download or Email Attachment Says Why

**Download** and **Add to email** in the sources panel showed only "The document could not be
attached to your email." (or "…downloaded.") whatever had gone wrong. The message now adds the
cause: iHub's reason, for example "You are not allowed to use this integration." when the user's
groups are not granted the iFinder integration (documents in iAssistant answers need it too), or
Outlook's own error.

## Chat: The Context Counter Includes What the Model Read

While the model researched, the context counter under the message box did not move: it counted
only the messages the browser held, not the web pages and documents the model was reading, so a
single long research turn could run into the model's limit while the counter showed plenty of
room. The server now counts the context window — from the token count the model provider reports
for each call, plus an estimate for what was added since — and the counter follows it while the
answer is being written. When the answer is done the counter shows what the next message will
send (the conversation so far plus the answer; a finished turn's tool results are not sent
again), and a reopened chat shows the same figure.

## Chat: An Empty Answer Says So and Offers Retry

An answer could stay completely blank, so the chat looked stuck after the question. This happens
when a reasoning model finishes its turn right after thinking and writes no answer. The answer now
reads "The model returned no answer." with a Retry button that asks the question again.

## Links to Other Sites Always Open in a New Tab

A link in rendered Markdown that points outside iHub — in a chat answer, a shared chat, a source or
project text, an uploaded file or an artifact preview — could replace iHub in the current tab
instead of opening a new one. Only live chat answers handled this reliably.

- Links to another host or port open in a new tab and cannot reach the iHub window.
- Links within iHub, anchors (`#section`) and `mailto:` links stay in the current tab.
- The same holds for links an answer writes as raw HTML.

## Server: Token Estimates Count With the Real Tokenizer

The server's token estimates were one token per four characters, although they are meant to use the
`o200k_base` tokenizer: the tokenizer package was installed for the browser only, and the server
fell back to the rough figure without a message. The package is now a dependency of the server, so
the figures behind the agent loop and context compaction, the skill catalog and skill-body budgets,
project size estimates, tool search and knowledge retrieval are real token counts.

- **Numbers move, in both directions.** English prose comes out about 5 to 14 percent lower than
  before, and a German sentence of 101 characters counted 26 tokens before and 18 now. JSON counts
  about 11 percent higher, and Chinese or Japanese text two to three times higher. Limits written
  in tokens, such as `skills.maxCatalogTokens` and `skills.maxSkillBodyTokens`, now apply to the
  real counts: they fit more English or German prose and less JSON or Chinese and Japanese text.
- **Cost.** Counting is exact but not free: about 7 ms for 100 KB of prose, 1 MB of prose holds the
  server for about 0.1 to 0.2 s. Texts above 256 KB (a very large attachment) are therefore counted
  from samples spread over the text, within about 7 percent of the exact count, in about 5 ms.
- Installations that run from a copy without the package keep the old behaviour.

## Chat: Answers Longer Than Five Minutes No Longer End in "Request timed out"

A chat turn that ran longer than five minutes, such as an analysis that crawls a large website,
stopped in the browser with the following text added to the answer, although the server went on
and finished the answer:

> Request timed out. The operation may have taken longer than expected.

The browser now checks whether the turn is still running and keeps showing it until the answer
is complete. A request that really failed still shows the error.

## Chat: Answering a Question Keeps the Chat's Tools and Settings

After the user answered a clarifying question, the chat went on with the app's default tools and
settings: an integration the user had switched on, such as the website corpus, was gone, and the
assistant fell back to other tools. The same happened to API and MCP callers that send only part
of the settings. A turn now uses the chat's stored setup (tools, model, style, output format,
thinking, web search, image and integration settings) for everything the request leaves out.

## The Cluster Primary Process Uses a Third of the Memory, and Workers Start Faster

With several workers (`WORKERS` > 1) the primary process, which only starts and supervises the workers, loaded
the whole application and used about as much memory as a worker (~400 MB RSS). It now loads only what it
needs (~120 MB). Every worker also stopped generating the API documentation (`/api/docs`) at startup: the
production build writes it, and the server reads it on the first request to `/api/docs`. Workers listen about
a second and a half sooner.

## In-Memory Caches Scale With Each Worker's Memory

The caches of project item text, project search indexes and fetched web pages had fixed sizes (96 MB, about
165 MB, and no limit for web pages), which on a worker with a small memory limit could take 40 % or more of
it. Each now takes a share of the worker's own memory limit (about a quarter for all of them together),
capped at its old size; the web page cache also keeps at most 256 pages per source type and drops the oldest
first. On a small worker, a project read again after a while may be loaded from storage again instead of
from memory.

## Config Locks No Longer Let Two Workers Write at Once

Under load, or after a worker crashed while holding a lock, several workers could change the same
file (users, OAuth clients, refresh tokens, short links, document templates, config files) at the
same time, and one change silently overwrote the other. File locks now stay held for as long as
their holder is working, a crashed holder's lock is taken over by exactly one worker, and a worker
whose lock expired no longer removes the lock of the worker that took over.

- A lock that cannot be obtained within its wait no longer lets the change run anyway: the request
  fails with `503` (`LOCK_TIMEOUT`) and can be retried. Nothing is written.
- The iFinder sign-in refresh gives up after 10 seconds if the identity provider does not answer,
  instead of holding the refresh lock. A waiting request used to refresh with the already used
  refresh token, which the provider rejected and which deleted the user's stored tokens.
- The `.update-lock` of the in-product updater is renewed and released only by the operation that
  created it.

## Creating, Editing and Deleting Users No Longer Loses Concurrent Changes

Creating, editing or deleting a user in Admin → Users read `users.json` and wrote it back without a lock, and so
did the first sign-in of an external user (OIDC, LDAP, NTLM, proxy, Teams) and the daily "last active" update. Two
of these at the same time — two admins, a bulk import through the API, or an admin next to a first login — both
answered success while one change silently disappeared. They now run under the same lock as the other writers of
`users.json`, and the check for an existing username happens against the freshly read file, so two creates of the
same name at once end with one `409` instead of two users.

## Storage Locks Hold Under Contention Between Workers

With several workers or replicas on one data volume, taking over an expired storage lock could rarely let two workers hold it at once (the same work done twice, or one worker's lock released by another); a takeover now elects exactly one.

## Saving a Config File No Longer Races Another Save of the Same File

A plain save of a configuration file (an app, model, prompt, page text, …) could land between another
worker's read and write of the same file, and one of the two changes was silently lost. Every way of
writing a config file now takes the same lock, in this process and across workers.

- Saving the usage tracking mode or the feature flags no longer rewrites `platform.json` or
  `features.json` from an empty body when the file exists but cannot be read; the request fails
  instead and the file is left untouched.
- Files are flushed to disk before they replace the old version, keep their permissions (the refresh
  token store is `0600`), and a malformed refresh token store is copied to `*.corrupt-<time>` before
  it starts empty.
- Two change-history snapshots of one resource saved in the same millisecond no longer overwrite each
  other.

## Groups, Credentials and Providers: Two Saves at Once No Longer Lose a Change

Creating, editing or deleting a group, a credential or a provider read the whole file, changed the copy
and wrote it back, so two admins (or two workers) saving at the same moment could drop one of the
changes — a group created a second earlier, an encrypted credential, a provider's API key or enabled
flag. Each of these routes now checks and changes the file under one lock.

- A content-access grant (Admin › Content access) is no longer reverted by a group edit that ran at the
  same time, and the other way round. Rolling a group back from the change history takes the same lock.
- Two admins removing `adminAccess` from the last two admin groups at once can no longer lock everyone
  out: the "last admin group" check runs on the groups as they are when the change is applied, so the
  second request is refused.
- Two requests creating the same credential or provider id now give exactly one success and one
  conflict instead of both passing the check.
- Editing a provider no longer reverts another provider's change when this server's cached copy is
  behind the file, and the first-run setup writes its API key to the stored list instead of the cache.
- Installing, editing and removing integrations changes `integrations.json` and the managed
  credentials in `credentials.json` under the same lock, next to the credentials routes.

## Chat: Answers No Longer Go Missing With Several Workers

With more than one worker, a message sent right after opening a chat could get no visible answer:
the spinner kept turning, and the answer only appeared after reloading the page. This happened more
often under load and with more workers (about 1 in 15 turns at 1,250 users and 8 workers
in our load test). The worker that takes the message now asks where the chat's stream is when it
has not heard of it yet, so the answer streams as usual.
