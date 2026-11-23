# Chat builder: fixes after the review

**Date:** 2026-11-23 · **Builds on:** [`04-chat-builder-implementation-plan.md`](04-chat-builder-implementation-plan.md), [`05-chat-builder-server-implementation.md`](05-chat-builder-server-implementation.md) · **Status:** implemented

A reviewer checked the chat builder and found eight problems. This note says what each one was,
what changed, and where the test is, so the next person can pick up from here.

## 1. Publish made the next save fail with 412

**Problem.** `POST /api/admin/apps/{id}/_toggle` rewrites the app file, so the file's revision
changes. The editor kept the old revision, and its next Save, Apply or Undo was refused as if
someone else had saved.

**Fix.** For one app, the toggle now works like the save:

- The answer carries the app's new revision as `ETag`.
- An optional `If-Match` refuses the toggle with 412 when someone else saved in between. With
  several apps or `*`, `If-Match` is refused with 400.
- Only the `enabled` flag of the stored file changes (before, the cached app with all schema
  defaults was written back).

The editor sends its revision with Publish and Unpublish (`setPublished` in
`client/src/features/admin/components/app-editor/adminAppRequests.js`, through `toggleApp` in
`client/src/api/adminApi.js`) and keeps the answer's `ETag`. A 412 shows the editor's
"Changed by someone else" notice (`useAppPublishing` options `isConflict` / `onConflict`).

The other action of the editor page that rewrites the app file is a rollback from the change
history. The page now reloads the app after every rollback, which also loads the new revision.
Duplicate goes to the "New app" page and changes nothing here; the access cards write
`groups.json`, not the app file.

