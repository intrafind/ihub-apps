# Security expert: admin UI rework, "Now" phase

Read-only review against the current code (HEAD `24ec91d`, 2026-11-16). Every finding below was re-checked in code; line numbers are current. "New" marks a problem that the November review did not report.

---

## 1. Angle summary

- **ID-B1 is a privilege escalation as well as a lockout.** A local admin who unticks `localAuth.enabled` loses the session on the next request: `jwtAuth.js:663-705` rejects local tokens while local sign-in is off. `hasAnyAdmin()` (`adminRescue.js:56-148`) then skips every local admin, because `isUserAuthMethodEnabled` returns false for them. `ensureFirstUserIsAdmin()` (`userManager.js:769, 826`; `localAuth.js:129`) then makes **the next person who signs in through OIDC, proxy or NTLM an administrator**. The fix therefore has to be a server-side invariant. Disabling the Save button is not enough.
- **ID-B2 has the same escalation path.** Demoting or disabling the last usable admin through `PUT /api/admin/auth/users/:id` (`auth.js:507-597`) runs no check. The rescue then promotes whoever signs in next. The DELETE guard that does exist (`auth.js:660`, `isLastAdmin`) reads `users.json` from disk outside the lock (TOCTOU), counts admins without checking that they can still sign in, and **fails open** when it errors (`adminRescue.js:362-367`).
- **One invariant module for every writer.** The lockout and last-admin rules must hold for every path that writes `platform.json`, `users.json` or `groups.json`. That includes `POST /admin/configs/platform`, any future scoped PATCH, platform rollback (`changes.js` `case 'platform'`), group rollback and `/api/setup/configure`. Rollback today rewrites the whole file and bypasses every guard.
- **PL-B4 is wider than reported.** The GET strips `proxyAuth.jwtProviders[].jwkUrl` (`configs.js:258-269`), and the POST replaces `proxyAuth` wholesale (`configs.js:373`). The Authentication page edits `jwkUrl` in `JwtProvidersSection.jsx:119`, but after a load the field is empty. A save from **the page meant to edit it** therefore also deletes it (New; seen in code, not run live). Proxy-JWT then fails closed: `httpFetch(undefined)` throws, which is a lockout and not a bypass. `jwkUrl` is a public key-set URL, not a secret, so stripping it gains nothing.
- **New: a redaction bypass already exists.** `saveSnapshot` stores the merged platform config with the plaintext `jwtSecret` (`configs.js:578-584`). `GET /api/admin/changes/platform/platform/:file` (`changes.js:48-66`) returns that snapshot unredacted. The planned "audit diffs / platform history view" (Next) would put this hole on screen.
- **If-Match must not reuse `server/utils/etag.js`.** Those ETags are 8-hex MD5 cache fingerprints ("not a security hash") of *resolved* cache data: secrets decrypted, `${ENV}` expanded, and possibly behind another worker. A revision must come from the **stored** body and be compared **inside** the `configStore.updateJson` mutator, under the lock.
- **ID-B6:** new machine clients get `['*']` from both the client (`AdminOAuthClientEditPage.jsx:37-40`) and the server (`oauthClients.js:263-268`). For `client_credentials`, those lists *are* the whole grant (`authorization.js:756-773`). Decision 4 gates the server part. Until 4b/4c, scripted callers keep the over-grant.
- **Privacy (OB-B4, OB-B28):** the full last user message, which can include image parts, is logged at `info` (`server/utils.js:322-328, 383-394`). The rater's username and chat ID are logged on every rating whatever the identification mode (`utils.js:360-371`), and `feedback.jsonl` stores the raw `chatId` (`feedbackStorage.js:52-63`). New: `configOverrides.js:96-99` logs **every `IHUB_PLATFORM__*` value in plaintext at `info`**, so a secret supplied that way (JWT secret, OTLP auth header) ends up in the log.
- **TLS and SSRF (PL-B12):** `isSsrfTrustedHost` (`httpConfig.js:158-164`) trusts every host on the TLS whitelist. `SourceManager.js:56` returns `addresses: null` for trusted hosts, so the connection is not pinned to the checked address. A trusted wildcard host can therefore reach any IP, including cloud metadata. Chat users reach this through the page reader. **OB-B13:** the OTLP exporters (`telemetry/exporters.js:31-36, 62-67`) take no agent, which breaks the CLAUDE.md outbound rule. Their `headers` (often API tokens) are also returned in clear by the platform GET and stored unencrypted (New).
- **Secrets shown once (ID-B15):** the secret-bearing responses (create `oauthClients.js:297`, rotate `:558`) send no `Cache-Control: no-store`. The rotated secret appears in `window.alert` (`AdminOAuthClientsPage.jsx:356`), where it cannot be copied safely and can end up in screenshots and crash reports.

