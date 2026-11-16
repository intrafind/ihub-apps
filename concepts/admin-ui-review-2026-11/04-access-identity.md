# Access & Identity: Users, Groups, Authentication, OAuth — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/users`, `/admin/users/new`, `/admin/users/:userId`, `/admin/users/:userId/view`, `/admin/groups`, `/admin/groups/new`, `/admin/groups/:groupId`, `/admin/auth`, `/admin/oauth`, `/admin/oauth/server`, `/admin/oauth/clients`, `/admin/oauth/clients/new`, `/admin/oauth/clients/:clientId`, `/admin/oauth/clients/cimd/:encodedClientId`, `/admin/oauth/connections` (`client/src/App.jsx:680-735`).

All five panel notes were delivered. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min) and the login limit (30 per 15 min) often returned 429. OAuth clients are switched off on this instance, so the client list and editor were judged partly from code. How pages *behave* after a failed load is reported as a finding: a real admin behind a NAT hits the same thing. All `zz-access-identity-*` test groups and users were deleted (the adversarial verifier found one leftover group, `zz-access-identity-limited`, with no members, and deleted it); no auth, OAuth or platform settings were saved. The lead re-checked disputed facts in code and live (`lead/check.js` in the scratch folder) and found one new P1 bug (ID-B3). An adversarial verifier then re-checked every finding (see the appendix).

## Summary

Access & Identity is iHub's control plane: who can sign in (Authentication), who people are (Users), what they may use (Groups), and what machines may do (OAuth). It is **not intuitive**: every page scored 2–3, and the admin completed only one of six realistic tasks; three failed.

The biggest problems:
- **Lockout trap.** If `/admin/auth` fails to load, it shows built-in defaults (Proxy mode, local sign-in off) as "All valid" with Save enabled; one click locks the admin out (ID-B1).
- **No guards on users.** Nothing stops demoting or disabling the last admin, and saving any edit to a disabled user silently re-enables them (ID-B2, ID-B3).
- **Permissions only add up, and the UI says otherwise.** Every signed-in user carries the built-in `authenticated` group, which by default grants all apps and models. With that shipped wildcard in place, "a group limited to 2 apps" is impossible, yet the editor claims it works (ID-B5). Admins can narrow `authenticated` itself, but nothing in the UI tells them that is the lever.
- **No answer to "why can't user X see app Y?"** (ID-PM1).
- **Machine OAuth clients default to every app and model**, explained with the wrong security model (ID-B6).

Wins to build on: the LDAP "Test a login" panel, the OIDC templates, the demo-accounts banner, the explanatory user-delete dialog, the create-time secret modal with Copy, and the group form's Integrations block, which already shows inherited grants correctly ("via users, authenticated").

## 1. What this part does

- **Users** (`/admin/users`, `…/:id/view`, `…/:id`): every persisted account (local, OIDC, proxy, LDAP, NTLM), with search, five filters and an inline active switch. View is a read-only card; Edit covers profile, enabled, group membership, password reset, personal usage limits, and the user's prompts and skills. Server: `/api/admin/auth/users` ([auth.js](../../server/routes/admin/auth.js)). Used weekly: onboarding, offboarding, password resets.
- **Groups** (`/admin/groups`, `…/:id`): the authorization model. Allow-lists for apps, models, prompts, workflows, skills and integrations; five flags (`adminAccess`, `contentAdmin`, `scheduledTasks`, `projects`, `projectSharing`); `inherits`; IdP group mappings; usage limits. Effective rights are the **union** of a user's groups, their parents and the implicit `authenticated` (or `anonymous`) group ([authorization.js:390-430](../../server/utils/authorization.js)); nothing can be denied. Used at setup, then monthly.
- **Authentication** (`/admin/auth`): one long form over the auth blocks of `platform.json`: six "Primary Authentication Mode" cards, six "Authentication Methods" checkboxes, default groups, and a card per enabled method (Proxy/JWT, Local with demo accounts and lockout, OIDC with templates, LDAP with a login test, NTLM). One Save writes everything. Used once at setup, then rarely, always high-stakes.
- **OAuth** (`/admin/oauth` + tabs): iHub as an authorization server. Overview (three status cards); **Authorization Server** (token lifetimes, auth-code, refresh, consent, and, oddly, **Personal API keys**); **Clients** (client-credentials, auth-code and CIMD clients; rotate, long-term token, disable, delete); **Connections** (grants users gave to apps). The DCR/CIMD acceptance policy lives elsewhere, in Integrations → MCP gateway ([AdminMcpGatewayPage.jsx:70-137](../../client/src/features/admin/pages/AdminMcpGatewayPage.jsx)). Used quarterly.

## 2. Is it intuitive? — verdict

Panel median, persona range in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| Users list | 3 (3) | Clean table and filters. Subtitle says "Manage local authentication users" but lists everyone ([AdminUsersPage.jsx:396](../../client/src/features/admin/pages/AdminUsersPage.jsx)); Auth Method filter lacks LDAP/NTLM; "Last Active" is always "Never" for local users (ID-B17); docs promise bulk actions that don't exist. |
| User view | 2 (2–3) | "Groups & Permissions" lists only manually assigned groups: no inherited or IdP groups, no resolved apps or models, which is why anyone opens it. |
| User edit / new | 3 (2–3) | Complete, with an unsaved-changes guard. But inputs have no visible border (ID-B7), Full Name is empty and "No authentication method set" shows for every existing user (ID-B18), errors appear before typing, and saving re-enables a disabled user (ID-B3). |
| Groups list | 3 (3) | Readable; Permissions column shows only raw app IDs; no search, member count, models or parents. |
| Group edit | 2 (2–3) | ~3,700 px with Save only at the bottom; empty-state copy is false under inheritance; "Admin Access" is styled like "Enabled"; no members; typing an ID that starts with a protected name freezes the field (ID-B13). |
| Authentication | 2 (2) | Two overlapping controls (mode cards and method checkboxes) with no explanation; no unsaved-changes guard; no OIDC test; validation only checks that a mode is set; dark-mode labels invisible; load-failure lockout trap. |
| — OIDC sub-form | 3 (admin) | Templates help, but Microsoft uses `/common` with no tenant field, Keycloak puts `${…}` in four URL fields, the callback is relative, and nothing says Entra sends group GUIDs. |
| — LDAP sub-form | 4 (admin) | Presets, good help, "Test a login". The model for the other methods. |
| OAuth overview | 3 (2–3) | Clear status cards, but "Disabled" offers no way to turn it on, and a load error also shows as "Disabled". |
| OAuth Authorization Server | 2–3 | Good endpoint copy buttons; mixes protocol settings with the product feature "Personal API keys". |
| OAuth clients + editor | 2 (2–3) | Hand-rolled list with five icon-only buttons; defaults to all resources with the wrong explanation; rotated secret in `alert()`; create while clients are off fails with "status code 400". |
| OAuth connections | 3 (TW) | Clear purpose; "Connections" appears in no auth doc. |

**Verdict.** The UI is organised around storage files (`platform.json`, `users.json`, `groups.json`, OAuth clients); admins think in outcomes ("Alice may use only these two apps", "Entra group X are admins", "our CI server needs a token"). Every realistic task crosses two or three pages, and no page shows the resulting effective access. The most important fact in this part, that permissions are an allow-only union with `authenticated: *` underneath, is misstated by the UI and barely mentioned in the docs. The pages that change sign-in have the fewest guards: no unsaved-changes prompt, no lockout check, no test before save. Visually, three generations of admin UI are mixed (DataTable lists, DualModeEditor forms with broken inputs, hand-rolled OAuth screens with `alert()`).

## 3. Task walkthroughs

The admin walked all six tasks end to end; other personas repeated parts. Step counts are the admin's.

