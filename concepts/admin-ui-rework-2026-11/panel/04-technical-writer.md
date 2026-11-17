# Technical writer — Now-phase docs, in-product copy, release notes, i18n

Panel member: senior technical writer. Read-only review of `/workspace/ihub-apps` at `24ec91d` (2026-11-16).
Every finding below was re-checked against the current tree; line numbers are current, not the review's.

## 1. Angle summary

- **One harmful doc is a compliance problem, not a docs nit.** `docs/pii-data-handling.md:35` tells DPOs uploads are "Not persisted / In-memory only". In fact `chatFilePolicy.js:33,40` store the original **and** the text by default (`original_and_text`, originals for 14 days). Two more wrong statements sit in the same file: `:99-103` says the log holds "the first 1000 characters of the response", which is false (only the question is logged, `server/utils.js:383-393`), and the logs row `:31` does not say that `info` logs every question with the user's name (OB-B4). Fix these first and in their own PR. They must not wait for the bundle.
- **Most of the "Fix first" list has moved since the review.** The stale OAuth enable steps (ID §9) are already fixed: `oauth-integration-guide.md:37-63` and `oauth-authorization-code.md:55-58` now teach Admin → OAuth. `admin-ui.md:513` is now `:528-532`, and "You do not need to edit JSON" is `:13`, not `:5`. Still wrong today: AI-B7 (`prompts.md:47,149`), AI-B15 (`apps.md:1517-1524`), OB-B5, OB-B28 (`feedback-feature.md:257,360-361`), IN-B13/IN-B14 (`browser-extension.md:33,107-119,153-158,240-244`), IN-B23 (3 diagnostics strings + `browser-extension.md:109,419`), the `AUTHENTICATION_QUICK_START.md:157-161` group `admin`, and AX-B1 (`agents.md:11,44-45`). New in this pass: `troubleshooting.md:380,386,397,408` repeats `admin` / `groups`, and the shipped id and field are `admins` / `internalGroups`.
- **Wrong in-product pointers are copy bugs with en and de twins.** Fix both keys in the same commit. SH-B14 `en.json:4625` / `de.json:5106`; ID-B6 `en.json:1602` / `de.json:2083`; CU-B12's placeholder `AdminPageEditPage.jsx:202` has no key at all; AI-B7's label `PromptFormEditor.jsx:330`; IN-B23 strings (server, English only).
- **`admin-ui.md` contradicts the UI in 12 places I re-verified.** The two that cause harm are `:13` ("everything can be done in the UI") and `:528-532` (an unsaved guard "on every edit page"; 12 of 76 admin pages call the hook, plus the 5 `AdminEditPageShell` editors). The Now fix is to make each statement true or qualify it. The full map rewrite is Next.
- **SH-B1 is still live** (`staticRoutes.js:110-111`). It is the prerequisite for every help link, and it needs **no** release entry, because `/admin/docs` is unreleased (`features.md:788`).
- **Microcopy: the helper exists, the 429 path doesn't.** `client/src/utils/apiErrorMessage.js` already maps `code` to `apiErrors.<CODE>` and has full en/de coverage (294 of 294 specific codes). `RATE_LIMITED` is in `GENERIC_ERROR_CODES` (`shared/apiErrors.js:32`), so a 429 shows the English `detail` and no wait time. Only 4 files under `features/admin` use the helper. 92 call sites still use `err.message` / `error.message ||`.
- **German: the gap is 1,270 keys, not ~1,000.** I ran the test's own regex over `features/admin` plus `admin.*` keys elsewhere: 1,270 distinct keys missing from both `en.json` and `de.json`, across 103 files. `AppCreationWizard.jsx` (97) lies *outside* `features/admin` and escapes via the `admin.` filter. Also: 19 German strings still use *du* (e.g. `de.json:369-370`, `pages.appChat.*`), and `AgentRunsPage.jsx` has no `useTranslation` at all. The ratchet must cover all three.
- **Release notes: about 14 entries across the Now PRs; I drafted the ones on my angle.** Two need a **breaking-changes** entry with "Before upgrading": OB-B4/OB-B28 (log fields that SIEMs parse disappear) and the 409 on deleting an inherited-from group if scripted callers exist. Docs-only PRs get none, with one exception I argue for (§2 D6).

## 2. Now-phase plan from my angle

PR themes. "Done" = what I check before approving.

### D1 — Harmful docs (roadmap row "Harmful docs…", plus README "Fix first, by harm"). Effort S. No decision gates except where noted.

**D1.1 OB-B5: `docs/pii-data-handling.md:35`.** Replace the row with:

```markdown
| Files uploaded to a chat or scheduled task | **Yes** (default `uploads.storageMode: "original_and_text"`) | `chat-files` storage: the extracted text stays with its chat; the original is kept **14 d** (`uploads.originalRetentionDays`; `0` = as long as the chat). Quotas: 1 GB per user, 50 GB per server | **Admin → Chat History → Uploaded files**: `uploads.enabled: false`; `uploads.storageMode: "server_text_only"` (original discarded after text extraction) or `"client_text_only"` (the original never leaves the browser), also per app (`app.uploads.storageMode`). See [Chat and Task Files](chat-files.md) |
```

Then add one sentence to the "Bottom line" note at `:39-45`, after "…the chats users keep.": "Files users upload to a chat are stored by default too: their text for as long as the chat, the originals for 14 days."