---

## 2. Now-phase plan from my angle

Seven PRs. Each lists the threat, where the code is now, the minimal correct fix, what must not be done, and the tests. **[Approval]** marks a change to shipped behaviour, an admin API or a config shape. **[Dn]** marks a change gated by README decision n.

### PR S1: Lockout refusal, last-admin and self guard, group delete (ID-B1, ID-B2, ID-B3, ID-B4)

#### S1.1 Server-side lockout refusal on platform writes (ID-B1, platform part of ID-B2)

**Threat.** A save made after a failed load (the client sends built-in defaults: `AdminAuthPage.jsx:40-80`, catch at :115-121, Save `disabled={saving}` at :265), or a deliberate untick, removes the caller's sign-in route. The result is a lockout plus the rescue escalation described in §1.

**Where.** `configs.js:277-466`. The `updatePlatform` mutator merges `anonymousAuth`, `proxyAuth`, `localAuth`, `oidcAuth`, `ldapAuth`, `ntlmAuth` and `auth` wholesale (:371-377). No check runs.

**Fix.** Inside the mutator, after the merge and before `return mergedConfig`, call `assertCallerKeepsSignInRoute(req.user, effective(mergedConfig), usersFile, resolvedGroups)`. `effective()` applies the `IHUB_PLATFORM__*` overrides (`applyIhubEnvOverrides`), because the runtime gate reads the cache, which has those overrides applied. If the check fails, throw `ServiceError('LOCKOUT_REFUSED', …)`: a new registry code, 409, with `details: { authMode, provider, reason }`.

The caller's sign-in route is (authMode, authProvider) from the token. The token carries `authProvider` (`tokenService.js:113`), but `jwtAuth.js` does not copy it onto `req.user`, so add that (one line per branch). Rules:

| Caller's `authMode` | Route survives only if (in the effective new config) |
|---|---|
| `local` | `localAuth.enabled === true`, and the caller's record is active and has a `passwordHash`. |
| `oidc` | `oidcAuth.enabled` and a provider with `name === authProvider` that is not disabled. If the caller's admin rights come from `groups.mappings` (not `internalGroups`), the mapping onto an `adminAccess` group must still exist (checked in S1.3). |
| `ldap` | `ldapAuth.enabled` and the provider `authProvider` is present. |
| `ntlm` | `ntlmAuth.enabled`. NTLM changes apply only after a restart, so the lockout is delayed, not avoided. Refuse the same way. |
| `proxy` | `proxyAuth.enabled`. A change to `userHeader` or `trustedProxies`, or removing the caller's `jwtProviders[]` entry, is also refused when the caller came in through that header or provider. |
| `teams` | Teams is not an admin route in practice. Treat it like OIDC with `teamsAuth.enabled`. |
| anonymous, any `oauth_*`, agents | Never an admin (`authorization.js:588-611`), so the route is not evaluated. Enabling `anonymousAuth` never satisfies the invariant. |

Also require that *some* admin route exists (`hasAnyAdmin` on the next state, see S1.3). Without it, the rescue promotes a stranger.

**Must not.**
- Rely only on disabling Save or showing a client confirm. Gating the page on a failed load (`AdminLoadError`, Retry only) is still required, as defence in depth.
- Add a `force` or `confirmLockout` body flag. That flag is the hole.
- Evaluate against the cache, `configCache.getPlatform()`. It can lag behind another worker.
- Fail open on an exception. If the invariant cannot be evaluated, refuse the save.

**Break-glass (documented, not an API).** Use file access, or set `IHUB_PLATFORM__LOCAL_AUTH__ENABLED=true` and restart, then sign in as a local admin. The legitimate migration from local to OIDC stays possible and the refusal message explains it: enable OIDC, sign in through OIDC as an admin (mapping or `internalGroups`), then disable local.

**Also enforce in:** `changes.js` platform rollback (today `updatePlatform(() => structuredClone(beforeState))`), `setup.js` `/configure` (:132), and any future scoped PATCH (S2).

