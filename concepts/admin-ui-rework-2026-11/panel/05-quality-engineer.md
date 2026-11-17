# Quality engineering view — admin UI rework, "Now" phase

Author angle: senior quality engineer. Scope: the 16 "Now" rows of `concepts/admin-ui-review-2026-11/README.md:372-391`.
Everything below was checked against the code as of 2026-11-16; line numbers are current.

## 1. Angle summary

- **The safety-critical defects are still live and none has a regression test.** ID-B1 (`AdminAuthPage.jsx:40-79` defaults `mode: 'proxy'`, `localAuth.enabled: false`; `:117-122` catch only sets a message; `:265` `disabled={saving}`), ID-B4 (`server/routes/admin/groups.js:878-924` delete checks only `adminAccess`, never `inherits`), ID-B2 (`server/routes/admin/auth.js:507-560` PUT has no `isLastAdmin` check; only DELETE at `:660`), PL-B4 (`configs.js:258-268` strips `jwkUrl` on GET, `:357` keeps `newConfig.proxyAuth` wholesale on POST), SH-B1 (`staticRoutes.js:109-110`). Each fix must land with a test that fails on today's code.
- **The test infrastructure is good, but the parts that matter here are hidden from CI.** Only three Playwright entry points run on PRs: `route-crawl.yml` (root crawl), `accessibility.yml` (axe), and the response-shape check. `test:e2e:subpath` (`playwright.subpath.config.js`) and every other spec in `tests/e2e/` (`admin-usage-reports`, `chat`, …) are **not run by any workflow**. A new e2e spec that is not wired into a workflow is decoration.
- **Existing unit tests mock the guard away.** `tests/unit/client/admin-shortlink-edit-page.test.jsx:37-38` (and others) replace `useUnsavedChanges` with a stub. The hook itself has no test. It also has a real gap: it patches only `navigator.push`/`replace` (`useUnsavedChanges.js`, the effect after `markSaved`), not `navigator.go`, so `navigate(-1)` — the Back button in `WorkflowEditorPage.jsx:195` (AX-B6) — is never blocked, and neither is the browser Back button (POP).
- **The safest test for "failed load offers no Save" is request interception in a real browser**, not a mocked unit test: `page.route()` answering the GET with a 429 problem+json, then asserting that no non-GET `/api/admin/*` request leaves the page whatever the user clicks. Pitfall: `client/src/api/client.js:117-118` retries a GET once on a *network* error, so `route.abort()` gets retried; use `route.fulfill({ status })`.
- **Server invariants (lockout, last admin, inherited group, redacted secrets, If-Match) belong in supertest unit tests**, using the established `jest.unstable_mockModule` pattern of `server/tests/admin-platform-config-merge.test.js`. They are deterministic, fast, and need no rate-limit care. E2E only proves the UI shows the refusal.
- **Destructive e2e must not share a server with the rest.** A broken last-admin or lockout guard in a spec on the shared `contents-e2e/` instance locks out every parallel spec (crawl, a11y). These specs get their own config, contents dir, port and `workers: 1`.
- **One generic round-trip contract test closes a whole class** (Pattern A/B in the README): for every admin config endpoint, `GET` then write the body back unchanged must leave the stored file semantically identical. Today it fails for platform (PL-B4, `jwkUrl`) — that is the point.
- **Ratchets beat big-bang checks** for the long tail: native `confirm()`/`alert()` (36 calls today in admin/workflows/shared), missing admin translation keys (AX-B7; the existing `translation-keys-exist.test.jsx:18` explicitly skips `features/admin`), admin pages without an unsaved guard, unbordered inputs. Each gets a baseline that may only go down, in the style of `KNOWN_VIOLATIONS` in `tests/e2e/accessibility.spec.js:313`.
- **Visual P1s (AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6) are invisible to axe.** axe does not test WCAG 1.4.11 non-text contrast, and `accessibility.spec.js:40` runs in light mode only. A computed-style check in light and dark is required.

## 2. Now-phase plan from my angle

Each PR theme lists its tests. "Done" = the named tests exist, fail on `main` before the fix (verified by the author once, noted in the PR), pass after, and run in a CI workflow.

### PR 1 — Load gating (ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5)