**D1.2 OB-B4, `pii-data-handling.md:99-103` (§2, item 2).** Today's text is wrong twice: it says "Verbose logging", but `info` is the default, and it says the response is logged, which it isn't. Text until the OB-B4 code fix ships:

> 2. **Application log.** At the default level `info`, every chat request, including scheduled-task runs, writes a `CHAT_REQUEST` line with the user's name and the full question (`query`). Every rating writes a `FEEDBACK` line with the user's name and the chat id. The answer text is not logged. Lines go to stdout and, with `logging.file.enabled`, to `logs/app.log`. Whatever collects stdout (container runtime, log shipper, SIEM) keeps them. `logging.level: "warn"` stops these lines.

After the fix (decision 7, recommended option): "Chat questions are not logged. A `CHAT_REQUEST` line names the app, model and user." If the content switch ships, add: "…unless **Log chat questions** (Admin → Logging → PII & Privacy, off by default) is on." Change the Summary row `:31` to: "Yes (stdout). At `info`, also each chat question and its user (see §2)". After the fix, change it back. **Done:** the docs PR merges *with* the code PR, not before. Otherwise the doc becomes wrong in the other direction.

**D1.3 OB-B28, `docs/feedback-feature.md:360-361` and table row `:257`.** Replace "**Irreversible**: No way to determine which user submitted feedback" with:

