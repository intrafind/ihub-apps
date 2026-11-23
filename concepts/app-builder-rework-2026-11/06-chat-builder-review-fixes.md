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
check, so only the line is shown there.

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
