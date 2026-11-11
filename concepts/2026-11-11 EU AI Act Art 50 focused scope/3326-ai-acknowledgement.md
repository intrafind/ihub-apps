# #3326 AI Act: user acknowledgement of AI use - PM + engineering analysis

Epic #3324, stack position 2 of 6 (after #3325, before #3327). Written 2026-11-11 against the checkout at `/workspace/ihub-apps`. Line numbers are from that checkout and will drift; re-grep before editing.

Facts that differ from the issue text:
- The latest migration is **V240**, not V226. `ls server/migrations | sort -V | tail` before you number anything.
- There is **no user data export** (DSAR) feature in the code. GDPR access today means "read the user record in users.json" (`docs/pii-data-handling.md:333-340`). See A5.
- The `GET /api/admin/auth/users` response already carries every field of the user record except `passwordHash` (`server/routes/admin/auth.js:255-270`). `aiAcknowledgements` shows up there without route changes.

---

## Part 1 - Product

### 1.1 What and why
A user must click through a configurable AI-use statement before the first chat message. The confirmation is evidence for the deployer: Art. 4 AI Act requires measures for AI literacy, and an auditor will ask "can you show that people were told?". It is stored per user (users.json) and in the audit log, and an admin can show it, export it, reset it and re-request it after the policy changes.

Beneficiaries:
- **Deployer / compliance officer:** can answer "who confirmed which policy version, when, and what exactly did the text say" (SHA-256 of the text).
- **End user:** is told once, plainly, that the tool is AI and where the policy lives.
- **Admin:** one place (users page) to see status and re-trigger.

### 1.2 User stories
1. As an end user, I want to confirm once that I know I am using AI tools before my first message, so that I know the rules of use (policy link) and I am not asked on every message.
2. As an end user after the admin pressed "Request again", I want to be asked once more at my next message, so that a changed policy reaches me.
3. As an anonymous visitor, I want the same confirmation per browser session without having to sign in, so that public chat apps are not locked out.
4. As an admin, I want to see on the users page who has confirmed which version and when, so that I can follow up on missing ones.
5. As an admin, I want to raise the required version (Request again), remove acknowledgements of one user or all users (confirmation dialog), and export a CSV filtered by acknowledged / not acknowledged, so that I can run a compliance campaign and hand evidence to an auditor.
6. As an admin, I want to switch enforcement off (dialog only asks) or the whole feature off, so that I can roll out gradually.
7. As a data protection officer, I want the acknowledgement to be deleted with the user and visible in the user's own data, so that Art. 15/17 GDPR requests are covered.

### 1.3 Success criteria (measurable)
- With feature + enforcement on, `POST /api/apps/:appId/chat/:chatId` without a valid acknowledgement answers `428` + `code: AI_ACKNOWLEDGEMENT_REQUIRED` and starts no run, writes no chat.
- After acknowledging, the same request succeeds; no second prompt until `requiredVersion` rises or the entries are removed.
- Editing the text alone never re-prompts. Request again re-prompts everyone, including anonymous sessions.
- CSV lists 100 percent of users in users.json, with the filter applied; formula injection is neutralised.
- Every acknowledgement and every admin action has an audit entry (test counts them).
- Deleting a user removes their `aiAcknowledgements` (test).