Tests:
- `tests/unit/client/admin-config-load-gate.test.jsx` — the shared hook (§3, `useAdminConfigLoad`): states `loading → ready | error`; `canSave` false until a successful load; retry resets to loading; a stale response from an earlier attempt does not overwrite a newer one (resolve promises out of order); unmount mid-request does not set state.
- `tests/unit/client/admin-auth-page-load-failure.test.jsx` — `AdminAuthPage` with `makeAdminApiCall` mocked to reject for `/admin/configs/platform`: no `role="button"` named Save is rendered or it is `disabled`; no form fields; `AdminLoadError` (`components/AdminLoadError.jsx`) with Retry is shown; "All valid" text is absent. Same file: groups/schema load failures do **not** gate Save (they are secondary), but platform does.
- `tests/unit/client/admin-load-gate-coverage.test.jsx` — static ratchet: every file under `client/src/features/admin/pages` and `components/*Config.jsx` that calls `makeAdminApiCall(..., { method: 'POST'|'PUT'|'PATCH' })` on a config endpoint either uses the hook or is in a baseline list that may only shrink. Seed list from PL-B3 (`SSLConfig.jsx`, `SsrfConfig.jsx`, `CorsConfig.jsx`, `CookieSettingsConfig.jsx`, `ProxyConfig.jsx`), OB-B1/B2 (telemetry, logging), IN-B1 (MCP gateway).
- E2E `tests/e2e/admin-safety-load-gating.spec.js` (see §2 E2E block): parametrised over the pages and the endpoints they load.

Done when: every page in the IDs above shows `AdminLoadError` and no enabled Save after a failed primary GET, and the e2e spec proves no write request leaves the page.

### PR 2 — Lockout refusal, last-admin/self guard, `active`, 409 on inherited group (ID-B1 server side, ID-B2, ID-B3, ID-B4)

Server tests (all `server/tests/`, jest ESM, run by `scripts/run-server-tests.js`):

`server/tests/admin-auth-config-lockout.test.js` — POST (and later PATCH) `/api/admin/configs/platform` with `req.user` fixtures carrying `authMethod` (`server/middleware/localAuth.js:118` sets `'local'`):

| Case | req.user.authMethod | Submitted | Expect |
|---|---|---|---|
| L1 | local | `localAuth.enabled: false`, nothing else enabled | 409, code (§3), file unchanged |
| L2 | local | `localAuth.enabled: false`, OIDC enabled with a provider | 409 (the *signed-in* admin loses access) unless explicit acknowledgement field (decision needed, §6) |
| L3 | oidc | OIDC provider removed that the user signed in with | 409 |
| L4 | local | `auth.mode: 'proxy'`, `proxyAuth.enabled: false` | 409 (no working method) |
| L5 | local | unrelated change (`defaultLanguage`) | 200, auth blocks untouched |
| L6 | anonymous-admin via `adminToken` | anything | behaviour documented, not crash |
| L7 | local | body with no auth keys at all | 200 (merge keeps existing; regression for `configs.js:357-364`) |

Assert the file on disk (temp `rootDir` as in `admin-platform-config-merge.test.js:31-35`), not just the status. Assert the response is `application/problem+json` with `code`.

`server/tests/admin-users-last-admin-guard.test.js` — PUT `/api/admin/auth/users/:id`:
- removing `admins` from the only admin → 409; from one of two → 200.
- `active: false` on the only admin → 409; on self (req.user.id === userId) → 409 even if others exist (self guard).
- removing own admin group → 409 (self guard).
- **inheritance**: a user whose group `ops` inherits `admins` counts as an admin. Today `isLastAdmin` (`server/utils/adminRescue.js:331-335`) reads only direct `permissions.adminAccess` of `internalGroups` — a test with `ops → admins` will expose that; the guard must use resolved groups.
- inactive admins (`active: false`) do not count (`adminRescue.js:326`).
- concurrency: two parallel PUTs demoting the two remaining admins → exactly one succeeds (model on `server/tests/admin-users-concurrent-writes.test.js`). Requires the check to run inside `configStore.updateJson`, not before it as `isLastAdmin` does today.

`server/tests/admin-users-active-roundtrip.test.js` (ID-B3) — PUT with body omitting `active` keeps `active: false`; server half. Client half: `tests/unit/client/admin-user-edit-active.test.jsx` — load a user `{ active: false }` (no `enabled`), change email, submit; the request body has `active: false` (today `AdminUserEditPage.jsx:282` sends `data.enabled !== false` → `true`).

`server/tests/admin-groups-delete-inherited.test.js` (ID-B4):
- DELETE parent `p` with child `c.inherits = ['p']` → 409, body names `c` (in `details`), `groups.json` unchanged, `configCache.refreshCacheEntry` not called.
- DELETE `p` with no inheritors → 204.
- transitive: `c → b → p`; deleting `p` lists `b` only (direct inheritors), deleting `b` lists `c`.
- regression for the cache-freeze: with the real `resolveGroupInheritance` (`server/utils/authorization.js:20`), assert that after any successful delete the remaining file resolves without throwing (property test over the seeded `server/defaults/config/groups.json` deleting each non-protected group in turn).
- protected groups (`server/utils/protectedGroups.js:8`) still 400 — **or** 409 if the team aligns codes; pin whatever is decided.

