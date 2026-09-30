# Breaking Changes — Unreleased

## Prompt Library: `[content]` Is Now `{{content}}`

Prompts in the prompt library mark where the user's own text goes with `{{content}}`, the same
`{{name}}` syntax as every other placeholder on the platform. `[content]` is no longer
recognized: a prompt that still contains it inserts `[content]` literally.

- The upgrade rewrites `[content]` to `{{content}}` in every prompt in `contents/prompts/` (and
  in a legacy `config/prompts.json`), so prompts on the server need no change.
- Any other `{{name}}` in a prompt text is now asked for when the prompt is used.

**Before upgrading:** prompt files kept outside the installation — backups, files you upload
under **Admin → Prompts**, provisioning scripts — must use `{{content}}` instead of `[content]`.

## Chat History: Documents of Answers Saved Before This Release No Longer Show

All sources of an answer are now stored in one place, for the new Sources panel. Answers saved
before this release, from 5.5.24 on, kept their iAssistant and iFinder documents in a different
form, which is no longer read. Those answers keep their text and links, but no longer show the
Documents list or its actions (preview, download, add to email). Answers from this release on show
their documents in the Sources panel. Shared links never included these documents and still do
not.

- Integrations that read the chat stream directly (not the web app, the Outlook add-in or the
  browser extension, which ship with the server) receive what an answer found as one
  `sources/added` event. The `tool/progress` phase `citation` and the `webSources` field of
  `tool/completed` are gone.

**Before upgrading:** Nothing to change on the server. Let users know that documents listed under
older answers are not shown any more; asking the question again lists them in the Sources panel.
Custom clients of the chat stream need to read `sources/added` (see the SSE v2 documentation).
