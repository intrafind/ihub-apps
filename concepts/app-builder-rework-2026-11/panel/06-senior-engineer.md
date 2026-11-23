# App builder rework: Senior Software Engineer

Panel report, 2026-11-20. Branch `claude/optimistic-bell-otjhc9`. Paths are relative to the
repository root. I did not read the other panel reports.

## Summary

Today there are two creation implementations, and each carries its own copy of the defaults.
The modal wizard (`client/src/features/apps/components/AppCreationWizard.jsx`, 1,667 lines)
and the editor in "new" mode (`AdminAppEditPage.jsx:82-154`) disagree on `preferredStyle`,
greeting, upload and input mode. AI generation runs in the browser against a generic LLM proxy
and trusts the answer.

I propose seven things, all additive on the HTTP API:

1. **One creation page** at `/admin/apps/new`, used by the button, Cmd+K, the setup wizard and
   Duplicate. It has two stages: "Start from" and "Essentials". It ends in the full editor of
   the new app with the Test panel open. The modal wizard and the template picker are deleted.
2. **One source of defaults**: `shared/appDefaults.js`, imported by the create page, the editor
   and the server generator.
3. **A server endpoint for AI generation**: `POST /api/admin/apps/_generate`. The server builds
   the brief, calls the model, sanitises the answer with an allowlist, validates it against the
   app schema and returns an unsaved app. The browser no longer parses model output.
4. **Ids are derived from the name** by a shared helper and checked against existing ids. The
   field moves into a collapsed "Technical name" row. The server stays the authority (409).
5. **A shipped template gallery** read from `server/defaults/apps` through
   `GET /api/admin/app-templates`. "Duplicate an existing app" is a separate start option and
   writes no lineage fields.
6. **A model list for content admins**: `GET /api/admin/app-models`. It fixes AI-B9 and lets the
   create page say "no model is set up" instead of producing an app that cannot answer.
7. **The editor keeps one page** but groups its 21 sections into seven collapsible groups with a
   sticky index and save bar, as the earlier panel resolved (Review:332).

No config migration is needed. No endpoint is removed. Seven work slices with disjoint files are
listed in the proposal.

The one thing I recommend **not** doing in this session is "test a disabled app as admin". The
app lookup that hides disabled apps has 45 call sites outside the admin routes. A partial change
ships a test chat in which export, tools or voice fail differently from the real app.

## Findings

Each finding is verified in code.

**F1. Two default sets.** The wizard draft uses `preferredStyle: 'normal'`
(`AppCreationWizard.jsx:40`). The editor uses `'keep'` and adds a greeting in en+de, an upload
block and a microphone block (`AdminAppEditPage.jsx:82-154`). The schema accepts any string for
`preferredStyle` (`server/validators/appConfigSchema.js:611`), so nothing catches the drift.

**F2. Two cleaning functions.** The wizard uses `buildAppPayloadFromWizard`
(`client/src/features/admin/utils/appWizardPayload.js:92-121`). The editor uses a local
`cleanAppData` (`AdminAppEditPage.jsx:257-324`). The test for the second one re-implements the
function inline instead of importing it (`tests/unit/client/admin-app-cleanup.test.jsx:8`), so
it tests a copy.

**F3. AI generation is a browser feature on top of a generic proxy.** The client fetches the
brief (`server/routes/admin/prompts.js:559-584`), posts it to `POST /api/completions`
(`prompts.js:1558-1630`) and parses the answer with a non-greedy regex. The allowlist of fields
exists only in the client (`shared/appGenerator.js:21-36` covers integrations; the rest is
inline in the wizard). `POST /api/completions` accepts any `messages` and any model id and sits
outside `/api/admin`, so the admin rate limiter (`server/middleware/setup.js:635`) does not
cover it.

**F4. The generator prompt can disappear.** The route answers 404 when the `app-generator`
prompt was deleted or disabled (`prompts.js:571-573`). The prompt is ordinary library content
that any content admin can edit.

**F5. The generator has no model fallback and reports failures wrongly.** No default model gives
400 "No model specified and no default model configured" (`prompts.js:1577`). The wizard shows
"Network error". A fresh install has no model at all (live walkthrough).

**F6. Ids.** The schema pattern is lower case, at most 50 characters
(`shared/validationPatterns.js:15-17`). The route helper `assertValidId` alone allows upper
case. Three id helpers already exist and none is shared with the app pages:
`slugify` in `client/src/features/admin/components/integrations/builder/builderModel.js:112`,
`slugify` in `shared/modelImportConfig.js:27`, and `toAppId` / `isValidAppId` / `suggestAppId`
in `server/services/integrations/exampleApps.js:55-91`. Nothing reserves the ids `new`,
`templates` and `integration-status`, although the routes `GET /api/admin/apps/templates`
(`apps.js:355`) and `/admin/apps/new` shadow them. An app with id `new` can be created and then
never edited.

