# Fixes — Unreleased

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