**Tests** (`server/tests/admin-lockout-invariant.test.js`):
1. A local admin posting `localAuth.enabled:false` gets 409 `LOCKOUT_REFUSED`, and the file is unchanged.
2. The same post by an OIDC admin while a local admin also exists gets 200.
3. A post containing the client's built-in defaults (proxy mode, local off) from a local admin gets 409.
4. Removing the caller's OIDC provider by name gets 409.
5. A rollback to a snapshot with local disabled, by a local admin, gets 409.
6. With the env override forcing local on, the save is allowed.
7. An evaluator that throws refuses the save.

#### S1.2 User PUT and DELETE: last-admin and self guard (ID-B2)

**Where.** `auth.js:507-597` (PUT, no check) and `:641-710` (DELETE, `isLastAdmin` from disk).

**Fix.** Write a pure helper, `countUsableAdmins(usersData, resolvedGroups, effectivePlatform)`, with the same rules as `hasAnyAdmin`: active, an enabled method, `adminAccess` through resolved groups, plus the LDAP/NTLM `defaultGroups`. Run it **on the `usersData` the mutator receives** after applying the change.
- If the result is 0, refuse with 409 `LAST_ADMIN`.
- Self guard: refuse `active:false` and refuse DELETE when `userId === req.user.id`, always.
- Allow self-demotion only when another usable admin remains, and the client shows a named confirm. Refuse it otherwise.
- Replace `isLastAdmin` in DELETE with the in-lock helper.
- Fail closed.

**Must not.** Keep `isLastAdmin`'s fail-open `catch → false`. Count admins who exist but cannot sign in (method disabled).

**Tests.**
1. Demoting the only admin gets 409.
2. Disabling yourself gets 409.
3. Demoting one of two admins gets 200.
4. An admin whose only method is disabled does not count.
5. Two concurrent DELETEs of the last two admins: exactly one succeeds. Run the mutators sequentially with a fake store.
6. After a refused demotion, `ensureFirstUserIsAdmin` for a new OIDC user does not grant admin.

#### S1.3 Group writes that remove admin reachability

`groups.js` PUT already guards the last `adminAccess` group (:760-771, by direct flag). Two gaps remain:
- Removing the `mappings` that bring IdP admins in.
- Changing `inherits` so that a group which gets `adminAccess` only through inheritance loses it. `countAdminAccessGroups` (:90-94) reads the direct flag only.

Minimal Now step: after the mutation, resolve the graph and require at least one usable admin (S1.2 helper) **when the caller is the only route**. If that turns out larger than S, restrict Now to the self case: the caller loses admin through this group edit, so refuse it.

#### S1.4 `active` not re-enabled (ID-B3)

**Where.** Client: `AdminUserEditPage.jsx:282` sends `active: data.enabled !== false`. The stored record has `active`, never `enabled`.
**Fix.** Seed the form from `active` and send `active` only when the admin changed it. Server, new: `auth.js:518, 549` stores any value. `active: "false"` or `0` is stored and later read as **active** (the checks are `=== false`: `localAuth.js:102`, `userManager.js:625`). Require `typeof active === 'boolean'` and answer 400 otherwise. Apply the same check to POST (:352).
**Tests.** PUT `{ email }` on a disabled user leaves `active:false`. PUT `{ active:"false" }` gets 400. A client unit test checks that a round-trip with an unchanged form sends no `active`.

#### S1.5 Deleting an inherited-from group (ID-B4)

**Where.** `groups.js:878-937` deletes without a dependency check. `configCache` then fails `resolveGroupInheritance` (`authorization.js:58-60`) and keeps serving the old resolved groups. **Revocations silently stop applying**, which makes this a security bug and not only an integrity bug.
**Fix.**
- In the DELETE mutator: if any group's `inherits` contains `groupId`, answer 409 `GROUP_IN_USE` with `details.dependants`.
- Defence in depth: every `groups.json` writer (POST, PUT, DELETE, `contentAccess.js`, group rollback in `changes.js`) runs a resolvability check on the next body before returning it, and refuses with 400 when the graph does not resolve.
- When a refresh fails resolution, keep the last good cache, but log at `error` and surface it on the Overview/health so the failure does not go unnoticed.