### PR 3 — No redacted or whole-file overwrites (PL-B4, CU-B3, OB-B10) + scoped PATCH / If-Match (decision 6)

`server/tests/admin-config-roundtrip.test.js` — **the contract test**. For each entry of a table `{ getPath, writeMethod, writePath, file }`:
`/api/admin/configs/platform` (platform.json), `/api/admin/ui` (ui.json), logging, telemetry, MCP gateway, SSL, SSRF, CORS, cookies, proxy (paths taken from `server/routes/admin/{ssl,ssrf,cors,proxy,logging,ui,mcpGateway}.js`).
Seed a fixture file that sets **every** secret and every field the GET redacts or omits (`auth.jwtSecret`, `localAuth.jwtSecret`, `speech.azure.subscriptionKey`, `proxyAuth.jwtProviders[].jwkUrl`, encrypted Jira/OIDC/LDAP refs). Then `GET` → write the body back → read the file → `expect(parse(after)).toEqual(parse(before))` ignoring `metadata.lastModified`/`updatedAt`. Fails today on `jwkUrl` (PL-B4) — that is the acceptance test.
Fixture: `server/tests/fixtures/admin-roundtrip/platform.full.json` etc. (I chose a fixture dir next to the test; `tests/fixtures/` is used by e2e only.)

`server/tests/admin-config-patch.test.js` — once the scoped PATCH exists (decision 6):
- PATCH `{ telemetry: {...} }` changes only `telemetry`; every other top-level key byte-equal.
- PATCH containing `"***REDACTED***"` for a secret keeps the stored secret (restore path `configs.js:65-70`); an empty string clears it only if the API says so (pin the rule).
- PATCH of `proxyAuth.jwtProviders` without `jwkUrl` keeps the stored `jwkUrl` per provider **matched by `name`**, not by index (reordering two providers must not swap URLs).
- OB-B10: privacy PATCH carries only privacy keys; a pending level change is not written. Client half in `tests/unit/client/admin-logging-privacy-save.test.jsx` asserting the request body keys.
- unknown top-level key → 400 with `errors[].pointer` (problem+json validation shape).

`server/tests/admin-config-if-match.test.js`:
- GET returns `ETag`; it is a hash of the stored content (writing the file directly on disk changes it — covers edits by scripts and another worker).
- write without `If-Match` → applied (optional per decision 6).
- write with matching `If-Match` → 200 + new `ETag`.
- write with stale `If-Match` → **412**, file unchanged, problem+json `code` (new registry code, §3). Note: `shared/apiErrors.js:41` already has storage `ETAG_MISMATCH: 409`; HTTP semantics for a failed `If-Match` are 412 — do not reuse the 409 code.
- `If-Match: *` → applied when the file exists.
- CU-B3 scenario: GET ui.json (ETag A) → create a page via the pages route → POST ui with `If-Match: A` → 412, the page entry survives.

Client: `tests/unit/client/admin-save-conflict.test.jsx` — on 412 the editor keeps the user's edits, shows a conflict message with "Reload" and does not retry silently.

### PR 4 — Unsaved-changes guards everywhere (ID-B11, CU-B4, AX-B6, OB-B16, PL-B14, IN-B12)

- `tests/unit/client/admin-unsaved-changes-hook.test.jsx` — the **real** hook inside `createMemoryRouter` + `RouterProvider`:
  - clean → `<Link>` navigates; dirty → blocked, `blocker.state === 'blocked'`; `proceed()` completes the original navigation; `reset()` stays.
  - `navigate(path, { replace: true })` blocked when dirty.
  - **`navigate(-1)` blocked when dirty** — fails today (only push/replace patched).
  - `beforeunload` listener present only while dirty (`window.dispatchEvent(new Event('beforeunload'))`, check `defaultPrevented`).
  - `markSaved()` then a navigation in the same tick is not blocked (save-then-redirect flow).
  - two guarded components mounted (shell + nested editor) → one prompt, not two; unmount restores the original `navigator.push`.
  - `initialData === null` (still loading) → never dirty.