**F7. Create is atomic already.** `configStore.createJson` is create-only
(`server/routes/admin/apps.js:728-735`), so two concurrent creates cannot both win. Id
uniqueness needs no new server mechanism, only a better client.

**F8. Templates are live apps.** `GET /api/admin/apps/templates` returns every enabled app with
its full configuration (`apps.js:355-363`). `server/defaults/apps` holds 27 shipped apps; they
are copied into `contents/` once (`server/utils/setupUtils.js:195`) and can be changed or
deleted there. The shipped files themselves are always readable from the package.

**F9. Content admins cannot read the admin model list.** `GET /api/admin/models` uses
`adminAuth` (`server/routes/admin/models.js:404`). The app pages therefore use the public,
permission-filtered `fetchModels()` (`AdminAppEditPage.jsx:51`).

**F10. Disabled apps are invisible to the whole chat path.** `configCache.getApps()` filters
`enabled !== false` (`server/configCache.js:887-905`). I count 45 calls of `getApps(` /
`getAppsForUser(` outside admin routes, tests and migrations, among them
`routes/chat/sessionRoutes.js:1100`, `:1336`, `routes/chat/conversationRoutes.js:80`,
`services/chat/ChatService.js:1965`, `routes/generalRoutes.js:343`, `routes/exports.js:49`,
`routes/magicPromptRoutes.js:54`, `routes/voiceRoutes.js:84`. `AppTestPanel.jsx:216-225` shows a
message instead of a chat for a disabled app.

**F11. The wizard is imported in exactly one place.** `AdminAppsPage.jsx:792-799`. Deleting it
touches that page, three unit tests (`app-wizard-locale-keys`, `app-wizard-payload`,
`app-creation-wizard-overridden-fields`) and the baseline
`tests/unit/client/translation-keys-baseline.json`, which fails when it lists a file that no
longer exists.

**F12. No new top-level route is needed.** `/admin/apps/new` already matches
`admin/apps/:appId` (`client/src/App.jsx:559`). An explicit child route placed before it changes
no entry in `KNOWN_ROUTES`.

## Proposal

### 1. Target flow

```
/admin/apps  --"Create app"-->  /admin/apps/new            (AdminAppCreatePage)
             --row "Duplicate"-> /admin/apps/new?from=<id>
Cmd+K "New App", SetupWizard --> /admin/apps/new

Stage 1  Start from:  Describe it (AI) | Template | Copy an existing app | Blank
Stage 2  Essentials:  name, description, icon, colour, instructions, model
                      collapsed: Technical name (id), category, content language
Create   POST /api/admin/apps  ->  navigate('/admin/apps/<id>?created=1')
Editor   opens with the Test panel open and a short "next steps" notice
```

Every start option fills the same draft object and lands on the same Essentials form. There is
no second copy of variables, upload or advanced settings: those live in the editor only. This is
W2 from the review (Review:242-250) with step 3 merged into step 2, because "Everyone or groups"
depends on the open owner decision 1.

### 2. Shared modules (the contract every slice codes against)

**`shared/appDefaults.js`** (new; imported by client and server, like `shared/appGenerator.js`)

```js
export const DEFAULT_APP_COLOR = '#4F46E5';
export const DEFAULT_APP_ICON = 'chat-bubbles';
export const DEFAULT_APP_CATEGORY = 'utility';

/** A complete new chat app. `language` is a base language such as 'de'. */
export function newAppDefaults(language = 'en') { … }
// id '', type 'chat', order 0, name/description/system { [language]: '' },
// color, icon, preferredOutputFormat 'markdown', preferredStyle 'keep',
// enabled true, variables [], starterPrompts [], greeting en+de,
// allowEmptyContent false, sendChatHistory true, category 'utility',
// inputMode and upload exactly as AdminAppEditPage.jsx:82-154 has them today.

/** What is sent to POST/PUT: today's cleanAppData plus the empty-language rules. */
export function cleanAppForSave(app) { … }
```

`cleanAppForSave` is `cleanAppData` moved out of `AdminAppEditPage.jsx:257-324`, extended by the
two rules from `buildAppPayloadFromWizard`: drop empty languages of `name`, `description`,
`system`; drop `messagePlaceholder` and `prompt` when no language has text. The editor and the
create page both call it. `preferredStyle` becomes `'keep'` everywhere; this changes what new
apps from the short flow store, and nothing for existing apps.

**`shared/appId.js`** (new)

```js
export const RESERVED_APP_IDS = ['new', 'templates', 'integration-status'];
export function slugifyAppId(text)            // 'Zusammenfassung für Ärzte' -> 'zusammenfassung-fuer-aerzte'
export function isValidAppId(id)              // pattern, length, not reserved
export function uniqueAppId(base, isTaken)    // base, base-2, base-3 …; '' -> 'app', then suffix
```

