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
| Form glue | `client/src/features/admin/hooks/useAdminFormErrors.js` | Wraps the visibility hook, merges messages the page passes in (`extraErrors`, e.g. server errors) and reports `{ isValid, errors, displayed }` (`validationReport()`) to `onValidationChange` when the problems change. Shared by the four forms so each keeps only its own rules (it also keeps SonarCloud's duplication gate green). |
| Frame | `client/src/features/admin/components/AdminFormErrorFrame.jsx` | `FormValidationProvider` + the element with `controlHandlers` + the summary after a save attempt. `summaryErrors` lets a form name entries its own way (the prompt form's "Variable 2 — Name"). |
| Inline messages | `fieldErrorId()` / `fieldErrorAttributes()` in `fieldErrors.js` | A field's message has the id `<field>-error`; the input gets `aria-invalid` and `aria-describedby` pointing to it. Inline messages are **not** live regions. |
| Clone ID | `client/src/features/admin/utils/copyId.js` | `copyId(id, takenIds)` → `<id>-copy`, `<id>-copy-2`, … The model and prompt lists pass it as `location.state.cloneId`; the edit pages put it into the ID field. The workflow list saves the clone directly under that ID. |
| Asterisk | `client/src/features/admin/components/RequiredMark.jsx` | The one required marker. Never put `*` into a label text. |
| Summary focus | `AdminFormErrorSummary.jsx` (`focusKey`) | A new value moves the focus to the banner. |
| Summary order | `AdminFormErrorSummary.jsx` (`orderByDocument`) | Before paint (layout effect) the entries are sorted by the document order of their field elements (same lookup as the click-to-focus links). Entries without an element on the page come last, in the given order. Works for every form that uses the summary, so no per-form order list is needed. |
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
server adds the refused ID to that list, so the message appears at the ID field. Any other save
error of the model and prompt pages is shown above the form (`AdminLoadError` / save error box) and
is not re-thrown (a re-throw ended as an unhandled rejection in the console).

Save attempts are counted per routed resource (`hooks/useSaveAttempts.js`): moving to another
model, prompt, group or user, or to a blank "new" form, starts at 0 again, so that form opens
clean. A 409 on create in the JSON mode (no form on screen) also sets the page error "This ID is
already taken." (`FIELD_KEYS.idTaken`); in form mode the message stays at the ID field.

Draft model: `PlatformConfigProvider` passes `appGenerator` through to `platformConfig`, so the
create pages hand the configured model to `DescribeSlot` (`configuredModelId`). Admin → Features
re-reads the shared configuration (`refreshConfig`) when any of its two writes went through.

Screen readers: only the focused summary is an alert. `DynamicLanguageEditor` renders its `error`
line without `role="alert"` and links it to its inputs (`aria-describedby`). Forms without a
summary pass `announceError` to keep the line announced: project settings dialog and form,
integration builder (Basics step), document template page. The app editor passes no `error` to
`DynamicLanguageEditor` (it marks fields through the context only) and has its own summary.

User form texts: `FIELD_KEYS.usernameRequired`, `usernameFormat`, `passwordRequired`,
`passwordMinLength`, `passwordMismatch` ("Enter a username." / "Geben Sie einen Benutzernamen
ein."); an invalid email uses `RULE_KEYS.email`. The old `admin.users.validation.*` keys were
removed (nothing else used them). The email is optional in the user schema, so there is no "Enter
an email address." text.

## Open points

- Other admin forms (providers, workflows, integrations) do not use these pieces yet.
- The app editor (`AppFormEditor`) still validates on mount; it edits saved apps only, so it opens
  clean in practice.
- Groups have no Clone action, so there is no clone ID for them.
- The workflow clone appends an English " (Copy)" to every language of the name.
- The prompt form's "Opens in app" message is not linked to the app picker
  (`SearchableAppsSelector` has no input to put `aria-describedby` on).