**Must not.** Silently drop the missing parent when resolving (`inherits` filtered at load). That hides the error, and a `rollback` could re-create the reference.
**Tests.** DELETE of a parent gets 409 and the file is unchanged. A rollback that re-introduces `inherits` to a deleted group gets 400. The cache still reflects a later valid edit.

### PR S2: No redacted or whole-file overwrites (PL-B4, CU-B3, OB-B10)

#### S2.1 The `jwkUrl` round-trip

- **Minimal fix.** Stop stripping `jwkUrl` in the GET (`configs.js:258-269`). It is a public JWKS URL. Pass it through `redactUrlSecrets` (`httpConfig.js:771`) so URL userinfo and token query parameters are masked.
- In the POST, restore masked parts by matching provider `name` against the stored provider. This one change fixes the Advanced and Provenance cards (`AdminAdvancedPage.jsx:38-42`, `ProvenanceSettingsCard.jsx:191-198`) and the auth-page loss.
- The workarounds that `delete platform.proxyAuth` (`AiNoticeSettingsCard.jsx:57`, `CookieSettingsConfig.jsx:56`, `ToolApprovalConfig.jsx:68`, `AdminPromptsPage.jsx:602`, `AdminLocalizationPage.jsx:89`, `AiAcknowledgementSettingsCard.jsx:64`) become unnecessary but harmless. Remove them only together with S2.3.

#### S2.2 One marker, one restore, one refusal (platform layer)

- The marker is defined three times as `'***REDACTED***'` (`configs.js:56`, `credentials.js:29`, `proxy.js:42`), and `secretRedaction.js:24` uses `'[redacted]'`. Create one module, `server/utils/redactedSecrets.js`, with:
  - `SECRET_MARKER`
  - `restoreRedacted(next, stored, secretPaths)`: path-based, supports `[]` arrays keyed by `name`/`id`
  - `assertNoMarkers(obj)`: a deep scan that throws 400 if any string equals a known marker or contains `[REDACTED]`/`[redacted]`
- Call `assertNoMarkers` in `updatePlatform` (`platformConfigStore.js:47`), and likewise in the credentials, proxy, models and providers writers. A marker can then never be persisted, whatever a page sends.
- **New hole to close.** For `localAuth.jwtSecret` / `auth.jwtSecret`, a client that *omits* the field silently deletes the secret, because the whole block is replaced (`configs.js:374, 439-445`). Fix: `restoreRedacted` treats a missing secret field as "keep" and an explicit `null` as "delete".

#### S2.3 Scoped PATCH (Decision 6) and If-Match (CU-B3, OB-B10)

**[D6] [Approval]: new endpoint `PATCH /api/admin/configs/platform`.** Security requirements, each one a test:
1. Same `adminAuth`. Same `updatePlatform` mutator. Same validators as the POST (`aiDisclosure`, `cookieSettings`, `toolApproval`, `sharedSecretHeaderProblem`). Same restore, encrypt and `assertNoMarkers`. Same lockout invariant (S1.1). Same snapshot and audit. **Factor the POST body into one `applyPlatformChange(req, patch)` function that both handlers call.** Two copies would drift, and the PATCH would become the bypass.
2. JSON Merge Patch (RFC 7396) over an **allowlist of top-level sections**. Reject unknown keys with 400. Sections that have their own dedicated, validated routes (`ssl`, `ssrf`, `cors`, `rateLimit`, `proxy`, `logging`) are **not** patchable here. Today the POST spreads `existingConfig`, so these keys cannot be changed through it. A naive PATCH would open them.
3. `null` on a secret path deletes it only when it is the explicit leaf. `null` on a parent (`localAuth: null`) gets 400.
4. Optional `If-Match` (see S3).

OB-B10: `PUT /api/admin/logging/config` should accept the privacy subset alone, or the client sends only the privacy fields.

#### S2.4 Snapshot redaction (New)

- `GET /api/admin/changes/:resource/:id/:filename` returns secrets the platform GET redacts. Run the same sanitiser (`sanitizeSecret` / `redactRedacted`) over `before` and `after` in the response.
- Rollback must then restore secrets from the current stored file (`restoreRedacted`), never write a marker. The snapshot files themselves should stop holding plaintext: store them with secrets encrypted (`encryptPlatformSecrets`, extended to cover the JWT secrets).
- Tests: the snapshot GET contains no `jwtSecret` value. A rollback after a secret rotation keeps the current secret, which is a product decision (ask). The default is to keep the current secret.