`slugifyAppId` does NFKD, maps ä/ö/ü/ß to ae/oe/ue/ss before stripping marks, lower-cases,
replaces every other run with `-`, trims `-._` at both ends and cuts to
`APP_ID_MAX_LENGTH`. A name without Latin letters (for example Japanese) gives `''`; then
`uniqueAppId` starts from `app`. `server/services/integrations/exampleApps.js` keeps its own
helpers in this session; folding them into the shared module is a follow-up (different owner,
`adminAuth` code path, no user benefit today).

**`client/src/features/admin/utils/appDraft.js`** (new; replaces `appWizardPayload.js`)

```js
export function contentLanguage(uiLanguage, platformDefault) // was wizardLanguage
export function appCategoryOptions(uiConfig, current)        // moved unchanged
export function draftFromBlank(language)
export function draftFromTemplate(template, { language, takenIds })
export function draftFromExistingApp(app, { takenIds, copyLabel })
export function draftFromGenerated(generatedApp)             // server result, already clean
export function buildCreatePayload(draft)                    // cleanAppForSave + id check
```

`draftFromExistingApp` deep-copies the app, removes `parentId`, `inheritanceLevel`,
`overriddenFields`, sets `allowInheritance` aside, appends the localized " (copy)" to every
language of `name`, sets `enabled` from the page's switch and derives a free id from the source
id (`summarizer` -> `summarizer-copy`, `summarizer-copy-2`). This is the "Duplicate without
lineage" resolution (Review:215). Existing apps keep their lineage fields; the schema still
accepts them (`appConfigSchema.js:734-737`).

### 3. Server

All three new routes go into one new file, **`server/routes/admin/appBuilder.js`**, registered
in `server/routes/adminRoutes.js` before `registerAdminAppsRoutes`. All use `contentAdminAuth`
and sit under `/api/admin`, so `adminApiLimiter` applies. Errors are thrown as `ServiceError`.

#### 3.1 `POST /api/admin/apps/_generate`

`_generate` is an action on the collection (api-guidelines: `POST /tasks/_preview` pattern). It
creates nothing, so it answers 200, not 201.

Request:

```json
{ "description": "Summarise a text in plain language", "language": "de" }
```

- `description`: string, trimmed, 10 to 4,000 characters. Otherwise 400 `VALIDATION_FAILED`.
- `language`: optional base language; default `platform.defaultLanguage`. The answer's texts are
  stored under this language only. This removes the three independent language selects.
- No `model` and no `messages` in the body. The caller cannot choose the model or the system
  message.

Response 200:

```json
{
  "app": { "id": "plain-summary", "name": { "de": "…" }, "system": { "de": "…" }, "…": "…" },
  "warnings": [
    { "code": "CATEGORY_REPLACED", "field": "category", "detail": "Unknown category 'business'" }
  ],
  "model": "gpt-5"
}
```

`app` is a complete, schema-valid, unsaved app: `newAppDefaults(language)` plus the sanitised
answer. The client can POST it unchanged. `warnings` lists everything the sanitiser dropped or
replaced; the client shows them in plain words and they make the behaviour testable.

Errors (problem+json):

| Situation | Status | `code` |
|---|---|---|
| Body invalid | 400 | `VALIDATION_FAILED` |
| No enabled model that can be used | 409 | `APP_GENERATOR_NO_MODEL` (new) |
| Model call failed | as today | the `LLM_API_ERROR_CODES` thrown by `llmClient` |
| Answer is not JSON, or nothing usable is left after sanitising | 502 | `APP_GENERATOR_INVALID_ANSWER` (new) |

Both new codes go into `shared/apiErrors.js` with en+de texts. The client branches on `code`:
for `APP_GENERATOR_NO_MODEL` it shows "No AI model is set up" with a link to `/admin/models`.

Implementation, in **`server/services/appGenerator.js`** (extended; pure functions except the
last one):

```js
export function pickGeneratorModel(models)
// the enabled model with default: true, else the first enabled model that is not an
// image/speech/embedding model; undefined when none.

export function generatorPrompt(storedPrompt, shippedPrompt, language, defaultLanguage)
// the library prompt 'app-generator' when it exists and is enabled, else the shipped
// server/defaults/prompts/app-generator.json. No more 404 (F4).

export function outputRulesBlock({ categories, language })
// appended by the server after the INTEGRATIONS block: the allowed keys, the category ids
// from ui.json, "write every text in <language>", "do not set preferredModel".

export function extractJsonObject(text)
// JSON.parse; else strip a ```json fence; else the substring from the first '{' to its
// balanced closing '}' (string-aware scanner, not a regex). Returns undefined on failure.

export function sanitizeGeneratedApp(raw, { language, categories, installed, isTaken })
// -> { app, warnings }