- `tests/unit/client/admin-unsaved-guard-coverage.test.jsx` — static ratchet: every admin page that renders `AdminSaveBar`, `AdminEditPageShell` or a Save `type="submit"` uses `useUnsavedChanges` (directly or through `useAdminResourceEditor`/`AdminEditPageShell`). Baseline seeded with today's misses (`AdminAuthPage.jsx`, `WorkflowEditorPage.jsx`, translation overrides editor, document template editor, logging, platform settings pages), must only shrink.
- Remove the `useUnsavedChanges` mocks from page tests where the page is the subject, or at least add one test per page family that uses the real hook.

### PR 5 — Named confirmations + `no-alert` (PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3)

- `tests/unit/client/confirm-dialog.test.jsx` — `ConfirmDialog` (`client/src/shared/components/ConfirmDialog.jsx`): `role="alertdialog"` with accessible name = title; the message names the object (prop `subject`/`objectName`, §3) and is the `aria-describedby` target; initial focus on the deny button (`initialFocusRef: denyButtonRef`); Escape and backdrop call `onDeny`; confirm label is a verb + object ("Delete group ops", not "OK"); `danger` styles; optional type-to-confirm input disables Confirm until the exact name is typed (for PL-B1 restore and AI-B2 "Disable all").
- Per-action tests (one file per family, cheap): `admin-backup-import-confirm.test.jsx` — choosing a file does **not** call `/admin/backup/_import` until confirmed (PL-B1, `AdminBackupPage.jsx` `onChange={handleImportConfig}`); `admin-bulk-toggle-confirm.test.jsx` — Enable/Disable All on apps/models/prompts open a dialog naming the count; Disable All on models warns about the default model (AI-B2); `admin-credential-delete-in-use.test.jsx` — IN-B3 dialog lists the installations using it.
- `tests/unit/client/admin-no-native-dialogs.test.jsx` — scans `client/src/features/admin`, `features/workflows`, `shared` for `window.confirm|alert|prompt` and bare `confirm(`; baseline count (36 today) may only fall; target 0. Plus ESLint `no-alert: 'error'` scoped to those folders in `eslint.config.js` (lint is the enforcement, the test is the ratchet that CI cannot skip: `auto-lint-format.yml` honours `[skip-lint]`).

### PR 6 — Visual P1s (AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6, SH-B9)

- E2E `tests/e2e/admin-visual-controls.spec.js` (§2 E2E block) with computed styles, light + dark.
- `tests/unit/client/admin-input-classes.test.jsx` — static guard: in `features/admin/**`, an `<input|select|textarea className="…">` literal must contain `border` or use the shared input class/component; baseline-ratchet. Cheap first line; e2e is the truth.

### PR 7 — Contract bugs (AI-B1, AI-B4, AI-B6, IN-B2, IN-B4, IN-B5, AX-B2..B5, CU-B1, CU-B2, CU-B7..B10)

- IN-B4: `tests/unit/client/integration-install-field-errors.test.jsx` fed with a problem+json **produced by the real server serializer** (`server/utils/errorResponse.js`), captured in `server/tests/problem-json-validation-shape.test.js`, which writes nothing but asserts the shape `errors[].pointer`. Both import one fixture `shared/test-fixtures/problem-validation.json`? — no, `shared/` ships; put it in `tests/contract/problem-validation.json` and have the server test assert the serializer output equals it. The client test then reads the pointers into fields.
- AI-B1: `tests/unit/client/app-wizard-locale-keys.test.jsx` — with `navigator.language = 'de-DE'` the payload has `name.de`, not `name['de-DE']`; extend existing `app-wizard-payload.test.jsx`.
- AX-B2: `tests/unit/client/dual-mode-editor-json-roundtrip.test.jsx` — edit in JSON mode, switch to form, save: the structural edit is in the payload.
- AX-B3: comma typed in group fields survives (`userEvent.type(field, 'a,b')`).
- AX-B5: Ask-a-Person localized label object renders text, editing `en` keeps `de`.
- CU-B1/CU-B2: server `shortLinkRoutes.test.js` extension — PUT changes `url`; `prompt` is stored and applied.
- CU-B9/CU-B10/SH-B1 are **base-path bugs**: server tests `basePath.test.js`-style with `X-Forwarded-Prefix: /ihub`: `GET /s/<code>` → `Location: /ihub/apps/chat`; `GET /admin/docs/foo.md` → 200 `text/html` (index.html) at root and under the prefix, while `GET /assets/missing.js` stays 404. Plus subpath e2e (below).
- CU-B7: `admin-translations-search.test.jsx` — "Changed only" defaults off; a search hit for an unchanged key is shown.

### PR 8+ — Smaller rows (tests only, briefly)