**Task 1 — Lock down a fresh install** (demo accounts off, change `admin` password, deal with demo `user`). Inspected, not saved.
- Steps: 4 for demo accounts (banner → Authentication → scroll past two sections → untick → Save at bottom); 5 for the password (Users → Edit → new + confirm → Save). About 12 actions over 4 pages with the demo `user`.
- Hurt: the banner ([AdminDemoAccountsAlert.jsx](../../client/src/features/admin/components/AdminDemoAccountsAlert.jsx)) links to the top of `/admin/auth`, not to the checkbox ~1,500 px down; it doesn't offer to disable `user`. The one Save rewrites every auth block. The label is near-invisible in dark mode (ID-B9). There is no self-service password change and no "must change at next sign-in". The Overview checklist marks "Admin account ready" done regardless (ID-B30).
- Outcome: **success**, slow and risky.

**Task 2 — Prepare OIDC (Entra ID / Keycloak) and map an IdP group.** Not saved.
- Steps: ~14 across `/admin/auth` and a group page.
- Hurt: method labels aren't clickable (ID-B21). Microsoft template uses `/common` with no tenant field and shows `${GOOGLE_CLIENT_ID}` as placeholder; Keycloak pre-fills `${KEYCLOAK_SERVER}/${KEYCLOAK_REALM}` in four URLs ([OidcProvidersSection.jsx:39-66, 252](../../client/src/features/admin/components/platform-form/OidcProvidersSection.jsx)). The callback hint is relative (:332). Whether groups arrive as names or GUIDs had to be read from `server/middleware/oidcAuth.js:127-185`. Mapping lives on each group's page. No test sign-in. A sidebar click lost all input without a prompt (ID-B11).
- Outcome: **partial**.

