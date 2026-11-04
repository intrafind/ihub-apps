# Fixes — Unreleased

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

## Default Groups Can No Longer Be Deleted or Lost

The built-in groups `admins`, `users`, `anonymous` and `authenticated` are required for permission
resolution, yet the admin UI still offered Delete and an editable ID for `admins` and `users`.

- The Delete action is now hidden and the ID locked for all four default groups.
- A migration restores any default group that was already deleted, with its original inheritance.
  Groups that still exist, including your customizations, are left untouched.