- OB-B3: `server/tests/logging-component-filter.test.js` — with a component filter set, an `error` from another component is still emitted.
- OB-B4 (decision 7): `server/tests/chat-request-log-no-content.test.js` — capture logger output for a chat request; assert the question text is absent at every level, including `debug`.
- OB-B28: `server/tests/feedback-privacy.test.js` — no username/chatId at `info`; anonymous mode writes no raw `chatId` to `feedback.jsonl`.
- ID-B6: OAuth client create UI default sends an explicit list, not `[]`; server behaviour unchanged (decision 4a) — pin current server semantics with a test so nobody "fixes" it silently.
- AX-B7, SH-B13, AI-B14, CU-B22: `tests/unit/client/admin-translation-keys-ratchet.test.jsx` — reuse the scanner of `translation-keys-exist.test.jsx` for `features/admin` with a per-file missing-key baseline in `tests/unit/client/fixtures/admin-missing-i18n-baseline.json`; fails when a file's count rises, and also when it falls without lowering the baseline (the a11y pattern). Every **new** key added in Now must exist in `en.json` and `de.json` (strict, no baseline).
- SH-B2/SH-B3: overview test — a failed apps request renders an error, not the fresh-install checklist.
- AX-B1/AX-B21: the schedule field is not rendered for agents (until the scheduler is fixed).

### E2E block (Playwright)

New config `tests/config/playwright.admin-safety.config.js`: `testMatch: 'admin-safety-*.spec.js'`, `workers: 1`, `retries: 0`, chromium only, two projects `root` and `subpath` (`/ihub`), webServer `tests/config/admin-safety-server.mjs` = the prod-build server of `subpath-server.mjs` on its own `contents-e2e-safety/` and ports (5175 public, 3101 app). `subpath-server.mjs` today falls back to `/ihub` when `SUBPATH_PREFIX` is empty (`(process.env.SUBPATH_PREFIX || '/ihub')`), so the root project needs a small change to accept an empty prefix (test infra, not product code).

Helpers `tests/e2e/helpers/admin.js`: `signInAsAdmin(context)` with cookies cached per worker (copy of `accessibility.spec.js:256-299` logic, extracted), `recordWrites(page)` (collects non-GET `/api/admin/*` requests), `failGet(page, pathRegex, status=429)` (fulfils with problem+json `{type,title,status,detail,code:'RATE_LIMITED'}`), `assertSafetyInstance(request)` (see pitfalls).

Specs and scenarios:

```gherkin
Feature: A config page that failed to load cannot be saved            # admin-safety-load-gating.spec.js
  Scenario Outline: primary GET answers 429
    Given I am signed in as the default admin
    And GET <endpoint> answers 429 for this page
    When I open <page>
    Then I see an error panel with a Retry button
    And no enabled "Save" button is visible
    And after clicking every visible button no POST/PUT/PATCH to /api/admin was sent
    When the GET succeeds again and I click Retry
    Then the form shows the stored values and Save is enabled
    Examples:
      | page                | endpoint                          |
      | /admin/auth         | /api/admin/configs/platform       |
      | /admin/security     | ssl, ssrf, cors, cookies, proxy   |
      | /admin/telemetry    | /api/admin/configs/platform       |
      | /admin/logging      | logging config endpoint           |
      | /admin/mcp/gateway  | /api/admin/configs/platform       |
      | /admin/ui           | /api/admin/ui                     |
```

```gherkin
Feature: Auth page refuses a lockout configuration                    # admin-safety-auth-lockout.spec.js
  Scenario: unticking the method I signed in with
    Given I signed in with local sign-in
    When I untick "Local authentication" on /admin/auth and click Save
    Then I see a refusal naming local sign-in as my current method
    And GET /api/admin/configs/platform still has localAuth.enabled true
    And a fresh context can still sign in as admin
```

```gherkin
Feature: The last admin cannot be removed                             # admin-safety-last-admin.spec.js
  Scenario: demote the only admin            -> refusal shown, user still in admins
  Scenario: disable my own account           -> refusal shown
  Scenario: with a second admin created via API, demoting one succeeds; cleanup deletes it
  Scenario: delete a group another group inherits from -> refusal names the child, group still listed
```

```gherkin
Feature: Unsaved changes are not lost                                 # admin-safety-unsaved.spec.js
  Scenario Outline: leave a dirty page
    Given I changed one field on <page>
    When I <leave>
    Then a dialog asks to discard or stay; "Stay" keeps my value; "Discard" navigates
    Examples: page ∈ /admin/auth, /admin/ui, /admin/workflows/<id>/editor, translation overrides
              leave ∈ click a sidebar link, press the page's Back button, browser back (page.goBack())
  Scenario: closing the tab while dirty triggers beforeunload (page.on('dialog') type 'beforeunload', with page.close({ runBeforeUnload: true }))
```