> - The user id is hashed with a server-side pepper and cannot be turned back into a name. The feedback entry still holds the chat id (`chatId`) in every mode, and while chats are stored, a chat id leads to the chat's owner. The application log also records the rater's user name at `info` (see [PII Data Handling](pii-data-handling.md#2-chat-content)). Anonymous mode hides the user in usage statistics. It does not make a rating anonymous.

Change the `:257` "Reversible?" cell to "No for the user id; the chat id is kept". Relabel the UI: `en.json:4783` "Anonymous (hashed)" → "Hashed user ID"; `de.json:5264` "Anonym (gehasht)" → "Benutzer-ID gehasht". If the OB-B28 code fix drops `chatId` in this mode, rewrite the bullet the same day.

**D1.4 Logging level copy (OB-TW3, part of OB-B4).** Change `docs/logging.md:21` to "`info`: normal operation (default). Also records each chat question and who asked it." Change `:28` to "**Recommendation:** use `info` in production only if your log retention is approved for chat content; otherwise `warn`." Change the UI note `en.json:2450` (`admin.logging.note4`) to "\"info\" also logs each chat question and its user. Use \"warn\" if logs must not hold chat content." In de (`de.json:2931`): "„info“ protokolliert auch jede Chat-Frage und den Benutzer. Verwenden Sie „warn“, wenn Protokolle keine Chat-Inhalte enthalten dürfen." Change all three again when the code fix lands.

**D1.5 AI-B7 (decision 12; recommendation "relabel + fix docs", no behaviour change).** Change `docs/prompts.md:47` to:

> | `appId` | string | No | The app the prompt opens in when a user picks it in the prompt library, if the user may open that app (otherwise the default chat app). In that app's prompt search it is listed first. It does **not** limit who sees the prompt. |

Change `:147` heading to "App-Linked Prompt — FAQ Bot" and `:149` to "This prompt opens in the `faq-bot` app and is listed first in that app's prompt search:".
UI, `PromptFormEditor.jsx:330,337,345`:

| Key | en | de |
|---|---|---|
| `admin.prompts.edit.appId` | Opens in app | Öffnet in App |
| `admin.prompts.edit.noApp` | Default chat app | Standard-Chat-App |
| `admin.prompts.edit.appIdDesc` | The prompt library opens this prompt in this app and lists it first there. It does not limit who sees the prompt. | Die Prompt-Bibliothek öffnet diesen Prompt in dieser App und zeigt ihn dort zuerst an. Wer den Prompt sieht, legt dieses Feld nicht fest. |

**D1.6 AI-B15, `docs/apps.md:1517-1524`.** Replace the block with (verified against `configCache.js:820-840`, `featureRegistry.js:306-319`, `generalRoutes.js:171-197`):

```markdown
**App not appearing in the list:**

Apps reload by themselves when a file or the admin editor changes them; a restart is not needed.
If a user does not see an app, check in this order:

1. **Enabled:** the app's switch in **Admin → Apps** is on.
2. **Access:** one of the user's groups grants the app (**Admin → Groups → Apps**: its id or `*`).
   Grants add up through `inherits`; anonymous visitors get what `anonymousAuth.defaultGroups` grant.
3. **Required features:** every id in the app's `requiredFeatures` is on in
   **Admin → Platform → Features**. An id the server does not know counts as off.
4. **Integrations:** every integration in `requiredIntegrations` and every installation the app binds
   is installed and enabled (**Admin → Integrations**).
5. **Valid file:** a file that fails validation is not loaded; the server log names it. App ids must
   be unique.
```

**D1.7 Wrong group ids (SH-TW3).** `docs/AUTHENTICATION_QUICK_START.md:157-161`: change the key and `id` from `"admin"` to `"admins"`, matching `server/defaults/config/groups.json:4`. `docs/troubleshooting.md:380,386,408`: `admin` → `admins`. `:397`: `"groups": ["admin", "users"]` → `"internalGroups": ["admins", "users"]`, matching `server/defaults/config/users.json:12`. I leave `external-authentication.md:156,507` alone: those are IdP-side group names in an example, not iHub ids.

**D1.8 `integrations.md:315` (IN §9 gap).** The sentence is correct for fresh installs. Append: "Installations upgraded through migration V203 can hold `*` on more groups: V203 gave `*` to every group that could use every installation. Check each group under **Admin → Groups → Integrations** after upgrading."

**D1.9 IN-B13/IN-B14/IN-B23, `docs/browser-extension.md`.**
- `:33` API table: "…auto-create the OAuth client" (drop "generate signing key"; `browserExtension.js:250-253` makes it opt-in via `rotate-key`).
- `:107-119` Step 1 → "## Step 1 — Check that integrations are on. The **Integrations** feature is on by default. If someone switched it off, turn it on in **Admin → Platform → Features** (`integrations` in `contents/config/features.json`); no restart is needed." Delete the `platform.json` JSON block.
- `:153-158` Step 3 → "## Step 3 — Create the signing key (needed for ZIP and CRX downloads). Click **Rotate signing key** once. The server creates an RSA key pair, stores the private half at `contents/.browser-extension-key.pem` and the public half in `platform.json` under `browserExtension.signingKey.publicKey`." Fix the UI label "(optional)" at `AdminBrowserExtensionPage.jsx:420` to "Required for ZIP and CRX downloads".
- `:240-244` force-install → "3. Chrome and Edge install extensions from outside their stores only through an **update manifest**. iHub does not serve one yet, so host `updates.xml` next to the `.crx` (example below) and set `ExtensionInstallForcelist` to `<extension-id>;https://intranet.example.com/ihub/updates.xml`. On Windows, such extensions are force-installed only on domain-joined or managed devices." Add the `gupdate` XML sample (`app appid` = extension id; `updatecheck codebase` = CRX URL; `version` = the manifest version). Mark "verify on a managed test device" in the PR.
- `:419` troubleshooting: "`features.integrations` in `contents/config/features.json` and `browserExtension.enabled` in `platform.json` must both be `true`."
- Server strings (IN-B23). `integrationDiagnostics.js:600`, `iFinderDiagnostics.js:339,351` (plus comments `:268`, `:303`): "Admin > Platform > SSL" → "Admin → Security → SSL / TLS" (section label `AdminSecurityPage.jsx:276`; the sidebar groups Security under Platform, but the page title is "Security"). Example for `:600`: "The TLS certificate of the target was rejected. Add the issuing CA to the iHub server's trust store, or add the domain under **Admin → Security → SSL / TLS**."

**D1.10 AX-B1 doc note (roadmap: hide the field and add a note now).** `docs/agents.md:11` "wake on their own (cron, webhook, manual trigger)" → "run when started (the **Run** button or the API)". Add a callout after the intro: "> [!WARNING] Agent schedules are not supported yet: a cron expression set on an agent is not saved and never runs. The Schedule field is hidden until it works." `:44` drop ", optionally configure a cron schedule"; `:45` "4. Start a run from the list page (**Run**)." `:36-41` also puts `features` in `platform.json`; change it to "Turn on **Agent Factory** in **Admin → Platform → Features** (`agentFactory` in `contents/config/features.json`)."

**D1.11 GETTING_STARTED drift (SH §9; cheap, same PR).** `:62` "**Admin → Providers**" → "**Admin → Models → Providers**". `:94` "**26 apps**" → "**About 25 apps**". 27 ship today (`server/defaults/apps`), and a number that drifts every release should not be exact.

**Done for D1:** every corrected line cites the code it was checked against in the PR description. `docsContent.test.js` passes. A reviewer from a second persona (security or on-prem admin) signs off on D1.1–D1.3. Admins who already did a DPIA hear about it (see D6).

### D2 — Wrong in-product pointers (SH-B14 = OB-B12, CU-B12, ID-B6 hint, IN-B23 UI side). Effort S. en + de in one commit.

| Where | Key | en (new) | de (new, Sie) |
|---|---|---|---|
| `AdminAuditLogPage.jsx:170-173` | `admin.auditLog.retentionHint` | Set in platform.json (`audit.retentionDays`, `audit.cleanupEnabled`). No admin page edits it yet. | Wird in platform.json festgelegt (`audit.retentionDays`, `audit.cleanupEnabled`). Noch keine Admin-Seite bearbeitet diese Werte. |
| `AdminPageEditPage.jsx:202` (literal today) | `admin.pages.fields.allowedGroupsPlaceholder` | admins, users or * | admins, users oder * |
| same, new help line | `admin.pages.fields.allowedGroupsHelp` | Group IDs, separated by commas, exactly as in Admin → Groups. * allows everyone. An unknown ID hides the page from everyone in it. | Gruppen-IDs, durch Kommas getrennt, genau wie unter Admin → Gruppen. * erlaubt allen den Zugriff. Eine unbekannte ID verbirgt die Seite. |
| `AdminOAuthClientEditPage.jsx:441-444` | `admin.auth.oauth.permissionsHint` | For a client that signs in users (authorization code), these lists narrow what the user may already use. For a service client (client credentials), there is no user: these lists are everything the client may use. Choose only what it needs. | Bei einem Client, der Benutzer anmeldet (Authorization Code), schränken diese Listen ein, was der Benutzer bereits nutzen darf. Bei einem Service-Client (Client Credentials) gibt es keinen Benutzer: Die Listen sind alles, was der Client nutzen darf. Wählen Sie nur, was er braucht. |

The `server/routes/admin/auditLog.js:156-157` comment ("edited through the platform config form") is also false; fix it in the same PR. Docs side of SH-B14: add `### Retention and privacy` under `admin-ui.md:460` "Audit Log". It names the four keys and says which ones only the file sets. The chip then gets `docsHref` `admin-ui.md#retention-and-privacy` when D-links land (Next). **Gate:** D2's ID-B6 row pairs with "least-privilege service-client UI" (decision 4a). The hint text above holds for both today's and the fixed behaviour.

### D3 — `admin-ui.md` statements contradicted by the UI (SH-TW3, SH-B26, ID-B23, PL-B21, AI-B25). Effort S. Qualify now, rewrite as the map in Next.

| Line | Now | Corrected text |
|---|---|---|
| `:12-13` | "You do not need to edit JSON files … Everything … can be done through the admin UI" | "> [!TIP] Most settings can be changed in the admin UI at `/admin`. Some can only be set in the configuration files; this guide says so where it applies, and [Platform configuration](platform.md) lists them." |
| `:32` | Customization: UI Customization, Localization, Pages, Short Links | "UI Customization, Disclaimer, Localization, Pages, Document templates, Short Links" (`AdminSidebarNavData.js:230-265`) |
| `:34` | Platform: …Security, Backup… | "Features, Voice Input, Security, EU AI Act, Backup & Restore, Updates, Advanced" (`:342-389`) |
| `:38` | chevron "at the bottom" | "Click the double chevron next to the logo at the top of the sidebar…" (`AdminSidebar.jsx:302-322`) |
| `:66`, `:588` | `n` creates a new item | Delete both rows until SH-B8 ships (`AdminLayout.jsx:55` passes no `onNew`). |
| `:102` | "Conversations — total chat sessions" | "**Model calls** — model calls in the last 30 days". Confirm the window in `useOverviewData.js` before merging. |
| `:111` | checklist "Disappears once complete" | Write this line in the SH-B3 PR. Until then: "Lists the first setup steps with links to their pages." |
| `:266` | Bulk operations (ID-B23) | Delete (no selection in `AdminUsersPage.jsx`). |
| `:516` | History on "apps, models, prompts, sources, providers, groups, users" | "The app, model, prompt and project editors have a **History** button…" Add a bullet: "**Rollback** restores a saved version after a confirmation." (`ChangeHistoryDrawer.jsx:147-203`) |
| `:528-532` | Guard on every edit page | Until the guard PR closes: "Most edit pages ask before you leave with unsaved changes. Settings pages (Authentication, Platform → Security, Logging, Telemetry, …) do not yet: save before you navigate away." When the PR lands: restore the absolute statement and add "Pressing Escape or clicking outside a dialog with unsaved changes asks too." |
| `:559-563` | SSL upload, SameSite, session expiry | "**SSL / TLS**: certificate checks you relax for listed hosts; **Cookies**: the Secure flag; **CORS**; **Rate Limits**; **SSRF Allowlist**; **Tool approval**; **Outbound Proxy**; **Value Encryption**." (`AdminSecurityPage.jsx:274-313`). Add a PL-B12 sentence with the D-privacy PR: "A host on the SSL / TLS list is also trusted by the SSRF guard." (decision 14) |
| `:569-573` | "Check for available updates" | "See whether a newer version is available (checked when the page opens)" |
| `:345-346` | "Defaults" and "vLLM Realtime" cards | "**Voice input (microphone button)**: the dictation service (browser or Azure Speech) and the transcription model; **Azure Speech**: endpoint and key with **Test connection**". Verify vLLM against `AdminVoiceInputPage.jsx:69-72` before merging. |
| `:143` | reload lands on the same heading | True after D4. Leave it, but D4 must land first or together. |

Also `document-feature` skill (`.claude/skills/document-feature/SKILL.md`, Workflow step 4): add "If the change alters an admin page, check its section in `docs/admin-ui.md`". This is SH-TW3's own recommendation. It is a skill edit, so the maintainers decide.

**Done:** each row is quoted in the PR with the code line that proves it. No new section is added in Now.

### D4 — SH-B1 docs deep links. Effort S. No release entry.

`server/routes/staticRoutes.js:110-111`: exempt `.md` under `/admin/docs/` from the "has an extension → 404" rule, e.g. `if (/\.[a-z0-9]+$/i.test(relativePath) && !/^\/admin\/docs\/[^?#]+\.md$/i.test(relativePath))`. Keep the `.md` URLs, because release notes and bookmarks already use them (`features.md:805`). **Done:** a unit test (`tests/unit/server/adminDocsRoutes.test.js` or a new static-route test) asserts 200 + `index.html` for `/admin/docs/oidc-authentication.md` and for `/ihub/admin/docs/oidc-authentication.md` with `X-Forwarded-Prefix`. It also asserts that `/assets/missing.js` still 404s. A manual cold load at `/` and `/ihub/` with a `#heading` lands on the heading. No `KNOWN_ROUTES` change is needed (`admin` is already known).

### D5 — Microcopy templates (SH-B10, ID-B14, PL-B15, AX-B15; theme 2/5). Effort S for the helper and templates; call-site migration rides with the PRs that touch each page.

**Platform change:** extend `apiErrorMessage(error, t, fallback)` (`client/src/utils/apiErrorMessage.js`). On status 429, return `t('apiErrors.RATE_LIMITED_WAIT', { count: retryAfterSeconds })` from the `Retry-After` header, with a fallback to `apiErrors.RATE_LIMITED`. Then make `getAdminApiErrorMessage` (`adminApi.js:15`) delegate to it, so its 71 importers get localization for free. Add `no-restricted-syntax` against `err.message` in `features/admin` with a baseline (92 sites today). Native dialogs: 31 `confirm/alert/prompt` calls; ESLint `no-alert` with a file-level baseline.

Templates. Keys go in `admin.common.*` unless noted; German uses *Sie* and the term **Benutzer** (decision 11), with i18next `_one/_other` plurals:

| Purpose | Key | en | de |
|---|---|---|---|
| Load error title | `admin.common.loadError.title` | Couldn't load {{thing}} | {{thing}} konnte nicht geladen werden |
| Load error body | `…loadError.body` | {{detail}} Nothing on this page can be saved until it loads. | {{detail}} Bis die Seite geladen ist, kann nichts gespeichert werden. |
| Load error action | `common.tryAgain` (exists) | Try again | Erneut versuchen |
| 429 | `apiErrors.RATE_LIMITED_WAIT_one/_other` | The server is busy. Try again in {{count}} second. / …in {{count}} seconds. | Der Server ist ausgelastet. Versuchen Sie es in {{count}} Sekunde erneut. / …in {{count}} Sekunden erneut. |
| 429 auto-retry | `admin.common.retrying` | The server is busy. Retrying in {{count}} s… | Der Server ist ausgelastet. Neuer Versuch in {{count}} s … |
| Error ≠ empty | `admin.common.listLoadError` | Couldn't load the list, so it may not be empty. {{detail}} | Die Liste konnte nicht geladen werden; sie ist möglicherweise nicht leer. {{detail}} |
| Save failed | `admin.common.saveError` | Couldn't save. {{detail}} Your changes are still here. | Speichern fehlgeschlagen. {{detail}} Ihre Änderungen sind noch da. |
| Conflict (412/409) | `apiErrors.CONFLICT` (exists, fine) | The data was changed in the meantime. Reload and try again. | (exists) |
| Delete, plain | `admin.common.confirmDelete.title` / `.body` | Delete {{type}} "{{name}}"? / This can't be undone. | {{type}} „{{name}}“ löschen? / Das kann nicht rückgängig gemacht werden. |
| Delete, used by | `…confirmDelete.usedBy_one/_other` | It is used by {{count}} item: {{list}}. They will stop working. / …{{count}} items… | Es wird von {{count}} Element verwendet: {{list}}. Es funktioniert dann nicht mehr. / …von {{count}} Elementen…: {{list}}. Sie funktionieren dann nicht mehr. |
| Delete, typed name | `…confirmDelete.typeName` | Type {{name}} to confirm. | Geben Sie zur Bestätigung {{name}} ein. |
| Confirm button | `…confirmDelete.action` | Delete {{type}} | {{type}} löschen |
| Platform-wide (AI-B2) | `admin.models.confirmDisableAll.body` | Disable all {{count}} models? Apps that use them stop answering, and the default model is cleared. | Alle {{count}} Modelle deaktivieren? Apps, die sie nutzen, antworten nicht mehr, und das Standardmodell wird entfernt. |
| Restore ZIP (PL-B1) | `admin.backup.confirmImport.body` | Replace the whole configuration with "{{file}}"? The current one is kept in contents/.backups/ (the three newest are kept). | Die gesamte Konfiguration durch „{{file}}“ ersetzen? Die aktuelle wird in contents/.backups/ aufbewahrt (die drei neuesten bleiben erhalten). |
| Audit cleanup (OB-B8) | `admin.auditLog.confirmCleanup.body` | Delete audit entries older than {{days}} days now? This can't be undone. | Audit-Einträge, die älter als {{days}} Tage sind, jetzt löschen? Das kann nicht rückgängig gemacht werden. |
| Unsaved (exists) | `admin.unsavedChanges.*` | keep; delete the per-page copies `admin.ui.unsaved`, `admin.projects.unsaved`, `admin.integrationBuilder.unsaved` | |
| Refusal: lockout (ID-B1) | `apiErrors.AUTH_CONFIG_LOCKOUT` | This change would leave you no way to sign in. Keep {{method}} on, or sign in with another method first. | Mit dieser Änderung könnten Sie sich nicht mehr anmelden. Lassen Sie {{method}} aktiv oder melden Sie sich zuerst mit einer anderen Methode an. |
| Refusal: last admin (ID-B2) | `apiErrors.LAST_ADMIN` | {{name}} is the last administrator. Give another user admin access first. | {{name}} ist der letzte Administrator. Geben Sie zuerst einem anderen Benutzer Administratorrechte. |
| Refusal: self (ID-B2) | `apiErrors.SELF_ADMIN_REMOVAL` | You can't remove your own admin access. Ask another administrator. | Sie können Ihre eigenen Administratorrechte nicht entfernen. Wenden Sie sich an einen anderen Administrator. |
| Refusal: inherited group (ID-B4) | `apiErrors.GROUP_INHERITED` | Group "{{id}}" is inherited by {{list}}. Remove it from their "Inherits" first. | Die Gruppe „{{id}}“ wird von {{list}} geerbt. Entfernen Sie sie dort zuerst unter „Erbt von“. |
| Refusal: in use (theme 5, Next) | `apiErrors.RESOURCE_IN_USE` | {{type}} "{{name}}" is still used by {{list}}. | {{type}} „{{name}}“ wird noch von {{list}} verwendet. |

Rules for the PRs: a confirmation names the object, its dependants and the undo path (or says there is none). A refusal says what to do instead. No "Are you sure". No "Error:" prefix. Never "Request failed with status code N". German status colour comes from `type`, never from the text (PL-B9). New codes go into `shared/apiErrors.js` with both locale entries; the en/de coverage of `apiErrors` is complete today (294/294), so keep it that way. The exact code names are the server PR's call; I only fix the copy.

### D6 — `docs/releases/next/` entries per Now PR

Format per `.claude/skills/document-feature/SKILL.md`: `##` title saying what is true now, symptom first for fixes, wrap at 100 columns, appended at the end of the file. Existing entries already cover SH-B9 (`fixes.md:817`) and SH-B5 (`:822`): no duplicates.

| Now PR | File | Title (draft) |
|---|---|---|
| Gate config pages on load | fixes | Admin Settings No Longer Save Defaults After a Page Failed to Load |
| Lockout / last-admin / `active` / inherited group | fixes | You Can No Longer Lock Every Administrator Out (bullets: last admin, own sign-in method, inherited group answers 409 `GROUP_INHERITED`) + separate "Saving a Disabled User Keeps Them Disabled" |
| Redacted / whole-file overwrites | fixes | Saving Advanced or Provenance No Longer Erases the Proxy JWT Key URL; a Stale UI Save No Longer Deletes Pages |
| Unsaved guards | fixes | Every Admin Page Asks Before Discarding Unsaved Changes |
| Named confirmations | features | Admin Confirmations Name What They Delete (bullet: choosing a ZIP no longer restores immediately) |
| Visual P1s | fixes | Admin Inputs Have Visible Borders, and the Cookies Save Button Is Readable |
| Contract bugs | fixes, one per area | "App Wizard: Create Works in Every Browser Language", "Short Links: Editing Changes the Target", … |
| Agent schedule hidden | fixes | Agents: The Schedule Field Is Hidden Until Schedules Run |
| OB-B4 + OB-B28 | **breaking-changes** | Chat Questions and Rater Names Are No Longer Written to the Log (draft below) |
| PL-B2 callout, PL-B12 shown | features | Backup and Security Pages Say What a Backup Holds and What the TLS List Trusts |
| Honest Overview (SH-B2/B3) | fixes | The Admin Overview No Longer Shows a Fresh Install When a Request Fails |
| Docs deep links (SH-B1) | **none** | Fixes an unreleased feature (`features.md:788`) |
| Service-client UI (ID-B6) | features | OAuth: New Service Clients Start With No Access (gated by decision 4) |
| Harmful docs, pointers (D1/D2) | fixes, **one** entry for the UI copy only | Admin Hints Point to the Right Page |
| Translation ratchet + keys | extend `features.md:1691` with a bullet | "…and the admin area: N texts that were English in German now have German text." |

Draft, `breaking-changes.md`:

```markdown
## Chat Questions and Rater Names Are No Longer Written to the Log

At the default level `info`, every chat request wrote the user's question and name to the
application log (`CHAT_REQUEST`, field `query`), and every rating wrote the rater's name and chat id
(`FEEDBACK`). Logs often go to systems with their own retention, so this was chat content kept
outside iHub's retention settings. `CHAT_REQUEST` now names the app, model and user only; `FEEDBACK`
carries neither the user name nor the chat id.

- The data-handling reference also lists files uploaded to chats, which are stored by default
  (originals 14 days). It said they were not kept. See [PII Data Handling](../../pii-data-handling.md).

**Before upgrading:** if a SIEM or log query reads `query` from `CHAT_REQUEST` or `user` from
`FEEDBACK`, change it. To stop logging the remaining user names too, set `logging.level` to `warn`.
```

My one exception to "docs-only gets no entry" is the uploads bullet above. A DPO who wrote a DPIA from the old row must learn that it was wrong, and the changelog is where operators look. I folded it into the privacy entry so no docs-only entry is needed. Decision 7 decides the headline; if the content switch ships, add a bullet naming it.

### D7 — i18n: translation-key ratchet (AX-B7, SH-B13, AI-B14, CU-B22, ID-TW3, IN-TW8, OB-B18, PL-B22). Effort S for the test; the keys themselves are M and are split per area.

Current state: `tests/unit/client/translation-keys-exist.test.jsx:19` skips `features/admin` and `auth-gate`, and `:64` filters every `admin.` key. With the test's own regex, the excluded scope holds **6,531 calls and 1,270 distinct keys missing from both locales in 103 files**. Worst: AdminAgentEditPage 99, AppCreationWizard 97, AdminBrowserExtensionPage 68, AdminOverview 50, PromptFormEditor 41. en/de key parity is clean: 0 keys in `en.admin` without a `de` twin. 25 `admin.*` German values equal the English, and they are product names; allowlist them.

Change the test (one PR, no locale edits):
1. Drop the `features/admin` exclusion and the `admin.` filter (`:19`, `:64`). Keep `auth-gate` (it has its own table) and say so in the header comment `:10-11`.
2. Add `translation-keys-baseline.json` next to it: a sorted list of the 1,270 keys. Assert (a) every used key is in en **and** de, **or** in the baseline; (b) every baseline key is still missing ("remove X from the baseline"), so the baseline can only shrink.
3. Add three cheap checks: every key under `en.admin` exists in `de` (lock today's parity); no German value matches `/\b(du|dich|dir|dein\w*)\b/i` outside a 19-entry allowlist that shrinks too (`de.json:369-370` contradicts `fixes.md:784`'s promise of formal address in the same area); and `_one` needs `_other` (AX-B30).
4. Hard-coded literals (AgentRunsPage: 0 `useTranslation`; the command palette's `AdminCommandPalette.jsx:11-25` labels): an ESLint `no-restricted-syntax` on `JSXText[value=/[A-Za-z]{3,}/]` in `features/admin`, warn-level plus a file baseline. That keeps the Now PR small.

**Done:** CI fails on any new missing admin key; the baseline file is reviewed like code; a short `docs/localization.md` paragraph tells contributors "add every `t()` key to `shared/i18n/en.json` and `de.json`; the test lists the ones you missed". The key fill-in (≈1,270 en + de) ships per area with the area's PR, worst areas first (Agents/Workflows/Skills = AX-B7, P1). No changelog entry for the test; one bullet per fill-in on the existing translations entry.

## 3. Shared components / hooks / server layers I require

| Layer | API sketch | Closes (docs/copy angle) |
|---|---|---|
| `apiErrorMessage(error, t, fallback)` (exists) + 429 branch; `getAdminApiErrorMessage` delegates | reads `Retry-After`, returns `apiErrors.RATE_LIMITED_WAIT` (plural) | SH-B10, ID-B14, PL-B15, AX-B15; part of theme 2 |
| `AdminLoadError` (exists) | add `thing` prop → "Couldn't load {{thing}}"; default action `Try again` re-runs the loader instead of `window.location.reload()` (`AdminLoadError.jsx:29`) | theme 1 copy, SH-B2 |
| `ConfirmDialog` named variant | `{ type, name, usedBy?: [{type,name,href}], undo?: string, requireTypedName?: bool }`, all copy from `admin.common.confirmDelete.*` | AI-B2, AI-B12, AX-B14, PL-B1, PL-B8, OB-B7, OB-B8, IN-B3 copy |
| One unsaved-dialog key set | `admin.unsavedChanges.*` only | removes 3 duplicate key sets; CU-B22 count |
| Translation ratchet test + baseline | §2 D7 | AX-B7, SH-B13, AI-B14, CU-B22 and siblings |
| Docs consistency test (extend `tests/unit/server/docsContent.test.js`) | also resolve `#anchors` in relative links (only file targets are checked today, `:106-127`); every `adminPage:` front-matter path is a real route | SH §9 CI goal; protects D1/D3 edits |
| Static-route exemption | §2 D4 | SH-B1 |

`DocsHelpLink`/`helpPath` are Next. I don't want "?" icons before the deep links and the docs are right, because a help link to a wrong page is worse than none.

## 4. Next / Later notes

- **Next:** docs wave 1 (`admin-first-hour.md`, `admin-how-do-i.md`, `where-is-setting.md`, `access-control.md`, `troubleshooting-access.md`, `sign-in-setup.md`, `corporate-network.md`). The `admin-ui.md` map rewrite (18 missing sections, SH-TW4). The `SUMMARY.md` "Administration" group. `DocsHelpLink` on every page header. `credentials.md`, `short-links.md`. Move `AUTHENTICATION_QUICK_START.md` to developer docs. `messageKey` from server diagnostics so IN-B23-style strings get German.
- **Release-note format:** the README wants an `audience` tag and "What you need to do" (SH-TW7). That changes `releaseNotes.js` parsing and the skill, so it is a maintainer decision and not Now.
- **Later:** German search synonyms in the docs search; a docs side drawer; fields for JSON-only settings, which would make D3's `:13` qualification unnecessary; docs wave 2.

## 5. Pre-mortem — the rework shipped and failed

| # | Failure | Mitigation |
|---|---|---|
| 1 | The OB-B4 doc fix merged before the code fix (or the reverse), so `pii-data-handling.md` was wrong in the other direction and a DPO cited it. | D1.2/D1.4 text lands in the code PR; a docs PR that touches `pii-data-handling.md` §2/§5 needs a security-persona review. |
| 2 | `admin-ui.md:528-532` was restored to "every page" when the guard PR closed only `AdminSettingsPage`, and the docs lied again. | Restore the absolute wording only with a Playwright test that iterates every admin route with a dirty form. |
| 3 | Baseline JSON rots: someone regenerates it to make CI green, and the ratchet becomes a no-op. | Test (b) fails on stale entries; CODEOWNERS on the baseline; a PR that grows it is refused by a size check (length may only drop). |
| 4 | Fill-in PRs add English to `de.json` ("Save" in German) to satisfy the key check. | The "identical to en" check with a product-name allowlist; spot-review by a German speaker per area. |
| 5 | New German strings use *du* again (they did after `fixes.md:784`). | The *du* lint in D7.3. |
| 6 | The 429 copy says "Try again in N seconds" but `Retry-After` is missing (CORS `exposedHeaders` behind a proxy), and users see "in NaN seconds". | Fall back to `apiErrors.RATE_LIMITED`; unit test both; check `standardHeaders` (`rateLimiting.js:101`) through the reverse proxy guide's config. |
| 7 | SH-B1 exemption is too wide (`/admin/docs/x.js` returns `index.html`), so asset 404s turn into HTML and break caching or CSP debugging. | Exempt only `\.md$`, and test that other extensions still 404. |
| 8 | Release entries pile up as near-duplicates (16 contract bugs → 16 entries), and admins skip What's New. | One entry per area; the reviewer runs the skill's "already covered?" check. |
| 9 | A breaking log change ships with only a fixes entry, and a customer's SIEM alert silently stops. | OB-B4/OB-B28 in `breaking-changes.md` with "Before upgrading", per D6. |
| 10 | Docs reference UI labels that a later rename (decision 11: Channels, Monitoring) changes, so nav paths in docs drift. | Ship the anchor and `adminPage` check (§3); make the rename PR grep `docs/` for the old label as an acceptance step. |
| 11 | Browser-extension force-install recipe still fails because the `updates.xml` example was untested. | The PR must include a screenshot from a managed test VM, or the section says "untested" plainly. |
| 12 | Corrected server strings (IN-B23) reach German admins in English. | Accept for Now (they already are English); file the `messageKey` work in Next. |
| 13 | Scope creep: "fix wrong docs" turns into rewriting `admin-ui.md`. | D3 is a fixed list of 14 rows; anything else goes to the Next map rewrite. |

## 6. Questions I have NOT asked

1. **Is a DPIA or customer statement based on `pii-data-handling.md` already out there?** It decides whether the uploads correction needs more than a changelog bullet (a direct customer notice). Default: the bullet plus a note in the PR asking support to tell known DPO contacts.
2. **Decision 7: does OB-B4 remove `query` for everyone, and does a content-logging switch ship?** It sets the final text of D1.2/D1.4 and the breaking entry. Default: the recommendation (removed, no switch in Now).
3. **Who owns German copy review?** 1,270 keys need a native reviewer, and Sie/Benutzer consistency is a product voice choice. Default: one IntraFind German speaker per area PR; terms per decision 11.
4. **Should `docs/` get German pages, or say once that they are English?** `docs/de` doesn't exist; `ihub-faq-de.md` does. Default: add one line to `docs/README.md`, "The documentation is in English", and no translations in Now.
5. **Are the Pages "Allowed Groups" and the OAuth hint going to be replaced by pickers soon (CU-B12, ID-B6)?** If so, the copy in D2 is short-lived. Default: ship the copy now (S), and replace it when the picker lands.
6. **Can I edit `.claude/skills/document-feature/SKILL.md`** to add the `admin-ui.md` check? It is agent config. Default: propose it in the PR; a maintainer applies it.
7. **Is the `updates.xml` workaround acceptable to recommend, or should Option B say "not supported yet"?** A self-written update manifest is a support burden. Default: document it as "works, untested by IntraFind", with the sample.
8. **Do external scripts delete groups via the admin API?** A 409 on an inherited-from group changes the contract. Default: fixes entry naming the code; move it to breaking-changes if anyone says yes.
9. **Is the Overview "Model calls" window 30 days?** I didn't trace `useOverviewData.js` fully. Default: the D3 row is merged only after the PR author confirms.

## 7. Decisions I made on my own

- **Verified lines beat the review's lines.** I re-derived every file:line; where the review differs (e.g. `admin-ui.md:513` → `:528`, `:5` → `:13`, `staticRoutes.js:109-110` → `:110-111`), I used the current one.
- **Dropped the stale OAuth item (ID §9) from the Now list.** `oauth-integration-guide.md:37-63` and `oauth-authorization-code.md:55-58` already teach the UI path. The remaining risk is ID-B6, which I handled as copy (D2).
- **Added `troubleshooting.md:380-408` and `GETTING_STARTED.md:62,94`** to D1. They are the same class of error and the same size; leaving them would fail the "fix the class at its worst instance" rule.
- **Qualify, don't rewrite `admin-ui.md` in Now.** The README puts the map rewrite in Next. Now only makes false statements true.
- **One breaking entry for OB-B4 + OB-B28 and a folded-in uploads bullet,** rather than a separate docs-only entry, which the skill forbids.
- **Ratchet by key baseline, not by count.** A count can stay flat while keys swap; a list can't.
- **Kept `auth-gate` excluded** from the key test: its own table is a deliberate design (`translation-keys-exist.test.jsx:10`).
- **German terms:** *Sie* throughout, **Benutzer** for "user" (decision 11's recommendation), „…“ quotes, "Erneut versuchen" (existing `common.tryAgain`).
- **New error-code names** (`AUTH_CONFIG_LOCKOUT`, `LAST_ADMIN`, `SELF_ADMIN_REMOVAL`, `GROUP_INHERITED`, `RATE_LIMITED_WAIT`) are placeholders for the copy. The server PRs choose the final names, and each needs `shared/apiErrors.js` plus en/de.
- **Browser-extension force-install:** I documented the `updates.xml` route plus the Windows managed-device limit from my knowledge of Chrome policy, not from iHub code; flagged for verification on a test device.
- **IN-B23 nav path:** I wrote "Admin → Security → SSL / TLS" (page title + section label), not "Platform → Security", because the docs use the page name, not the sidebar group, elsewhere (`breaking-changes.md:849`).