export async function generateApp({ description, language, user })
// brief -> llmClient.complete -> extractJsonObject -> sanitizeGeneratedApp
// -> appConfigSchema.safeParse -> { app, warnings, model }
```

The model call is `llmClient.complete({ modelId, messages: [system brief, user description],
options: { maxTokens: 4096, responseFormat: 'json' }, retries: 0, telemetry: { kind: 'utility',
purpose: 'app-generator', user } })`. It goes through `LLMClient`, so the proxy and the SSL
whitelist rules are already honoured; no new outbound connection is written. The user's text is
only ever the user message.

`sanitizeGeneratedApp` rules. Anything not listed is dropped.

| Field | Rule |
|---|---|
| `name`, `description`, `system` | String or localized object -> `{ [language]: text }`, trimmed. Caps: 80 / 300 / 8,000 characters. Missing `name` or `system` -> the endpoint fails with `APP_GENERATOR_INVALID_ANSWER`. Missing `description` -> first sentence of the request text. |
| `id` | Ignored. The server sets `uniqueAppId(slugifyAppId(name), isTaken)`. |
| `category` | Kept when it is an id in `ui.json` `appsList.categories.list`; else `DEFAULT_APP_CATEGORY` plus a warning. |
| `color` | Kept when it matches `#RRGGBB`; else the default. |
| `icon` | Kept when it matches `/^[a-z0-9-]{1,40}$/`; else the default. The client's `IconPicker` shows whether it resolves. |
| `messagePlaceholder`, `prompt` | Optional, same localisation, 300 / 4,000 characters. |
| `variables` | At most 8. `name` must match the schema's name pattern, be unique, and appear as `{{name}}` in `prompt` or `system`; else dropped. `type` in string, text, number, boolean, date, select; else `string`. `label` -> `{ [language]: text }`, falling back to the name. `select` needs at least one predefined value, else it becomes `string`. Only `name`, `label`, `type`, `required`, `defaultValue`, `predefinedValues` are copied. |
| `starterPrompts` | At most 4, `title` and `message` only. |
| `websearch` | Only `{ enabled: true }`. |
| `integrations` | `integrationsFromAnswer(raw.integrations, installed)` as today. |

Never taken from the model: `type`, `iframeConfig`, `redirectConfig`, `enabled`, `order`,
`preferredModel`, `allowedModels`, `upload`, `outputSchema`, `customResponseRenderer`,
`rendererConfig`, `features`, `toolApproval`, `toolChoice`, `skills`, `workflows`, `apps`,
`parentId`, `settings`. After merging, the result runs through `appConfigSchema.safeParse`. A
failure at that point is a bug in the sanitiser, so it is logged with the issue paths (not the
model text) and answered as `APP_GENERATOR_INVALID_ANSWER`.

The raw answer is not logged above debug level and never reaches the browser console.

#### 3.2 `GET /api/admin/app-templates`

```json
{ "items": [ { "id": "summarizer", "name": {…}, "description": {…}, "icon": "…", "color": "…",
               "category": "…", "app": { /* full config */ } } ], "nextCursor": null }
```

New file **`server/services/appTemplates.js`**: `APP_TEMPLATE_IDS` is a fixed list of shipped
files in `server/defaults/apps` (my proposal: `chat`, `summarizer`, `translator`,
`email-composer`, `file-analysis`, `web-chat`, `meeting-agenda-generator`). `loadAppTemplates()`
reads them from the package directory, not from `contents/`, caches them in memory, removes
`enabled`, `order`, `allowInheritance`, and removes integration bindings whose installation is
not present. A file that fails the schema is skipped and logged. A test asserts that every id in
the list exists and yields a schema-valid app.

Why not a new `server/defaults/app-templates/` folder: `copyDefaultConfiguration` copies the
defaults tree into `contents/` on first setup (`setupUtils.js:195`), so a new folder would be
copied there as dead files, and the content would exist twice.

`GET /api/admin/apps/templates` stays as it is. The client stops calling it.

#### 3.3 `GET /api/admin/app-models`

```json
{ "items": [ { "id": "gpt-5", "name": {…}, "provider": "openai", "enabled": true,
               "default": true } ], "nextCursor": null }
```

Every configured model, including disabled ones, with exactly these five fields. No URL, no key,
no key status. Used by the create page and the editor's model pickers. `items: []` lets the
create page show the "no model" notice before the user has typed anything.

#### 3.4 `POST /api/admin/apps` (existing, `apps.js:713`)

One change: reject ids in `RESERVED_APP_IDS` with 400 `VALIDATION_FAILED`. Nothing else. The id
stays required; the client derives it. See "Breaking changes" below.

#### 3.5 Not changed

`GET /api/admin/prompts/app-generator` and `POST /api/completions` stay registered and
unchanged. After this work no client code calls them (`AppCreationWizard.jsx:660` was the only
caller of `/completions`). Removing them is a breaking change for any script that uses them and
needs the owner's decision plus `Deprecation` / `Sunset` headers.

### 4. Client structure