```gherkin
Feature: Destructive confirmations name their object                   # admin-safety-confirmations.spec.js
  Scenario: delete a group  -> alertdialog name contains the group name; focus starts on Cancel; Escape cancels and nothing is deleted
  Scenario: Disable all models -> dialog states the count and the default-model consequence; Cancel sends no _toggle
  Scenario: choose a backup ZIP -> no /admin/backup/_import request until typed confirmation (route intercepted; fulfil 204, never hit the real restore)
  Scenario: no native dialog appears anywhere (page.on('dialog') fails the test unless type is beforeunload)
```

```gherkin
Feature: Form controls are visible in light and dark                   # admin-visual-controls.spec.js
  Scenario Outline: every visible text input/select/textarea in <page>
    Given theme <mode> (localStorage 'ih-dark-mode' via addInitScript; also emulateMedia colorScheme for 'auto')
    Then each control has border width >= 1px and border-vs-background contrast >= 3:1
    And each checkbox label has text contrast >= 4.5:1
    And primary buttons (e.g. Cookies Save) have text/background contrast >= 4.5:1
```

The visual spec computes contrast in `page.evaluate` from `getComputedStyle` (`borderTopColor`, nearest opaque ancestor `backgroundColor`, `color`); results go into a per-page baseline map that only shrinks (`KNOWN_UNBORDERED`). It runs in the main `playwright.config.js` (read-only, safe to share) and is added to `accessibility.yml`. Additionally run axe `color-contrast` once in dark mode for `/admin/auth` (ID-B9).

Subpath additions (routing touched by SH-B1, CU-B9, CU-B10): add `admin-subpath-links.spec.js` to `playwright.subpath.config.js` `testMatch`: cold-load `/ihub/admin/docs/<page>.md` renders the docs page; short-link Copy puts `…/ihub/s/<code>` on the clipboard (`context.grantPermissions(['clipboard-read'])`); following `/ihub/s/<code>` ends under `/ihub/`. If any Now PR adds a top-level route, `known-routes-sync.test.jsx` covers the list, and the crawl covers the cold load at root.

### CI wiring

| Job | Command | Where |
|---|---|---|
| server unit | `node scripts/run-server-tests.js` (already in `test:quick`) | `unit-tests.yml` — no change |
| client unit + ratchets | `npm run test:unit` (already in `test:quick`) | `unit-tests.yml` — no change |
| admin safety e2e | `cd client && npm run build && cd .. && npx playwright test --config tests/config/playwright.admin-safety.config.js` → new script `test:e2e:admin-safety` | new job in `route-crawl.yml` (same setup steps), `timeout-minutes: 20`, upload report |
| visual controls | `npm run test:a11y` extended with the new spec | `accessibility.yml` |
| subpath crawl + links | `npm run test:e2e:subpath` | **new**: not run by any workflow today; add a job after the client build |

Local: `npm run test:unit -- tests/unit/client/admin-unsaved-changes-hook.test.jsx`, `node scripts/run-server-tests.js admin-config-roundtrip`, `npx playwright test --config tests/config/playwright.admin-safety.config.js --project=root --headed`.

### Rate-limit and environment pitfalls

1. **Shipped limits**: auth API 30 sign-ins / 15 min, admin API 100 / min (README; decision 9). `e2e-contents.mjs:38-48` raises every limit to 1,000,000 only in the seeded contents dir. A spec that signs in per test without caching cookies hits 429 on any instance without that seed.
2. **`reuseExistingServer: !process.env.CI`** (`playwright.config.js:79`): locally, a developer's own `npm run dev` on 5173 with **real `contents/`** is reused — destructive specs would edit real users and groups. `assertSafetyInstance()` must check a marker (e.g. `rateLimit.adminApi.limit === 1000000` in the platform GET, or a sentinel file the safety server writes) and abort otherwise. The safety config sets `reuseExistingServer: false`.
3. **Login lockout**: 5 failed sign-ins lock the account (`server/utils/loginLockout.js:34`). Never test a wrong password against `admin`; create a throwaway user.
4. **Don't create real 429s** to test load gating: they leak into other specs for the window's duration. Intercept.
5. **GET retry on network error** (`client/src/api/client.js:117-118`): fulfil with a status instead of aborting, or the second attempt loads normally and the test passes for the wrong reason.
6. **CI retries** (`retries: 2` in `playwright.config.js:14`) hide a guard that works "sometimes"; the safety config uses `retries: 0`.
7. **Shared contents and parallel specs**: the main config is `fullyParallel`; a spec that saves platform/auth config there races the crawl and a11y suites. Keep all writes in the safety config.
8. **Auth reload semantics**: CLAUDE.md says auth changes need a restart; the maintainer note says OIDC is live, LDAP next sign-in, NTLM restart. A spec that asserts "still can sign in" must use a fresh `request.newContext()` and must not depend on restart behaviour.
9. **Server unit tests** mount only the route under test, so rate limiters and `adminAuth` are bypassed (`jest.unstable_mockModule('../middleware/adminAuth.js', …)`). Add one test per new refusal that runs through the real `adminAuth` with an anonymous user to prove the refusal is not reachable unauthenticated.

