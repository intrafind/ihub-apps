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