```
client/src/features/admin/pages/AdminAppCreatePage.jsx      page frame, stage switch, create
client/src/features/admin/components/app-create/
  useAppDraft.js          reducer: { source, draft, idTouched, dirty }
  StartChooser.jsx        four cards
  DescribeStart.jsx       textarea, Generate, cancel, error by code, warnings list
  TemplateGallery.jsx     cards from /admin/app-templates
  ExistingAppPicker.jsx   searchable list from /admin/apps (all apps, with icon)
  EssentialsForm.jsx      name, description, IconPicker, colour, instructions, model
  TechnicalDetails.jsx    collapsed: id (auto, editable), category, content language
  NoModelNotice.jsx       shown when /admin/app-models has no enabled model
```

Target size: no file above 300 lines. The page is a real route, not a modal, so it gets the
admin shell, dark mode, focus handling and the base path for free.

Behaviour that fixes concrete defects:

- **Id**: `EssentialsForm` derives the id from the name on every change until the user edits the
  id (`idTouched`). `TechnicalDetails` checks it against the ids loaded from `/admin/apps` and
  shows "already in use" inline. On a 409 `CONFLICT` from POST with an untouched id, the page
  retries once with the next free suffix; with a touched id it opens `TechnicalDetails` and
  focuses the field.
- **Errors**: field errors are a map `{ field: messageKey }`, never a match on message text
  (`AppCreationWizard.jsx:469` matches the English sentence). A 400 with `details.issues` is
  mapped by `path` to the field.
- **Leaving**: the page uses `useUnsavedChanges` and `UnsavedChangesDialog`, like the editor.
- **After create**: `navigate('/admin/apps/<id>?created=1', { replace: true })`. The editor
  reads the parameter once, opens the Test panel, shows the toast and removes the parameter.
- **Duplicate**: `?from=<id>` loads `/admin/apps/<id>`, builds `draftFromExistingApp` and opens
  Essentials directly. Unknown id -> the Start stage with an error notice.
- **Generate**: one request, a `AbortController` behind "Cancel", the button disabled while it
  runs. A second generation after manual edits asks for confirmation.

`App.jsx`: add `<Route path="admin/apps/new" element={<AdminAppCreatePage />} />` before
`admin/apps/:appId`. No `KNOWN_ROUTES` change.

`AdminAppsPage.jsx`: "Create App" and the empty-state button become
`navigate('/admin/apps/new')`; "Clone" becomes "Duplicate" and navigates with `?from=`; the two
modal states and both imports go (`:354-371`, `:792-799`).

`AdminAppEditPage.jsx`: delete `makeDefault` and the `isNewApp` branches (POST branch at
`:230-239`, the navigation at `:359-365`, the "New App" breadcrumb). This removes AI-B16 (the
editor that opens with four errors) by construction. Use `newAppDefaults` only where
`useAdminResourceEditor` requires a default, `cleanAppForSave` for PUT, and `/admin/app-models`
instead of `fetchModels()`. Add the sticky `AdminSaveBar` and move `enabled` into the header.

`AppFormEditor.jsx` and `app-form/`: wrap the existing section components, unchanged inside, in
seven groups using a new `app-form/EditorGroup.jsx` (a disclosure with a one-line summary) and
`app-form/EditorGroupNav.jsx` (sticky index with scroll-spy and an error dot). Group order as in
Review:193-202. Open by default: Basics, Instructions and inputs. A group that contains a
validation error is forced open, and the error summary links to the field's group. All groups
stay mounted, so Ctrl+F after "Expand all", validation and the dirty check keep working.

Deleted: `client/src/features/apps/components/AppCreationWizard.jsx`,
`client/src/features/apps/components/AppTemplateSelector.jsx`,
`client/src/features/admin/utils/appWizardPayload.js`,
`tests/unit/client/app-wizard-locale-keys.test.jsx`,
`tests/unit/client/app-wizard-payload.test.jsx`,
`tests/unit/client/app-creation-wizard-overridden-fields.test.jsx`, and the entries of the two
deleted components in `tests/unit/client/translation-keys-baseline.json`.

### 5. Work slices

Each file has one owner. Slices A and B publish the contract in sections 2 and 3 first (empty
function bodies are enough), then everyone works in parallel.