### 1.4 Non-goals
- Per-app or per-group acknowledgement, per-language versions, e-signature, expiry/renewal timers, reminder emails.
- A DSAR/self-service data export feature (does not exist; not built here).
- Acknowledgement for machine callers (OAuth clients, personal API keys, MCP, A2A, inference API, webhooks, scheduled runs).
- The admin overview page (#3329) and the passive first-turn notice (#3325).
- Backward-compat shims. The new field is additive; nothing to shim.

### 1.5 Ambiguities and proposed resolutions

| # | Question | Resolution (proposed) |
|---|---|---|
| A1 | 428 on SSE/streaming? | The turn is a plain JSON `POST /api/apps/:appId/chat/:chatId`; the SSE stream is a separate `GET` of the same path (`sessionRoutes.js:514`, a read-only subscribe, no model call). Gate only the POST. The client opens the stream *before* the POST (`useAppChat.js:333-340`), so a 428 arrives with the stream attached; the proactive client gate (B7) prevents that in the normal flow and the error path already detaches the stream. Never gate the SSE GET, `/stop`, `/status`. |
| A2 | Which entry points enforce? | Human, session-bound LLM starts: (1) chat POST `sessionRoutes.js:857`, (2) `POST /api/workflows/:id/execute` (`workflowRoutes.js:816`), (3) `POST /api/workflows/executions/:id/chat/:appId` (`:1046`), (4) `POST /api/agents/profiles/:profileId/runs` (`agents/runs.js:158`). One shared middleware, so a fifth is one line. Not enforced: `/api/magic-prompt` (utility call, no conversation; list as follow-up), scheduled tasks (run later as the owner), webhooks (`triggerRoutes.js:51`), voice WS (rides on chat POST). |
| A3 | API / MCP / A2A / inference API callers? | Exempt. Machine principals are `isOAuthClient`, `isPersonalApiKey`, `clientId` set (delegated token), `isAgent` (`jwtAuth.js:338,359,494-510`, `mcpAuth.js:145`). A human cannot click a dialog there, `/v1/*` and `/api/inference/v1/*` keep OpenAI-shaped errors (`api-guidelines.md` scope note), and a 428 would break integrations silently. Document it. Note: personal-API-key calls of the chat POST by integrators are exempt for the same reason. |
| A4 | What is "per session" for anonymous? | Per **guest identity**: the `ihubGuest` cookie (30 days, `chatOwner.js:30-37`). The server remembers it in a signed, httpOnly cookie `ihubAiAck` bound to that guest id. Evidence is the audit entry (no users.json record exists). Cookie lost or cookies blocked = asked again (the chat cannot work without the guest cookie anyway, `GUEST_COOKIE_MISSING`). A stricter "every browser restart" is a one-line change (drop `maxAge`); confirm with PO. |
| A5 | GDPR export / delete? | Delete: the entries live on the user object, so `DELETE /api/admin/auth/users/:id` (`auth.js:630`) removes them; no `USER_CLEANUP_STEPS` entry needed. Audit entries stay under the audit retention (365 days default), as for every other audited action (`pii-data-handling.md:339`). Export: no DSAR feature exists. Deliver (a) the field in users.json (already the documented source), (b) `GET /api/ai-acknowledgements/me` returns the caller's own `history` (self-access), (c) one row in the docs table, (d) a note for whoever builds a DSAR export later. |
| A6 | CSV "filter"? | `status=acknowledged` = has an entry with `version >= requiredVersion`. `status=pending` = everyone else (never acknowledged, or only older versions). Omitted = all. Each row also carries `status` = `acknowledged` / `outdated` / `never`. Scope = users.json records only (anonymous guests are not listed; they are in the audit log). |
| A7 | Interplay with #3325 notice and the old `ui.json` disclaimer? | Three different things: #3325 notice = passive, empty-chat, never stored; this = blocking, stored, once per version; `DisclaimerPopup` (`Layout.jsx:234`, localStorage `ihub-disclaimer-acknowledged`, not stored) = legacy first-visit popup. They are independent settings. Risk: a new user sees the legacy popup, then this dialog. Recommend the UX designer decides stacking; no server coupling. |
| A8 | Default on for upgrades? | The issue says enforcement is on by default. That means every existing installation blocks every chat user (and anonymous visitors) after the upgrade until they click. Recommend: keep it (the epic is compliance-by-default), call it out as a behaviour change in the release note, and get an explicit PO sign-off. Fallback if rejected: migration writes `enabled:false` for existing installs, defaults file keeps `true` for fresh ones. |
| A9 | Enforcement off: what does the dialog do? | Dismissible; reappears at most once per browser session (client `sessionStorage`); server never refuses. Nothing is recorded on dismiss. |
| A10 | Request again while the feature is off? | Allowed (admin may prepare); has no effect until enabled. Show it in the response and UI. |
| A11 | Same text, new version: which hash? | Hash of the resolved text in the language the user saw, stored with that `language`. The client sends the hash it displayed; the server rejects a mismatch (409) so the stored hash is always what was on screen (B3). |
| A12 | Audit retention vs evidence | For known users the durable evidence is users.json. For guests it is only the audit log, which expires after `audit.retentionDays` (365 by default; kept forever if `audit.cleanupEnabled=false`). State it in the docs. |

---

## Part 2 - Engineering

### 2.1 Data model
users.json record (additive, no migration, `passthrough` schema already accepts it):
```json
"aiAcknowledgements": [
  { "version": 2, "textHash": "sha256:9f2c...", "acknowledgedAt": "2026-11-11T09:12:03.000Z", "language": "de" }
]
```
- One entry per version; a repeat at the same version is a no-op. Valid iff any `version >= requiredVersion`.
- `language` is an additive extra to the issue's shape (needed to reproduce the hash); drop it if PO objects.
- Add an optional `aiAcknowledgements` array to `server/validators/userConfigSchema.js:8` (documentation + schema export).

platform.json (`server/validators/platformConfigSchema.js`, next to `audit` at ~460, `.passthrough().prefault({})`):
```json
"aiAcknowledgement": {
  "enabled": true,
  "enforce": true,
  "requiredVersion": 1,
  "resetAt": null,
  "text":  { "en": "...", "de": "..." },
  "policyUrl": ""
}
```
- `requiredVersion` (int >= 1) and `resetAt` (ISO or null) are **server-owned**: written only by the admin actions below, never taken from a settings save (B5).
- `policyUrl`: `^https?://` or a site-relative `/...`; reject `javascript:` etc. in the schema and in the admin POST (the client renders it as a link). Plain-text `text` only; the client renders it as text, never HTML.
- No outbound connection is made (the URL is only a link), so the SSL-whitelist rule does not apply. Do not add a link checker or preview fetch.

Guest cookie `ihubAiAck` = `v<version>.<issuedAtMs>.<hmac>`; HMAC-SHA256 over `guestId|version|issuedAtMs` with `resolveJwtSecret()` (`server/utils/tokenService.js:62`). httpOnly, `sameSite:lax`, `path:/`, secure via `getCookieSecureFlag(req)`, `maxAge = GUEST_COOKIE_MAX_AGE_MS`. Valid iff HMAC ok, bound guest id matches, `version >= requiredVersion`, `issuedAt >= resetAt`.

### 2.2 Server code (new / changed)
New:
- `server/services/aiAcknowledgement/aiAcknowledgementService.js` - `getSettings()` (reads `configCache.getPlatform()`, applies defaults), `resolveText(settings, language)`, `textHash(text)` (SHA-256 of the exact string, `sha256:` prefix), `statusOfUser(user, settings)` -> `acknowledged|outdated|never`, `summary()` (counts for #3329: acknowledged / pending / total), `buildCsvRows(status)`.
- `server/services/aiAcknowledgement/guestAcknowledgement.js` - sign/verify/set cookie (uses `guestIdOf`, `guestOwnerId` from `server/services/chat/chatOwner.js:85,105`).
- `server/middleware/aiAcknowledgementRequired.js` - the 428 guard (2.3).
- `server/routes/aiAcknowledgementRoutes.js` - user endpoints; register in `server/startup/routes.js` beside `registerUsageRoutes` (~line 98).
- `server/routes/admin/aiAcknowledgements.js` - admin endpoints; register in `server/routes/adminRoutes.js` after `registerAdminAuthRoutes(app)` (line 66).
- `server/migrations/V24x__ai_acknowledgement_defaults.js` + `server/tests/migration-v24x.test.js`.

Changed:
- `server/utils/userManager.js` (after `saveUsers`, line 186): `recordAiAcknowledgement(userId, entry, usersFilePath)` and `clearAiAcknowledgements(userIdOrNull, usersFilePath)`. **Use `configStore.updateJson(relPath, mutate)`** (`ConfigStore.js:681`), not `loadUsers` + `saveUsers`: `saveUsers` is a last-write-wins rewrite of the whole file (its own comment, lines ~200-215) and acknowledgements are written by many users at once at rollout. Resolve the path with `locateUsersFile` / `localUsersFile(platform.localAuth)` like the rest of this module; when `relPath` is null (file outside contents/) fall back to `loadUsersFresh` + `saveUsers`. After writing: `configCache.refreshCacheEntry(cacheKey)` (waits for the cluster). Note `routes/admin/auth.js:23` hardcodes `config/users.json`; the new admin code must use the module's path, not that constant.
- `server/routes/admin/configs.js` POST (line 267): the merge at ~326-345 lists keys explicitly, so a client-sent `aiAcknowledgement` is dropped unless named. Add it, validate `policyUrl`/text shape, and **always take `requiredVersion` and `resetAt` from `existingConfig`**. If `enabled`, `enforce`, `policyUrl` or a text hash changed, write an audit entry (`update`, resource `aiAcknowledgement`, details: changed keys + new text hashes).
- `shared/apiErrors.js` `FEATURE_ERROR_CODES` (line 79; chat codes near 327): add `AI_ACKNOWLEDGEMENT_REQUIRED: 428`. Add `apiErrors.AI_ACKNOWLEDGEMENT_REQUIRED` to `shared/i18n/en.json` (apiErrors block at ~9508) and `de.json`.
- `server/defaults/config/platform.json` (near `audit`, line 301): the block with default en + de text.
- `server/validators/auditEntrySchema.js`: no change needed; reuse existing actions (below).
- `tests/config/e2e-contents.mjs` (platform seeding, ~line 30): see 2.7.

### 2.3 Enforcement (428)
`aiAcknowledgementRequired(req, res, next)` (new middleware), placed **after `chatAuthRequired` and before `validate(...)`** so a 401/403 wins over a 428 and no side effect (`settleChatClarifications`, `authorizeChat`, repository writes at `sessionRoutes.js:~950-1000`) has run:
1. `settings = getSettings()`; if `!enabled || !enforce` -> `next()`.
2. Machine principal (A3) -> `next()`.
3. Principal has a users.json record -> `statusOfUser`. If not acknowledged, **re-read once with `loadUsersFresh()`** before refusing (`userManager.js:165`; another worker may have written the ack milliseconds ago and the sync bus lags).
4. No record (anonymous guest, or a session whose record vanished) -> verify the guest cookie (2.1).
5. Not valid -> `throw new ServiceError('AI_ACKNOWLEDGEMENT_REQUIRED', 'Confirm the AI usage notice before sending messages', { status: 428, details: { requiredVersion } })`. The error middleware renders `application/problem+json` with `code` (`api-guidelines.md` section 3). No `res.status().json()`.

Apply it to the four routes in A2. Do not log an audit entry per refusal (noise); `logger.debug` only.

### 2.4 Endpoints (docs/api-guidelines.md compliant)
User (`authRequired`, works for the anonymous principal like `GET /api/usage/me`, `usageRoutes.js:81`):
- `GET /api/ai-acknowledgements/me?language=de` -> 200
  `{ enabled, enforce, requiredVersion, acknowledged, text, textHash, language, policyUrl, history? }`
  `history` only for users with a record. When `enabled=false` return `{ enabled:false, enforce:false, acknowledged:true, requiredVersion }` and no text. This is **not** in the cached `/api/configs/platform` (`dataRoutes.js:780`): that whitelist is global and cached, this is per user.
- `POST /api/ai-acknowledgements/me` body `{ version, textHash, language }`
  - `201` + `Location: /api/ai-acknowledgements/me`, body = the new entry. `200` with the existing entry if already valid at that version (idempotent: two tabs, double click; no second audit entry).
  - `409 CONFLICT` (generic code, `details.requiredVersion`) if `version != requiredVersion` or `textHash` != hash of the current text in `language` (admin changed it while the dialog was open; client refetches and re-shows).
  - `403 FEATURE_DISABLED` when the feature is off.
  - Known user: `recordAiAcknowledgement` + audit. Guest: set `ihubAiAck` cookie + audit only; skip the audit entry when a valid cookie is already present (no unbounded audit growth from a client without a cookie jar; the global rate limiter also applies).

Admin (`adminAuth`):
- `GET /api/admin/auth/users` - unchanged (returns `aiAcknowledgements`). The UI gets `requiredVersion` from `GET /api/admin/configs/platform`. No new read endpoint (matches the issue).
- `POST /api/admin/ai-acknowledgements/_request-again` -> 200 `{ requiredVersion, previousRequiredVersion }`. Increment inside `configStore.updateJson('config/platform.json', ...)` (atomic against a concurrent settings save or a second click), then `configCache.refreshCacheEntry('config/platform.json')`.
- `DELETE /api/admin/auth/users/{userId}/ai-acknowledgements` -> 204 (`404` if no such user; `assertValidId` like `auth.js:503`).
- `DELETE /api/admin/ai-acknowledgements` -> 204; clears every user record and sets `resetAt = now` (so guest cookies issued before it die too). Confirmation dialog is client-side; the server needs nothing extra.
- `GET /api/admin/ai-acknowledgements/_export?status=acknowledged|pending` -> `text/csv`, `Content-Disposition: attachment; filename="ai-acknowledgements.csv"`. Model on `GET /api/admin/audit-log/export` (`routes/admin/auditLog.js:75`) and `buildCsv` (`server/utils/csv.js`, already escapes `= + - @`). Columns: `userId, username, name, authMethods, active, status, version, acknowledgedAt, textHash, requiredVersion`. No email (data minimisation).
  The `_action` GET form is the guidelines' virtual-collection pattern; if reviewers prefer a bare verb-free path, `GET .../ai-acknowledgements?format=csv` is the alternative.

Audit via `logAudit` (`AuditLogService.js:178`), existing actions only (`auditEntrySchema.js` enum has `create|update|delete|export`), `resource: 'aiAcknowledgement'`:

| Event | action | resourceId | details |
|---|---|---|---|
| user acknowledges | create | userId, or guest owner hash (`guestOwnerId`, never the cookie secret) | version, textHash, language, policyUrl, subject user/guest |
| request again | update | `requiredVersion` | from, to |
| remove one | delete | userId | removed versions |
| remove all | delete | `*` | users, entries |
| export | export | `*` | status filter, rows |
| settings changed | update | `settings` | changed keys, text hashes (see 2.2) |

`logAudit` masks email-shaped ids unless `audit.includeEmail`; local usernames are not emails, fine. Details are capped at 64 KB (`sanitizeDetails`).

### 2.5 Migration
Number: next free is **V241**. #3325 is first in the stack and also adds platform defaults (notice text), so it will most likely take V241 and this issue takes **V242**, #3327 V243. Decide by `ls server/migrations | sort -V | tail -3` when the branch is cut after #3325; never reuse or renumber an applied one. Use the `create-migration` skill.
```js
export const version = '242'; export const description = 'ai_acknowledgement_defaults';
precondition: ctx.fileExists('config/platform.json')
up: ctx.setDefault(platform,'aiAcknowledgement.enabled',true) ... enforce true, requiredVersion 1,
    resetAt null, text {en,de}, policyUrl ''   // existing values kept (setDefault semantics, see V232)
```
Test like `migration-v232.test.js`: fresh, partial (admin already set `text`), idempotent second run.
Mirror the same block in `server/defaults/config/platform.json` (fresh installs copy defaults and skip the migration for brand-new files only; existing installs need the migration).
Default English/German text must be neutral and short; the real wording is a content task for the PO/legal.

### 2.6 Client (data and state only; visuals are the designers' job)
State the UI needs:
- `GET /api/ai-acknowledgements/me` result: `enabled, enforce, acknowledged, requiredVersion, text, textHash, language, policyUrl`. Refetch on language change, on login/logout (`AuthContext` user id change), and after a 409.
- A promise-based gate `ensureAcknowledged()` provided by a new `AiAcknowledgementProvider` mounted next to `DisclaimerPopup` in `client/src/shared/components/Layout.jsx:234` (not inside `AuthContext.jsx`: this state is per principal and per language, and the provider must also exist for anonymous). Files: `client/src/shared/hooks/useAiAcknowledgement.js`, `client/src/api/endpoints/aiAcknowledgement.js` (export through `client/src/api/index.js`).
- Where it plugs in: `useAppChat.js` `sendMessage` (before placeholders and the stream are created) awaits `ensureAcknowledged()` when `enabled && !acknowledged`; the reactive path adds `AI_ACKNOWLEDGEMENT_REQUIRED` to the error handling at `useAppChat.js:42-66/360` (do not render it as an error text: re-open the gate, then retry the pending message once). Same gate for `AppCanvas`, `ComparePanel`, `useVoiceMode`, `WorkflowExecutionPage`, `useOfficeChatAdapter` (all call chat/workflow POSTs). Verify the Office taskpane, `browser-extension/background.js` and the Teams/Nextcloud embeds: they use their own entry points and must at least show a readable message for a 428 (check each; likely a follow-up if they bypass `Layout`).
- Enforcement off: dismissible, shown at most once per browser session (`sessionStorage`, wrapped in try/catch).
- Admin users page (`AdminUsersPage.jsx`, 466 lines, loads `/admin/auth/users` at line 161): needs per user `aiAcknowledgements`, plus `requiredVersion`/`enabled` from the platform config, to derive the status column; the actions are the four admin calls above; CSV download goes through the same `makeAdminApiCall` mechanism (check `admin-api-call-body-conventions.test.jsx` for blob handling).
- Admin settings (text, policyUrl, `enabled`, `enforce`): in the platform config form via `POST /api/admin/configs/platform`; which page hosts it is the UX designer's call. `requiredVersion` is shown read-only.
- i18n: new keys in `shared/i18n/en.json` + `de.json` under `aiAcknowledgement.*` (`title`, `accept`, `policyLink`, `dismiss`, `stale`) and `admin.users.aiAcknowledgement.*` (column, status values, request again, remove one/all, confirm texts, export, filter); `apiErrors.AI_ACKNOWLEDGEMENT_REQUIRED`. Both languages in the same commit.
- No new top-level route, so the `KNOWN_ROUTES` / `index.html` sync rule in CLAUDE.md does not apply (the dialog is not a route).

### 2.7 Tests
Unit (`server/tests/`, jest or node:test; see `scripts/run-server-tests.js` classification):
1. `aiAcknowledgementService.test.js`: validity `>=`, hash stability and per-language, idempotent record, clear one/all, status values, CSV filter semantics, formula-injection cell.
2. `aiAcknowledgementMiddleware.test.js`: enforce on/off/disabled; machine principals exempt; known user ok/outdated/never; stale-worker re-read; guest cookie valid / tampered / wrong guest / old version / before `resetAt`; response is problem+json with `code` and `status 428`.
3. Chat route (pattern: `server/tests/chatSessionRoutesErrors.test.js`): POST without ack -> 428 **and** `authorizeChat` not called, no repository write; SSE GET, `/stop`, `/status` unaffected.
4. Admin routes: non-admin gets 403 on all five (also add to `admin-endpoints-security.test.js`); request-again is atomic under two parallel calls; remove one/all; export content + audit counts; `GET /api/admin/auth/users` includes `aiAcknowledgements` and never `passwordHash`.
5. Platform POST preserves `requiredVersion`/`resetAt` when the client sends stale values; audit written on settings change; bad `policyUrl` -> 400.
6. Concurrency: 50 parallel `recordAiAcknowledgement` for different users lose none (`updateJson`).
7. `admin-delete-user.test.js` / `user-deletion-cleanup.test.js`: deleted user's acks are gone.
8. `migration-v242.test.js`; `default-config-schema-validation.test.js` still passes with the new default block; en/de key parity and registry/i18n test for the new error code.
9. `npm run lint:fix && npm run format:fix`, and `scripts/check-api-guidelines.js` (route naming, verbs).
Client (`tests/unit/client/`): gate opens on `enabled && !acknowledged`; 428 triggers re-open and one retry; stale 409 refetches; `text` rendered as text (XSS: `<img onerror>` stays inert); disabled/enforce-off behaviour.
E2E (`tests/e2e/ai-acknowledgement.spec.js`, Playwright; admin `admin`/`password123`): chat blocked by dialog, accept, reply arrives; direct `page.request.post` to the chat route before accepting returns 428; Request again re-prompts; Remove clears; CSV download has the user; anonymous flow if anonymous access is on in the e2e contents.
**Existing suites break by default**: `tests/e2e/chat.spec.js` and every spec that sends a message hit the dialog/428 once the default is `enforce:true`. Set `platform.aiAcknowledgement.enabled = false` in `tests/config/e2e-contents.mjs` (where `rateLimit` is raised, ~line 30) and have only the new spec turn it on via the admin platform API. Same check for `tests/integration/api/chat.test.js` and the subpath e2e config.

### 2.8 Docs and release note
- Feature doc: extend a shared EU AI Act page (`docs/eu-ai-act.md`, created by #3325 if it exists, else create it and add it to `docs/SUMMARY.md`); keep this section: settings, versioning rule, who is exempt, guest behaviour, audit retention caveat, CSV columns.
- `docs/pii-data-handling.md:333-340`: add the acknowledgement to the Art. 15/17 rows.
- `docs/api-guidelines.md`: no change. Mention the 428 code in the error-code docs if a list exists (`docs/error-responses.md`).
- Release note in `docs/releases/next/` via the `/document-feature` skill: `features.md` entry, and a line in `breaking-changes.md` because enforcement is on by default (A8). Never write into a numbered release directory.
- New source files carry the two-line SPDX header (`reuse annotate --copyright="IntraFind Software AG" --license=LicenseRef-iHub-Apps --exclude-year --single-line <file>`).

### 2.9 Pitfalls checklist
1. Platform POST drops unnamed keys and would overwrite `requiredVersion` with a stale form value (2.2).
2. `saveUsers` is last-write-wins across workers; use `updateJson` (2.2). Existing admin PUT (`auth.js:545`) is also a whole-file read-modify-write and can still clobber a concurrent ack within a small window; acceptable, mention in review.
3. `routes/admin/auth.js` reads the hardcoded `config/users.json`, the login code reads `localUsersFile(platform.localAuth)`. A customised `usersFile` makes them diverge; use the userManager path.
4. External users are persisted at login (`validateAndPersistExternalUser`, `userManager.js:564`), so `req.user.id` is the users.json key. Service principals and a session whose record was deleted have no record: they must not crash the guard (cookie path / exempt).
5. A 428 must come before any side effect of the chat POST (clarification settling, chat creation). The stream is already attached when the POST fails (A1).
6. Guest binding: the ack cookie is bound to the guest id; do not store the cookie secret anywhere (audit uses `guestOwnerId`).
7. Default-on means all existing e2e/integration tests need the switch (2.7) and every non-`Layout` client (Office, extension, Teams, embeds) needs a defined 428 behaviour.
8. Text edits must not bump the version (issue rule); the 409-on-hash-mismatch keeps evidence honest instead.
9. Do not cache `GET /api/ai-acknowledgements/me` (per user, per language); send `Cache-Control: no-store`.
10. `enabled=false` must make the guard a pure no-op (no users.json read) so the default hot path stays cheap when off.

### 2.10 Implementation order (rough size)
1. Schema + defaults + migration + error code + i18n keys (0.5 d)
2. `userManager` helpers with `updateJson` + service + guest cookie (1 d)
3. Middleware, wire into 4 routes, user GET/POST endpoints (1 d)
4. Admin endpoints (request again, remove one/all, export), platform POST merge + audit (1 d)
5. Server tests incl. migration, concurrency, route/guard tests (1 d)
6. Client provider/hook/gate + `useAppChat`/canvas/compare/voice/workflow/office wiring (1.5 d, excluding visuals)
7. Admin users page column/actions/export wiring (0.5 d, excluding visuals)
8. E2E, e2e-contents switch, docs, release note, lint/format, SPDX (1 d)

Total roughly 7 person-days (size L), plus design review. Dependencies: needs #3325 merged first only for the shared docs page and the migration number; #3329 reuses `summary()`, the export and the two actions, so keep them in the service, not in route handlers. Decisions needed from PO before coding: A8 (default on for upgrades), A4 (guest lifetime), A2 (workflows/agents in scope), and the default policy wording.
