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

## Chat: A Skill Used Several Times Shows Once Above the Answer

When a skill was activated more than once in an answer — started with `/name` and loaded again by
the model, or loaded in several rounds — its icon appeared once per activation above the answer.
Each skill now appears there once.

- The answer's thought chain lists every activation as a **Used skill** row, in order with the
  searches and tool calls, saying whether you started it or the model loaded it.
- Answers saved before this fix show each skill once as well.
