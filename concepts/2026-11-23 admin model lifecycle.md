# Admin model lifecycle (review findings AI-B9, B12, B13, B21, B23, recommendation 9)

Implementation notes, so the next person can pick this up without the review report.

## What changed and where

| Finding | What the admin sees now | Server | Client |
| --- | --- | --- | --- |
| AI-B9 | The app editor's Preferred Model, Allowed Models and Magic Prompt model list every chat model of the admin model list, marked "(disabled)" or "(default)". A content admin (no `GET /api/admin/models`, 403) still gets the models they may use. | none | `app-editor/adminAppRequests.js` (`fetchEditorModels`), `app-form/modelChoices.js`, `ModelSection.jsx`, `MagicPromptSection.jsx`, `AdminAppEditPage.jsx` (`noModel` = no enabled model) |
| AI-B12 | Deleting a model or an app first lists what names it, and says the copy stays in the change history. The page of a deleted model or app offers "Restore from History". | `GET /api/admin/models/{id}/_dependants`, `GET /api/admin/apps/{id}/_dependants`, both built on `server/utils/resourceDependants.js` | `utils/deleteDependants.js`, `AdminModelsPage.jsx`, `AdminAppsPage.jsx`, `hooks/useDeletedResourceRestore.js`, `ChangeHistoryDrawer.jsx` (`onRestored`) |
| AI-B13 | When the server makes a model the default on its own, a toast names it (list, and after a save in the editor). | Header `Default-Model-Assigned` (URI-encoded id) on create, update, `_toggle`, delete of a model; exposed through CORS | `adminApi.js` (`assignedDefaultModelId`, `toggleModels` adds `assignedDefaultModelId`), `AdminModelsPage.jsx`, `AdminModelEditPage.jsx` (hands it to the list via navigation state) |
| AI-B21 | Setup step 1 is done for a keyless endpoint the admin set up (a custom provider, or a built-in one with a base URL). The shipped `local` entry without a URL still does not count. | none | `utils/modelsArea.js` (`getSetupSteps` takes `providers`), `ModelsSetupStrip.jsx` |
| AI-B23 | The API key hint states the lookup order: model key, provider key, model env var, provider env var, with the real variable names. | none (order is `inspectModelApiKey` in `server/utils.js`) | `ModelFormEditor.jsx` (`apiKeyLookupHint`) |
| Rec. 9 | Enable switch per row, "Make default" row action (enabled chat models only), Test button in the model editor (tests the saved model). | `POST /api/admin/models/{id}/_make-default` (409 disabled, 400 not chat) | `AdminModelsPage.jsx`, `AdminModelEditPage.jsx`, `components/ModelTestResult.jsx`, `utils/modelTestMessages.js` (`runModelTest`) |

## Decisions

- **Warn, never block.** No reference breaks the server: an app whose model is gone falls back to the
  default model; a group entry naming nothing grants nothing. The provider delete is different (it
  refuses with `PROVIDER_IN_USE`) because its models would silently lose their key.
- **Groups are read from the authored `groups.json`**, not from the cache: the cache's groups carry
  their parents' permissions, so every child would look like it lists the item.
- **A header for the auto-assigned default**, because delete answers `204` without a body and a
  member in the created model's body would look like a model field.
- **"Which model takes over"** in the dependants answer is the first enabled chat model of the
  cache's list. When the stored files carry no default flag the config loader promotes in file
  order, so in rare cases another model takes over; the header after the delete tells the truth.
- **Keyless step 1**: the earlier rule ("a keyless endpoint does not count by itself") existed so a
  fresh install does not look half done because of the shipped keyless `local` provider. The new
  rule keeps that and counts endpoints the admin actually configured.

## Tests

- Server: `server/tests/admin-model-lifecycle.test.js`, `server/tests/admin-app-dependants.test.js`.
- Client: `tests/unit/client/admin-model-lifecycle.test.jsx` (list page),
  `admin-model-lifecycle-utils.test.jsx` (helpers), `admin-deleted-restore.test.jsx` (404 restore and
  editor Test), additions in `models-area-utils.test.jsx` and `admin-app-editor-save-and-test.test.jsx`
  (`appEditorHarness.jsx` now answers `GET /admin/models` with `adminModels` or 403).

## Open points

- The model editor's "Apps Using This Model" box still counts only `preferredModel`; it could use the
  dependants endpoint.
- Content admins cannot read the change history (`adminAuth`), so they are not offered the restore.