## 3. Shared components/hooks/server layers I require (test seams)

- **`useAdminConfigLoad(loader, { deps })`** → `{ status: 'loading'|'ready'|'error', data, error, retry, canSave }`; consumed by `AdminEditPageShell` (`disabled` prop exists at `AdminEditPageShell.jsx:125,144`) and `AdminSaveBar`. Closes ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5. Test seam: pure hook test + coverage ratchet.
- **`useUnsavedChanges` v2**: also intercepts `navigator.go` and POP; prefer react-router's `useBlocker` if the app runs on a data router (needs checking — `App.jsx`). Same return shape so pages don't change. Closes AX-B6, ID-B11, CU-B4, OB-B16, PL-B14, IN-B12.
- **`ConfirmDialog` props**: add `subject` (the named object), `confirmPhrase` (type-to-confirm), keep current props backward compatible. Closes PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3.
- **Server `adminInvariants.js`** (`server/utils/`): `assertAdminRemains(usersData, groupsResolved, change, actor)`, `assertNoInheritors(groups, groupId)`, `assertAuthReachable(mergedPlatform, actor)`. Pure functions, run **inside** `configStore.updateJson` callbacks. Unit-testable without Express (`server/tests/admin-invariants.test.js` gets the full case matrix; route tests only check wiring). Closes ID-B1 (server), ID-B2, ID-B4.
- **Error codes in `shared/apiErrors.js`**: e.g. `LAST_ADMIN` (409), `GROUP_HAS_INHERITORS` (409), `AUTH_LOCKOUT` (409), `PRECONDITION_FAILED` (412). Clients branch on `code`; tests assert codes, not message text (messages get translated/reworded).
- **Config write layer**: `ETag` from content hash on admin config GETs; `checkIfMatch(req, currentEtag)` helper; merge-patch with `restoreSecretIfRedacted` applied recursively and providers matched by `name`. Closes PL-B4, CU-B3, OB-B10.
- **Test helpers**: `tests/e2e/helpers/admin.js` (above); `tests/unit/client/helpers/renderAdminPage.jsx` (MemoryRouter data router + i18n stub + `makeAdminApiCall` mock by URL/method table) so page tests stop hand-rolling mocks.

## 4. Next/Later notes

- Promote the round-trip contract test to cover **every** admin write route (generated from `scripts/dump-routes.js`, like the response-shape check) — Next.
- Response-shape snapshot only covers GETs (`check-response-shapes.js` header); extend to the error bodies of admin writes.
- Run the full `tests/e2e/` suite nightly (not per PR) so the unwired specs stop rotting.
- Visual regression screenshots for the shared input/button components once the design-system work lands; until then the computed-style check is enough.
- Mutation testing (Stryker) on `adminInvariants.js` only — small, critical, cheap.
- When If-Match becomes required (decision 6 later), flip the "without If-Match → applied" test to 428 and add `Deprecation` header tests.

## 5. Pre-mortem