### PR S3: If-Match and ETag for config writes (CU-B3, PL-B4 lost updates) [D6]

**Threat.** Lost update: two tabs or two admins, last write wins. CU-B3 deletes page entries in `ui.json` (`ui.js:238-262` writes blindly).

**Fix.**
- Add `server/utils/configRevision.js` with:
  - `revisionOf(storedBody)`: SHA-256 over canonical JSON of the **stored** body (encrypted form), base64url, 22+ characters, as a strong ETag.
  - `assertIfMatch(req, storedBody)`, called **inside** the `updateJson` / `updatePlatform` mutator.
- GET returns `ETag` plus `Cache-Control: no-store` (these responses describe secrets).
- On a mismatch, answer `412` with a new registry code `PRECONDITION_FAILED`. Do not reuse the storage code `ETAG_MISMATCH`, which is 409.
- `If-Match` is optional in Now. Making it required (428) is [D6] [Approval].

**Must not.**
- Reuse `configCache` ETags or `shortHash`: MD5 truncated to 32 bits, computed on decrypted, env-expanded data, which can lag across workers.
- Compare outside the lock.
- Compute the revision from the redacted GET body. Two different stored secrets would then share a revision.

**Tests.** A stale If-Match gets 412 and the file is unchanged. No If-Match keeps today's behaviour. The revision changes when only a secret changed. A two-worker simulation: the second write gets 412.

### PR S4: Machine OAuth clients and secret reveal (ID-B6, ID-B15)

**ID-B6, Now [D4a].**
- Client: new clients start with `[]` for apps, models and prompts, and at least one app is required. An explicit "All" writes `['*']`. Always send all three arrays.
- Fix the hint text (`AdminOAuthClientEditPage.jsx:439-444`): for `client_credentials` the lists *are* the grant.
- When `grantTypes` changes on edit, warn: `[]` means "nothing" for machine clients and "no extra restriction" for delegated ones (`authorization.js:775-781`).
- **Server unchanged in Now.** `oauthClients.js:263-268` still turns an empty or missing list into `['*']` for scripted POSTs. Call that out in the release note and the docs. 4b or 4c closes it.
- Must not: ship a client that sends `[]` for "None" before the server honours `[]`. The server would store `['*']`, so the UI's "None" would silently mean "All". **Until 4b/4c, the client must block saving a machine client with "None" for any list.** It must not send `[]`.

**ID-B15.** `SecretRevealDialog`:
- A read-only field, a Copy button (`navigator.clipboard.writeText`), and "I have stored it" to close.
- The secret lives only in component state. It is cleared on close. It is never put in the URL, `localStorage`, a query cache or `console`.
- Replace `alert()` at `AdminOAuthClientsPage.jsx:356` and `AdminOAuthClientEditPage.jsx:223`, the latter for URI validation as an inline error.

Server: add `Cache-Control: no-store` to the create (`:297`) and rotate (`:558`) responses. **Do not** rename `/rotate-secret` to `/_rotate-secret` in Now [Approval, API]. Test: both responses carry `no-store`.

### PR S5: Backup restore and backup sensitivity (PL-B1, PL-B2) [D10]

**PL-B1 Now.**
- A named `ConfirmDialog` before upload ("type REPLACE"), listing what will be replaced: users, keys, chats. Reset the `<input type=file>` on cancel.
- A client-side confirmation is acceptable **here only**: the threat is an accident, the caller is already a full admin, and the server already keeps a pre-import copy in `.backups` (`backup.js:46`).
- **Must not:** add a preview as a GET that mutates, or a staged upload that is reachable without `adminAuth`. A staged-import design (Next) stores the ZIP outside served paths, binds it to the uploading admin, expires it, and re-runs zip-slip validation on apply.
- Next: the preview states "after restore, your account X: exists / admin / sign-in route enabled" (reuse S1). Restore is break-glass, so warn, never refuse.

**PL-B2 Now.**
- A callout on the backup page: the file contains `.encryption-key`, `.jwt-private-key.pem`, `.jwt-secret` and password hashes. Store it like a key.
- Add `Cache-Control: no-store` on `GET /backup/export` (the export is already audited at `backup.js:335`).
- Move the per-file `logger.info('Adding to archive')` (`backup.js:304`) to `debug`: 127 lines per export, with user IDs in the paths.
- Format change [D10] [Approval].

