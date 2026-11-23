# Breaking Changes — 5.7.5

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

## Access: Anonymous Visitors Use Only the Default Model

The group **Anonymous** now grants the Chat app and **the default model**: whichever model is
marked as the default on the Models page. Before, it named its models (`gemini-flash-latest` and
`local-vllm`). Every signed-in user inherits **Anonymous**, so those models were granted to
everyone and could not be limited to a smaller group, such as HR.

- A group's model list can hold the new entry **Default model (whichever is set as default)**,
  `"@default"` in `groups.json`. It grants the model that is the default at that moment and moves
  with it when you make another model the default. **All (\*)** still grants every model.
- An update changes the **Anonymous** model list to `["@default"]` only if it is still a shipped
  list: `gemini-flash-latest` and `local-vllm`, or `gemini-flash-latest` alone. A list you changed
  stays as it is; the server log says that it was left alone.
- After the update, anonymous visitors on such an installation can use only the default model.
  Signed-in users keep their models through their other groups (**All (\*)** on a new
  installation).
- **Who can use this model** and **Why can't someone see this?** show a grant through this entry
  as "as the default model". **Restrict access** leaves the entry alone and says when the model
  stays usable through it.

**Before upgrading:** If anonymous visitors should keep a model that is not the default, add it to
the group **Anonymous** under **Access & Identity → Groups → Permissions → Models** after the
update.
