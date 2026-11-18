# On-prem iHub admin: the Now phase from the operator's seat

Perspective: I run iHub on-prem (Docker and bare Node) behind a corporate proxy with a private CA. Sign-in is OIDC (Entra or Keycloak) plus LDAP, with a local `admin` kept for emergencies. Some installs sit under `/ihub/`. I script the admin API (curl and CI jobs), sometimes edit `contents/config/*.json` by hand, and upgrade every few releases, so I skip many `docs/releases/next/` entries at once. Everything below was re-checked against HEAD `24ec91d` (2026-11-16). Where code differs from the review, I say so.

---

## 1. Angle summary

- **The P0 is worse for my installs than the review says.** On a failed load, `AdminAuthPage.jsx:40-80` seeds `mode: 'proxy'`, `localAuth.enabled: false` and **`anonymousAuth.enabled: true`**. Save sends every block, and `configs.js:357-364` takes each one wholesale (`newConfig.auth || existingConfig.auth`). One click can lock me out **and** open the instance to anonymous users, not just lock me out (ID-B1). Load-gating has to land first, before anything cosmetic.
- **New: every Authentication save erases proxy-JWT `jwkUrl`, not just Advanced and Provenance (extends PL-B4).** `GET /api/admin/configs/platform` strips `jwkUrl` from `proxyAuth.jwtProviders` (`configs.js:256-267`). `AdminAuthPage` posts the whole `proxyAuth` back (`:134`), the server keeps it as sent (`configs.js:359`), and nothing restores `jwkUrl` (grep: its only server mention is the strip comment). `JwtProvidersSection.jsx` shows the field empty. So any edit to any auth method on `/admin/auth` silently breaks JWT proxy sign-in. Same fix as PL-B4 (restore-if-omitted on the server), but at P1 with the auth page in scope.
- **Break-glass has to keep working, and today it is undocumented.** There is no env-based recovery. `ADMIN_SECRET` is documented in `docs/INSTALLATION.md:599` but no server code reads it, so the doc is stale. The real recoveries are (a) edit `contents/config/platform.json` on disk to re-enable `localAuth` and restart, and (b) the implicit "admin rescue" (`utils/adminRescue.js:238`), which makes the *next* non-LDAP user to sign in an admin when `hasAnyAdmin()` is false. Any new guard must sit on **admin API writes only**. It must never refuse to boot or reject a hand-edited file.
- **The admin rescue is itself a risk on OIDC-only installs (Suspected, from code).** `hasAnyAdmin()` (`adminRescue.js:55-140`) counts only persisted users whose **`internalGroups`** grant admin, plus LDAP/NTLM default groups. It deliberately ignores group *mappings* (e.g. Entra "iHub-Admins" → `admins`). If I disable local sign-in after SSO works (the hardening step everyone takes) and my admins get admin only through a mapping, the **first OIDC or proxy user to sign in becomes an admin** (`userManager.js:769, 826`). The last-admin guard and the lockout refusal must share one definition of "an admin can still sign in", and that definition must include mappings. This needs the security expert's eyes before we ship guards that depend on it.
- **Scripts must not break silently.** Every new 409 (last admin, group still inherited from, lockout refusal) and every status-code change (decision 13: 201 on create) changes behaviour for my scripts. All of these are additive and fine, but **each needs a line in `docs/releases/next/breaking-changes.md` naming the route, the status and the `code`**. I skip releases, and that file is the only thing I read before upgrading.
- **`If-Match` must stay optional (decision 6) and must hash the file on disk, not the cache.** I edit `ui.json` and `groups.json` by hand. The existing ETags (`apps.js:303`, `models.js:422`) are cache list ETags. An `If-Match` that compares against the config cache would not notice my on-disk edit and would still let a stale UI save overwrite it. Compute the version inside `configStore.updateJson` under its lock.
- **Backup is my DR plan, and it is currently a loaded gun.** Choosing a file restores at once (`AdminBackupPage.jsx:246`, PL-B1). The ZIP holds `.encryption-key`, JWT keys and password hashes (PL-B2, `backup.js:120-121`). The metadata has no iHub version (`backup.js:323-329`: `version: '1.0'` is the *format*), so restoring a backup from a *newer* iHub onto an older one runs `runConfigMigrations()` against migrations it doesn't know. The server already keeps 3 pre-import copies in `contents/.backups/` (`backup.js:42-48`). Nobody is told, and the UI has no way back to them.
- **Privacy fixes change my log pipeline.** Removing `query` from `CHAT_REQUEST` (`server/utils.js:383-393`, OB-B4) and `user` from `FEEDBACK` (`utils.js:360-371`, OB-B28) is right. My SIEM parses both, though, so the release note must name the removed fields and the opt-in key, if there is one.
- **Rate limits are per IP, and behind my proxy every admin shares one IP.** The shipped `adminApi` limit is 100/min (`server/defaults/config/platform.json:238-241`) against 500 in code (`rateLimiting.js:152`). The 429 is the usual trigger for every "save after failed load" bug. Load-gating stops the damage. The limit still needs fixing via a guarded migration (decision 9).
- **Subpath deployments:** SH-B1, CU-B9 and CU-B10 bite me directly at `/ihub/`. The docs 404 and the short links both break the base path.