**Tests.** `server/tests/admin-app-if-match.test.js` (toggle block);
`tests/unit/client/app-conversation-panel.test.jsx` ("Publish and Unpublish keep the editor
revision"). The fake server in `tests/unit/client/helpers/appEditorHarness.jsx` bumps the revision
on `_toggle`.

## 2. GET could send an old body with a new revision

**Problem.** `GET /api/admin/apps/{id}` took the body from the cache and the `ETag` from the file.
Between a save and the cache refresh, or on another cluster worker, the two did not match.

**Fix.** The body and the `ETag` now come from one read of the stored file. The body is padded the
way the cache pads it (`prepareStoredResource` in `server/resourceLoaders.js`, which uses the same
`prepareItem` as the loader in `server/utils/resourceLoader.js`).

**Test.** `server/tests/admin-app-if-match.test.js` ("while the cache lags behind").

## 3. Removing block marks could create a new one

**Problem.** `withoutBlockMarks('<<>>><LATEST…')` removed `>>>` and joined `<<` and `<` into `<<<`.

**Fix.** Each run of three or more `<` or `>` becomes one space
(`server/services/appGeneratorBrief.js`).

**Test.** `server/tests/app-revision.test.js` ("never joins the neighbours …").

## 4. Content other than the instructions had no size limit

**Fix.** `assertRevisable` (`server/services/appRevision.js`) checks every content key the model
sees, in the language of the turn, against `REVISE_CONTENT_LIMITS` (`shared/appRevision.js`):

- personal apps: the limits of the personal-app schema (`USER_APP_LIMITS`);
- admin apps: their schema has no limits, so the table sets limits that every app in
  `server/defaults/apps` fits (checked by a test).

A request over a limit gets `400 APP_REVISE_TOO_LONG` with `details.field` (the content key) and
`details.max`, before the limiter counts it, on both routes. The client shows the old sentence for
`system` and a new one (`admin.apps.conversation.error.contentTooLong`) for every other key.

**Open point.** The admin limits are a choice made here, not a product decision. If an admin app
legitimately needs more (say, 15 input fields), raise the number in `REVISE_CONTENT_LIMITS.admin`.

**Tests.** `server/tests/app-revision.test.js` ("the limits of the content a turn reads"),
`server/tests/app-revise-route.test.js`.

## 5. The personal route could log the request body

**Problem.** Failures before the body was parsed (gate, feature switch, validation) wrote no audit
entry of their own, so the audit safety net wrote one with the first 500 characters of the body.

**Fix.** The failure handler of `POST /api/apps/_revise` audits every failure of a signed-in user,
like the admin route.

**Test.** `server/tests/app-revise-route-personal.test.js` ("the audit entry of a refused turn").

## 6. `de-DE` text was written back under `de`

**Fix.** `revisionLanguageKey` (`shared/appRevision.js`) picks the key a turn reads and writes: the
exact language when the value has text there, else the base language. The server writes under it
(also labels of input fields and starters), counts "other languages" the same way, and the
Improve dialog reads the same key.

**Tests.** `server/tests/app-revision.test.js` ("other languages"),
`tests/unit/client/app-editor-improve.test.jsx`.

## 7. An Undo that was running stayed "undoing" after a reload

**Fix.** `readConversation` maps `undoing` back to `applied` (and `applying` to `proposed`, as
before). **Test.** `tests/unit/client/app-revision-patch.test.jsx`.

## 8. Apply and Undo also saved other unsaved changes, unchecked

**Fix.** When the form has unsaved changes outside the content keys (`unsavedOutsideContent` in
`conversationState.js`), the change card says "Apply also saves your other unsaved changes in the
form." (or the Undo version). In the admin editor such an Apply or Undo first runs the form's
validity check, the same as Save (`saveValue(value, { checkForm })` in `useEditorSave.js`); a
form with errors is not saved, and the card says why. The personal editor's Save has no client
check, so only the line is shown there. (Superseded by R4 below: the check is now per change and
counts content keys too.)

**Tests.** `tests/unit/client/app-conversation-panel.test.jsx` ("with other unsaved changes in
the form"), `tests/unit/client/app-revision-patch.test.jsx`.

## Also done: `reviseApp` split into steps

SonarCloud rated `reviseApp` far over the complexity limit. It is now a short sequence of the plan's
steps: `readContent` (1, 2), `callModel` (4, 5), `interpretAnswer` (6) with `questionReply` and
`changeReply` (7 to 10). `changeOf` and `contentForModel` lost their nested parts the same way.
The behaviour is unchanged; the existing tests of `app-revision.test.js` guard it.

## Not changed

The personal route's `mayCreate` gate stays as it is; whether it should apply to revising is a
product question for the owner.

## Second review round (PR #3965)

A second review found the problems below. Each fix has a regression test.

### R1. An admin app was cut to the size of a personal app

**Problem.** A revision of an admin app ran the sanitiser with the draft limits (8 fields, 4
starters, a message template of 4,000 characters, a default of 200). A change that touched
`starterPrompts`, `variables` or `prompt` dropped starters and shortened texts the admin had
written.

**Fix.** `sanitizeGeneratedApp` takes `limits` (default `DRAFT_LIMITS`). `changeReply` in
`server/services/appRevision.js` passes the limits of the target
(`REVISE_CONTENT_LIMITS[target]` in `shared/appRevision.js`): the admin limits are those the owner
confirmed (12 fields, 12 starters, prompt 8,000, default 2,000, …). A draft of `_generate` keeps
`DRAFT_LIMITS`.

On the way, two more rewrites of untouched content were found and fixed: a field or starter the
model wrote back unchanged is now taken from the draft as it is, and a field's default that the
draft names by option value (`professional`) is no longer rewritten to the option's label.

**Tests.** `server/tests/app-revision.test.js`, "an admin app keeps its size": 6 starters, a
default of about 1,000 characters, a 6,000-character template, and every app in
`server/defaults/apps` round-tripped (a no-op change answers `NO_CHANGE`; rewording one starter or
field changes only that entry).

### R2. Keys the sanitiser does not know were dropped

**Problem.** `variablesWithLanguages` and `startersWithLanguages` built each entry from scratch,
so a field lost `description` and `placeholder`, a starter its `description`, `variables` and
`autoSend`.

**Fix.** `overEntry` starts each entry from the draft's entry it replaces (same field name; for a
starter the same title or message, else the same place) and overlays only the sanitiser's keys.
The other keys come from the draft only: the sanitiser never reads them from the model, and a new
entry has none. When a kept entry breaks the schema (a field the author is still typing, with an
empty label), `changeReply` builds the patch again with `keepDraft: false`, from the sanitiser
alone, as before this fix; only then does a schema failure answer 502.

**Tests.** `server/tests/app-revision.test.js`, "the author's own keys of a field or starter"
(`outlook-reply` with `autoSend`, the shipped fields with `placeholder`, an injected key, a new
entry).

### R3. LLMClient's connect timeout was reported as a slow answer

**Fix.** `CONNECT_TIMEOUT` (the providerCode of LLMClient's own connect ceiling) maps to
`connectionTimeout` in `server/services/loop/llmFailureCause.js`.

**Tests.** `server/tests/chat-failure-cause.test.js`, `server/tests/model-test-failure-messages.test.js`.

### R4. Apply and Undo saved unsaved content edits without saying so

**Problem.** `unsavedOutsideContent` ignored every content key, so an unsaved description went
with an Apply of the instructions unannounced, and the admin form check did not run.

**Fix.** It is replaced by `unsavedOutsideChange(form, saved, changeKeys)`: every key of form
and saved app counts, minus the keys the change itself writes (`changeKeysOf`: patch keys and
ticked suggestion keys before Apply, the keys Apply set after). Each `ChangeCard` computes it for
itself from the `saved` prop. `useConversation` passes `{ keys }` to `persist`, and the admin
editor's `persistFromConversation` runs `checkForm` when the result is true. The personal editor
passes `saved` only (its Save has no client check).

**Tests.** `tests/unit/client/app-conversation-panel.test.jsx` (an unsaved name before Apply; a
name edited after Apply, then Undo), `tests/unit/client/app-revision-patch.test.jsx`.

### R5. A change of a field's type or default showed no difference

**Fix.** `linesOf('variables', …)` writes one line per field with label, required, type, options
and default (`fieldLine` in `conversationState.js`; new i18n keys
`admin.apps.conversation.line.default` and `.typeBoolean`).

**Test.** `tests/unit/client/app-revision-patch.test.jsx` ("a field line names the type and the
default").

### R6. A second Bedrock wizard run moved every Bedrock model

**Fix.** Each imported Bedrock model stores the region it was listed in as its own
`config.region` (`buildImportedModelConfig` option `region`, used by the wizard and the import
dialog). The wizard sets the provider's region only when the provider has none. The region field
is prefilled with the effective region: `GET /api/admin/providers` (and `/:providerId`) now sends
the read-only `effectiveRegion` on the Bedrock entry (provider region, else a valid
`AWS_REGION` / `AWS_DEFAULT_REGION`); provider saves drop it. `docs/models.md` and the release
note say so.

**Tests.** `tests/unit/client/provider-connect-utils.test.jsx`, `server/tests/llm-provider-links.test.js`
("the effective region of the Bedrock provider").

### R7. An invalid Bedrock region silently sent data to another region

**Fix.** `BedrockAdapter.resolveRegion` skips only empty sources. The first source that is set
decides; when it is not a region, the call fails with an `LLMError` `INVALID_REQUEST`, providerCode
`BEDROCK_REGION_INVALID`, whose message names the value and its source. No failure-cause key fits
a configuration error, so none was added: an admin sees the message in the model test and the
chat, other users the generic "model call failed". Saving a Bedrock model with an invalid
`config.region` answers 400 (`normalizeBedrockModelRegion` in `server/routes/admin/models.js`).

**Tests.** `server/tests/bedrock-model-discovery.test.js` ("a set but invalid region is a
configuration error"), `server/tests/llm-provider-links.test.js` ("the region of a Bedrock
model").

### R8a. A change without a sentence did not reset the question count

**Fix.** `wireConversation` keeps a builder `change` entry even with empty text; the route
already accepts an empty builder text. **Test.** `tests/unit/client/app-revision-patch.test.jsx`.

### R8b. The run ledger kept the raw failure text

**Problem.** `LLMClient._recordError` wrote `err.message` (socket text with the host, a
provider's body) into the ledger's `error` event, which a run's non-admin owner replays through
`GET /api/runs/:runId/events`.

**Fix.** The ledger records `ledgerErrorMessage(err)` (`llmFailureCause.js`): the cause's
headline (`Network error`, `Connection timeout`, …) or `The model call failed (<code>)`. The raw
text goes to the server log (`Model call failed`, warn). The comments in `ChatService.js` and
`chatErrors.js` say so.

**Test.** `server/tests/runsEventsLedgerErrorRoute.test.js`.

## Known limits

- `rebaseModelUrl` (`server/routes/admin/providers.js`) swaps the provider's whole old base for
  the new one, path included: when an admin changes the path of a base (`/v1` to `/v2`), every
  linked model URL under it moves to the new path too, which is right for a moved gateway but
  not when only the listing path changed; there was no minimal safe fix, so it is noted here.