| Slice | Owns (creates / changes / deletes) | Depends on |
|---|---|---|
| **A. Shared core** | `shared/appDefaults.js`, `shared/appId.js`, `client/src/features/admin/utils/appDraft.js`; deletes `appWizardPayload.js`; tests `tests/unit/shared/app-defaults.test.js`, `app-id.test.js`, `tests/unit/client/app-draft.test.jsx`; rewrites `admin-app-cleanup.test.jsx` to import `cleanAppForSave` | none |
| **B. Server** | `server/routes/admin/appBuilder.js`, `server/services/appGenerator.js`, `server/services/appTemplates.js`, `shared/appGenerator.js`, one line in `server/routes/adminRoutes.js`, the reserved-id check in `server/routes/admin/apps.js`, two codes in `shared/apiErrors.js`, `tests/contract/response-shapes.json`; tests `server/tests/app-generate-route.test.js`, `app-generator-sanitize.test.js`, `app-templates.test.js`, `app-models-route.test.js` | A (signatures) |
| **C. Create page** | `AdminAppCreatePage.jsx`, `components/app-create/*`, the route in `client/src/App.jsx`, three calls in `client/src/api/adminApi.js`; deletes the wizard and the picker; tests `tests/unit/client/app-create-page.test.jsx` | A, B (shapes) |
| **D. Apps list** | `client/src/features/admin/pages/AdminAppsPage.jsx`, `AdminCommandPalette.jsx` (label only), `SetupWizard.jsx` (no change expected; verify) ; updates `admin-bulk-toggle-confirm.test.jsx` and `admin-apps-missing-integration.test.jsx` if they render the wizard | C (route exists) |
| **E. Editor frame** | `client/src/features/admin/pages/AdminAppEditPage.jsx`, `AppTestPanel.jsx` (accept `initiallyOpen`); updates `admin-app-editor-save-and-test.test.jsx`, `admin-app-editor-upload-default.test.jsx` | A |
| **F. Editor form** | `client/src/features/admin/components/AppFormEditor.jsx`, new `app-form/EditorGroup.jsx`, `app-form/EditorGroupNav.jsx`; no edits inside the existing section files except labels | none |
| **G. Words, docs, e2e** | `shared/i18n/en.json`, `shared/i18n/de.json`, `tests/unit/client/translation-keys-baseline.json`, `docs/admin-ui.md`, `docs/apps.md`, `README.md`, `docs/releases/next/features.md`, `tests/e2e/app-create.spec.js` | all |

Two rules keep the slices from colliding:

- Only slice G edits the two i18n files and the baseline. Slices C to F write
  `t('admin.apps.create.…', 'English default')` and hand over a list of key, English and German
  text. Key prefixes: `admin.apps.create.*` (C), `admin.apps.list.*` (D), `admin.apps.edit.*`
  (E), `admin.apps.groups.*` (F).
- Only slice B edits files under `server/` and `shared/apiErrors.js`; only slice A edits the
  other files under `shared/`, except `shared/appGenerator.js` (B).

### 6. Tests that must exist before this counts as done

- `shared/appDefaults`: `newAppDefaults('de')` passes `appConfigSchema` once id, name,
  description are filled. This is the test that ties client defaults to the server schema.
- `shared/appId`: umlauts, empty result, 50-character cut with suffix, reserved ids.
- `sanitizeGeneratedApp`: a table of hostile answers (type `iframe` with a URL, a
  `customResponseRenderer`, an unknown integration, 40 variables, a variable without label, a
  nested object as `name`, an id with `../`). Each must yield a schema-valid app or a clean
  failure.
- `extractJsonObject`: plain, fenced, text before and after, nested objects, braces inside
  strings.
- Route test for `_generate` with a stubbed `llmClient`: 200 shape, 409 without a model, 502 for
  prose, 401/403 for anonymous and normal users.
- `app-create-page`: blank path and template path end in one POST and a navigation to
  `/admin/apps/<id>?created=1`; a 409 with an untouched id retries once; German UI stores
  `name.de`.
- e2e `app-create.spec.js`: button -> blank -> create -> editor, at `/` and under a subpath;
  `_generate` fulfilled by a Playwright route stub.
- Existing ratchets: translation keys (shrinks by about 91 entries), admin class hygiene, unsaved
  guard coverage, load-gate coverage, known-routes sync (unchanged).

### 7. Migrations and breaking changes

**Migrations: none.**

- No field is added to, renamed in or removed from existing app files.
- The shipped `app-generator` prompt is not changed. The server appends its own rules block and
  the sanitiser ignores `preferredModel` and unknown categories, so the stale example in
  installed copies does no harm. Changing the prompt text would need a V260 migration that
  updates only unmodified copies (as V231 did); I avoid that.
- Apps that carry `parentId`, `inheritanceLevel`, `overriddenFields` keep them.

**Changes the owner should know about:**

| Change | Breaking? | Note |
|---|---|---|
| `/admin/apps/new` shows the short create page, not the full editor | UI only | Creating an app directly in the full form or in JSON mode is gone; "Upload Config" remains for JSON |
| `POST /api/admin/apps` refuses the ids `new`, `templates`, `integration-status` | Yes, narrowly | 400 `VALIDATION_FAILED`. A script that created such an app got an app the UI could not open. Needs a `breaking-changes.md` entry, or the owner drops the check |
| Duplicated apps no longer store `parentId` / `inheritanceLevel` / `overriddenFields` | Data shape of new apps | `GET /api/admin/apps/{id}/inheritance` then reports no children for new copies; `docs/apps.md:577-579` needs a sentence |
| New apps from the short flow store `preferredStyle: 'keep'` instead of `'normal'` | No | The editor always did |
| Three new routes, two new error codes | No | Additive |
| `GET /api/admin/apps/templates`, `GET /api/admin/prompts/app-generator`, `POST /api/completions` lose their only client caller | Not removed | Removal is a separate, owner-approved breaking change |

### 8. Deliberately out of scope for this session