### PR S6: Privacy in logs (OB-B4, OB-B28) [D7]

- **OB-B4.** Delete `query` from the `CHAT_REQUEST` line (`utils.js:393`). Keep `messageCount` and optionally `queryChars`.
  - `logEntry.query` can be a multimodal content array with base64 images, so this also fixes log bloat.
  - Must not: only move it to `debug` (D7 explains why).
  - Existing log files are not scrubbed. The release note tells admins to purge or rotate logs and SIEM indexes.
  - Test: capture logger output for a chat request; the line has no message text.
- **OB-B28.**
  - The `FEEDBACK` line (`utils.js:360-371`) logs `user` and `sessionId` (the chat ID) in every mode. Derive both from the identification mode: anonymous → omit both; pseudonymous → `resolveUserId(id, 'pseudonymous')` (`UserFingerprint.js:95`); identified → as today.
  - `feedback.jsonl`: in anonymous mode, store an HMAC of `chatId` keyed with a server secret, not plain SHA (chat IDs are guessable from context), or omit it.
  - Relabel "Anonymous (hashed)" (`shared/i18n/en.json:4783`, and `de`).
  - Tests per mode.
- **New, same PR.** `configOverrides.js:96-99`: log the override **path** only, and mask the value when `isSecretName(lastSegment)` (`secretRedaction.js`). Test: `IHUB_PLATFORM__LOCAL_AUTH__JWT_SECRET=x` does not appear in the log output.
- The DPO doc fix (OB-B5) belongs to the docs PR. Security asks that it list every place user content persists: logs (until this PR), `feedback.jsonl` snippets of 300 characters, chats, uploads, and provenance.

### PR S7: TLS allowlist, SSRF and OTLP (PL-B12 [D14], OB-B13)

**PL-B12 Now (D14a, no behaviour change).**
- `SSLConfig.jsx:212-213`: show the whitelist even when "ignore invalid certificates" is off, labelled "These hosts are also trusted by the SSRF guard (can reach private addresses)".
- Show the same list on the SSRF page.
- Add a startup `warn` naming the hosts that are SSRF-trusted *only* through `ssl.domainWhitelist`.

**Must not (in Now).** Decouple silently, which would break installs. **Next (D14b) [Approval]:** migration `V{NNN}__split_ssrf_trust_from_tls_whitelist.js` copies the entries into `ssrf.allowedHosts`, and `isSsrfTrustedHost` reads only `ssrf.allowedHosts`. The copy preserves exactly today's trust. The security gain comes from admins reviewing a list that is now visible and separate, so the release note must say that.

**Extra hardening to propose [Approval].** A trusted host is still refused when it resolves to link-local or metadata addresses (`169.254.0.0/16`, `fd00:ec2::254`). Pin the resolved address for trusted hosts too: today `SourceManager.js:56` returns `addresses: null`.

**OB-B13.**
- Pass the existing agent to both OTLP exporters: `httpAgentOptions: () => createAgent(endpointUrl)` (`httpConfig.js:650`). This applies the TLS whitelist bypass and the proxy.
- Verify the option name and factory form against the installed `@opentelemetry/otlp-exporter-base` 0.301 typings. The packages are not installed in this checkout, so this is unverified.
- Never set `rejectUnauthorized:false` or `NODE_TLS_REJECT_UNAUTHORIZED` yourself.
- Tests (CLAUDE.md rule): a whitelisted host gets `rejectUnauthorized:false`; a non-whitelisted host gets default TLS. Extend `server/tests/telemetry-exporters.test.js`.
- New (Next): treat `telemetry.exporters.otlp.headers` values as secrets: redact on GET, restore and encrypt on save.

---

## 3. Shared components, hooks and server layers

