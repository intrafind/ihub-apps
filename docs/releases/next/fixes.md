# Fixes — Unreleased

## OpenAPI Tools: Array Parameters

Array query parameters of OpenAPI tools declared in `form` style are now sent as the document
says (repeated by default, comma-joined for `explode: false`) instead of always comma-joined,
which APIs such as CKAN rejected. `spaceDelimited` and `pipeDelimited` arrays are still sent
comma-joined. A tool may also set `openapi.arrayStyle` to `json-list`.


## Accessibility: Button Names Match Their Visible Text

The language selector, the account menu in the sidebar and the admin search button are now
named by the text they show (WCAG 2.5.3 Label in Name), for example "Select language: EN"
instead of "Select language". Speech-input users can activate them by reading the text on the
button, and screen readers announce the same words that are visible.


## Admin Sidebar in German

With German as the interface language, the admin sidebar showed most section and page names in
English, for example "AI Workspace", "Access & Identity", "Users" or "Backup & Restore". All
sections and pages of the sidebar are now translated.


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