- **Testing a disabled or draft app** (F10). It needs one lookup helper,
  `findAppForRequest(appId, user)`, applied to all 45 call sites or a reasoned subset, plus a
  test per site that a normal user still gets 404. Until then new apps are created enabled, as
  today, unless the admin switches "Available to users" off on the create page; the create page
  then says that the test chat needs the app enabled.
- **Item-level audience** ("only these groups"): owner decision 1 is open.
- **Optimistic locking on `PUT /api/admin/apps/{id}`**: real gap
  (`client/src/api/adminConfigRevision.js:44-47` covers platform and UI only), unrelated to
  creation.
- **Form fields for the JSON-only settings** except what a group needs to make sense.
- **Personal apps for non-admins.** The flow is built so that it could be mounted elsewhere
  (the page takes its API functions from `adminApi.js` only), but there is no owner, quota or
  permission model on the server.

## Pre-mortem

It is May 2027. The rework shipped and failed. These are the engineering stories.

**1. The defaults drifted again.**
What happened: the create page stored apps without a greeting; the editor added one on first
save; customers saw apps change after an unrelated edit.
Root cause: someone added a field to `makeDefault` in the editor "just for now" instead of
`shared/appDefaults.js`, and `loadResource` in the editor kept its own "ensure sections exist"
block.
Prevention: delete `makeDefault` from the editor in the same change. Add a test that greps
`client/src/features/admin` for a second literal `'#4F46E5'` / `chat-bubbles` default object,
and the schema test for `newAppDefaults`.

**2. Generation produced an app that could not be saved.**
What happened: the model returned a `select` variable without options; POST answered 400 with a
Zod path; the user had typed nothing wrong and could not fix it.
Root cause: the sanitiser handled the shapes we thought of. The schema is 769 lines.
Prevention: `_generate` validates its own result with `appConfigSchema` and never returns an
invalid app. The hostile-answer table test runs against the real schema, not a mock.

**3. The generated app bound a powerful integration nobody noticed.**
What happened: a description mentioned "our tickets"; the model bound the Jira integration with
all actions; the app was enabled and visible to every signed-in user.
Root cause: bindings came back inside `app` and Essentials did not show them. New apps default
to enabled and groups default to `apps: ["*"]`.
Prevention: the create page lists "Connected systems" from `app.integrations` and
`websearch.enabled` with a checkbox each, before Create. The sanitiser returns a warning entry
for every binding. Engineers must not hide these under Technical details.

**4. Two engineers edited the same file and one change was lost.**
What happened: slices C and E both touched `AdminAppEditPage.jsx` for the `?created=1`
handling; the later merge dropped the sticky save bar.
Root cause: the ownership table was treated as advice. `shared/i18n/*.json` had four writers.
Prevention: the table in section 5 is binding. C only navigates; E owns everything inside the
editor page. One owner for the i18n files. Run `git diff --stat` per slice before merging and
reject files outside the slice.

**5. Deleting the wizard broke CI in three unrelated places.**
What happened: the translation baseline test failed because it still listed
`AppCreationWizard.jsx`; two list-page tests failed because they clicked through the picker; the
e2e route crawl failed on the removed dialog.
Root cause: F11 was not followed up; deletion was the last commit of the day.
Prevention: slice C deletes the two components first, on day one, and runs the full unit suite
then. Slice G owns the baseline and removes the entries in the same merge.

**6. The id helper produced collisions and empty ids in real names.**
What happened: "FAQ" and "F.A.Q." both became `faq`; a Japanese name became `''` and POST
failed with "Missing required fields"; a 50-character name plus `-2` exceeded the limit.
Root cause: three slugifiers already exist and a fourth was written from memory without edge
cases.
Prevention: one shared `shared/appId.js` with the test cases named in section 6. The 409 retry
on an untouched id. The server never trusts the client's uniqueness check.

**7. The editor regrouping hid errors and broke saved links.**
What happened: Save was disabled, the error sat in a collapsed group, and the admin could not
find it. Support links to `#variables` stopped scrolling.
Root cause: sections were unmounted when collapsed, so validation anchors did not exist.
Prevention: groups stay mounted and are hidden with the `hidden` attribute; a group with an
error is forced open; the error summary expands the target group before focusing. Keep the
existing section `id` attributes.

**8. `_generate` hung and the user clicked five times.**
What happened: a slow local model took 90 seconds; five requests ran in parallel; the last
answer overwrote edits made after the first.
Root cause: no cancel, no single-flight on the client, and `maxTokens` 8192 with reasoning
models.
Prevention: the button is disabled while a request runs; `AbortController` on Cancel and on
unmount; an answer is applied only when its request id is the current one; `maxTokens` 4096;
the admin rate limiter already bounds the route.

**9. We shipped half of "test a disabled app".**
What happened: someone patched `sessionRoutes.js` and `generalRoutes.js` so the test panel could
open a disabled app. Export, magic prompt and voice still answered 404; worse, one patched
lookup forgot the admin check and a normal user could chat with a disabled app by id.
Root cause: 45 call sites, changed by hand under time pressure.
Prevention: do not start it in this session. When it is done, it is one helper with one
permission check, a lint rule or test that forbids raw `getApps()` lookups by id in routes, and
a negative test per route.

