# Chat-based app builder (#3898): server part as built

**Date:** 2026-11-23 · **Plan:** [04-chat-builder-implementation-plan.md](04-chat-builder-implementation-plan.md)
· **Scope:** the server of slice 1 and what slice 2 needs from it. The client is not built yet.

This note says what exists, where, and where it differs from the plan, so the client work (or a
later server change) can start from here.

## Where things are

| What | File |
|---|---|
| Engine `reviseApp` (plan 2.3, steps 1 to 10) | `server/services/appRevision.js` |
| Brief, output rules, data blocks | `server/services/appGeneratorBrief.js` (`REVISE_BRIEF`, `revisionOutputRules`, `buildRevisionMessages`, `withoutBlockMarks`) |
| Shared model choice, catalogue, categories | `server/services/appGenerator.js` (`pickDraftModel`, `installationsFor`, `appCategoryIds`, `searchFor`, `baseLanguage`) |
| Keys, limits, warning codes, `applyRevisionPatch` (isomorphic, for the client) | `shared/appRevision.js` |
| Hidden-character strip (moved) | `shared/visibleText.js`; `server/validators/userAppSchema.js` re-exports it |
| Limiter constants | `shared/appGenerator.js` (`APP_REVISE_LIMITER`, `APP_REVISE_TURN_LIMIT`, `APP_REVISE_WINDOW_MS`) |
| Limiter | `server/middleware/rateLimiting.js` (`appReviseLimiter`, `resetAppReviseLimiter`) |
| Admin route, body parser, audit helper | `server/routes/admin/appBuilder.js` (`parseRevisionRequest`, `revisionAuditDetails`, `withClientAbort`) |
| Personal route | `server/routes/userAppRoutes.js` |
| `ETag` / `If-Match` on the admin app | `server/routes/admin/apps.js` |
| Feature `appBuilderChat` | `server/featureRegistry.js` |
| e2e model markers `e2e-revise-*` | `tests/config/e2e-llm-stub.mjs` (`APP_REVISE_MARKERS`) |

## Contract (both routes)

`POST /api/admin/apps/_revise` (content admins, feature `appGenerator`) and
`POST /api/apps/_revise` (signed in, `userApps` on, may create personal apps, feature
`appGenerator`). Both count against one limiter: 60 turns per user per hour, failed turns
included, counted only after the body passed validation.

Request: `{ draft, conversation, fields?, allowQuestions?, language? }` as in plan 2.2. Builder
entries may carry `kind` (`question`, `change`, `message`): **the client must send it back**,
because the server counts questions since the last change from it.

Response: `{ reply, text, question, patch, changed, suggestions, warnings, model }` as in plan
2.2. `patch` values are whole values; `null` removes a key. Merge with `applyRevisionPatch`.

Errors: `VALIDATION_FAILED` (pointer per member, e.g. `/conversation/2/text`),
`APP_REVISE_TOO_LONG` (400, `details: { field: 'system', max: 8000 }`), `RATE_LIMITED` with
`details.limiter: 'appRevise'`, `APP_GENERATOR_NO_MODEL`, `APP_GENERATOR_INVALID_ANSWER`,
`FEATURE_DISABLED`, `USER_APPS_DISABLED`, `PERMISSION_DENIED`, `FORBIDDEN`, `ABORTED`,
`QUOTA_EXCEEDED` and the model client's codes.

Admin app save: `GET /api/admin/apps/{id}` answers `ETag` (revision of the stored file);
`PUT` with `If-Match` answers 412 `PRECONDITION_FAILED` (`details.resource: 'app'`) and writes
nothing on a mismatch; without the header it behaves as before. The `PUT` answer carries the
new `ETag`. CORS already exposes `ETag`.

## Decisions taken while building (not in the plan, or made concrete)

1. **The model's answer format** is `{ reply, text, question: { text, choices }, change: { … } }`.
   A missing or unknown `reply` is inferred from what the answer holds.
2. **Untouched keys** are found by sanitising the current content and the proposal with the same
   sanitiser and comparing the results, so the sanitiser's own normalisation never shows up as a
   change of a hand-written app.
3. **Required texts** (`name`, `description`, `system`): an empty proposal is ignored, never
   applied. An optional text (`prompt`, `messagePlaceholder`) proposed as empty loses the
   request language; with no language left the patch holds `null`.
4. **`allowEmptyContent`** (admin only) is only ever switched on, when a new field went into the
   template; an admin's own `true` is never switched off by a turn.
5. **`fields`** also turns off proposals: with `fields`, the brief lists no web search and no
   catalogue, and `suggestions` is empty. `prompt` still follows `variables` when a new field
   needed a template line.
6. **The schema check** builds a full app from `newAppDefaults` plus the draft's content keys,
   applies the patch and counts only issues on patched keys: invalid content the author left
   untouched is the save's business, not the turn's.
7. **Starter languages** are matched by same title or message in the request language, then by
   position when the number of starters stayed.
8. **The personal route** requires the right to create personal apps (`mayCreate`), like
   `_generate`, which matches `generator` in `GET /api/apps/_config`.
9. **Block marks** are runs of three or more `<` or `>`; they are removed from data, single
   angle brackets stay. A `>>>` in an app's own text is therefore lost if the model writes that
   text back.
10. **`NO_CHANGE`** has `field: ''`.

## Not done here

Client (slice 1 and 2 UI), i18n keys `admin.apps.conversation.*`, docs and the release entry,
the Playwright specs. Only `apiErrors.APP_REVISE_TOO_LONG` was added to `shared/i18n/en.json` and
`de.json`, because the server test requires a message for every error code.
