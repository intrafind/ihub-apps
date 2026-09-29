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