1. **Lockout guard ships too strict**: an install with only proxy auth (no `authMethod` on `req.user`, or admin via `adminToken`) can no longer save any platform change. *Mitigation*: case L6/L7 matrix; guard only evaluates when auth blocks actually change; integration test with `proxyAuth` user fixture.
2. **Last-admin guard ignores inheritance or external admins** (OIDC/LDAP admins are not in `users.json`): either false refusals or false safety. *Mitigation*: inheritance test (`ops → admins`), decide whether external admins count (§6), test both.
3. **Guard evaluated outside the file lock**: two admins demote each other concurrently. *Mitigation*: concurrent PUT test; invariant functions only called inside `updateJson`.
4. **Load gating blocks a page whose secondary request fails** (schema, groups), making the auth page unusable during a partial outage. *Mitigation*: unit test that only the primary load gates Save.
5. **Unsaved guard double-prompts or blocks the post-save redirect** (markSaved race), training admins to click "Discard" by reflex. *Mitigation*: hook tests for save-then-navigate and nested guards; e2e "save then click sidebar → no dialog".
6. **409 instead of 400 breaks scripted callers** that check for 400 on protected/last-admin-group delete (`groups.js:886,902` throw `BAD_REQUEST` today). *Mitigation*: flag as API change (CLAUDE.md), pin chosen codes in tests, release note.
7. **PATCH restore misses a secret** (new secret field added later, or providers reordered) and wipes it. *Mitigation*: round-trip fixture sets every secret; a schema-driven test lists every field marked secret in the platform schema and fails if the fixture lacks it.
8. **If-Match 412 surfaces as a generic error and the user loses their edits** on reload. *Mitigation*: client conflict test keeps form state.
9. **Destructive e2e locks out the shared CI instance** and every later spec fails with confusing 401s. *Mitigation*: separate config/contents/port, `assertSafetyInstance`, `workers: 1`, `retries: 0`.
10. **New strings only in English** (Now adds many dialogs/errors), the German UI regresses again (AX-B7 class). *Mitigation*: strict check for new keys in en+de; ratchet for old ones.
11. **Subpath regressions invisible** because the subpath suite is not in CI. *Mitigation*: wire `test:e2e:subpath` into a workflow in PR 7.
12. **Tests mock the thing under test** (as the current page tests mock `useUnsavedChanges`) and stay green while the guard is broken. *Mitigation*: rule in review: a fix's regression test may not mock the fixed module; e2e covers the integration.
13. **Ratchet baselines are raised to make CI green.** *Mitigation*: baselines in separate files with CODEOWNERS; the test prints the diff; raising requires a reason comment.

## 6. Questions I have NOT asked

1. **What counts as "an admin" for the last-admin guard** — only local users in `users.json`, or also OIDC/LDAP/proxy users mapped to `admins` by group mapping? *Matters*: decides whether an install with SSO admins can delete its last local admin. *Default*: count local active users with resolved `adminAccess`; if any external mapping grants `adminAccess`, warn but allow.
2. **Lockout refusal: hard block or acknowledged override?** (e.g. switching from local to OIDC is legitimate). *Default*: 409 unless the request includes an explicit `acknowledgeLockoutRisk: true` set by a typed-confirmation dialog; tests cover both.
3. **Status codes for invariants**: 409 vs existing 400 (`groups.js:886,902,773`). *Default*: 409 for new invariants; keep existing 400s unchanged until the user approves the change.
4. **PATCH shape** — RFC 7396 merge patch on `/api/admin/configs/platform`, or per-section routes? *Default*: merge patch on the existing resource; tests written against it.
5. **ETag for admin configs: per file or per section?** *Default*: per file (simpler, conservative).
6. **Is `App.jsx` on a data router** (`createBrowserRouter`)? Decides whether `useBlocker` can replace the navigator patch. *Default*: keep the patch and add `go`/POP handling.
7. **Can CI build the client in the e2e jobs** (time budget ~25 min per `route-crawl.yml:20`)? *Default*: one shared build job with artifact upload.
8. **Are cross-browser runs wanted for safety specs?** *Default*: chromium only, like crawl/a11y.
9. **Who owns ratchet baselines?** *Default*: admin-UI maintainers via CODEOWNERS.

## 7. Decisions I made on my own

- Server invariants tested at supertest level, not e2e; e2e only proves the UI path. Rationale: determinism, speed, no shared-state risk.
- New destructive e2e get their own Playwright config, contents dir and ports, using the production build. Rationale: isolation; the prod build is also what customers run.
- Simulated failures use `page.route().fulfill(status)`, never real rate limits or `abort()`. Rationale: client GET retry and cross-spec leakage.
- Chose `412` for failed `If-Match`, distinct from storage `ETAG_MISMATCH: 409`. Rationale: RFC 9110 semantics.
- Ratchets (baselines that may only shrink) for long-tail classes rather than fixing all at once. Rationale: matches `KNOWN_VIOLATIONS` precedent; keeps Now PRs small.
- Assert error `code`, never message text. Rationale: messages will be translated and reworded.
- Contract test fixtures live next to server tests (`server/tests/fixtures/admin-roundtrip/`), the cross-side problem+json fixture in `tests/contract/`. Rationale: existing layout.
- Did not write any test into the repo, did not run servers or tests (brief: read-only). The system prompt's `/concepts/...` storage rule was overridden by the brief's single-file deliverable.
- Treated the subpath suite's absence from CI as a defect to fix in Now (PR 7), since three Now items are base-path bugs.
