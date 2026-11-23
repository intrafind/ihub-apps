# Breaking Changes — Unreleased

## Prompt Library: the App Generator Prompt Is Removed

The prompt **App Generator** (`app-generator`) is no longer part of the prompt library. It
prepared app drafts for the old **Generate with AI** wizard. The app builder of **New app** drafts
apps with iHub's own instructions, so the prompt steered nothing any more, yet every user saw it
on `/prompts`.

- An update deletes `contents/prompts/app-generator.json`, also a copy an administrator changed.
  A prompt with the ID `app-generator` stored under another file name is left alone.
- The endpoint `GET /api/admin/prompts/app-generator` is removed. Once the prompt is gone, the
  path answers 404 like any unknown prompt ID.
- New installations no longer ship the prompt.
- The answer of `POST /api/admin/apps/_generate` and `POST /api/apps/_generate` no longer has
  the field `brief`, which said whether a changed prompt prepared the draft.

**Before upgrading:** If you changed the App Generator prompt and want to keep its text, copy
`contents/prompts/app-generator.json` out of `contents/` first. Scripts that call
`GET /api/admin/prompts/app-generator` must stop doing so; there is no replacement.