| Layer | API sketch | Closes |
|---|---|---|
| `server/utils/authInvariants.js` | `signInRouteOf(user)` → `{mode, provider}`; `routeSurvives(route, effectivePlatform, userRecord)`; `countUsableAdmins(usersData, resolvedGroups, effectivePlatform)`; `assertCallerKeepsSignInRoute(req, nextPlatform, ctx)`; `assertAdminRemains(ctx)`. Pure, fails closed, takes the **in-lock** bodies. `hasAnyAdmin`/`isLastAdmin` become thin wrappers. | ID-B1, ID-B2, rescue escalation, rollback/setup bypass |
| `server/utils/groupGraph.js` (or extend `validateGroupInheritance`) | `dependantsOf(groups, id)`, `assertResolvable(groups)` | ID-B4, rollback re-reference |
| `server/utils/redactedSecrets.js` | `SECRET_MARKER`, `restoreRedacted(next, stored, paths)`, `assertNoMarkers(obj)`, `redactForRead(obj, paths)` (used by the GET, snapshots, and later the audit diff) | PL-B4, snapshot leak, omitted-field deletion |
| `server/utils/configRevision.js` | `revisionOf(stored)`, `setRevisionHeaders(res, rev)`, `assertIfMatch(req, stored)` | CU-B3, lost updates (D6) |
| `applyPlatformChange(req, patch, {mode:'replace'\|'merge'})` | the one platform writer that both POST and PATCH call | Prevents a PATCH bypass |
| `shared/apiErrors.js` additions | `LOCKOUT_REFUSED:409`, `LAST_ADMIN:409`, `GROUP_IN_USE:409`, `PRECONDITION_FAILED:412` | Lets the client branch on `code` |
| `server/utils/privacyLog.js` | `identityForLog(user, mode)`, `chatRefForLog(chatId, mode)` | OB-B4, OB-B28 |
| Client `SecretRevealDialog` | `<SecretRevealDialog secret label onClose />`, no persistence, Copy, explicit acknowledge | ID-B15 (reused for API keys, webhook secrets) |
| Client load gate | `useAdminResourceEditor` returns `loadFailed`, and the shell renders `AdminLoadError` instead of the form | ID-B1 defence in depth, and the other load-gating IDs |
| Client error mapping | `LOCKOUT_REFUSED` / `LAST_ADMIN` → a named, explanatory dialog (what to do first), never a generic toast | ID-B1, ID-B2 UX |

---

## 4. Next/Later notes

1. **Decision 4b or 4c:** the server stores `[]` as "none" for machine clients, with `Deprecation`/`Sunset` if 4b.
2. **Decision 14b:** the SSRF/TLS split migration, plus metadata-IP refusal and address pinning for trusted hosts.
3. **Decision 10:** backup "configuration only" vs "full" with a passphrase-wrapped key. A staged import with a lockout preview.
4. **Group changes take effect only at token expiry (verify; possibly P1).** `jwtAuth.js` builds `groups` from the token (`decoded.groups`, e.g. :681, :729). Demoting an admin probably takes effect only when the token expires (default 480 min). Disabling is immediate (`userRecordState`). If confirmed, re-resolve groups from the record for persisted users, or bump a per-user token generation on demotion.
5. OTLP header secrets: redact, restore and encrypt.
6. Make `If-Match` required (428) after one release with it optional [D6].
7. Config history view: only after the snapshot redaction in S2.4.
8. One sweep for `no-store` across all admin GETs that carry secrets, done through middleware on `/api/admin/*`.

---

## 5. Pre-mortem

1. **The guard locks out a legitimate migration from local to OIDC.** *Mitigation:* the refusal `detail` names the steps (sign in via the new method first). Docs recipe. A test covers the full migration.
2. **The guard misreads the caller's route because `authProvider` is missing from old tokens.** *Mitigation:* if the provider is unknown, require the whole method to stay enabled and at least one provider to remain. Never treat "unknown" as "survives".
3. **The env override hides the real state.** The stored file says local is off, the env says on. The guard passes, then ops remove the env var and are locked out. *Mitigation:* the Authentication page shows "overridden by environment" per field. The startup log lists overrides by path (S6 masks the values).
4. **Rollback, setup or a new PATCH bypasses the invariants.** *Mitigation:* the invariants live in `applyPlatformChange` and in the group and user mutators. A test enumerates every route that writes `platform.json` (the 24 callers of `updatePlatform` in `server/routes/`) and asserts that the auth-block writers go through the guard. `scripts/check-route-changes.js` flags new writers.
5. **The PATCH reopens `ssl`, `ssrf` or `cors` without their validators.** *Mitigation:* an allowlist of sections, unknown keys get 400, and a test for each excluded section.
6. **The marker refusal breaks a page that legitimately round-trips a marker in a field we did not list.** *Mitigation:* ship `assertNoMarkers` with a precise error naming the path. Run the e2e suite over every admin save. Release note.
7. **ID-B6 client change ships before the server honours `[]`, so "None" stores `['*']`.** *Mitigation:* the client blocks "None" until 4b/4c (S4). A contract test posts `[]` and asserts what is stored.
8. **Removing `query` from the logs breaks SIEM dashboards** that count questions or alert on keywords. *Mitigation:* a release note with a migration hint (use `messageCount` and usage statistics). D7 accepted this.
9. **The group-delete 409 breaks a scripted cleanup** that deletes parents before children. *Mitigation:* `details.dependants` lists the order. Docs.
10. **ETag false positives:** encrypting a plaintext secret lazily on save changes the stored body, and the next If-Match fails. *Mitigation:* the revision is computed after the write, and the save response returns the new `ETag`. The client stores it from the response, not from a re-GET.
11. **Fail-closed evaluation causes outages:** `users.json` is briefly unreadable, so every platform save is refused. *Mitigation:* the refusal carries a distinct code (`SERVICE_UNAVAILABLE` with a retry hint), and it applies only to saves that touch auth blocks.
12. **i18n:** new error codes have no `de` text and the dialog shows an English `detail`. *Mitigation:* client strings keyed by `code`, en and de, and the translation-key ratchet.