---

## 2. Now-phase plan from my angle

Shipping order is a recommendation. PR 1 and PR 2 must merge before any PR that touches a config page's layout. The flags below mean: **[DEC n]** = gated by README decision n; **[CONTRACT]** = changes admin API behaviour for scripts; **[SHAPE]** = config shape or migration; **[BEHAVIOUR]** = changes shipped runtime behaviour.

### PR 1: Load-gating (ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5)

- One hook, `useAdminConfigSection` (§3). No form, no Save, no "All valid" until the GET succeeds. On failure, show `AdminLoadError` with Retry.
- `AdminAuthPage` drops its hard-coded initial `config` (`:40-80`) entirely. `savedConfig === null` means no form is rendered.
- The Logging page makes three sequential GETs (OB-B2), so it gates on **all** of them.
- **Done means:** a Playwright test per page answers the GET with 429 and 500 and asserts that no enabled Save exists and no POST/PUT is sent. The pages in scope are `/admin/auth`, MCP gateway, Logging, Telemetry, Security (SSL, SSRF, CORS, Cookies, Proxy) and `/admin/ui`. A unit test asserts that `AdminAuthPage` has no default auth object left to post.
- No contract or shape change.

### PR 2: Server-side safety on the platform write (ID-B1 defence in depth, PL-B4, extended jwkUrl finding)

- **Restore omitted secret-bearing fields** in `POST /api/admin/configs/platform`. For each `proxyAuth.jwtProviders[i]` matched by `name`, keep the stored `jwkUrl` when the submitted one is absent or empty. Same idea as `restoreSecretIfRedacted`.
- **Done means:** a test where GET → POST round-trips leave `platform.json` byte-identical, apart from key order (the round-trip contract test, theme 6), for an install with proxy JWT providers, OIDC, LDAP and an Azure speech key.
- **Lockout refusal** (ID-B1, ID-B2 "untick own method"). After the merge, inside the `updatePlatform` callback, refuse with **409** when either holds:
  1. A **human** caller (`req.user.authMode` not `oauth_*`) would lose their own sign-in method: `localAuth.enabled` turned off while they're signed in locally, their OIDC provider removed or disabled, `proxyAuth` disabled while they came in through the proxy.
  2. **No** sign-in route to an admin remains for anyone. This uses the shared `canAnyAdminSignIn(platform, groups, users)`, which counts mapped external admin groups (§3).
  - New registry code, e.g. `AUTH_LOCKOUT` (409), whose `details` name the method and the reason. **[CONTRACT]**, additive.
  - **Override:** body field `confirmLockoutRisk: true`. Audit-logged with the before/after methods. I need it for the legitimate "move from local to OIDC-only while signed in locally" step, when I've tested OIDC in another browser. The UI shows it as a named confirmation, not a checkbox. **Needs approval**, because it's a new body field on a shared endpoint.
  - Machine callers (service client, static API key) only get check 2. My CI must be able to switch methods.
- **Done means:** tests for local→OIDC with no override (409), with override (200 plus audit entry), from an API key (200 if an OIDC admin mapping exists), and proxy-auth disabled by a proxy-signed-in admin (409). A hand edit of `platform.json` on disk is never checked: the server boots with it and only *logs a warning* if no admin route exists.

### PR 3: Users and groups invariants (ID-B2, ID-B3, ID-B4)

