# Fixes — Unreleased

## Admin Sidebar in German

With German as the interface language, the admin sidebar showed most section and page names in
English, for example "AI Workspace", "Access & Identity", "Users" or "Backup & Restore". All
sections and pages of the sidebar are now translated.

## API Documentation on Windows

On a server running on Windows, the API documentation at `/api/docs` listed no endpoints: the
route files were looked up with Windows path separators, which the file search does not accept.
All three documents (Chat & General, Admin, OpenAI compatible) now list their endpoints on
Windows too.

## Accessibility: Admin Switches and the Change History Drawer

The change history drawer and the on/off switches of the admin now work the same way with the
keyboard and with a screen reader.

- The change history drawer (the **History** button on the edit pages) takes keyboard focus when
  it opens, keeps Tab inside, closes on Escape and returns focus to the **History** button. The
  rollback confirmation on top of it can be reached with the keyboard, and Escape cancels it.
- Every switch is one shared control that screen readers announce with its name and state. The
  switches for **Enable PWA** and a workflow's **Enabled** had no name before. The switches on the
  MCP gateway and OAuth pages now use the same indigo colour as the others.
- On the OAuth page, clicking the text **Personal API Keys** or **Offer client credentials**
  toggles its switch.
- Workflow editor: for a workflow file without an `enabled` setting, the first click on the
  **Enabled** switch did nothing. It now turns the workflow off.

## OpenAPI Tools: Array Parameters

Array query parameters of OpenAPI tools declared in `form` style are now sent as the document
says (repeated by default, comma-joined for `explode: false`) instead of always comma-joined,
which APIs such as CKAN rejected. `spaceDelimited` and `pipeDelimited` arrays are still sent
comma-joined. A tool may also set `openapi.arrayStyle` to `json-list`.

## Scheduled Tasks: "Schedule this…" Keeps the Chat's Tools

"Schedule this…" on a chat message opened the task form with the chat's iFinder and MCP server
tools switched off, and saving the task failed with "The app does not offer: iFinder". A chat
names these tools by their integration or server (`iFinder`, an MCP server id), a task by the
tools themselves. The form now switches on exactly the tools the chat had on and saves them; when
the chat had every tool on, the task keeps the app's defaults.


## Accessibility: Button Names Match Their Visible Text

The language selector, the account menu in the sidebar and the admin search button are now
named by the text they show (WCAG 2.5.3 Label in Name), for example "Select language: EN"
instead of "Select language". Speech-input users can activate them by reading the text on the
button, and screen readers announce the same words that are visible.

## Chat: A Skill Used Several Times Shows Once Above the Answer

When a skill was activated more than once in an answer — started with `/name` and loaded again by
the model, or loaded in several rounds — its icon appeared once per activation above the answer.
Each skill now appears there once.

- The answer's thought chain lists every activation as a **Used skill** row, in order with the
  searches and tool calls, saying whether you started it or the model loaded it.
- Answers saved before this fix show each skill once as well.

## Marketplace: Downloads Stay Off Internal Addresses

A registry's catalog could make the iHub server fetch from any address, including internal ones
such as the cloud metadata endpoint: an item, a skill's or an integration's companion files and
redirects were downloaded wherever the catalog pointed. The server now fetches from the
registry's own host (also on a private address, so registries inside the company network keep
working), from `api.github.com` and `raw.githubusercontent.com` for a registry on GitHub, and
from any other host only when it has a public address.

- Every redirect is checked again, at most 5 are followed, and a redirect to another host gets
  none of the registry's credentials (between the GitHub hosts they are kept).
- A refused download fails with a message that names the host, for example:

  > Marketplace fetch from '169.254.169.254' refused: the host is not the registry's own host
  > and not a public address (IP 169.254.169.254 is private)

- A private registry whose items or companion files live on another internal host than its
  catalog has to serve them from the catalog's host.

See [Marketplace → Security](../../marketplace.md#security).

## Answer Badge: "Based on Connected Systems" for Integration and MCP Answers

Answers built from an MCP server, a remote agent or an installed integration such as a people
directory were badged "Based on AI knowledge", although the data came from that system; a Jira
search was badged "Based on web search". They now show **Based on connected systems**.

- Web search integrations (Brave, Qwant, STAAN) keep "Based on web search", iFinder keeps "Based
  on iFinder documents".
- A call that only returned an error does not count, and iHub's own tools (asking the user,
  scheduled tasks) do not either.