---

## 6. Questions I have NOT asked

1. **Should self-demotion be allowed when another admin exists?** It matters for the size of the self-guard surface. *Default:* allowed with a named confirm. Self-disable and self-delete are always refused.
2. **Is `auth.mode` still an effective gate, or only a label beside the per-method `enabled` flags?** The guard must evaluate the real gate. *Default:* evaluate the `*.enabled` flags, plus `auth.mode` wherever `jwtAuth`/`proxyAuth` read it. Verify before coding.
3. **Do IdP-mapped admins (OIDC `mappings`) need to count for "an admin remains"?** `hasAnyAdmin` deliberately ignores mappings (`adminRescue.js:107-110`). *Default:* they count for the caller's own route, but not for the global "admin remains" check, which matches the rescue semantics.
4. **Should a platform rollback restore the old secrets or keep the current ones?** *Default:* keep the current ones. A rollback must never re-introduce a rotated, possibly leaked secret.
5. **Is the per-file backup log line relied on by support?** *Default:* move it to `debug`.
6. **Is `jwkUrl` ever an internal URL with credentials?** *Default:* show it with `redactUrlSecrets` applied, and restore on save.
7. **Can the feedback HMAC key reuse the JWT secret?** *Default:* no. Derive a dedicated key with HKDF from the encryption key.
8. **Is the OTLP exporter rebuilt on a runtime reload?** If not, an agent fix needs a restart. *Default:* document "restart required" for exporter TLS changes.
9. **Are there external tools that POST `/admin/configs/platform` with partial bodies** that the marker refusal or the PATCH allowlist would affect? *Default:* assume yes, and keep the POST semantics unchanged except for the refusals.

---

## 7. Decisions I made on my own

- **New error codes over generic ones** (`LOCKOUT_REFUSED`, `LAST_ADMIN`, `GROUP_IN_USE` as 409; `PRECONDITION_FAILED` as 412). They are additive per `docs/api-guidelines.md`, and the client branches on `code`.
- **No override flag on the lockout refusal.** Break-glass stays out of band (file or env plus restart). An in-band flag would be exploitable by a CSRF-ish or scripted mistake, which is the very thing being prevented.
- **Fail closed** in the new invariants, unlike the existing `isLastAdmin`.
- **Treat the rescue escalation as part of ID-B1 and ID-B2.** That raises ID-B2 from "UX P1" to a security P1.
- **Accept a client-only confirmation for PL-B1** (accidental threat, pre-import copy kept), but not for ID-B1 or ID-B2.
- **Un-strip `jwkUrl` rather than build a per-field merge.** It is not a secret, and this is the smallest change that fixes the auth page and both cards.
- **Revision = SHA-256 of the stored body,** compared under the lock. Not the cache ETag.
- **Keep `If-Match` optional in Now** (D6 recommendation). Requiring it needs approval.
- **ID-B6 server unchanged in Now** (D4a), with the "None"-blocking safeguard on the client.
- **Add three issues the review did not report to the Now PRs:** snapshot redaction (S2), the env-override log leak (S6), and `no-store` on secret responses (S4, S5). Each is small and on the same code path. OTLP header secrets and token-frozen groups go to Next.
- I did not run anything live. The `jwkUrl` loss on the auth page and the token-frozen groups come from reading the code.