## Questions I did not ask

1. **Should a new app be visible to users at once?** Today it is (`enabled: true`, groups with
   `apps: ["*"]`). I kept that as the default with a switch on the create page. Only the owner
   can say whether "created hidden, cannot be tested until enabled" is acceptable in the
   interim.
2. **Is "non-technical user" a content admin, or a normal user without admin rights?** I
   designed for content admins. If normal users should create apps, the server needs ownership,
   visibility and quota rules that do not exist.
3. **May content admins see every configured model, including ones their groups cannot use?**
   `GET /api/admin/app-models` assumes yes (names and provider only).
4. **Does any customer script call `POST /api/completions`,
   `GET /api/admin/prompts/app-generator` or `GET /api/admin/apps/templates`?** I left them in
   place because I cannot know.
5. **Does anyone rely on `parentId` lineage of cloned apps** (reports, own tooling)? I stop
   writing it for new copies.
6. **Do customers edit the `app-generator` prompt on purpose?** I keep honouring the library
   copy. If nobody does, reading only the shipped file would be safer and simpler.
7. **Which shipped apps are good templates?** My list of seven is an engineer's guess from file
   names and from which ones need no integration.
8. **Which model should generate apps when the default model is small or local?** I use the
   default model and fall back to the first enabled one. A platform setting was not requested.
9. **Is creating an app straight in the full form or JSON editor still needed** by power users,
   beyond "Upload Config"?
10. **Should generation count against a usage quota or budget?** I did not verify how
    `kind: 'utility'` calls are metered.
11. **Is it acceptable that the AI path stores texts in one language only?** The current prompt
    asks for English and German; I store only the chosen content language and rely on the
    editor's Translate button for the rest.

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible |
|---|---|---|---|
| 1 | A route page at `/admin/apps/new` replaces the modal wizard and the editor's "new" mode | Keep a modal; keep both entry points | Yes, but the wizard is deleted, so reverting means restoring it from git |
| 2 | Dedicated `POST /api/admin/apps/_generate` with server-side sanitising and schema validation | Keep client-side parsing over `POST /api/completions` and only fix the regex | Yes (additive) |
| 3 | `_generate` returns an unsaved app; saving stays one `POST /api/admin/apps` | A `_generate` that also creates the app | Yes |
| 4 | The model's `id` is ignored; the server derives a free id from the name | Trust the model's id after a pattern check | Yes |
| 5 | Ids are derived in the client and checked against the loaded list; one automatic retry on 409 | Make `id` optional on `POST /api/admin/apps` and derive it on the server | Yes; the server variant can be added later without breaking anything |
| 6 | Reserve `new`, `templates`, `integration-status` on create | Leave it; rename the client route instead | Yes, but it is a narrow breaking change and needs the owner's nod |
| 7 | Templates come from a fixed list of shipped files via `GET /api/admin/app-templates` | Keep "every enabled app is a template" (the owner's decision of 2026-11-17, Rework:46); a new `server/defaults/app-templates/` folder; the marketplace catalog | Yes. Note: this does not contradict the owner's decision; existing apps stay available under "Copy an existing app", now including disabled ones |
| 8 | Duplicates carry no lineage fields | Keep writing `parentId` and friends | Yes for future copies; copies made meanwhile have no lineage |
| 9 | The generator prompt falls back to the shipped file when the library copy is missing; the library copy still wins | Always use the shipped file (fixes AI-B8 fully) | Yes |
| 10 | The shipped prompt text is not changed, so no migration | Rewrite the prompt and add V260 | Yes |
| 11 | New `GET /api/admin/app-models` for content admins | Open `GET /api/admin/models` to content admins; keep the public `fetchModels()` | Yes |
| 12 | New routes live in a new file `server/routes/admin/appBuilder.js` | Add them to the 1,165-line `apps.js` | Yes |
| 13 | The old three endpoints stay registered | Remove them now with `Deprecation` headers | Yes |
| 14 | Testing disabled apps is not built in this session; new apps stay enabled by default | A partial patch of the chat routes; create disabled by default | Yes |
| 15 | The editor stays one page with collapsible groups; section components are wrapped, not rewritten | Tabs; rewriting sections onto `AdminSettingsPage` | Yes |
| 16 | `preferredStyle: 'keep'` is the single default | Keep the wizard's `'normal'` | Yes |
| 17 | AI output is stored under one content language | Ask the model for en+de as the prompt does today | Yes |
| 18 | One owner for the i18n files and the baseline during implementation | Every slice edits `en.json` / `de.json` and conflicts are merged as a union | Yes (process only) |
| 19 | `exampleApps.js` keeps its own id helpers for now | Move them into `shared/appId.js` in the same change | Yes |
