# Fixes — Unreleased

## The Admin Area Is Fully Translated into German

The admin area is fully translated into German. Many labels, hints, breadcrumbs, dialogs and
messages still appeared in English when the admin language was German, including the "History"
button of the model editor and the user, group and authentication settings.

- German text uses one term per concept, matching the admin navigation: "Anbieter" for model
  providers, "Tool" for the functions a model calls, "Benutzer" for users.
- These texts can now also be changed under **Admin → Customization → Localization**, which only
  offers keys that exist in the built-in translations.

## New Model, Prompt, Group and User Forms No Longer Open with Errors

**Admin → Models → Add model** and **Admin → Prompts → Add prompt** opened with a red error box,
a second list of the same errors and messages such as "id must be at least 1 characters", in
English even in the German admin area. Required labels showed two asterisks. The forms for a new
group and a new user also opened with errors.

- A blank form shows no errors. A field says what is wrong once you leave it or change it, and the
  first click on save lists every open point in one summary at the top, with links to the fields.
- Messages are short instructions in the admin language, such as "Enter an ID." or "Use only
  lowercase letters, numbers, dots, underscores and hyphens."
- An ID that another model, prompt or group already uses is reported at the ID field while you
  type. **Clone** of a model, prompt or workflow proposes the ID `<id>-copy` (or `<id>-copy-2`, …
  when that one is taken) instead of an empty ID or an ID that already exists.
- Required fields carry one asterisk; the prompt description is now marked as required, as the
  server always required it.

## Admin: Connection Errors Say What to Fix, and Failed Loads Are No Longer Empty Lists

- **Model Test and Import models** show the upstream HTTP status, the host and the error code,
  with a line on what to check: a rejected or missing key, a wrong URL path, a failure on the
  endpoint itself, or a host that cannot be reached. An untrusted certificate (private CA or
  self-signed) is named as such, with a link to the SSL whitelist under **Security**.
- Testing a disabled model on a server that needs no key (vLLM, LM Studio) no longer fails with
  "API key not found".
- **A list that fails to load** (Providers, Apps, Models, Prompts, Agents) shows the error with
  **Retry** and keeps what was already loaded, instead of "No … yet, create your first".

## Admin: Visible Fields, Phone Layout and Labels

- Form fields have a visible border, padding and background everywhere, in light and dark mode,
  and every label is linked to its field. The provider pages use the same fields and buttons as
  the rest of the admin.
- On phones, the model and prompt editor headers are no longer hidden behind the form, the
  Providers list keeps its actions on screen, and all Prompts tabs fit.
- The Apps and Prompts lists show one **All Categories** chip and the category an item is listed
  under instead of "N/A". Apps without a preferred model say **Default model**, and a prompt
  linked to an app that no longer exists says so.
- **Groups can be cloned** like models and prompts (without their external group mappings). A
  cloned workflow keeps its name. The provider form no longer has the **Provider Enabled**
  checkbox, which had no effect, and the Providers list no longer shows a **Disabled** badge for it.
- A model save the server refuses brings its error into view.

## Models Follow a Change of Their Provider's Base URL

Changing a provider's **Base URL** under **Admin → Models → Providers** left its models on the
old address: each model keeps its own **API URL**, built from the base URL when it was imported
or connected, so chat requests still went to the old endpoint.

- Saving a new base URL now moves every model linked to the provider whose **API URL** starts
  with the old base URL to the new one; the rest of the URL is kept. Each moved model gets an
  entry in its change history and in the audit log.
- The provider page says how many linked models now use the new address and lists any linked
  model it left alone because its **API URL** points elsewhere, with a link to change it.

## Group Saves No Longer Overwrite Each Other

When two administrators saved the same group at nearly the same time, or the **Connect a
provider** flow granted its models to a group while someone edited it, one of the changes was
lost without a word.

- The group editor now saves only if the groups have not changed since it opened. Otherwise it
  says **Changed by someone else**, saves nothing and keeps your edits; **Reload** loads the
  current version.
- The **Connect a provider** flow reads the groups again and retries once when another save got
  there first, so it keeps the other change and still grants its models.
- For scripts: `GET /api/admin/groups` returns an `ETag`; send it as `If-Match` with
  `PUT /api/admin/groups/{groupId}` to get `412` instead of overwriting a newer change.
