# Admin form errors after touch or save

Status: implemented (finding AI-B16 / AI-UX5 of
[the admin UI review](admin-ui-review-2026-11/02-apps-models-prompts.md), epic #3741).

## Problem

The model, prompt, group and user editors validated on every render, including the first one. A
blank "new" form opened with a red summary, a second "Validation Summary" box from
`DualModeEditor`, and raw Ajv sentences ("id must be at least 1 characters"), in English even in
the German UI. Labels passed to `DynamicLanguageEditor` contained a literal `*`, and the component
adds its own, so they read "Name \* \*".

## How it works now

| Piece | File | Job |
| --- | --- | --- |
| Rule texts | `client/src/features/admin/utils/fieldErrors.js` | Turns `validateWithSchema` errors (keyword + params) into translated sentences. `RULE_KEYS` are generic, `FIELD_KEYS` are field-specific ("Enter an ID."). `schemaFieldErrors()` gives one message per field; a required localized text without any text gets one message at the field (`name`), not one per language. |
| Visibility | `client/src/features/admin/hooks/useFieldErrorVisibility.js` | Keeps the set of touched top-level fields. A blur or change of an input/textarea/select inside the form marks its `data-field` / `name` / `id`. Returns only the errors of touched fields, or all of them when `showAll` is set. |
| Asterisk | `client/src/features/admin/components/RequiredMark.jsx` | The one required marker. Never put `*` into a label text. |
| Summary focus | `AdminFormErrorSummary.jsx` (`focusKey`) | A new value moves the focus to the banner. |
| Editor frame | `DualModeEditor.jsx` | When the form reports `displayed` in its validation state, the red "Validation errors" mark follows it and the bottom "Validation Summary" box is not shown in form mode. Forms that do not report `displayed` (app editor, platform form) behave as before. |

Each form (`ModelFormEditor`, `PromptFormEditor`, `GroupFormEditor`, `UserFormEditor`) exports a
pure `<x>FieldErrors()` function, spreads `controlHandlers` on its root element and reports
`{ isValid, errors, displayed }`. The summary renders only when `showAllErrors` is true.

Each page (`Admin{Model,Prompt,Group,User}EditPage`) keeps `formValidation`, `editorMode` and
`saveAttempts`. A submit in form mode with an invalid form only increments `saveAttempts` (which
sets `showAllErrors` and `summaryFocusKey`). The `<form>` has `noValidate`, so the browser bubble
does not pre-empt the summary; model and prompt pages call `reportValidity()` after their own check
for the remaining native constraints (provider-specific required fields). JSON mode still saves and
lets the server answer.

Duplicate IDs: model, prompt and group pages pass `takenIds` (the loaded list). A 409 from the
server adds the refused ID to that list, so the message appears at the ID field.

## Open points

- Summary order follows the schema, not the visual order of the model form (API Model ID comes
  before Name).
- The user form keeps its existing password texts ("Username is required"), which are translated
  but not phrased as instructions.
- Other admin forms (providers, workflows, integrations) do not use these pieces yet.
- The app editor (`AppFormEditor`) still validates on mount; it edits saved apps only, so it opens
  clean in practice.