**Task 3 — Group with 2 apps and 1 model inheriting `users`; add a user; check what they see.**
- Steps: 11 (group) + 8 (user, via the user's edit page; groups have no members view) + logging in as the user.
- Hurt: the member saw **16 apps**. `users` grants `apps:["*"]`; with `inherits: []` the user still carried `authenticated` (`*`). Meanwhile the editor said "No parent groups - this group only has its own permissions" ([GroupFormEditor.jsx:383](../../client/src/features/admin/components/GroupFormEditor.jsx)) and "No prompts selected - users can't access any prompt templates" (:449), while the Integrations block on the same form said "via users, authenticated". Two of the three chosen resources were disabled, unmarked in the picker (ID-B29). The PM got the same result by API with no server warning.
- Outcome: **failed**. Restriction requires narrowing the built-in `authenticated` group, which nothing tells you.

**Task 4 — Partial admin rights (sub-admin).**
- Steps: 3 (found "Content Admin").
- Hurt: only "Admin Access" (everything) and "Content Admin" exist. Content Admin's scope is described three ways: "Apps, Prompts, Projects" (GroupFormEditor.jsx:254), "Apps, Prompts, and Sources" (shipped group), "Group access card for their own groups" (`docs/admin-ui.md:282`). The server also opens skills and usage guides to it (`contentAdminAuth` in `server/routes/admin/skills.js`). No identity-admin or read-only role; sub-roles were deferred in `concepts/admin-redesign-2026/` and never built.
- Outcome: **partial**.

**Task 5 — Register a machine OAuth client and get credentials.**
- Steps: 6.
- Hurt: Overview says "OAuth Clients: Disabled" with no button; the switch is on the Clients tab and saves immediately without confirmation. "New client" stays usable while clients are off; Create returns "Request failed with status code 400", dropping the server's "OAuth clients are not enabled on this server" ([AdminOAuthClientEditPage.jsx:175](../../client/src/features/admin/pages/AdminOAuthClientEditPage.jsx)). The form pre-selects All (*). `docs/oauth-integration-guide.md:41-78` says edit JSON (`"oauth": {"enabled": true}`, an outdated shape), restart, and use curl.
- Outcome: **failed** (hidden prerequisite; the panel may not toggle platform security).

**Task 6 — Why can't user X see app Y?**
- Steps: 9+ (user view → group IDs → each group → each parent → app's "Group access" card).
- Hurt: the card listed `admins`, `users`, `authenticated` for `ifinder-search`, yet the app was hidden, probably because the iFinder integration isn't installed (`GET /api/admin/integrations/installed/ifinder` → 404), which is invisible from the user side. The admin had to log in as the user and call `/api/apps`. No route computes effective permissions; docs search finds nothing.
- Outcome: **failed** in the UI.

## 4. What is broken

P0 = lockout or data loss in a normal flow · P1 = wrong security outcome or blocked core task · P2 = wrong/misleading with a workaround · P3 = polish.

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| ID-B1 | Confirmed (verifier, live) | If `/admin/auth` fails to load (429, network blip), the form keeps built-in defaults (`mode: 'proxy'`, `localAuth.enabled: false`, `anonymousAuth.enabled: true`), shows "All valid", and Save stays enabled. The server replaces every auth block wholesale, so one click turns off local sign-in and locks the admin out. (UX, TW, admin; lead re-read.) | [AdminAuthPage.jsx:40-80](../../client/src/features/admin/pages/AdminAuthPage.jsx) defaults, :117-122 catch only sets a message, :263 `disabled={saving}` only; [configs.js:357-364](../../server/routes/admin/configs.js). Verifier: GET of the platform config answered 429 in the browser → "Failed to load configuration: Too many requests", "All valid", **Proxy Mode** checked, Save enabled (`verify/v2.js`, `verify/b1.png`; Save not clicked). Screenshots `ux/auth.png`, `tw/shots/en__admin_auth.png`, `admin/shots/auth.png`. | **P0** |
| ID-B2 | Confirmed (code) | No last-admin or self guard on **edit**: you can remove `admins` from the last admin or disable your own account. Only DELETE checks `isLastAdmin`. Afterwards `ensureFirstUserIsAdmin` makes the **next local user to sign in** an admin. The platform save likewise lets you untick the method you're signed in with. (Admin, UX, TW.) | [auth.js:500-553](../../server/routes/admin/auth.js) PUT vs :647 DELETE; [adminRescue.js:238-275](../../server/utils/adminRescue.js) via `middleware/localAuth.js:129`; `PlatformFormEditor.jsx:68-117`. | **P1** |
| ID-B3 | Confirmed (lead, live) | **Saving any change to a disabled user re-enables them.** Stored users have `active` but no `enabled`; the editor sends `active: data.enabled !== false`, so `undefined` → `true`. Repro: created `zz-access-identity-lead-u`, disabled it by API, opened Edit (Enabled showed unchecked), changed only the email, saved → `GET` returned `active: true`. Deleted afterwards. | [AdminUserEditPage.jsx:282](../../client/src/features/admin/pages/AdminUserEditPage.jsx); `UserFormEditor.jsx:249-253`; `lead/check.js` `AFTER SAVE active= true`. | **P1** |
| ID-B4 | Confirmed (verifier, live) | Deleting a group that others **inherit from** is not blocked. `resolveGroupInheritance` then throws `Parent group not found`; the cache keeps the old groups, so the deleted group stays effective, later group saves silently don't apply, and after a restart groups fail to load. (PM.) | [groups.js:871-937](../../server/routes/admin/groups.js); [authorization.js:58-60](../../server/utils/authorization.js); [configCache.js:593-600](../../server/configCache.js). Verifier repro (`verify/b4.sh`, `b4.out`): created parent `…-vp` and child `…-vc` (inherits vp); `DELETE vp` → 204; the cache (`/api/admin/search`) still listed `vp`; then renamed another group and created a new one (both 200, both on disk) — the cache showed neither. Fixing the child's `inherits` restored the cache; all test groups deleted. The restart failure is from code, not run. | **P1** |
| ID-B5 | Confirmed (repro) | A group cannot restrict signed-in users, and the editor says it does: resource sections ignore inheritance and the implicit `authenticated` (`*`), showing "No apps selected - users won't see any apps"; with no parents, "this group only has its own permissions". (All five.) | [GroupFormEditor.jsx:383, 448-469](../../client/src/features/admin/components/GroupFormEditor.jsx) vs `GroupIntegrationsSection.jsx:114-156` (correct `inheritedGrants`, from `client/src/features/admin/utils/groupIntegrationAccess.js:127`); `server/defaults/config/groups.json`; admin's test user saw 16 apps with `inherits: []`. | **P1** |
| ID-B6 | Confirmed | New OAuth clients default to client credentials with **All (*)**, and the server turns an empty list into `['*']`. The hint says the lists filter "the user's existing permissions", but a client-credentials token has no user: the lists *are* the grant. An empty list means "nothing" for machine clients and "no restriction" for auth-code clients. (PM, UX, TW, admin.) | `AdminOAuthClientEditPage.jsx:38-44, 439-444`; [authorization.js:752-781](../../server/utils/authorization.js); `server/routes/admin/oauthClients.js` POST. | **P1** |
| ID-B7 | Confirmed (lead + verifier, live) | User and Group editor text inputs have **no border and no padding**: classes assume `@tailwindcss/forms`, which the Tailwind 4 build doesn't load (computed `border-top-width: 0px`, `padding-left: 0px`). Same class string in ~25 admin files. (UI.) | `UserFormEditor.jsx:188,220,240,366,394`; `GroupFormEditor.jsx:174,203`; `client/package.json:51`. | **P1** |
| ID-B8 | Confirmed (lead + verifier, live) | Dark mode only applies on pages that mount `useDarkMode` (DualModeEditor, DarkModeToggle). Cold-loading `/admin/users` or `/admin/groups` with a dark OS renders light; `/admin/auth` renders dark. No theme toggle in the admin sidebar. (UI.) | `client/src/hooks/useDarkMode.js:58-60`; `lead/check.js`. | P2 |
| ID-B9 | Confirmed | Dark mode: `/admin/auth` checkbox labels are near-invisible, including "Show Demo Accounts in Login Form" (no `dark:` variant). (UI.) | `LocalAuthSection.jsx:80,96`; `PlatformFormEditor.jsx:233-320,493`; `NtlmAuthSection.jsx:99,113`; `OidcProvidersSection.jsx:174,454,465`; `ui/crops/dark_auth.png`. | **P1** |
| ID-B10 | Confirmed | At 390 px the demo-accounts banner wraps one word per line (~800 px tall, links overlapping) at the top of every admin page. (UI.) | `AdminDemoAccountsAlert.jsx:126-129`; `ui/crops/m_users.png`. | P2 |
| ID-B11 | Confirmed (repro; verifier, live) | `/admin/auth` has no unsaved-changes guard: OIDC + LDAP provider input was lost on a sidebar click. Users and Groups have one, and `docs/admin-ui.md:513` promises it everywhere. (UX, admin.) | `AdminAuthPage.jsx:169` (`hasUnsavedChanges` used only for LDAP search); `ux/flow1.js`, `admin/t3.js`. | **P1** |
| ID-B12 | Confirmed (repro) | Deleting a group with members gives a bare "Are you sure…?" and leaves dangling `internalGroups` on users. (UX, admin.) | `AdminGroupsPage.jsx:126`; `users.json` after the test. | P2 |
| ID-B13 | Confirmed (lead + verifier, live) | New group: the ID input becomes `disabled` as soon as its value equals a protected ID; `users-sales` freezes at `users`. (UX.) | `GroupFormEditor.jsx:173,184`; `lead/check.js` `value: users disabled: true`. | P2 |
| ID-B14 | Confirmed (repro; verifier, live) | OAuth errors drop the server's `detail` ("Request failed with status code 400"), e.g. creating a client while clients are off. Same `error.message` pattern 9× on the clients page. (UX, admin.) Verifier: POST answered 400 with `detail` "OAuth clients are not enabled on this server"; the page showed "Failed to create OAuth client: Request failed with status code 400". | `AdminOAuthClientEditPage.jsx:175`; `AdminOAuthClientsPage.jsx:97,120,156,185,217,255,329,363,404`. | P2 |
| ID-B15 | Confirmed | A rotated secret (shown once) appears in `window.alert()` without Copy; redirect-URI validation also uses `alert()`. (UX, UI, TW, admin.) | `AdminOAuthClientsPage.jsx:356-358`; `AdminOAuthClientEditPage.jsx:223` vs the create modal :765-810. | P2 |
| ID-B16 | Confirmed (verifier, live) | A failed list load shows the raw error **and** "No users found – Create your first user to get started" (Groups likewise). (PM, UX, TW.) | `AdminUsersPage.jsx:183,553-559`; `AdminGroupsPage.jsx:116,254-256`. | P2 |
| ID-B17 | Confirmed (lead, code + data) | `lastActiveDate` is written only for external users, so local users always show "Never" and stale local accounts can't be found. `admin` signed in dozens of times today and has none. (PM.) | `server/utils/userManager.js:511,718`; `contents/config/users.json`. | P2 |
| ID-B18 | Confirmed (lead, data) | Edit User: Full Name empty (form reads `fullName`, users store `name`) and "No authentication method set" (stored users have no `authMethods`). (UX, UI.) | `UserFormEditor.jsx:238,298-319`. | P2 |
| ID-B19 | Confirmed | Auth validation only checks that `auth.mode` is set: "All valid" for OIDC mode with OIDC off, an OIDC provider without Client ID, or no usable method. (UX, TW, admin.) | `PlatformFormEditor.jsx:68-75`. | P2 |
| ID-B20 | Confirmed | Config without UI: `ldapAuth.allowSelfSignup` defaults to **true** with no toggle (any directory user becomes a persisted user); NTLM self-signup has no toggle; also OAuth client `scopes`, `oauth.personalKeys.scopes`, `oauth.dcr.maxClients`, `oauth.cimd.*` tunables, and any password policy (6 characters hard-coded). (PM.) | `platformConfigSchema.js:403`; `userManager.js:765-767`; `routes/admin/auth.js:368,541`. | P2 |
| ID-B21 | Confirmed | Accessibility: auth-method and "All (*)" labels aren't tied to their checkboxes (clicking text does nothing; unnamed for screen readers); the resource picker isn't keyboard-operable and matches English names only ("local-vllm" finds nothing). (UI, admin.) | `PlatformFormEditor.jsx:224-273`; `ResourceSelector.jsx:26-27,93-100,138-175`. | P2 |
| ID-B22 | Confirmed / Suspected | OIDC templates: Microsoft `/common` without tenant (single-tenant Entra apps reject it with AADSTS50194: **Suspected**, not reproduced) and a `${GOOGLE_CLIENT_ID}` placeholder; Keycloak/Auth0 `${…}` variables in URL fields. (PM, UI, admin.) | `OidcProvidersSection.jsx:39-66,252`. | P2 |
| ID-B23 | Confirmed | `docs/admin-ui.md:255` describes bulk user actions; the Users table has no selection. (PM, UX.) | `AdminUsersPage.jsx:546-560`. | P2 |
| ID-B24 | Confirmed | OAuth Overview swallows load errors and shows all cards "Disabled"; the Server tab reports "Failed to load OAuth clients" for a server-config error (shared i18n key). (TW, UI.) | `AdminOAuthPage.jsx:56-92`; `AdminOAuthServerPage.jsx:77`. | P2 |
| ID-B25 | Confirmed | Create forms show errors before typing, twice (top summary + bottom "Validation Summary"), with schema text like "username must be at least 1 characters". (UI, UX, admin.) | `UserFormEditor.jsx:154`; `GroupFormEditor.jsx:140`; `DualModeEditor.jsx:256-263`. | P3 |
| ID-B26 | Confirmed | Users filters: no LDAP/NTLM option; the bar overflows at 1440 px with the AI-acknowledgement filter on. (UX, TW, UI, PM.) | `AdminUsersPage.jsx:465-479`; `ui/crops/dark_users2.png`. | P3 |
| ID-B27 | Confirmed (lead, code) | Auth save always says "Authentication configuration saved successfully!" The server returns `reconfiguration.requiresRestart` (only NTLM needs a restart; OIDC reconfigures live, LDAP applies on next sign-in), but the client ignores it. | `configs.js:110-130,565-571`; `AdminAuthPage.jsx:140`. | P3 |
| ID-B28 | Confirmed | Wrong labels: "Anonymous Mode — No authentication required (default)" (shipped default is `local`, page default `proxy`); "Enable dual authentication" (six methods); "Microsoft/Azure AD" (now Entra ID); an NTLM "Enable Debug Logging" checkbox under a banner saying debug settings moved to Platform → Logging. (PM, TW.) | `PlatformFormEditor.jsx:180-181,592-611`; `AdminAuthPage.jsx:191-192`; `OidcProvidersSection.jsx:560`; `NtlmAuthSection.jsx:90-102`. | P3 |
| ID-B29 | Confirmed | Group and client pickers offer disabled apps/models without a marker. (Admin.) | `admin/t6.js`; `contents/apps/summarizer.json`. | P3 |
| ID-B30 | Confirmed | Polish: Overview "Admin account ready" is hard-coded done (`AdminOverview.jsx:82-118`); client form hard-codes "Maximum: 1440 minutes" (`AdminOAuthClientEditPage.jsx:407,413`); group/user create return `200` not `201` + `Location`; the OAuth nav entry and routes ignore `admin.pages` hiding (`AdminSidebarNavData.js:185` `visible: true`; `App.jsx:707-726` unconditional, while users/groups/auth are wrapped in `showAdminPage`); the user-edit group picker turns typed text into an "external group" on Enter; per-model limits table clipped at 390 px. | as cited; `ui/crops/m_ue.png`. | P3 |
| ID-B31 | Confirmed (verifier, curl + code) | User view calls `GET /api/admin/oauth/connections?userId=…`, which returns 400 ("OAuth clients are not enabled on this server") when OAuth is off; the catch sets an empty list, so nothing is shown. Harmless while OAuth is off; the defect is that a real failure is swallowed the same way and the console logs a 400 on every user view. (Admin.) | `AdminUserViewPage.jsx:50-68`; `admin/t10.js`; `verify/b31.out`. | P3 |

## 5. Findings by persona

### Product manager

- **ID-PM1 — No effective-access answer (weekly job).** The user view lists only `internalGroups` ([AdminUserViewPage.jsx:168-190](../../client/src/features/admin/pages/AdminUserViewPage.jsx)); no admin route computes effective permissions. The pieces exist: `getPermissionsForUser`, `enhanceUserWithPermissions`, and the sign-in group breakdown already stored for the audit drawer (`AuditEntryDetailDrawer.jsx:170`). Build an **Access** tab: resolved groups with source (manual / IdP mapping / implicit / inherited via X), effective apps, models, prompts, skills, integrations, and a "Check access to…" box listing every gate in order (user enabled → group grant path → app enabled → required model → required integration installed → feature flag). Server: `POST /api/admin/users/{id}/_explain-access`. Biggest support-ticket reducer in the part.
- **ID-PM2 — "Restrict a team" is impossible as admins expect** (ID-B5). Now: effective preview + wildcard warning. Then decide whether shipped `authenticated` stays `*` (§10). Always: document the recipe.
- **ID-PM3 — "Primary mode" is cosmetic but dominates the page.** `auth.mode` only orders the login form (`client/src/auth-gate/auth-gate.js:584`), labels the Overview, and picks one proxy log branch (`server/middleware/proxyAuth.js:295`). The checkboxes turn methods on.
- **ID-PM4 — Machine clients over-permissioned** (ID-B6). Start empty, require one app, end with a credentials sheet: ID, secret, token URL, ready `curl` (already in `docs/oauth-api-examples.md`), `.env` copy.
- **ID-PM5 — API-access policy is split three ways**: CIMD clients under OAuth → Clients, CIMD/DCR policy under Integrations → MCP gateway, personal keys under Authorization Server (so `docs/personal-api-keys.md:47-49` needs a two-page path).
- **ID-PM6 — Sub-admin is one hard-coded role** (`contentAdmin`, `AdminSidebar.jsx:257-275`); `admin.pages.*` hides pages globally, not per group. Replace the two booleans with an **Admin role** select per group; first new role: Read-only (auditors, works councils).
- **ID-PM7 — Settings in the wrong place.** Missing UI: ID-B20. Present but shouldn't be: `localAuth.usersFile` and JWT secret (`LocalAuthSection.jsx:37,63`) break sign-in if changed; "Download platform-config.json" exports *all* platform settings from an auth page (`AdminAuthPage.jsx:194-205`).
- **ID-PM8 — IdP group mapping is typed by hand**, although iHub already records raw IdP groups per sign-in with "Not mapped" flags (`docs/admin-ui.md:470-478`). Suggest unmapped groups seen at recent sign-ins in the field, and add an "Unmapped IdP groups" panel to the Groups list.
- **ID-PM9 — Fresh-install security stops at a banner.** `/setup`'s four steps are Welcome, Sign in, Connect an AI provider, Done (`SetupWizard.jsx:50`, :301-516); no security step. See W1.

### UX designer

- **ID-UX1 — Auth page: one risky form with no safety net** (ID-B1, B2, B11, B19). No form after a failed load (Retry only); refuse saves that leave the current admin no method; confirm when a change touches the caller's own method; reuse the `useAdminResourceEditor` blocker; sticky save bar ("3 unsaved changes · Discard · Save").
- **ID-UX2 — Mode vs methods is a false mental model.** The radio looks like a master switch but isn't; "Anonymous" appears as both a mode "(default)" and a method. One list of methods plus a "default on the login page" select (enabled methods only).
- **ID-UX3 — The group form hides additive permissions.** The fix exists on the same form: generalise `inheritedGrants` from `GroupIntegrationsSection` to every resource section as greyed chips ("All apps (*) · via users") and warn when a parent grants `*`.
- **ID-UX4 — Adding a user to a group takes 7 steps** through the user's edit page, and delete doesn't say who's affected (ID-B12). Members section with Add/Remove, member count, and a delete dialog that names affected users and offers reassignment.
- **ID-UX5 — No feedback after save.** User/group saves navigate back silently (`AdminGroupEditPage.jsx:138`, `AdminUserEditPage.jsx:347`); after creating a user you land on the list, though personal limits can only be set on an existing user. Stay on the record with a toast.
- **ID-UX6 — Errors throw away the server's `detail`.** `getAdminApiErrorMessage` exists and is used on the auth page; use it everywhere here (ID-B14, B16), and on 429 say "The server is busy; retrying in N s" and retry.
- **ID-UX7 — OAuth enablement is split and hidden**: two switches on two tabs, no hint which one a machine client needs. Show "OAuth clients are off. [Turn on]" on the client form *before* filling it; put each switch on its Overview card.
- **ID-UX8 — OIDC setup spans two pages and can't be tested.** Mapping 5 Entra groups means 5 group pages. Provider-side mapping table, absolute redirect URI with Copy, "Test sign-in" popup.
- **ID-UX9 — Cmd+K matches page labels only** (`AdminCommandPalette.jsx:10-40`): "OIDC", "LDAP", "password", "demo", "API key", "Entra" find nothing; the only create action is "New App" (:49). Add keywords and New user / New group / New OAuth client / Hide demo accounts actions.
- **ID-UX10 — Slugified group ID** derived from the name (editable behind a pencil) removes ID-B13 and typos.

### UI designer

- **ID-UI1 — Four page-header styles in one section**: white band + `text-3xl font-bold` (Users/Groups/Auth, `AdminUsersPage.jsx:389-392`); `text-2xl` no band (OAuth, `OAuthTabsHeader.jsx:63`); `AdminEditPageShell` (editors); back-arrow + breadcrumb outside the band (`AdminOAuthClientEditPage.jsx:286-306`). The tab bar is already shared (`AdminTabs.jsx`, used by both `ModelsTabsHeader` and `OAuthTabsHeader`); what differs is the header band and title, so extract an `AdminPageHeader` and use it in both tab headers and the list pages.
- **ID-UI2 — Shared form components.** Blue (`bg-blue-600`: Add User/Group/LDAP, OAuth) and indigo (`bg-indigo-600`: Save) primaries meet on one screen. Ship `AdminButton`/`AdminInput`/`AdminCheckbox` (roadmap 3B-3, `concepts/2026-05-28 Admin UI Phase 3 Roadmap.md`) and migrate this part first; fixes ID-B7, B9, B21.
- **ID-UI3 — Row actions differ per table.** Groups shift the pencil 32 px on protected rows (no delete); OAuth clients have five bordered icon buttons with `title` only (`AdminOAuthClientsPage.jsx:826-868`), where eye-slash means "Disable" but eye means "View" on Users. Use `DataTableRowActions` (View, Edit, overflow menu) and a disabled "Protected" delete.
- **ID-UI4 — Dangerous privileges look like settings.** "Admin Access" and "Content Admin" are plain checkboxes in Basic Information next to "Enabled" (`GroupFormEditor.jsx:232-260`). Move them to an amber "Administrative rights" card with confirm-on-enable.
- **ID-UI5 — Modals without dialog semantics**: OIDC template picker (`OidcProvidersSection.jsx:480`), created-secret modal (`AdminOAuthClientEditPage.jsx:765`), token modal (`AdminOAuthClientsPage.jsx:884`) are `div.fixed` without `role="dialog"` or focus trap; `shared/components/Modal.jsx` has both. One `SecretRevealDialog` (value, Copy, "I saved it") for create, rotate and token.
- **ID-UI6 — Two save models on one OAuth screen**: enable switches save immediately (`AdminOAuthServerPage.jsx:130-160`), settings need "Save Settings". Keep immediate save only for on/off, with a confirm and a toast.
- **ID-UI7 — Density**: Group edit ~3,700 px, User edit ~2,100 px; a fixed one-third description column wastes ~280 px at 1440. Tabs or an anchor rail plus a sticky Save/Cancel footer.
- **ID-UI8 — Inconsistent details**: three "Add provider" button styles on `/admin/auth` (`ui/crops/auth_a.png`, `auth_b.png`); the Users Status column shows a pill *and* a switch for the same state with hard-coded English (`AdminUsersPage.jsx:103-128`); Groups list shows raw app IDs and a bare "Apps:" for groups without apps.

### Technical writer

- **ID-TW1 — No page in this part links to docs.** `utils/docsLinks.js` is imported only by the Docs and Changelog pages. Add a shared `DocsHelpLink` to every card header (map in §9).
- **ID-TW2 — Copy misstates security** (ID-B5, B6); rewrites in §9.
- **ID-TW3 — German is half done.** 120 `t()` keys in scope exist in **neither** `en.json` nor `de.json` (all `admin.users.fields.*`, `admin.groups.edit.*`, `admin.auth.oauth.tabs.*`); ~80 more strings are hard-coded English (GroupFormEditor 20, PlatformFormEditor 19, OidcProvidersSection 12, LocalAuthSection 10, NtlmAuthSection 10, AdminUsersPage 9). German OAuth tabs read "Overview · Authorization Server · Clients · Verbindungen" (`tw/shots/de__*.txt`). Add keys, extract literals, add a CI check that every `t('admin.…')` key exists in en and de.
- **ID-TW4 — Terminology drift.**

  | Concept | Names in use | Pick |
  |---|---|---|
  | On/off | Enabled · Active/Inactive · Active/Suspended · Enable/Disable | Enabled / Disabled |
  | Non-expiring client token | Long-Term Token · static API key | API token |
  | Client-credentials client | OAuth client · service account · "Without dynamic" | Service client |
  | User grants | Connections · Connected applications · grants | Connections |
  | External groups | External Group Mappings · External Mappings · Groups Attribute · Groups Header | IdP groups |

- **ID-TW5 — Admin-rights copy.** "Content Admin" under-states its scope and is never named as the sub-admin option (docs search "sub-admin": 0 hits); "Admin Access — Allow members of this group to access administrative functions" (GroupFormEditor.jsx:236) doesn't say "all of them, including sign-in and users".
- **ID-TW6 — Developer-facing fields on `/admin/auth`**: "JWT Secret — Use environment variable ${JWT_SECRET}" conflicts with `docs/oidc-authentication.md:73-76` (RS256 by default, no secret needed); "Users File Path" is an implementation detail. Plus ID-B28.

### iHub admin

- **ID-ADMIN1 — "Everyone signed in" is invisible.** The lever for task 3 is the `authenticated` group, which looks like any other system group. Pin `authenticated` and `anonymous` at the top of Groups as **"Everyone signed in"** / **"Everyone (anonymous)"** with a "baseline for all users" badge.
- **ID-ADMIN2 — One Save for all of sign-in is the wrong granularity.** Toggling demo accounts puts the whole identity config at risk. Per-method Save and Test, plus a server-side refusal of configs that leave the caller no sign-in route.
- **ID-ADMIN3 — Templates don't reach a working Entra/Keycloak login.** Entra sends group **object IDs**, and with many groups an overage `_claim_names` pointer, which the server already detects (`middleware/oidcAuth.js:135`). Keycloak sends no `groups` claim without a mapper. The form and docs say none of this.
- **ID-ADMIN4 — Weak credentials hand-off.** After create, the token URL is on another tab; after rotate, `alert()`. One credentials sheet everywhere, with "Test token".
- **ID-ADMIN5 — The best page here is `GETTING_STARTED.md:105-110`** (exactly where to change passwords and turn off demo accounts). Link it from the banner; use it as the model for rewrites.
- **ID-ADMIN6 — The user editor's group picker accepts free text**; Enter (select everywhere else) adds a non-existent group. Allow only defined groups; external names belong in group mappings.

## 6. What should be rearranged

1. **Sidebar order and names.** The section is sorted alphabetically at runtime (`AdminSidebarNavData.js:393`): Authentication, Groups, OAuth, Users. Order by frequency instead: **Users → Groups & permissions → Sign-in methods → API access**. "Authentication" and "OAuth" are protocol words; Users last hides "change the admin password".
2. **Authentication → method cards.** One card per method: on/off, a status line ("2 providers · last successful sign-in 3 h ago" / "Needs setup"), Configure (inline or `/admin/auth/oidc` etc.). Below: one "Default on the login page" select. Removes the six mode cards (~1,000 px).
3. **"Sign-in security" card at the top of Authentication**: demo accounts, lockout, session timeout. The banner links to `/admin/auth#security`.
4. **Deployment settings out**: Users file path, JWT secret and "Download platform-config.json" to Platform → Advanced. The read-only JWT Signing Algorithm (affects all sign-in tokens) moves from the OAuth server tab to Authentication.
5. **Group editor order**: Name/ID/Enabled → **Inherits from** (it decides what the selectors mean) → **Access** (own + inherited) → Members → IdP group mappings → Administrative rights (warning card) → feature flags → Usage limits; tabs or anchor rail, sticky Save.
6. **User page: merge View into Edit as tabs** — Profile · **Access** · Usage & limits · Content (the existing `AdminUserPromptsTab`/`AdminUserSkillsTab`, today on the Prompts and Skills pages). Hide the password card for non-local users.
7. **OAuth → "API access", four tabs**: *Service clients* · *Apps acting for users* (auth-code, DCR and CIMD clients, with the DCR/CIMD policy moved in from MCP gateway, which keeps a link) · *Personal API keys* (out of Authorization Server) · *Server settings*. Overview cards merge into the tab header, each with its switch.
8. **IdP mappings in two places, one store**: keep them on the group and add a mapping table on each OIDC/LDAP provider card writing the same `mappings`.
9. **Groups list columns**: Group | Inherits | Grants ("2 apps · 1 model · admin") | Members | Mappings, plus search, with `authenticated`/`anonymous` pinned (ID-ADMIN1).

Renaming `/api/admin/auth/users` to `/api/admin/users` is a breaking API change; leave it for the next API revision, decided with the user (CLAUDE.md).

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Admin unions four groups in their head | **Access check / "View as user"** on users; add the existing **Group access** card (`ContentAccessSection.jsx`, already on app, prompt, skill and workflow editors) to model pages | Answers task 6 in one step; the server already computes it |
| Static "No apps selected" empty states | **Inherited chips + wildcard warning** (generalise `inheritedGrants`) | Pattern exists and is correct on the same form |
| Mode cards + method checkboxes | **Method cards** + one default select | One concept per decision; no invalid states |
| One Save for all auth blocks | **Per-method Save and Test** + server-side lockout refusal | Smaller blast radius; makes ID-B1 impossible |
| Four URL fields with `${…}` | **Issuer URL + discovery**, tenant field for Entra | Fewer fields, correct tenant |
| OIDC saved untested | **Test sign-in popup** showing claims and resulting groups, like `LdapLoginTest.jsx` | Catches redirect/tenant/claim errors; doubles as mapping discovery |
| Free-text IdP group chips | **Mapping table with suggestions** from recent sign-ins | Entra GUIDs can't be typed reliably |
| Membership edited only from the user | **Members drawer** from the list's member count | 10 people = 70 steps today |
| One client form with grant checkboxes | **Typed creation**: Service client / App that signs users in / MCP client | Different fields and permission semantics |
| `alert()` for secrets | **`SecretRevealDialog`** with Copy and a curl sample | Secrets shown once must be copyable |
| Two admin booleans | **Admin role select** | Scales to sub-roles without more checkboxes |
| Free group ID | **Slug from name**, editable | No protected-ID lock, fewer typos |
| Silent navigate-back | **Toast, stay on the record** | Confirms the save; allows follow-ups |
| Raw "status code 4xx" | **Server `detail`** + auto-retry on 429 | The server already sends good messages |

## 8. Wizards to add

**W1 — Secure this installation** (a checklist with inline actions, not a linear wizard; §10)
- Starts: demo-accounts banner, Overview "Getting started", and a new last step of `/setup` (`SetupWizard.jsx:50`). Who: every admin, day 1. Builds on what exists: the Overview checklist (`AdminOverview.jsx:82-120`) already has "Admin account ready" (hard-coded done) and "Connect identity provider (optional)"; extend it rather than adding a new surface.
- Steps: 1. Change the `admin` password (inline, Generate + Copy). 2. Demo `user`: disable, delete or set a password. 3. Hide demo accounts. 4. Anonymous access: keep or turn off. 5. Review lockout and session settings.
- End: server verifies a working sign-in method for the current admin; the Overview item turns green only when every shipped demo account (`admin`, `user`) is either deleted, disabled, or no longer uses its shipped password (replacing the hard-coded `done`, ID-B30). Replaces ~12 actions on 4 pages.

**W2 — Connect an identity provider (OIDC)**
- Starts: Authentication → "Add sign-in method → Single sign-on"; Overview "Connect identity provider". Who: admins connecting Entra ID, Keycloak, Okta, Google, ADFS or generic OIDC, once per company.
- Steps: 1. Choose the provider. 2. Enter only its variables (Entra tenant ID; Keycloak server + realm; or an issuer URL); discovery fills endpoints. 3. Show the **absolute** redirect URI with Copy, plus per-IdP instructions (Entra: enable the groups claim; Keycloak: add a groups mapper). 4. Client ID and secret (stored encrypted; env-var option explained). 5. **Test sign-in** popup showing received claims, highlighting `groups`, GUIDs and overage. 6. Map groups: each received value becomes a row → pick an iHub group; offer "map to admins". 7. Self-signup and default groups. 8. Enable, choose whether it's the default, keep local admin as fallback.
- End: validates a successful test sign-in, mappings that resolve to existing groups, local admin still enabled; creates the provider and writes group `mappings`; reports the server's real reconfiguration result (OIDC applies live, ID-B27). Replaces the template modal, `${…}` editing and the trip to each group page. Planned as "Connect SSO" (JTBD #5) in `concepts/admin-redesign-2026/`, not built.

**W3 — New group from intent**
- Starts: Groups → New group → "Start from a template". Who: admins onboarding a department or restricted team.
- Steps: 1. Name (ID derived). 2. Start from: Department (inherits `users`) / Restricted (no inheritance) / Content admins / Copy of X; warn when the parent grants `*`. 3. Apps, models, prompts with a live "members will see N apps" count. 4. Members: local users and/or IdP mappings. 5. Optional limits. 6. Review effective access for a sample member.
- End: creates the group, lands on it. For "Restricted" it explains that `authenticated` still grants `*` and links the documented fix; it does not change built-in groups itself. Planned as "Onboard Group" (JTBD #1), not built.

**W4 — Register a machine integration (service client)**
- Starts: API access → New client → "Who will call iHub?" (server/script → this wizard; app acting for users → auth-code form; a person → Personal API keys). Who: admins wiring CI jobs, n8n, other backends.
- Steps: 1. If clients are off: inline "Turn on OAuth clients" with confirm. 2. Name, description. 3. Apps, models, prompts — **nothing preselected**, at least one app required. Each resource type has an explicit "All" choice that writes `["*"]` and a "None" state that must stay none. Today the server turns an empty list into `["*"]` (`server/routes/admin/oauthClients.js:264-268`, ID-B6), so an untouched models or prompts list grants everything. The server must store and enforce an empty array as no access, and write `["*"]` only when the admin picked "All". The wizard sends `[]` for "None", never omits the field. 4. Token lifetime, bounded by the server maximum. 5. Credentials sheet: client ID, secret (once), token URL, ready `curl`, `.env` download, "Test token".
- End: validates a token can be issued with the selected grant. Replaces the single form for this case and the curl-first docs.

**Where a wizard would be wrong.** LDAP (presets + "Test a login" already work; add a bind-only "Test connection"). Editing an existing group or user (power users need the dense form, improved per §6). Authorization Server settings. The Users list. Proxy/JWT needs a **tester** ("paste a sample header/JWT → resolved user and groups"), not a wizard.

## 9. Documentation

**What exists and its quality**

| Admin task | Best doc today | Rating |
|---|---|---|
| Demo accounts off, change passwords | `GETTING_STARTED.md:105-110` (names the UI) | good, short |
| Methods / primary mode | `AUTHENTICATION_QUICK_START.md` (developer setup, 8 JSON blocks, Vite ports, middleware chain); `security.md:68-114` | JSON-only |
| Local auth, lockout, session | `platform.md:591-604` | JSON-only |
| OIDC with Entra / Keycloak | `oidc-authentication.md` (10 JSON blocks; Azure at :129-139 skips groups claim, GUIDs, overage and the tenant authorize URL; "Entra ID" appears only for the Microsoft Apps integration (:146) and the tenant logout URL (:459); Keycloak only for logout) | JSON-only |
| Map IdP groups | `oidc-authentication.md:246-290` (JSON, fictional names); LDAP quickstart better | JSON-only / partial |
| LDAP | `ldap-ntlm-authentication.md:144` documents "Test a login" | partial |
| NTLM, Proxy/JWT | `ntlm-technical-reference.md`, `jwt-authentication.md`, `external-authentication.md` (19 JSON blocks) | JSON-only |
| Create group, restrict apps | `admin-ui.md:267-284` (says "union", not that `authenticated` grants `*`) | partial |
| Sub-admin | `admin-ui.md:282`; `authentication-architecture.md` (developer "Analysis") | partial |
| Why can't X see Y | `troubleshooting.md:359-410` "Permission Denied (403)": jq commands only, and stale (`users.<name>.groups` instead of `internalGroups`, group `admin` instead of `admins`); nothing covers a hidden app | stale / JSON-only |
| Register machine client | `oauth-integration-guide.md:37-95` and `oauth-authorization-code.md:49-66` (both stale `"oauth": {"enabled": true}`, "restart", curl) | stale |
| App that signs users in (auth-code client) | `oauth-authorization-code.md`, `ihub-as-oidc-idp.md` (protocol walkthroughs; the UI is named once, `ihub-as-oidc-idp.md:582`) | JSON/curl-only |
| Rotate secret, long-term token | `oauth-integration-guide.md:594,734` (curl) | JSON-only |
| Personal API keys | `personal-api-keys.md` | good |
| Connections, CIMD approve/block | only `mcp-integration.md` (`oauth-authorization-code.md:560-572` names the `platform.oauth.cimd` keys) | missing |
| Usage limits | `usage-limits.md` | good |

Structural problems: `admin-ui.md` has **no Authentication or OAuth section**, though :5 promises everything can be done in the UI; it promises bulk user actions (:255, ID-B23) and unsaved-changes warnings on every edit page (:513, false for `/admin/auth`). The first "Authentication & Security" entry in `SUMMARY.md` is a developer analysis.

**Gaps a new admin cannot learn today:** how permissions combine; restricting a team; partial admin rights; connecting Entra or Keycloak through the form; registering a machine client through the UI; approving or blocking CIMD clients; debugging "user can't see app".

**Proposed pages** (UI-first, every step "Admin → … → field label"; add to `SUMMARY.md`):
1. **`access-control.md` — Who can use what: groups and permissions.** Union model with a diagram (anonymous → authenticated → users → admins); implicit `authenticated` and wildcards; recipe "Restrict a team to two apps"; inheritance pitfalls incl. deleting a parent (ID-B4); Admin Access vs Content Admin (exact pages, what's not possible yet); members and IdP mappings.
2. **`sign-in-setup.md` — Set up sign-in.** Securing a fresh install; method switches vs default method; what applies live vs needs a restart (only NTLM; ID-B27); self-signup and default groups per method; lockout-prevention checklist; a short section per method linking the deep doc.
3. **`oidc-entra-keycloak.md` — Sign in with Entra ID or Keycloak.** App registration with the redirect URI from the UI; the form field by field; tenant URL vs `/common`; groups claim (Entra object IDs, `groupMembershipClaims`, overage; Keycloak group mapper); mapping in the UI; testing; logout.
4. **`oauth-clients.md` — Connect another system (API access).** Enabling server and clients; service clients vs apps acting for users and their permission semantics; copy-once secrets, rotate, API tokens; Connections; CIMD approval. Move curl to `oauth-api-examples.md`; fix the stale config in `oauth-integration-guide.md`.
5. **`troubleshooting-access.md` — Why can't a user see an app?** Checklist: user enabled → groups resolved (manual, mapping, inherited, implicit) → app enabled → group grants app → model granted → integration installed → feature flag → OAuth client filter, with where each is visible in the UI.

**Updates:** add Authentication and OAuth sections to `admin-ui.md`; remove the bulk-actions claim (or build it); move `AUTHENTICATION_QUICK_START.md` to developer docs and point the quick-start slot at `sign-in-setup.md`; add glossary entries (ID-TW4); link `GETTING_STARTED.md#default-access` from the banner. Note for maintainers (not edited): CLAUDE.md's "platform/auth changes need a server restart" is no longer accurate for OIDC, LDAP and local.

**Contextual help links**

| Page / field | Link to |
|---|---|
| Authentication header, each method card | `sign-in-setup.md#<method>`; OIDC → `oidc-entra-keycloak.md` |
| OIDC "Groups Attribute"; group "IdP group mappings" | `oidc-entra-keycloak.md#groups-claim` |
| Group editor: Inherits from, Access, Administrative rights | `access-control.md#inheritance`, `#wildcards`, `#admin-roles` |
| User page Access tab | `troubleshooting-access.md` |
| API access tabs; client permission box | `oauth-clients.md#service-clients` / `#apps-acting-for-users` |
| Demo-accounts banner | `GETTING_STARTED.md#default-access` and W1 |

**Help text to rewrite (current → proposed)**
- Group empty state: "No apps selected - users won't see any apps" → "No apps from this group. Members still get the apps of their other groups and of every group this one inherits from." If an ancestor grants `*`: "This group inherits **All apps** from `users`; selecting apps here can't narrow that. [How to restrict a team]"
- No parents: "No parent groups - this group only has its own permissions" → "No parent groups. Members also get everything granted to *Everyone signed in* (`authenticated`)."
- OAuth client box (client credentials): "…'All (*)' is selected, meaning this OAuth client can access all resources the user has permission for … acting as a filter on top of the user's existing permissions" → "This client acts as itself, not as a user. It can use exactly the apps, models and prompts selected here. 'All' includes items added later." Keep today's text for authorization code.
- Primary mode: "Select the primary authentication mode for default behavior and routing" → "Default sign-in method: what the login page shows first (OIDC can redirect straight to the provider). The method must also be switched on."
- Subtitle: "Enable dual authentication for maximum flexibility" → "Choose how people sign in. You can switch on several methods at once."
- Admin Access: "Allow members of this group to access administrative functions" → "Full administrator. Members can change everything, including sign-in settings, users and these permissions."
- Content Admin: "Content Admin (Apps, Prompts, Projects)" → "Content editor: manage apps, prompts, skills and projects, and grant them to their own groups. No access to users, groups, models or settings."
- Show Demo Accounts: "Display demo account credentials on the login form for development/testing" → "Show demo sign-in buttons on the login page. Turn this off before anyone else can reach iHub: the buttons reveal the shipped admin password."
- Auth load error: "Failed to load configuration: …" (above a live form) → "Couldn't load the sign-in settings. Nothing is shown, so outdated values can't be saved. [Try again]"
- Auth save: "Authentication configuration saved successfully!" → "Sign-in settings saved." plus, when the server reports `requiresRestart`: "Restart the server for NTLM changes to take effect."

## 10. Where the panel disagreed

- **Severity of ID-B1.** UX and admin: P0; TW: P1. **Resolved: P0** — ordinary trigger (any failed load), one click on an enabled Save, lockout that needs file access to undo.
- **Restart message.** TW wanted "restart required" after every auth save, following CLAUDE.md. **Resolved by code:** OIDC reconfigures live, LDAP applies on next sign-in, only NTLM needs a restart, and the server already returns `reconfiguration.requiresRestart` (`configs.js:110-130`). Show the server's answer, not a blanket warning (ID-B27).
- **Change the default or document it?** PM: ship a narrower `authenticated` group (behaviour change + migration). TW and admin: document the recipe and make `authenticated` visible. **Resolved:** visibility and docs now (ID-ADMIN1, W3, `access-control.md`). Changing shipped defaults breaks existing installs; per CLAUDE.md it goes to the user as a decision.
- **One Save with a review diff, or per-method saves?** UX: review diff on one form. Admin: per-method Save and Test. **Resolved:** per-method cards (smaller blast radius); the server-side lockout refusal is required either way, with a short confirm only when a change touches the caller's own method.
- **Lock-down: wizard or checklist?** UX: five-step linear wizard; PM: a `/setup` step; admin and UI: a checklist card. **Resolved:** checklist with inline actions, launched from the banner, the Overview and the last `/setup` step (W1); the items are independent and admins come back to finish them.
- **How far to take sub-admin.** PM: role select with Read-only first. UX: rename to "Admin role" with today's values only. Admin: consistent naming now, sub-roles as the planned Phase 3. **Resolved:** ship the select now with None / Content / Full and consistent descriptions (cheap; fixes the copy); Read-only is the first new role (clearest enterprise demand, lowest risk).
- **Visual-bug severity.** UI rated the dark-mode cold load (ID-B8) and the 390 px banner (ID-B10) P1. **Resolved: P2** — nothing lost, workarounds exist. Invisible dark labels on `/admin/auth` (ID-B9) and borderless inputs (ID-B7) stay P1: they hide controls in a security task.
- **Facts settled by the lead.** "No authentication method set" (UI: Suspected) is Confirmed — stored users have no `authMethods`. Sidebar order is alphabetical at runtime (`AdminSidebarNavData.js:393`), not source order. PM said "(default)" contradicts the schema default `local`, TW said the page default `proxy`: both true, the label is wrong either way.

## 11. Top recommendations

| # | Recommendation | Why | Impact H/M/L | Effort S/M/L | Type |
|---|---|---|---|---|---|
| 1 | **Close the lockout and re-enable holes**: no form/Save after a failed auth load (ID-B1); server refuses auth configs leaving the caller no sign-in route; last-admin/self guard on user PUT (ID-B2); fix `active` on user save (ID-B3); block deleting inherited-from groups (ID-B4); unsaved-changes blocker on `/admin/auth` (ID-B11). Reuse what exists: `AdminLoadError` (already on the user/group editors and user view) for the failed load, the `useAdminResourceEditor` blocker for the guard | One click can lock out an install; an offboarded user can silently regain access | H | S | fix |
| 2 | **Tell the truth about permissions**: inherited chips + wildcard warning in every group resource section (generalise `inheritedGrants`), rewritten empty states, `authenticated`/`anonymous` pinned as "Everyone signed in / anonymous" | Task 3 fails and the form says it worked | H | S–M | UX |
| 3 | **Least-privilege service clients**: nothing preselected for client credentials, per-grant copy, inline "clients are off → Turn on", server `detail` in errors, one `SecretRevealDialog` for create/rotate/token | A default machine credential can use every app and model | H | S | fix |
| 4 | **Access tab + "Check access to…"** on users, backed by `POST /api/admin/users/{id}/_explain-access`, listing every gate (groups, enabled flags, model, integration, feature flag) | The weekly "why can't X see Y" job has no answer (task 6 failed) | H | M | UX |
| 5 | **Shared form components here first** (`AdminInput`/`AdminCheckbox`/`AdminButton`, roadmap 3B-3) on User, Group and Auth forms; apply the theme at the admin root | One pass fixes borderless inputs, invisible dark labels, unlinked labels, blue/indigo split, dark cold load (ID-B7, B8, B9, B21) | H | M | UI |
| 6 | **Authentication as sign-in method cards**: per-method Save and Test, "default on login page" select, Sign-in security card on top, deployment fields moved out | Removes the mode/method confusion and shrinks each save's blast radius | H | M–L | IA |
| 7 | **Connect identity provider wizard (W2)**: tenant/issuer discovery, absolute redirect URI, test sign-in with claims, mapping table writing `mappings` | SSO is the most error-prone one-time task; LDAP already proves the test pattern | H | L | wizard |
| 8 | **Five UI-first docs** (`access-control`, `sign-in-setup`, `oidc-entra-keycloak`, `oauth-clients`, `troubleshooting-access`); Auth/OAuth sections in `admin-ui.md`; remove the false bulk-actions claim; `DocsHelpLink` on every card | An admin who doesn't know how can today only learn JSON | H | M | docs |
| 9 | **Members on groups** (list, add/remove, count column, delete dialog naming affected users) and a slugified group ID | 7 steps per user; deletes leave dangling IDs (ID-B12, B13) | M | M | UX |
| 10 | **Secure this installation checklist (W1)** + self-service password change + `lastActiveDate` for local users (ID-B17) + LDAP self-signup toggle (ID-B20) | Day-1 hardening is spread over 4 pages; stale local accounts can't be found | M | S–M | wizard |

Next after the top 10: API access consolidation (§6.7), the Admin role select (§10), the i18n sweep with a CI key check (ID-TW3), Cmd+K keywords and create actions (ID-UX9).

## Appendix — verification log

No row of section 4 was refuted. Corrections and narrowed claims elsewhere in the report:

- §9 "Why can't X see Y — none": **Refuted.** `docs/troubleshooting.md:359-410` has a "Permission Denied (403)" section; it is jq-only and stale, so the gap stands but the rating is now "stale / JSON-only".
- §9 "search 'Entra ID' finds no OIDC page": **Refuted.** `oidc-authentication.md:146` and :459 mention Entra ID (Microsoft Apps integration, tenant logout URL); the real gap (groups claim, GUIDs, overage, tenant authorize URL) stands.
- §7 "'Who can use this?' on app and model pages": **Already exists for apps.** `ContentAccessSection.jsx` ("Group access") is on the app, prompt, skill and workflow editors (`docs/admin-ui.md:281`); narrowed to model pages.
- ID-PM9 "`/setup`'s four steps are about LLM providers": **Partly wrong.** The steps are Welcome, Sign in, Connect an AI provider, Done; the conclusion (no security step) stands.
- ID-UI1 "extract `AdminTabsHeader` from `ModelsTabsHeader`": **Already done for the tab bar.** `AdminTabs.jsx` is shared by `ModelsTabsHeader` and `OAuthTabsHeader`; narrowed to a shared page header.
- §9 machine-client docs: `oauth-authorization-code.md:49-66` has the same stale `"oauth": {"enabled": true}` + restart text as `oauth-integration-guide.md` (added). `ihub-as-oidc-idp.md` was missing from the doc table (added).
- Wrong `path:line` fixed: ID-B1 (:117-122, :263), ID-B14 (9 call sites, :404 added), ID-B28 (`AdminAuthPage.jsx:191-192`, `OidcProvidersSection.jsx:560`), ID-B30 (`AdminSidebarNavData.js:185`, `App.jsx:707-726`), ID-B31 (`AdminUserViewPage.jsx:50-68`), ID-B5 (`inheritedGrants` lives in `utils/groupIntegrationAccess.js:127`).
- Status changes: ID-B4 code-only → Confirmed live; ID-B31 Suspected → Confirmed (harmless while OAuth is off). ID-B22 stays partly Suspected (`/common` rejection by single-tenant Entra apps not reproducible here).

### Adversarial verification

Scripts and output in `scratchpad/access-identity/verify/`.

- **Live, browser** (`v1.js`, `v2.js`, output `v1.out`, `v2.out`): ID-B1 (platform-config GET answered 429 by route interception; non-GET requests were blocked so nothing could be saved), ID-B7 (email input `border-top-width: 0px`, `padding-left: 0px`), ID-B8 (cold load with a dark OS: no `dark` class on `/admin/users` and `/admin/groups`, `dark` on `/admin/auth`), ID-B11 (changed a number field on `/admin/auth`, clicked Users in the sidebar: navigated, no dialog), ID-B13 (typed `users-sales`: value `users`, input disabled), ID-B14 (create while clients are off), ID-B16 (users list GET answered 500: error and "No users found / Create your first user" both shown).
- **Live, API** (`b4.sh`, `b4.out`, `b31.out`): ID-B4 (orphaned inheritance freezes the group cache; group create also answered 200, not 201, confirming part of ID-B30), ID-B31.
- **Code re-read** for every other row: ID-B2 (`auth.js:500-560` PUT has no `isLastAdmin`; DELETE checks it at :647), ID-B3 (`AdminUserEditPage.jsx:237-282`: loaded user has no `enabled`, save sends `active: data.enabled !== false`), ID-B5 (shipped `authenticated` grants `apps`/`models` `*`; empty-state strings at `GroupFormEditor.jsx:383,449-489`), ID-B6 (`AdminOAuthClientEditPage.jsx:38-40` defaults `['*']`, `oauthClients.js:264-268` empty → `['*']`), ID-B9/B10/B12/B15/B17-B21/B23-B30 at the cited lines; ID-B10 also from `ui/crops/m_users.png`.
- **Already implemented?** Searched `client/src` and `server/routes` for `SecretRevealDialog`, `AdminInput`/`AdminButton`/`AdminCheckbox`, an explain-access or effective-permissions route, a group members view, slugified group IDs, a self-service password route, OIDC/group/service-client wizards (only `SetupWizard` and `AppCreationWizard` exist), a server-side auth lockout check, and `docs/releases/next/` entries for this area: none found, so recommendations 1-10 and W1-W4 stand (with the narrowing above).
- **Docs** (§9): grepped `docs/` for Entra ID, sub-admin (0 hits), CIMD, Connections, bulk operations (`admin-ui.md:255` confirmed), unsaved changes (`admin-ui.md:513` confirmed), troubleshooting, and the stale `oauth` block.
- **Cleanup**: deleted leftover group `zz-access-identity-limited` (no members, no children); all verifier groups `zz-access-identity-v*` deleted; no `zz-` users or OAuth clients remain.