- **ID-B3** is client-only. `AdminUserEditPage.jsx:282` sends `active` from the loaded user's `active`, not `enabled`. The server PUT is already partial (`auth.js:545`), so there's no contract change. Done: a test that disables, edits the email and saves, then checks that `active` is still `false`.
- **ID-B2:** `PUT /api/admin/auth/users/:id` refuses (409 `LAST_ADMIN`) to remove admin groups from, or deactivate, the last admin who can sign in. It also refuses (409) to deactivate or demote **yourself** unless another admin route exists. **[CONTRACT]**, additive.
  - **Fix `isLastAdmin` (`adminRescue.js:308-367`) to use the same predicate.** Today it ignores whether the admin's auth method is enabled, and it **returns `false` on error** ("allow deletion"). That fails *open*. A guard should fail closed with 503 and a clear message.
- **ID-B4:** `DELETE /api/admin/groups/:id` refuses with 409 `RESOURCE_IN_USE`, `details.usedBy: [{type:'group', id}]`, when another group's `inherits` names it. Verified: no `inherits` check in `groups.js:878-946`. **[CONTRACT]**, additive. Also refuse a **PUT** that removes a group's `inherits` target or sets a missing one. The same cache freeze can be reached by hand-editing, so `configCache` should **log and keep serving** rather than freeze silently (`configCache.js:593-600`). A hand-edited orphan must surface on the admin Overview, not just in the log.
- **Status-code consistency:** existing guards answer differently. Last admin user delete is `FORBIDDEN` 403 (`auth.js:661`), last admin group delete is `BAD_REQUEST` 400 (`groups.js:911`). Pick 409 for the new guards. Changing the two existing ones is a contract change, so **ask** (I'd accept a clean change with a release note, since scripts rarely branch on these).
- **Done means:** each refusal is a problem+json body with `code`, and the release note lists every route and code.

### PR 4: No redacted or whole-file overwrites (PL-B4, CU-B3, OB-B10)

- PL-B4: Advanced (`AdminAdvancedPage.jsx:38-42`) and Provenance (`ProvenanceSettingsCard.jsx:191-198`) post only their own keys, as `AiNoticeSettingsCard.jsx:58-59` does. PR 2 makes the server tolerate the old clients as well.
- CU-B3: `/admin/ui` save. Short term, the server merges the `pages` list from disk: the page routes own `pages`, and the UI form must not write it. Plus **optional `If-Match`** on `POST /api/admin/ui` **[DEC 6]**. Without the header, behaviour stays as today, so my scripts keep working.
- OB-B10: the "Save Privacy Settings" card sends only the privacy keys. `PUT /api/admin/logging/config` is already a shallow merge (`logging.js:75-80`). Add `logAudit` and `saveSnapshot` there (OB-B6: verified there are none).
- **Done means:** a two-tab test, where creating a page in tab B and saving the UI in tab A keeps the page. With `If-Match` from a stale GET, the answer is 412 and the `code` names the resource. Also an on-disk edit test: GET, then edit the file by hand, then POST with the old `If-Match`, expecting 412.

### PR 5: Unsaved-changes guards (ID-B11, CU-B4, AX-B6, OB-B16, PL-B14, IN-B12)

- Wire `useUnsavedChanges` into `AdminSettingsPage` once. Give `Modal` a `dirty` prop.
- `/admin/auth` first: losing a half-typed OIDC client config is the one that costs me an afternoon with the IdP team.
- **Done means:** Playwright edits a field, clicks the sidebar and sees a dialog, on the 6 named surfaces. No server change.

### PR 6: Named confirmations and backup safety (PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3, PL-B2 callout)

- **PL-B1:** picking a file only *stages* it. A dialog shows the file name, the backup date and the number of files from `backup-metadata.json`, plus "Current contents will be saved to `contents/.backups/<timestamp>` (last 3 kept)", and asks for typed confirmation. Done: no POST before the confirmation, tested.
  - Optional, but I want it: `POST /api/admin/backup/_preview` returns metadata and a file list without swapping. **[CONTRACT]**, additive. If it's too big for Now, read the metadata client-side from the ZIP (jszip), with no server change.
  - **Version check.** Add `ihubVersion` and `lastMigration` to `backup-metadata.json` on export (additive), and on import refuse (409 `BACKUP_NEWER_THAN_SERVER`) a backup whose migration history contains versions this server doesn't have. Old backups without the fields still import. **[CONTRACT]**, additive, but it's a new refusal, so it gets a release note.
- **PL-B2 (Now = callout only, [DEC 10]):** say plainly on the page and in the release note that the ZIP contains `.encryption-key`, JWT signing keys and password hashes, and that it must be stored like a key file. Do **not** change the export contents in Now. My restore-to-new-server runbook depends on the key being in the ZIP. Note: the export is **`GET /api/admin/backup/export`** (`backup.js:932`), not `POST` as decision 10 says. Fix the decision text before asking.
- Other confirmations: `ConfirmDialog` gets `itemName` and `consequences[]` props (§3). Add ESLint `no-alert`.
- **IN-B3:** deleting a credential that's in use returns 409 with `usedBy[]`. **[CONTRACT]**, additive.

### PR 7: Privacy and logging (OB-B4, OB-B28, OB-B5, PL-B12 shown) **[DEC 7] [BEHAVIOUR]**

- OB-B4: remove `query` from the `CHAT_REQUEST` line for all installs. If a content-logging switch is added, it's a **new key** (e.g. `logging.contentLogging.chatQuestions: false`). Since absent means off, **no migration is needed**; the code default does it. I'd still add the key to `server/defaults/config/platform.json` so it's discoverable.
- OB-B28: drop `user` from `FEEDBACK` at `info`.
- **Release note (`breaking-changes.md`):** the event types and field names removed, the opt-in key, and that the change applies to every log level. My SIEM rules break silently otherwise.
- PL-B12: Now only *shows* that SSL-whitelisted hosts are SSRF-trusted (`httpConfig.js:158-164`, read-only text on SSL and SSRF). **[DEC 14]** decides the coupling. As a proxy/private-CA admin I depend on it today (internal LLM endpoints on RFC1918 addresses are in my `ssl.domainWhitelist`), so option (c) would break me. If (b) is chosen, the migration must **copy** the entries, never move them, and log each one copied.

### PR 8: Contract bugs that bite operators (subset of the Now "contract bugs" row)

- **CU-B9, CU-B10** (short-link copy and redirect drop the base path) and **SH-B1** (docs 404 on reload, `staticRoutes.js:109-110`). Done: a test under `/ihub/` doing a cold load of `/ihub/admin/docs/<page>.md`, plus a short-link redirect staying under `/ihub/`. These need the subpath e2e harness that CLAUDE.md already asks for on new routes.
- **AX-B1** (hide the agent schedule): the editor must **round-trip** a `schedule` already in the agent JSON, never strip it. Hiding a field is not deleting data. I hand-wrote schedules expecting them to work once the scheduler is fixed.
- **ID-B6:** UI-only in Now (the default selection becomes empty). The server `[]`→`['*']` (`oauthClients.js:264-268`) stays until decision 4.

### PR 9: Docs and release notes (OB-B5, SH-B14, IN-B23, CU-B12, plus my additions)

- `docs/releases/next/breaking-changes.md` gets one section, "Admin API: new refusals". It's a table of route, method, condition, status, `code` and how to fix: last admin (user PUT), inherited group (DELETE), lockout (platform POST), credential in use, backup newer than server, plus `If-Match`→412 when the header is sent.
- `docs/releases/next/fixes.md`: the jwkUrl erase. Admins who use proxy JWT must **re-check `jwkUrl` after upgrading**, because a previous save may already have erased it. This is the single most important line for me.
- **New "Recover admin access" section** in `docs/security.md` or the planned `sign-in-setup.md`: the on-disk edit (`contents/config/platform.json` → `localAuth.enabled: true`, restart), where `users.json` lives, how the admin rescue behaves, and that `ADMIN_SECRET` does nothing. Remove it from `INSTALLATION.md:599` or implement it, and ask which.
- Fix the drift: `breaking-changes.md` says `PUT /api/admin/configs/platform`, but the route is `POST` (`configs.js:277`).

### Not in my Now (fine to stay where the README puts it)

The visual P1s, workflow quick fixes, translation ratchet and Overview honesty are good, but none would bite me on upgrade. Ship them as they come.

### Pull forward from Next, gated

- **Rate limit [DEC 9] [SHAPE]:** migration `V2xx__admin_api_rate_limit_default.js`, modelled on V253's "only untouched shipped values" pattern. It changes `rateLimit.adminApi.limit` to 500 only when it is exactly `100` with `windowMs: 60000`. A tuned value is left alone and logged. Keying per user (`req.user.id` for authenticated admin calls, IP otherwise) is a code change with no shape change. I want both in Now, because two admins behind one egress IP is my normal day.

---

## 3. Shared components, hooks and server layers

| Name | API sketch | Closes |
|---|---|---|
| `useAdminConfigSection(path, { select, merge })` | `→ { status: 'loading'|'ready'|'error', data, savedData, dirty, error, retry, save(partial, { ifMatch }) }`. Renders nothing editable unless `ready`. `save` sends only changed top-level keys of its section, plus the `ETag` it read. It calls `useUnsavedChanges(dirty)` itself. | ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5, OB-B10, PL-B4 (client side), ID-B11/PL-B14 when used |
| `AdminConfigGate` | `<AdminConfigGate state={section}>{form}</AdminConfigGate>`: skeleton, then `AdminLoadError` with Retry, then children. | same pages; enforced by a lint rule ("no `onSave` outside a gate") |
| Server: `restoreOmittedSecrets(submitted, stored, spec)` | spec lists paths such as `proxyAuth.jwtProviders[name].jwkUrl`, `auth.jwtSecret`, `speech.azure.subscriptionKey`. Generalises `restoreSecretIfRedacted` to "absent or redacted → keep stored". | PL-B4, the extended jwkUrl finding, and future redaction additions |
| Server: `adminAccessInvariants.js` | `canAnyAdminSignIn(platform, groups, users)` and `callerKeepsSignIn(platform, req.user)`. It considers enabled methods, active users, `internalGroups`, **external group mappings to admin groups** and LDAP/NTLM default groups. It is used by the platform POST, user PUT and DELETE, group PUT and DELETE, **and** `hasAnyAdmin`/`isLastAdmin`, so the rescue and the guards agree. It fails closed. | ID-B1 (server), ID-B2, the rescue hole, last-admin consistency |
| Server: versioned write in `configStore.updateJson(file, fn, { ifMatch })` | Computes `etag = shortHash(raw bytes)` under the lock and throws `PRECONDITION_FAILED` (412, new registry code) when a sent `ifMatch` differs. GET routes set `ETag` from the same hash. With no header, the write is unconditional (today's behaviour). | CU-B3, OB-B10, multi-admin edits, script plus UI races, on-disk edit races **[DEC 6]** |
| Server: `usedBy(resourceType, id)` | Returns `[{type, id, name}]`. The first providers are groups (`inherits`) and credentials. 409 `RESOURCE_IN_USE` with `details.usedBy`. | ID-B4, IN-B3 (Now); AI-B12, AX-B13, CU-B14 (Next) |
| `ConfirmDialog` additions | `itemName`, `consequences: string[]`, `typedConfirmation?: string`, `danger`. Modelled on the EU AI Act switch-off dialog. | PL-B1, PL-B8, OB-B7, OB-B8, AI-B2, AX-B14 |
| Axios problem+json interceptor | Maps `detail`/`code` to the message, retries once on `Retry-After` for GET only, and never retries writes. | SH-B10, ID-B14 (raw errors), 429 fan-out symptoms |
| Audit plus snapshot on every platform sub-write | `logging.js`, `usage.js` (tracking mode) and others call `saveSnapshot` and `logAudit` like `configs.js:575-588`. | OB-B6 |

---

## 4. Next and Later notes

- **Next:** the full config resource (`PATCH /api/admin/configs/platform/{section}`, keeping POST as is: no shim needed, because POST stays), plus a platform history view over the snapshots `saveSnapshot` already writes. I want a "restore this snapshot" button there before any restore wizard.
- **Next:** restore points. List `contents/.backups/*` (the pre-import copies) and update snapshots in the UI, with restore. Today recovering from a bad import needs a shell.
- **Next:** decision 10 (c), the passphrase-protected full backup. Keep a documented, scriptable "full including keys" mode for my DR runbook. Scope the "configuration only" export so it never contains `.encryption-key`.
- **Next:** readable 429s plus the one `/api/admin/shell` call (PL-B18). Review `authApi` (PL-B23): 30 per 15 min counting successful logins, per IP, is a morning-peak lockout behind NAT.
- **Next:** OIDC wizard (WZ-4) with a "test sign-in in a new window before disabling local" step, which makes the lockout override rare.
- **Later:** `adminRole` (decision 5). Any stored-shape change to `groups.json` needs a migration and a breaking-changes entry, because I generate `groups.json` from AD with a script.
- **Later:** a read-only effective-config viewer before any raw platform.json editor (agrees with PL §10).

---

## 5. Pre-mortem: it shipped and failed

1. **The lockout refusal blocks a legitimate migration to SSO-only, and the admin edits JSON by hand under pressure, making a typo.** Strict parsing then refuses the next save (`configs.js:315-321`). *Mitigation:* the `confirmLockoutRisk` override with a named dialog; a 409 `detail` that says exactly what to do ("sign in through OIDC in another window first, or confirm"); the recovery doc.
2. **The guard counts only `internalGroups` and refuses every save on a mapping-only OIDC install** ("no admin can sign in" while 5 Entra admins can). *Mitigation:* a shared predicate that counts mappings; fixtures for local-only, OIDC-mapping-only, LDAP default groups, proxy headers and NTLM.
3. **The guard runs at startup or config load and an install refuses to boot after an upgrade.** Break-glass is gone. *Mitigation:* guards only on admin API writes; startup only warns and puts the warning on the Overview. A test boots with a no-admin `platform.json`.
4. **The jwkUrl fix lands, but installs already broken by earlier saves stay broken, and nobody notices** until a JWT key rotates. *Mitigation:* a release note telling proxy-JWT admins to check `jwkUrl`; a startup warning when a JWT provider has no `jwkUrl`.
5. **`If-Match` is made mandatory "for safety" in review, and every CI script gets 428.** *Mitigation:* decision 6 says optional; a test that a POST without the header still succeeds; any later move to required gets `Deprecation` and `Sunset` headers plus approval.
6. **The ETag comes from the config cache, so an on-disk edit plus a stale UI save still loses data**, or every save 412s after a cache refresh with a different key order. *Mitigation:* hash the raw file bytes under the `updateJson` lock; a test with an on-disk edit between GET and POST.
7. **The rate-limit migration overwrites a value an admin tuned** (e.g. 50 for a hardened DMZ install). *Mitigation:* the V253 pattern, which changes only exactly `100/60000`, logs the skip, and is covered by a test with a tuned value.
8. **Two Now PRs both add `V254__…`.** Migrations are forward-only, and checksum or ordering trouble follows on installs that pulled a nightly. *Mitigation:* reserve migration numbers in the epic; CI checks for duplicate version prefixes.
9. **The SIEM loses chat-question events after the upgrade**, and the security team calls it a broken audit trail. *Mitigation:* a `breaking-changes.md` entry naming the `CHAT_REQUEST.query` and `FEEDBACK.user` removals and the opt-in key; the audit log (not the app log) is the documented place for accountability.
10. **A restore of a backup from a newer iHub version half-migrates `contents/`**, and the response says "imported, but one or more migrations failed" (`backup.js:866-868`), with no way back in the UI. *Mitigation:* the version check before the swap; the pre-import copy path in the confirmation dialog; restore-points UI next.
11. **The import confirmation stages the ZIP client-side but the server still swaps on POST**, so a script or a double click still restores at once. That's acceptable for scripts. *Mitigation:* disable the button while a confirmation is pending; the server keeps its `.import.lock` (`backup.js:50`) against concurrent imports.
12. **Hiding the agent schedule field strips `schedule` on the next save**, and when the scheduler is fixed, schedules are gone. *Mitigation:* a round-trip test on the agent editor with unknown or hidden fields.
13. **German error texts for the new 409s are missing**, and German admins see English `detail` or raw codes. *Mitigation:* the client maps `code` to i18n keys, en and de added in the same PR, covered by the translation ratchet.
14. **The new guards' status codes are inconsistent** (403 here, 400 there, 409 elsewhere), so scripts can't branch. *Mitigation:* one registry entry per invariant in `shared/apiErrors.js`, all 409, branched on `code`.
15. **The subpath regressions come back**, because only the root deployment is tested. *Mitigation:* the `/ihub/` e2e project in CI for SH-B1, CU-B9 and CU-B10.

---

## 6. Questions I have NOT asked

1. **Do admins on mapping-only OIDC installs exist in the field, and is the admin rescue intended to fire for OIDC/proxy users?** If so, an ordinary employee can become admin after local sign-in is disabled. *Default:* treat it as a security bug; `hasAnyAdmin` counts mappings; the rescue fires only for local sign-in or behind an explicit setting.
2. **`ADMIN_SECRET`: implement it as a documented break-glass, or delete it from the docs?** It matters because operators believe it works. *Default:* delete it from the docs in Now; propose a real break-glass (e.g. an env var that force-enables `localAuth` for one boot, audit-logged) for Next.
3. **Is the `confirmLockoutRisk` override acceptable, or must the refusal be absolute?** An absolute refusal blocks the SSO cut-over. *Default:* override with a named confirmation and an audit entry.
4. **Which callers script `POST /api/admin/configs/platform` with full bodies today**, e.g. IntraFind's own deployment tooling or Helm hooks? Restoring omitted fields changes what "omit `jwkUrl`" means: you can no longer *clear* it by omission. *Default:* clearing needs an explicit `null`; documented.
5. **Should the existing 403 (last admin user) and 400 (last admin group) become 409?** *Default:* yes, with a release note; no shim.
6. **Is the backup version check allowed to refuse old-to-new, or only new-to-old?** *Default:* refuse only when the backup has migrations the server doesn't know (new-to-old); old-to-new is normal and already migrates.
7. **For the per-user admin rate limit, what keys requests from service clients and API keys?** *Default:* `client_id` or the key id; IP for unauthenticated requests.
8. **Does a multi-pod install (shared `contents/` volume) make the file-hash ETag reliable across pods?** The lock in `configStore.updateJson` is per process or per file. *Default:* yes if the lock is a file lock (it uses `fileLock.js` for imports); confirm with the maintainer of #3699 (scaling beyond one pod).
9. **Content logging: is any customer contractually required to keep question logging?** *Default:* off by default with an opt-in key, as in decision 7.
10. **Should the hand-edit orphan-inheritance case (ID-B4) refuse to load the groups file or degrade gracefully?** *Default:* degrade. Drop the bad `inherits` entry in the in-memory resolution, warn on the Overview, and never freeze the cache silently.

---

## 7. Decisions I made on my own

- **Load-gating and server-side secret restore come before everything else.** They turn the P0 and the jwkUrl loss into no-ops even for old clients or a hand-crafted POST.
- **I extended PL-B4's scope to `AdminAuthPage`** on code evidence (`configs.js:256-267, 359`; `JwtProvidersSection.jsx`; no restore path for `jwkUrl`). I did not reproduce it live, because the repo is read-only and no server was started.
- **I flagged the admin-rescue escalation as Suspected**, from code only (`adminRescue.js:55-140, 238-275`; `userManager.js:769`). It needs a live repro by the security expert.
- **Machine callers skip the "own sign-in method" check** but not the "some admin can sign in" check. Otherwise CI-driven auth changes become impossible.
- **All new guards return 409** with dedicated registry codes, not 403 or 400. Conflict with current state is what they are, and `api-guidelines.md` reserves 400 for validation.
- **`If-Match` is optional, hashes the file bytes, and returns 412** (not 409) on mismatch, per RFC 9110. That needs a new registry code (`PRECONDITION_FAILED`). I found no existing one, only `VERSION_CONFLICT` and `REVISION_CONFLICT` at 409.
- **No change to backup contents in Now.** Callout only; the DR runbook depends on the keys being in the ZIP. Decision 10 stays with the user.
- **The rate-limit migration is pulled into Now**, gated by decision 9, using the "only untouched shipped values" pattern from V253.
- **No migration is needed for the privacy switches**: new keys, with absent meaning off. They still go into `server/defaults/config/platform.json` for discoverability.
- **Hand edits on disk are never refused.** The admin API is guarded and the file system is break-glass. This is a principle, not a feature.
- **I counted subpath (CU-B9, CU-B10, SH-B1) as an operator-critical part of the Now scope**, not polish.
- **I didn't re-verify the visual, workflow or translation findings.** They don't affect upgrades or scripting, so I relied on the review.
