# Integrations: Integrations hub, Integration builder, MCP gateway, Credentials, client add-ins — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/integrations` (tabs Installed, Catalog, Requests, Inbound, plus the install dialog), `/admin/integrations/:instanceId` (Overview, Settings, Releases), `/admin/integrations/builder/:instanceId` ("Add manually", including `builder/new`), `/admin/mcp/gateway`, `/admin/credentials`, `/admin/office-integration`, `/admin/browser-extension`, `/admin/copilot-agent`, `/admin/nextcloud-embed` (`client/src/App.jsx:734-773`).

All five panel notes were delivered and used. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min, `contents/config/platform.json` `rateLimit.adminApi`) often answered 429. Many screenshots therefore show pages after a failed load. That is an environment limit, but how each page *behaves* after a failed load is a finding: an admin behind a shared NAT or proxy hits the same thing. Screenshot names below refer to the panel's scratch folders (`integrations/{pm,ux,ui,tw,admin}/shots/`), which are deleted after the review.

Cleanup: the admin created and deleted all `zz-integrations-*` credentials, installations and the builder definition (the builder definition needed a manual folder delete, see IN-B17). One declined request record (`ireq_cb224f…`, note "zz test cleanup") remains, because no UI or API can delete a request. The lead created no entities; the lead's checks (curl against the live API, code reads) are listed in the appendix.

## Summary

This part turns iHub from a chat UI into a hub that reaches company systems. It holds three products under one sidebar section: **outbound integrations** (a catalog of 56 definitions, an install dialog, a builder for OpenAPI/HTTP/script/MCP/A2A), **inbound channels** (Outlook add-in, browser extension, M365 Copilot agent, Nextcloud embed, the MCP gateway) and **secrets** (the credential store).

It is **moderately intuitive at best**: most pages score 2–3. The admin finished two of six tasks cleanly, three partly, and failed one (restricting an MCP server to one group). The biggest problems:

- **The first click on the flagship integrations fails.** Brave/Staan/Qwant propose the wrong ID and then fail with "installed once, as brave" (IN-B2). Jira's only sign-in mode is shown as a disabled "(later release)" (IN-B5). Field errors never reach the field (IN-B4). All four are small client/server contract mismatches, confirmed live.
- **Pages stay editable after a failed load.** The MCP gateway can then save over the whole `mcpServer`/`oauth` blocks (IN-B1); the client pages offer Enable and Save with unknown state (IN-B6).
- **Credentials are blind.** No "used by", deletion of an in-use credential goes through silently (IN-B3), and there is no doc.
- **Access cannot be set on the integration.** Eight shipped groups grant `integrations: ["*"]`, so giving one MCP server to one group means editing about seven groups (IN-PM1).
- **The same things appear in two or three places** (client cards on Installed and Inbound; the MCP gateway in Inbound and the sidebar; two ways to add an MCP server), and "MCP gateway" in the sidebar lures admins who want to *connect* an MCP server.

Wins to build on: the install dialog's numbered sections and in-dialog Test, the test diagnostics (iFinder and DNS failures say exactly what to fix), the installation page, the Requests flow, the Copilot page's numbered steps and live prerequisite check, and the Outlook rollout doc.

## 1. What this part does

- **Integrations hub** (`/admin/integrations`). Four tabs. *Installed* groups installations by type (People directories, Web search, MCP servers, Built-in) and, oddly, starts with a "Clients" section of four inbound cards. *Catalog* lists 56 definitions (shipped plus Marketplace; 40 are MCP servers) with search and an **Install** button per tile. *Requests* holds users' requests for integrations (approve opens the install dialog, decline takes a note). *Inbound* repeats the four client cards and adds the MCP gateway. Header buttons: Reload catalog, Add manually, Install (which only switches to the Catalog tab). Used at setup, then weekly for requests.
- **Install dialog** (from a Catalog tile or a request). Five numbered sections: 1 · Name, 2 · Settings, 3 · Sign-in, 4 · Who may use it (read-only), 5 · Actions, with a sticky footer holding Test connection and Install. Secrets are either typed inline (MCP server, service-account mode) or picked from the credential store (Brave, Staan, Jira).
- **Installation page** (`/admin/integrations/:id`). Overview (configuration facts, approval policy, actions, apps that use it, migration log), Settings (a type-specific editor), Releases. Header: Test in chat, Test connection, Disable, Remove. The strongest page in the part. Used when something breaks.
- **Builder** (`/admin/integrations/builder/new`, "Add manually"). Five steps drawn as tabs: Basics → Sign-in → Source → Actions → Review (`builderModel.js:21`). Sources: OpenAPI, HTTP, script, MCP, A2A. Has an unsaved-changes guard. Used rarely, by power admins.
- **MCP gateway** (`/admin/mcp/gateway`). *Inbound*: exposes iHub's apps, tools and workflows to external MCP clients (Claude, Cursor, Copilot). It also holds platform-wide OAuth switches (authorization server, DCR, CIMD hosts and approval mode). Used once at setup.
- **Credentials** (`/admin/credentials`). A flat list of encrypted secrets (secret, bearer, basic, API key header/query, OAuth2) that integrations, auth providers and tools reference by ID. Create, edit, delete. Also lists the auto-generated `integration-<id>-<field>` secrets. Used at setup and at rotation time.
- **Client add-in pages** (Outlook `/admin/office-integration`, browser extension, Copilot agent, Nextcloud embed). Each has an Enable button that creates an OAuth client, display text, starter prompts and a deliverable (manifest, CRX/ZIP, Teams package, embed URL) that appears only after Enable. 1,599 / 810 / 716 / 574 lines respectively. Used once per rollout.

## 2. Is it intuitive? — verdict

Panel median, persona range in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| Integrations → Installed | 3 (3–4) | Type grouping and key facts per tile ("API key: set", version) are useful; the admin rated it 4 for that. But four "Available" client cards push installations below the fold, every tile repeats an 8-group list because `*` is expanded, and "Enabled" shows even when the tile says "API key not set". |
| Integrations → Catalog | 3 (2–3) | Search and groups work. 56 tiles in one ~8,700 px scroll, each with a primary blue Install; iFinder and Jira sit at the bottom under "Built-in"; the generic "MCP server" tile is #20 of 40; searching "outlook" finds nothing. |
| Install dialog | 3 (2–4) | The numbered sections and in-dialog Test are the best wizard-like UI here (UI: 4). Undermined by IN-B2, B4, B5, B9, sign-in fields that appear above the sign-in choice, a read-only "Who may use it", and Esc discarding input. |
| Requests | 4 (3–4) | Clear statuses and decline dialogs. Approve commits too early (IN-B15). |
| Inbound | 2 (2–3) | Four of five cards duplicate Installed; "Available" means "off". |
| Installation page | 4 (3–4) | Test with "What to check", apps that use it, Test in chat. Overview leads with approval policy and a migration log; header has five buttons with Remove the most salient; two "Test connection" buttons with different meanings. |
| Builder | 3 (2–3.5) | Per-step validation and an unsaved guard (UX), but drawn as tabs with "Create integration" primary on every step (UI), Sign-in before Source, credential creation only in a new tab, and it creates an enabled integration with 0 actions (admin: 2). |
| MCP gateway | 2 (2) | Inbound page sitting among outbound items; protocol jargon (RFC 7591, CIMD, Mcp-Session-Id); borderless inputs; platform OAuth policy mixed in; editable after a failed load. |
| Credentials | 2 (2) | Bare list: no used-by, no last-changed, no test; subtitle "…via credentialRef"; icon-only unnamed buttons; inaccessible modal; `window.confirm` delete; English-only in German. |
| Outlook add-in | 3 (2–4) | Complete, and its deployment steps are good. But the title says "Office Integration", the Description field is mislabelled, the deliverable is hidden until Enable, and the deployment steps are at the very bottom of a 1,600-line page. |
| Browser extension | 2 (2–3) | The required production step is labelled "Set up packaged downloads (optional)"; contradictory group copy; force-install recipe in the docs is wrong; page untranslated (68 keys). |
| Copilot agent | 3 (2–4) | Numbered steps and a live prerequisite check (PM, TW: 4, "the model to copy"). Enable silently switches on the OAuth server and the MCP gateway platform-wide. |
| Nextcloud embed | 3 (2–3) | Short and clear; its hard dependency (Nextcloud storage integration) is text only, and it points admins to a repo README. |

**Verdict.** The UI is organised around the four records of the data model (definition, installation, app binding, group grant; `docs/integrations.md:7-16`). Admins think in one sentence: "connect X and let team Y use it in app Z". Today that sentence crosses three or four pages (Credentials, Catalog dialog, Groups, App editor), and nothing after Install points to the next step. The install dialog and installation page are genuinely good, and the test diagnostics are the best in the admin. What drags the part down is (a) first-contact bugs on exactly the integrations a new admin tries first, (b) pages that pretend to know their state after a failed load, (c) a credential store with no idea who uses what, and (d) three visual generations and two or three paths to the same page.

## 3. Task walkthroughs

The admin walked all six tasks end to end; UX and PM repeated tasks 1, 2 and 5 up to Test and cancelled. Step counts are the admin's.

**T1 — Add Brave web search with an API key and use it in an app.**
- Steps: 14 on 3 pages. Credentials → Add → 4 fields → Save → Integrations → Catalog → search → Install → change the ID → pick the credential → Test → Install → App editor → Web search.
- Hurt: the order only works if the admin creates the credential first, which nobody guesses; the dialog's "+ Create new credential" opens `/admin/credentials` in a new tab and needs a manual refresh (`OpenApiToolEditor.jsx:143`). The proposed ID `brave-search` fails with `"com.intrafind/brave-search" is installed once, as "brave"`, which reads as "already installed" (IN-B2). A bad key gives "Brave search failed with status 422 · What to check: Check the server log". The dialog shows "Granted to: … anonymous …", so a paid key is usable by anonymous visitors, with no opt-out (IN-ADMIN10). Install ends on a flash message; nothing says "now use it in an app" (IN-PM9).
- Outcome: **partial** (installed; test fails on the dummy key, which is the environment; the app picked it up via "Auto").

**T2 — Connect an MCP server by URL with a bearer token, test it, limit it to one group.**
- Steps: 22+. Sidebar "MCP gateway" first (wrong page, it is inbound), then back; builder 5 steps; credential in a second tab; then the Groups rework.
- Hurt: the builder asks for Sign-in before Source. "List the server's tools" is optional, so the admin created an *enabled* integration with 0 actions granted to every signed-in user (`admin/shots/t2-b-created.png`). "Who may use it" is read-only. To restrict: untick "All integrations" on `authenticated` and `users` (and five other groups that also hold `*`), re-tick every other integration, then grant the new one to the target group. Restricting individual tools to a group does not exist.
- Outcome: connect and test **partial**; group restriction **failed**.

**T3 — Add iFinder and Jira and test the connection.**
- Steps: iFinder 5, Jira 6.
- Hurt: iFinder's test is excellent ("Pick or create the private key credential … or sign with the OIDC key pair", effective config shown). Jira: only "Invalid install values" with no field named (IN-B4); the client secret is asked twice (IN-B9); the only sign-in mode is a disabled "(later release)" radio (IN-B5); a made-up client ID passes the test green (IN-B16). The iFinder tile says "Sign-in: none" while section 2 configures per-user JWT/OIDC token exchange.
- Outcome: **partial**.

**T4 — Handle a pending user request.**
- Steps: 4.
- Hurt: Approve marks the request `approved` before the install; cancelling the dialog leaves the user told "approved". The Requests badge shows 0 while the panel says "Open requests (1)". Users can request admin building blocks ("MCP server", "A2A agent", "LDAP browser") and installed-but-disabled integrations (`GET /api/integrations/requests` as `user`).
- Outcome: **success**, with a trap.

**T5 — Roll out the Outlook add-in / browser extension: what to download, what to send IT.**
- Steps: Outlook 3 + Enable; extension 4 + Enable + signing key. Not enabled on the shared instance.
- Hurt: the manifest URL, download and deployment steps render only after Enable (`AdminOfficeIntegrationPage.jsx:748,1552`), and Enable creates an OAuth client. On the extension, the required signing-key step is labelled "(optional)" (`AdminBrowserExtensionPage.jsx:420`), and the docs say Enable creates the key when it does not (IN-B13). The force-install policy in the docs cannot work (IN-B14). There is no "IT handoff" anywhere; the admin assembles it from the docs.
- Outcome: **partial**.

**T6 — Rotate a credential used by two integrations.**
- Steps: 3 (edit, paste, save).
- Hurt: rotation itself works for Brave (secret resolved per call). But the admin cannot see that two integrations share the key, there is no "test everything that uses it", and deleting an in-use credential is allowed; afterwards the installation Overview still says "API key: set" until a manual test (IN-B3). For MCP connections the new token probably does not reach an open connection (IN-B25).
- Outcome: **success**, blind.

## 4. What is broken

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| IN-B1 | Confirmed (reproduced) | **MCP gateway is fully editable and saveable after its config fails to load.** `platform` stays `null`, toggles show defaults, Save is enabled (only `disabled={saving}`, :589). Each toggle spreads `prev` (null) so the state holds only the touched block; Save POSTs it, and the server replaces `oauth` and `mcpServer` wholesale. Verifier repro (GET answered 500, POST intercepted and aborted): one click on the first switch + Save sent exactly `{"mcpServer":{"enabled":true}}`, which would drop `expose`, `transports` and `publicUrl`; touching an OAuth switch instead drops the rest of `oauth` (DCR, CIMD hosts, approval mode). Nothing reached the server. (UI, UX, TW) | [AdminMcpGatewayPage.jsx:44-58, 80-133, 143-150](../../client/src/features/admin/pages/AdminMcpGatewayPage.jsx); [configs.js:365, 370](../../server/routes/admin/configs.js); `ui/shots/mcpgw-light.png`, `verify/b1-gateway-failed-load.png` | P1 |
| IN-B2 | Confirmed (live) | **Install-once definitions propose the wrong ID.** Catalog and detail views never send `singleton`, so the dialog proposes `brave-search` (editable) instead of locking `brave`; Test/Install fail with SINGLETON_ID "installed once, as brave", which reads like "already installed". Affects Brave, Qwant, Staan, Jira, iFinder, iAssistant, Entra, Website corpus. Docs promise "Brave Search installs as `brave`" (`web-tools.md:425`). (UX, admin) | [integrations.js:146-193](../../server/routes/admin/integrations.js) (no `singleton`); [IntegrationInstallForm.jsx:218, 435](../../client/src/features/admin/components/integrations/IntegrationInstallForm.jsx); lead: `GET …/catalog/com.intrafind%2Fbrave-search` has no `singleton` key | P1 |
| IN-B3 | Confirmed | **A credential in use can be deleted without warning.** The server never checks references; the client uses `window.confirm` "cannot be undone". Afterwards the installation Overview still says "API key: set" until a manual Test shows `Credential "…" has no value or does not exist`. Integration-owned `integration-<id>-<field>` secrets are listed and deletable too. (all five) | [credentials.js:248-273](../../server/routes/admin/credentials.js); [AdminCredentialsPage.jsx:428](../../client/src/features/admin/pages/AdminCredentialsPage.jsx); `InstalledIntegrationService.js:107`; `admin/shots/t6-dangling-test.png` | P1 |
| IN-B4 | Confirmed (live) | **Install/test field errors never reach the fields.** The client reads `data.details.issues[].key`; the problem+json serializer moves issues to top-level `errors[]` with `pointer`. The admin sees only "Invalid install values", and the server messages are untranslated fragments ("required"). (TW, admin) | [IntegrationInstallForm.jsx:66-70, 309-318](../../client/src/features/admin/components/integrations/IntegrationInstallForm.jsx); [errorResponse.js:210-222](../../server/utils/errorResponse.js); lead: `POST …/catalog/com.intrafind%2Fifinder/_test` → `errors:[{pointer:"/values/baseUrl",message:"required"},…]` | P1 |
| IN-B5 | Confirmed (live) | **Jira's only sign-in mode is a disabled "Each user signs in (OAuth) (later release)" radio**; the same for the native storage providers (Google Drive, Office 365, Nextcloud). The native adapter declares no modes, so the route falls back to `['none','service-account']`. An admin reads "Jira does not work yet". (UX, admin) | [integrations.js:181-184](../../server/routes/admin/integrations.js); `IntegrationInstallForm.jsx:542-562`; lead: Jira `authModes ['oauth-user']`, `supportedAuthModes ['none','service-account']` | P1 |
| IN-B6 | Confirmed (reproduced) | **Client pages show an active Enable and an editable form after a failed status load** (Office, browser extension, Copilot, Nextcloud; all four render the form once `loading` is false, whatever the load result). On Office, Save PUTs empty starter prompts, start page and description; the server rejects it only while Display name is blank (`requireNonEmpty`), so typing a name then saving overwrites the shipped prompts. Verifier repro (GET answered 500, PUT intercepted): Enable and Save enabled; Save sent `{"displayName":{},"description":{},"starterPrompts":[],"officeJsMode":"cdn",…,"startPage":{"defaultPage":"start",…}}`. (PM, UX, UI, TW) | [AdminOfficeIntegrationPage.jsx:226-231, 545-575, 683-720](../../client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx); [officeIntegration.js:396-399](../../server/routes/admin/officeIntegration.js); `ui/shots/office-light.png`, `copilot-light.png`, `verify/b6-office-failed-load.png` | P2 |
| IN-B7 | Confirmed (reproduced) | **Empty states over load errors.** Integrations shows the error (an `AdminLoadError` with Retry, :604) *and*, below it, the four client cards and "Nothing installed yet / Open the catalog" with tab counts 0; Catalog says "No definitions match"; Credentials shows "No credentials configured" next to an active Add button. Errors can be raw ("Request failed with status code 429"). AdminInstallationPage does it right. (all but admin) | [AdminIntegrationsPage.jsx:207-229, 604, 649-680](../../client/src/features/admin/pages/AdminIntegrationsPage.jsx); `AdminCredentialsPage.jsx:487-499`; `tw/shots/en-integrations.txt`, `verify/b7-integrations-failed-load.png`, `verify/b7-credentials-failed-load.png` | P2 |
| IN-B8 | Confirmed | **Outlook "Description" field is labelled with the page subtitle** ("Configure the Outlook add-in and manage manifest deployment") in EN and DE: one i18n key for both. (PM, UX, UI, TW) | `AdminOfficeIntegrationPage.jsx:664, 824`; `shared/i18n/en.json:1871`, `de.json:2331` | P2 |
| IN-B9 | Confirmed (code) | **Jira asks for the OAuth client secret twice** (in 2 · Settings and 3 · Sign-in). Jira's `auth.oauthUser.field` is `clientSecretRef`, which is also a non-sensitive admin install field, so it renders once among the Settings fields and again as the sign-in `secretField`. (UX, admin) | `IntegrationInstallForm.jsx:255-262, 493-500, 565-574`; `configFieldWhen.js:42`; `com.intrafind__jira/integration.json` (`auth.oauthUser.field`); `ux/shots/jira-form.txt` | P2 |
| IN-B10 | Confirmed | **MCP gateway text inputs have no border or padding** (Public URL, CIMD, DCR fields float as placeholder text). (UI) | `AdminMcpGatewayPage.jsx:303, 334, 356, 397, 484`; `ui/shots/crop-mcpgw-dark.png` | P2 |
| IN-B11 | Confirmed | **Credentials modal is not an accessible dialog** (no `role="dialog"`, Escape does nothing, labels without `htmlFor`); Edit/Delete are icon-only with no name. (UI) | `AdminCredentialsPage.jsx:526-537, 547-640` | P2 |
| IN-B12 | Confirmed | **Install dialog closes on Esc/backdrop/✕ without asking**; no unsaved-changes guard on the client pages, gateway, Credentials or the installation Settings editors (only the builder has one). `docs/admin-ui.md:513-517` promises the warning on edit pages generally. (UX) | `IntegrationInstallDialog.jsx:41-45` passes `onClose` to `Modal` (backdrop and Escape close by default, `Modal.jsx:17, 41`); in this part `useUnsavedChanges` only in `AdminIntegrationBuilderPage.jsx:101` | P2 |
| IN-B13 | Confirmed | **Docs say Enable generates the browser-extension signing key; the code makes it a separate opt-in step**, so the admin following the docs finds no Download. (PM) | `docs/browser-extension.md:144-149` vs [browserExtension.js:250-253](../../server/routes/admin/browserExtension.js) | P2 |
| IN-B14 | Confirmed | **The extension force-install recipe cannot work.** Docs: `ExtensionInstallForcelist` "with the URL of the CRX". Chrome/Edge expect `<id>;<update-manifest URL>`, and iHub serves no update manifest (no `updatecheck`/`gupdate`/`update_url` in `server/` outside `node_modules`). PM rated Confirmed, UX/admin Suspected; the lead settled it by the server grep. (PM, UX, TW, admin) | `docs/browser-extension.md:228-241` | P2 |
| IN-B15 | Confirmed | **Approve commits before the install.** The request flips to `approved` when the dialog opens; cancelling leaves the requester seeing "Approved, being set up". The tab badge counts only `open` requests (`openCount`) while the panel lists `open` + `approved` as "Open requests (1)". By design per the route comment, but misleading. (admin) | `server/routes/admin/integrationRequests.js:12-17`; `IntegrationRequestsPanel.jsx:25-27, 96`; `AdminIntegrationsPage.jsx:396-398, 524`; `settings/components/RequestableIntegrations.jsx:53-57`; `admin/s25.js`, `s27.js` | P2 |
| IN-B16 | Confirmed (code) | **Jira test is green with a made-up client ID and secret** ("Atlassian Jira reachable", 4 ok): the client step only checks that an ID and a resolvable secret exist, and the reachability step is a `HEAD` on auth.atlassian.com; the OAuth flow is deliberately not run (connector comment). (admin) | curl `_test` with `clientId: zz-client-id`; `protocols/native/connectors/jira/index.js:84-148` | P2 |
| IN-B17 | Confirmed (code) | **Removing a builder integration leaves `custom/<id>` in the catalog**; no UI or route deletes it (`InstalledIntegrationService.remove` only drops the installation and its managed credential; `integrationBuilder.js` has no DELETE). (admin) | catalog count unchanged; folder remained under `contents/integration-definitions/`; `InstalledIntegrationService.js:960-976` | P2 |
| IN-B18 | Confirmed (narrowed) | **Copilot's Enable turns on platform-wide OAuth** (authz server, client registry, auth-code, refresh tokens) **and the MCP gateway without a confirm.** Not silent: the status text next to the button says so ("Enabling creates the OAuth client … and turns on iHub's OAuth server and MCP gateway"); the gap is that a platform-wide change sits behind a one-click button with no confirm or undo note, and the gateway docs say a first-time OAuth enable needs a restart. (PM, admin) | [copilotAgent.js:272-279](../../server/routes/admin/copilotAgent.js); `AdminCopilotAgentPage.jsx:335` (disclosure), `:167-173` (confirm used only for rotate); `docs/mcp-integration.md:861-866` | P3 |
| IN-B19 | Confirmed (code) | Test summary reads "ok 1 · warnings 0 · failed 1 · ms": protocol tests put `durationMs` at the top level, the client reads `summary.durationMs` (native diagnostics do put it in `summary`, so iFinder shows it). (admin) | [protocols/common.js:28-40](../../server/services/integrations/protocols/common.js) vs `integrationDiagnostics.js:116-121`; `IntegrationTestResults.jsx:207` | P3 |
| IN-B20 | Confirmed | Typing an existing ID (`staan`) shows no inline error; Install stays enabled. (UX) | `ux/shots/brave-dup.txt` | P3 |
| IN-B21 | Confirmed | Builder: "Create integration" is primary from step 1; it creates an enabled integration with 0 actions; in edit mode an empty description reads "No languages configured". (PM, UI, admin) | `AdminIntegrationBuilderPage.jsx:339-344`; `builder/builderPackage.js:381` (`enabled: true` for a new installation); `admin/shots/t2-b-created.png` | P3 |
| IN-B22 | Confirmed | Create-credential dialog says "Leave as \*\*\*REDACTED\*\*\* to keep the current value" with nothing stored. (UI, TW, admin) | `AdminCredentialsPage.jsx:151-154` | P3 |
| IN-B23 | Confirmed (narrowed) | **Wrong paths in copy and docs.** Diagnostics say "Admin > Platform > SSL" (SSL is a card on Platform → **Security**, `AdminSecurityPage.jsx:7`); `browser-extension.md` Step 1 and its troubleshooting put the feature flag in `platform.json` `features` (flags live in `contents/config/features.json`). The "Admin → Integrations → Credentials" paths were dropped from this row on verification: the sidebar has an **Integrations section** that holds Credentials, so the path is right (see the appendix). (PM, UX, UI, TW) | `integrationDiagnostics.js:600`; `docs/browser-extension.md:99-110, 408-411` | P3 |
| IN-B24 | Confirmed | Remove vs Delete mixed on one action (tile aria-label "Remove", tooltip "Delete", dialog "Remove integration?", button **Delete**). (UI, TW) | `AdminIntegrationsPage.jsx:851-855`; `InstallationTile.jsx:226-229` | P3 |
| IN-B25 | Suspected (code supports) | **Rotating a bearer credential does not reach open MCP connections.** The token is resolved once when the transport is built and reused per request; the credential PUT only refreshes the cache. The admin's Brave rotation worked because that path resolves per call. Verifier: nothing rebuilds the connection on rotation either — `McpClientManager` decides on a rebuild by comparing the `auth` config JSON, which holds the credential *reference*, not its value. Not reproduced (no reachable MCP server). (TW) | `server/services/mcp/McpServerConnection.js:112-130, 185, 196, 208-211`; `McpClientManager.js:278-283`; `credentials.js:103-109` | P2 |
| IN-B26 | Confirmed | Read-only manifest/embed URL fields have no focus ring and Copy gives no feedback (Copilot's `CopyField` does). (UI) | `AdminOfficeIntegrationPage.jsx:764-770`; `AdminNextcloudEmbedPage.jsx:334-340` | P3 |

Cross-cutting, reported elsewhere and also visible here: any `/admin/auth/status` error, including 429, renders "Admin Access Required" to a signed-in admin (`useAdminAuth.jsx:27-29`; see parts 07/08); a cold load of an `/admin` URL ignores dark mode (SH-B9 in part 01); the demo-accounts banner is ~800 px tall at 390 px (SH-B5).

## 5. Findings by persona

### Product manager

- **IN-PM1 — No way to give one integration to one group** (also UX, TW, admin; the admin's T2 failed on it). Shipped `groups.json` grants `integrations: ["*"]` to admins, users, authenticated, browser-extension, nextcloud-embed, agents, agent-operators and content-admins; `anonymous` gets `["ihub","type:web-search"]` (lead read `contents/config/groups.json`). Grants are allow-only (`integrationAccess.js:132`); installations no longer carry groups (V203, `ALLOWED_GROUPS_REMOVED`). Recommendation: an **Access** card on the installation ("Everyone with integration access / Only these groups"), backed by a per-installation `restricted` flag that `*` and `type:` grants do not cover. Related to ID-B5 in part 04 (allow-only union).
- **IN-PM2 — Two secret models in one dialog** (also UX6, admin, TW). MCP/service-account secrets are typed inline and stored as `integration-<id>-<field>` (`InstalledIntegrationService.js:106-107, 336-340`); Brave, Staan, Jira and the builder only *select* a stored credential (`ConfigFieldInput.jsx:62-73`, `BuilderAuthStep.jsx:113`). Recommendation: every credential field offers "Paste a new secret | Use a stored credential"; paste creates the profile inline.
- **IN-PM3 — Credentials is a dead-end list; secrets live in four places.** No used-by, no updated-at, no test, no hint that `${ENV}` placeholders are supported (`isEnvVarPlaceholder`), no doc. Secrets also live as managed per-installation credentials, provider keys (Models → Providers) and auth-provider secrets. Recommendation: make Credentials the inventory of every secret iHub holds (read-only where another page owns it) with "Used by" and "Last changed".
- **IN-PM4 — Inbound shown three times; Installed lists things that are not installed** (also UX4, UI12, TW). Client cards on Installed (`AdminIntegrationsPage.jsx:657, 694`) and Inbound (`InboundIntegrations.jsx:79`); the gateway on Inbound and the sidebar (`AdminSidebarNavData.js:208-213`).
- **IN-PM5 — Two ways to add MCP or A2A** (also UX3, TW, admin): catalog definitions `com.intrafind/mcp-server`/`a2a-agent` vs builder Source MCP/A2A (`BuilderSourceStep.jsx:47-59`), with different secret handling.
- **IN-PM6 — The gateway page owns platform OAuth policy.** The OAuth authorization-server toggle exists here (`AdminMcpGatewayPage.jsx:247`) and on `AdminOAuthServerPage.jsx:129`; DCR/CIMD policy is only here, and the CIMD client page sends admins back (`AdminOAuthCimdClientEditPage.jsx:23`). Part 04 reached the same conclusion. Recommendation: show OAuth state read-only with a link; add a "Connect a client" card (endpoint URL plus snippets for Claude, Cursor, VS Code).
- **IN-PM7 — Browser-extension rollout is half-built; channels gate access differently.** IN-B13, IN-B14; the extension has Allowed Groups, Outlook only an app limit (`AdminOfficeIntegrationPage.jsx:843`), Nextcloud nothing although a `nextcloud-embed` group ships. Recommendation: generate the key on Enable, serve `update.xml`, show a GPO/Intune snippet, give all four channels the same "Who can sign in" card.
- **IN-PM8 — Settings with no UI:** `officeIntegration.calendarStarterPrompts` (read by `officeAddin.js:93`), `mcpServer.defaultScopes` (V050/V080; also personal API key scopes, V084), global CIMD defaults `oauth.cimd.allowedGroups/Apps/Models/Prompts/Scopes` (only per-client overrides have UI).
- **IN-PM9 — Install ends on a flash message** (`AdminIntegrationsPage.jsx:382-392`). An integration does nothing until bound to an app; the example-app shortcut is on the installation page, which the admin is not taken to. Recommendation: land on the installation page with a "Next steps" checklist.
- **IN-PM10 — Four client pages reinvent one skeleton** (Enable → OAuth client → display → prompts → deploy) with different headers, back links and capabilities. Recommendation: one Channel template (also UI2, UX12).

### UX designer

- **IN-UX1 — One request spread over 3–4 pages with no thread** (T1: 14+ steps). The installation page's empty state says "Bind it in an app's Integrations section" with no picker (`AdminInstallationPage.jsx:979-985`). Recommendation: after Install, a success panel "Use in apps: [Web Chat ✓] [Research ✓] · Who can use it: All signed-in users (change)".
- **IN-UX3 — "MCP gateway" vs "MCP server" naming trap** (also admin IN-ADMIN4: the admin went there first). Rename the sidebar item "Expose iHub via MCP" and add a line on the page: "To connect an external MCP server, install it from the Catalog". Pin "Connect any MCP server by URL" first in the MCP group.
- **IN-UX5 — "Enabled" is not "working".** Staan shows green Enabled next to "API key not set" while Web Chat uses it (`ux/shots/staan.txt`). Add a "Needs setup" (amber) state, keep the last test result and time per installation, show it on the tile, sort attention items first.
- **IN-UX8 — Sign-in fields appear above the sign-in choice.** Fields with an `authMode` condition render in 2 · Settings (`IntegrationInstallForm.jsx:264-268, 488-500`); the radio is in 3 · Sign-in, so choosing "OAuth client" makes fields appear out of view. Nest them under their option.
- **IN-UX9 — Test result and commit are disconnected.** Results appear at the bottom of a long modal; Install stays enabled after a failed test. Put a compact status in the sticky footer ("✗ API key missing — Fix" focuses the field); after a failed test ask "Install anyway (disabled)?".
- **IN-UX10 — Cmd+K cannot find this part.** Hard-coded English list with only "Integrations" (`AdminCommandPalette.jsx:11-45`); no MCP gateway, Credentials, Outlook, extension, Copilot, Nextcloud; no search over installations or credentials. (Part 01 recommends building the palette from the sidebar data; add keywords "outlook, add-in, manifest", "api key, secret, token".)
- **IN-UX11 — Header actions mis-weighted.** "Reload catalog" (maintenance) has the weight of "Add manually"; primary "Install" only switches tabs (`AdminIntegrationsPage.jsx:582-593`). One primary "+ Add integration"; "Reload catalog" into the Catalog toolbar; rename "Add manually" to "Build custom integration".
- **IN-UX12 — Client pages don't answer "what do I send IT?".** Contradictory extension group copy ("Defaults to the 'browser-extension' group" vs "No groups selected — sign-in is unrestricted"); Office has no group control; deployment is the last card; only Office and Nextcloud have a back link; none links to its doc.

### UI designer

- **IN-UI1 — Three primary colours, two title sizes.** `PRIMARY_BUTTON_CLASS` is blue-600 (`formStyles.js:28`); Office, Copilot, Nextcloud hand-roll indigo-600; the extension uses emerald-700 (`AdminBrowserExtensionPage.jsx:374, 432`); gateway and Credentials hand-roll blue without focus styles. Six of the admin's 13 `text-3xl` titles are here (norm: `text-2xl`).
- **IN-UI2 — Client pages and gateway need the shared settings shell.** All four use `min-h-screen bg-gray-50` plus a white header band (Office:655, BrowserExt:315, Copilot:285, Nextcloud:221), a visible stripe in dark mode, no `AdminBreadcrumb`, Save only at the bottom (Office ~4,400 px). Move them onto `AdminSettingsPage` (section nav, sticky save with dirty indicator, `AdminSettingsPage.jsx:87, 136`).
- **IN-UI3 — Duplicated components.** Starter-prompt editor copied 3× (Office:1454-1530, BrowserExt:667-735, Nextcloud:436-520); three copy-field implementations (Copilot `CopyField`, `CopyableValue`, inline); Enable/Disable status card 4×. Extract `StarterPromptsEditor`, one `CopyField`, `IntegrationStatusCard` on `Switch`; move `CredentialRefSelect` (used by 8 editors) out of `OpenApiToolEditor.jsx`.
- **IN-UI4/UI5 — Installed tiles are low-density and their icons ambiguous.** 6 installations take ~1,300 px; the 8-group line repeats on every tile (`InstallationTile.jsx:173-181`); ✓ means "Enable" but reads as "OK" (`:187-236`). Collapse to "All groups" / "8 groups"; status as a `Switch`; Test, Remove, Connected users into `MoreActionsMenu`; offer a DataTable view.
- **IN-UI6 — Catalog lacks hierarchy for 56 items.** All Install buttons primary; descriptions unclamped (Entra ~10 lines); no filter chips. Secondary Install, clamp to 3 lines, chips (People, Web search, Storage, MCP, Agents, Built-in), IntraFind/Built-in first.
- **IN-UI7/UI9 — Installation header overloaded; two Test buttons.** Test in chat, Test connection, Disable, Remove in one row (`AdminInstallationPage.jsx:524-590`), wrapping on mobile; header Test uses saved values, footer Test unsaved ones. Header = status switch + Test (primary) + overflow; label "Test saved settings" / "Test these changes".
- **IN-UI8 — Editors need a sticky save bar.** x500 settings are 4,883 px with Save at the bottom; reuse the `AdminSettingsPage` bar in `EditorFooter` (`InstallationEditorParts.jsx:203`).
- **IN-UI10 — Inconsistent inputs in the builder.** `DynamicLanguageEditor` inputs ~42 px with a red ✕ on the only language and "Add Language" in title case, next to 38 px `INPUT_CLASS` fields.
- **IN-UI13 — Mobile tab bar.** "Inbound" is off-screen at 390 px with no affordance (`AdminTabs.jsx:61`).

### Technical writer

- **IN-TW1 — No page in scope links to `/admin/docs`.** The only doc link is a definition's `docsUrl`, and every shipped one points to `github.com/intrafind/ihub-apps/blob/main/docs/…` (wrong version, unreachable when air-gapped). Rewrite to `/admin/docs/X.md#a` (`docsLinkTarget` exists) and add a "Learn more" link to each page header.
- **IN-TW2 — Wrong doc targets.** iAssistant's `docsUrl` points to `iFinder-Integration.md`, not `ifinder-iassistant-admin-guide.md` (`com.intrafind__iassistant/integration.json:48`); Nextcloud says "see nextcloud-app/README.md in the iHub repo" (`AdminNextcloudEmbedPage.jsx:555`) although `docs/nextcloud-embed.md` exists.
- **IN-TW4 — Each sign-in mode has three names** (dialog "Shared service account (one token for everyone)", builder "Service account (one shared credential)", tile "service account", docs "Service account"). Use one set: *No sign-in*, *Shared account*, *Each user signs in*, *iHub's own OAuth client*.
- **IN-TW5 — Terminology drift.** Outlook Add-in vs "Office Integration" (title) vs `/office-integration`; "Clients" vs "Inbound"; builder vs "Add manually" vs "Custom"; actions vs tools ("Connected · 8 tools" vs "Actions (1)"); "gateway" for both MCP gateway and LLM provider gateway.
- **IN-TW7 — Microcopy rewrites** (selection; full list in section 9): "(later release)" → hide the mode; "required" → "Enter a value."; "The base URL is an http(s) URL." → "Enter a URL that starts with http:// or https://."; "Without a key: STAAN_API_KEY" → "Fallback: environment variable STAAN_API_KEY (set / not set)"; "Always ask (default)" and "Always ask" both in one select → keep one.
- **IN-TW8 — German gaps.** Browser extension page: 68 keys missing in en.json and de.json (page fully English); Credentials 38; gateway 5; credential picker 5. Register mixes *du* (Nextcloud, catalog empty state, action detail) and *Sie*. "Definition auf der Platte" → "installierte Definition"; "scharfzuschalten" → "zu aktivieren"; "Marketplace" vs "Marktplatz" on one page. Server diagnostic hints are English only.
- **IN-TW9 — `JIRA_INTEGRATION.md` contradicts itself** (also admin): line 100 "former `JIRA_*` variables are not read", but troubleshooting says "Ensure all environment variables are set" (269), "Adjust `JIRA_RATE_LIMIT_*`" (334, no such variable), `DEBUG=jira:* npm run dev` (363).
- **IN-TW11 — Overview leads with internals.** On `/admin/integrations/staan`: Configuration → approval policy → actions → instructions → "Migration log v1.0.0 → v1.1.0". Add a status line ("Working · last test OK 2 min ago · used by 3 apps · all groups") and move the migration log to Releases.

### iHub admin

- **IN-ADMIN3 — T2 group restriction failed** (see IN-PM1). Also: per-tool restriction by group does not exist; document "use two apps" until it does.
- **IN-ADMIN5 — Builder order and dead ends.** Sign-in before Source; credential only in a new tab; Create before any successful tool listing (IN-B21). Recommendation: Source → Connection → Sign-in → Test & tools → Access → Review; create *disabled* until the tool listing has succeeded.
- **IN-ADMIN6 — Credential lifecycle is blind** (IN-B3). Delete should answer 409 with the list of users and an explicit "delete anyway"; Overview should say "missing credential" in red; "Test all users" after save.
- **IN-ADMIN7 — Requests:** mark approved only when the install succeeds; count approved-not-installed in the badge; stop offering admin building blocks and installed-but-disabled integrations as requestable.
- **IN-ADMIN8 — Test results are mostly excellent; two exceptions.** Brave 422 → "Check the server log" (map 401/403/422 to "the key is wrong or has no plan" and show the redacted provider body); Jira green on fake values (label it "reachability only" or probe `client_credentials`).
- **IN-ADMIN9 — No cleanup for builder integrations** (IN-B17): Remove should offer "also delete its definition"; Catalog needs Delete for `custom/*` with no installation.
- **IN-ADMIN10 — Anonymous visitors can spend a paid search key.** `anonymous: ['ihub','type:web-search']` (V204) and the dialog shows it read-only. Keep the default, but show "Anonymous visitors can use this — uses your API key" with one-click "exclude anonymous".
- **IN-ADMIN11 — Rollout deliverables hidden behind Enable** (T5). Show deliverables in preview before Enable; confirm side effects (IN-B18); make catalog search find inbound clients ("outlook" finds nothing).
- **IN-ADMIN12 — iFinder says "Sign-in: none"** while configuring per-user token exchange. When a native integration handles identity itself, show "Sign-in: per user (configured above)" and hide section 3.

## 6. What should be rearranged

1. **Installed shows only installations.** Remove the Clients section (four "Available" cards). Order: needs attention (missing credential, failed migration, failed last test) → the rest. (PM, UX, UI, TW, admin)
2. **One inbound tab: "Clients"** (rename "Inbound"; TW suggested "Use iHub elsewhere") holding Outlook, browser extension, Copilot, Nextcloud and the MCP gateway, with status labels Off / On / Needs attention. Catalog search also matches these.
3. **Sidebar Integrations section:** Integrations · Credentials · "Expose iHub (MCP)" as a deep link to the gateway, or drop it (see section 10). Fixes the T2 detour.
4. **OAuth policy moves to Access & Identity → OAuth** (authorization-server toggle, DCR, CIMD hosts/approval/defaults); the gateway shows it read-only with a link. Agreed with part 04.
5. **Header:** one primary "Add integration" (or "Browse catalog"); "Reload catalog" into the Catalog toolbar; "Add manually" → "Build custom integration".
6. **Catalog order:** Built-in / IntraFind first (iFinder, iAssistant, Jira, web search, people directories), then storage, then the MCP marketplace; pin generic "MCP server" and "A2A agent" at the top of their groups.
7. **One entry point per protocol:** builder Source MCP/A2A hands off to the catalog definitions; builder stays for OpenAPI, HTTP, script.
8. **Builder:** Basics → **Source → Sign-in** → Actions → Review; Create only on Review.
9. **Install dialog:** Name → Connection → Sign-in (with its own fields nested) → Test → then Who may use it and Actions/Apps. Move "Enabled" out of "Who may use it".
10. **Installation page:** status header (state, last test, used by N apps, granted to N groups, each with inline edit); add **Access** and **Apps** cards; migration log to Releases; Remove into an overflow or Danger zone.
11. **Client pages:** Status + prerequisites → **Roll out** (always visible, disabled until enabled) → Who can sign in → Appearance → Prompts → Advanced. Outlook: fold Office.js source and answer actions under Advanced; rename the page "Outlook add-in".
12. **MCP gateway:** "Status and endpoint" card first (on/off, copyable `/mcp` URL), then exposed resources; client identification and transports under Advanced.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| "+ Create new credential" opens `/admin/credentials` in a new tab, then ↻ refresh (`OpenApiToolEditor.jsx:143`) | Inline "Paste a new secret / Use a stored credential" on every credential field; "+ New" opens a Drawer and auto-selects the result | Removes the tab trip in T1/T2; one secret pattern instead of two |
| Access granted group-side with `*` lists | Access set resource-side on the installation (Everyone / Only these groups) with effective audience shown | T2 drops from ~10 Groups edits to 2 clicks; matches Copilot Studio/Glean |
| Credentials as a hand-rolled `<ul>` with modal and `window.confirm` | DataTable (name, type, used by, updated) + Drawer + delete with impact preview (the Remove-integration dialog already lists consequences) | Rotation and safe deletion; accessible |
| Binary Enabled pill | Health state with last test result and time | "Enabled" ≠ "working" (Staan) |
| "Bind it in an app's Integrations section" | "Use in apps…" multi-select on the installation page (data exists in `appsBindingInstallation`) | Binding without visiting each app editor |
| Four bespoke client pages (1,599 / 810 / 716 / 574 lines) | One Channel template on `AdminSettingsPage` plus channel extras | Consistency, sticky save, less code |
| Prose rollout steps in docs | Generated "IT handoff" per channel (manifest URL/XML; extension ID + `update.xml` + policy JSON; Teams package + OAuth values; embed URL + origins) | What the admin actually sends IT |
| Server error `detail` shown verbatim, English fragments | Client maps problem `code` + `errors[].pointer` to localized copy at the field | Fixes IN-B4 and the German gaps in one place |
| 56 tiles in one scroll | Filter chips + list view toggle; tiles for browsing | Findability |
| Load failure → defaults/empty state | `AdminLoadError` + Retry, no form until loaded (AdminInstallationPage pattern) | Prevents IN-B1/B6/B7 |

## 8. Wizards to add

**W1 — Connect an MCP server** (quick connect)
- Starts: Catalog → pinned "Connect any MCP server by URL" tile; also "Add integration" → "An MCP server".
- Who: every admin connecting a vendor or internal MCP server (T2).
- Steps: 1. URL (transport auto-detected). 2. Sign-in: none / paste bearer token (stored as a managed credential) / per-user OAuth (a 401 with `WWW-Authenticate` suggests OAuth). 3. Test and list tools (must pass, or explicit "create disabled"). 4. Choose tools (read-only preselected, write actions need approval). 5. Who may use it (Everyone / Only these groups). 6. Add to apps (optional). 7. Done: summary + Try in chat.
- Validates: reachability, auth, tool listing. Creates: credential, installation, access setting, app bindings.
- Replaces: the builder's MCP source, the new-tab credential detour, the Groups rework.

**W2 — Add web search**
- Starts: Catalog Web search group; an app's Web Search panel when no engine is installed (today it only links to the catalog, `web-tools.md:149-170`); first-run Installed empty state.
- Who: nearly every new install (T1).
- Steps: 1. Pick engine (Qwant needs no key; Brave/Staan need one). 2. Paste key. 3. Live test search (readable provider errors). 4. Who may use it, with the anonymous warning. 5. Choose apps (bulk `websearch.enabled`) or "Auto". 6. Done.
- Validates: one real search. Creates: credential, singleton installation (fixed ID), app settings.
- Replaces: 14 steps on 3 pages.

**W3 — Roll out to staff** (Outlook, browser extension, Copilot, Nextcloud; one shared template)
- Starts: each client page's Roll out card.
- Who: admins handing iHub to IT (T5).
- Steps: 1. Prerequisites (live checks, Copilot pattern: public URL, Nextcloud storage installed, …). 2. Enable, with a confirm listing side effects (OAuth client; for Copilot the OAuth server and MCP gateway). 3. Who can sign in (groups; same card on all four). 4. Appearance and prompts (skippable). 5. Generate the IT package: manifest/CRX/ZIP/Teams package, extension ID, `update.xml` URL and policy JSON/registry, redirect URIs, hosts to allow, required admin role, verification checklist. 6. Verify: shows when the first user from the target group signs in.
- Replaces: hidden-until-Enable deliverables and doc-only IT instructions.

**W4 — Rotate credential**
- Starts: Credentials row → Rotate.
- Steps: 1. Shows "Used by: Brave Search, GitHub (MCP), OIDC Entra". 2. Paste new value. 3. Auto-test every consumer (reconnects MCP connections, IN-B25). 4. Commit, or roll back if any test fails.
- Replaces: blind edit + manual re-tests.

**Not a new wizard, but a fix:** turn the builder's tabs into a real stepper (numbers, ✓, Create only on Review, Source first). And after any install, a **Next steps checklist** on the installation page: Tested ✓ · Bound to apps (n) · Who can use it · Try in chat.

**Where a wizard would be wrong:** the installation Settings editors and approval policy (power users revisit them); Catalog browsing; the Requests tab (already a 4-step flow); the MCP gateway's transports and CIMD settings (set once by experts; collapse them under Advanced instead); Outlook's Office.js source and answer actions. UX proposed one big "Add integration" intent wizard spanning every integration type; the panel prefers the targeted W1/W2 first (section 10).

## 9. Documentation

**What exists and its quality**
- `docs/integrations.md` (903 lines): an accurate spec of the model, tiles and API, but contributor-oriented. It opens with "Four records", mixes UI steps with JSON, storage paths, migration numbers and issue numbers; "Requests from users" is at line 473; no screenshots. About 60% (API, writing a definition, migrations, code map) belongs in a developer page.
- `docs/mcp-integration.md` (1,710 lines): outbound and inbound mixed; setup explained as a JSON field table (line 64) and "`groups.json` → `permissions.integrations`" (69); "Admin operations" is a list of REST endpoints; inbound explained via `platform.mcpServer.*` keys.
- `docs/web-tools.md`: has three UI steps for API keys (414-445) but leads with app JSON, and the key steps are 270 lines from the app setup; promises "Brave installs as `brave`" (false today, IN-B2).
- Client rollout guides — the best docs here: `outlook-add-in.md` (Step 1–6, M365 Admin Center and Exchange paths, troubleshooting), `microsoft-365-copilot-agent.md` (133 lines, numbered), `nextcloud-embed.md`. `browser-extension.md` has good steps but IN-B13 and IN-B14.
- `JIRA_INTEGRATION.md`: UI steps OK (51-82), troubleshooting stale (IN-TW9). `iFinder-Integration.md`: "Environment Variables" before "The iFinder Installation"; the excellent test diagnostics are not documented.
- `admin-ui.md`: one nav row for Integrations; no "Managing integrations" section.
- In-product search: "credential" tops out at `oauth-integration-guide.md`; "rotate" finds only OAuth and extension topics.

**Gaps (tasks a new admin cannot learn from the docs today)**
1. Add web search to an app through the UI (no `web-search` page; `integrations.md:31` is one dense paragraph).
2. Connect an MCP server with a bearer token, as UI steps.
3. Restrict an integration to some groups, including the `*`-on-`authenticated` trap and that per-tool-per-group is impossible.
4. Credentials: what they are, create, rotate safely, delete, `${ENV}` fallbacks, the encryption key and backup. No page at all.
5. Read a test result (status → cause → fix).
6. Expose iHub via the MCP gateway through the UI and connect Claude/Cursor to it.
7. A correct Chrome/Edge policy rollout for the extension.

**Proposed pages**
- `docs/integrations-how-to.md` — "Integrations: common tasks". Each task: goal, 4–8 numbered UI steps, "check it worked", "if it fails". Tasks: Add web search to an app · Connect an MCP server (URL + token) · Limit an integration to some groups (and what you cannot limit) · Test a connection and read the result (table: Failed / Blocked / Unreachable / Auth required → cause → fix for iFinder, MCP, Jira, web search) · Handle a user's request · Build an integration from an OpenAPI URL.
- `docs/credentials.md` — What a credential is vs a secret typed in the install dialog (managed `integration-<id>-<field>`) · Types and when to use each · Create · Use in an integration, auth provider, tool · Rotate safely (find users, edit, re-test, MCP reconnect) · Delete · Environment-variable fallbacks · Encryption key (`contents/.encryption-key`) and backups.
- `docs/client-rollout.md` — comparison table (what users get, what IT installs, sign-in, groups) plus an "Information for IT" block per client; the four guides stay as detail pages.
- `docs/admin-ui.md` — new "Managing integrations" section: tabs, tile anatomy, installation page, glossary, screenshots.
- Move developer content out of `integrations.md` into `integration-development.md`; add an "Admin quick start" at the top. Add an "Integrations" section to `SUMMARY.md` instead of 11 entries mixed under Features.
- Fix: `browser-extension.md` Step 3 (key is opt-in) and force-install (`<id>;<update URL>` + sample `updates.xml`, once served); `JIRA_INTEGRATION.md` troubleshooting → a "what Test shows → cause → fix" table, delete dev-only sections; all "Admin → Integrations → Credentials" paths (IN-B23).

**Contextual help in the product**

| Page / field | Link to | Help text: current → proposed |
|---|---|---|
| Integrations header | `integrations-how-to.md` | — |
| Installation page "Documentation" (definition `docsUrl`) | `/admin/docs/<file>#anchor` instead of GitHub `main` | — |
| Install dialog, 4 · Who may use it | `integrations-how-to.md#limit-an-integration-to-some-groups` | "Edit on Admin → Groups" → (until editable) "Everyone in these groups can use it. To limit it, see *Limit to some groups*." |
| Install dialog, disabled sign-in mode | — | "(later release)" → hide unsupported modes; if shown: "Not available for this connection type" |
| Install dialog, field errors | — | "Invalid install values" → "Check the highlighted fields: Client secret is required." |
| Credentials header | `credentials.md` | "Named, encrypted auth profiles referenced by tools and integrations via credentialRef." → "Secrets that integrations use to sign in (API keys, tokens, passwords). Stored encrypted; integrations refer to them by ID." |
| Credential secret field | — | Create: "Encrypted at rest. Leave as \*\*\*REDACTED\*\*\* to keep the current value." → "Stored encrypted. Nobody can read it back after saving." Edit: "Leave empty to keep the current secret." |
| Credential delete | — | "This cannot be undone." → "Delete "x"? Brave Search and GitHub (MCP) use it and will stop working." |
| Credential picker | `credentials.md#create` | "+ Create new credential" (new tab) → "+ New credential" (inline) |
| Installed tile groups | — | "Groups: admins, agent-operators, agents, …" → "All groups" when granted by `*` |
| Tile fact | — | "Without a key: STAAN_API_KEY" → "Fallback: environment variable STAAN_API_KEY (set / not set)" |
| Header CTA | — | "Install" (switches tab) → "Browse catalog" |
| MCP gateway header | `mcp-integration.md#inbound--exposing-ihub-as-an-mcp-server` | "Authenticate with an OAuth client (see /admin/oauth/clients)…" → make "OAuth clients" a link |
| MCP gateway page intro | — | add: "This page lets other tools use iHub. To connect an MCP server to iHub, install it from the Catalog." |
| Browser extension, Allowed Groups | `browser-extension.md#…` | "No groups selected — sign-in is unrestricted" → "Pick at least one group, or All (\*) to let every signed-in user use the extension." |
| Browser extension, packaged downloads | `client-rollout.md#browser-extension` | "Set up packaged downloads (optional)" → "Packaged download for staff rollout (required for IT deployment)" |
| Outlook, Copilot, Nextcloud headers | their rollout guides | Nextcloud "see nextcloud-app/README.md in the iHub repo" → link to `nextcloud-embed.md#step-2--get-the-plugin-tarball` |
| Test results, Brave 422 | — | "Check the server log" → "Brave rejected the key (422): the key is wrong or has no active plan." |
| Diagnostics SSL hint | — | "Admin > Platform > SSL" → "Platform → Security → SSL / TLS" |
| Dense fields (CIMD, DCR, stateless mode, extension IDs, approval policy) | matching doc anchors | replace 60–70-word inline paragraphs with one line + "?" link |

## 10. Where the panel disagreed

- **How to restrict an integration to a group.** PM: a per-installation `restricted` flag that `*` does not cover. UX: an exception the resolver honours over `*`. TW: a group multi-select in the install dialog that writes `permissions.integrations`. Admin: a picker on the installation page. **Resolution:** both halves. The editor lives on the installation (and in the dialog after Test) and writes group grants; the server adds `restricted` so narrowing does not require removing `*` from seven groups. Without the server half, the TW/admin picker would silently do nothing for users who hold `*`. Coordinate with part 04's allow-only union work.
- **Where Credentials lives.** UX/TW: fold it into Integrations as a "Secrets" tab, since docs already say "Integrations → Credentials". PM: make it a global inventory of every secret, including provider keys. Admin: keep the page, create inline in flows. **Resolution:** keep the sidebar page (it also serves OIDC, LDAP, storage and tools, so it is not integration-only), make it the inventory with Used by, add inline creation everywhere, and fix the docs' paths rather than moving the page to match them.
- **MCP gateway placement.** UX: rename to "Expose iHub via MCP". PM: drop the sidebar item into a Channels tab. Admin: move under Inbound. **Resolution:** list it on the inbound "Clients" tab; keep a renamed sidebar deep link ("Expose iHub (MCP)") for discoverability; move OAuth policy out.
- **One big intent wizard vs targeted flows.** UX proposed W1 "Add integration" (intent → provider → connect → test → actions → who/where), effort L. PM, UI, admin preferred targeted MCP and web-search flows. **Resolution:** build W1/W2 (section 8) first; an intent "front door" can route into them later.
- **Install dialog: modal or drawer.** UX: drawer with a sticky test footer. UI: the modal with numbered sections is the best UI here (4/5). **Resolution:** keep the modal, add a dirty guard and a sticky test status; reconsider a drawer only if the reordered dialog still overflows.
- **Builder quality.** UX scored it 3.5 ("real stepper with validation and an unsaved guard"); UI 3 ("tabs, Create on step 1"); admin 2. **Settled by code:** both facts are true (`AdminIntegrationBuilderPage.jsx:101, 289, 339-344`); the order and the early Create are the problem.
- **Installed tab score.** Admin 4 (the facts per tile are what an operator needs); designers 3 (noise and duplication). **Resolution:** 3; keep the facts, remove the noise.
- **Severity of the field-error bug.** TW P2, admin P1. **Resolution:** P1 — it stops T3 cold on Jira.
- **Office blank-save risk.** PM "Suspected", TW "P1". **Settled by code:** the server rejects a blank display name (`officeIntegration.js:396-399`), so the risk needs one typed field; Confirmed, P2.
- **Does rotation work?** Admin: yes. TW: suspected not for MCP. **Settled:** both. Per-call resolution (Brave) works; MCP bearer tokens are resolved at connect time (IN-B25, Suspected with code support).
- **Force-install recipe.** PM Confirmed, others Suspected. **Settled:** Confirmed; iHub serves no update manifest.

## 11. Top recommendations

| # | Recommendation | Why | Impact | Effort | Type |
|---|---|---|---|---|---|
| 1 | **Fix the install contract bugs:** send `singleton` and lock the ID; read `errors[].pointer` into fields with localized messages; real `supportedAuthModes` for native adapters (no "(later release)"); single Jira secret field; read top-level `durationMs`; inline duplicate-ID error. | The first integrations a new admin tries (Brave, Jira, storage) look broken (IN-B2, B4, B5, B9, B19, B20). | H | S | fix |
| 2 | **Load-failure rule for the whole part:** no form, Enable or empty state until loaded; `AdminLoadError` + Retry; Save/Enable disabled until loaded; dirty guard on the install dialog, client pages, gateway and Credentials. | Prevents config loss on the gateway and the client pages; stops "Nothing installed yet" scares (IN-B1, B6, B7, B12). | H | S | fix |
| 3 | **Credential safety:** server-computed "Used by" (integrations, auth providers, tools); delete returns 409 with consumers unless forced; "missing credential" on the installation; label integration-owned secrets; accessible Drawer; fixed copy; reconnect MCP on rotation. | Rotation and deletion are blind today (IN-B3, B11, B22, B25). | H | M | fix/UX |
| 4 | **Access on the integration:** "Who may use it" editor on the installation page and in the dialog after Test, backed by a server `restricted` flag that `*` does not cover; effective audience; anonymous warning for paid engines. | T2 failed; restricting one server means editing ~7 groups (IN-PM1, ADMIN10). | H | M | UX |
| 5 | **Inline secrets everywhere** ("Paste a new secret / Use a stored credential"), shared `CredentialRefSelect` in its own module. | Removes the new-tab detour and the two-pattern confusion (IN-PM2, UX6). | H | M | UX |
| 6 | **After install: Next steps checklist + W2 "Add web search" + W1 "Connect an MCP server"** with test gate, access and app binding. | Turns 14–22 steps on 3–4 pages into one flow (IN-PM9, UX1). | H | M | wizard |
| 7 | **IA cleanup:** Installed shows only installations; one "Clients" tab with the four channels and the gateway; rename the sidebar gateway link; OAuth policy to Access & Identity; one MCP/A2A entry point; builder Source-first, Create only on Review, no enabled 0-action integrations, delete `custom/*` on Remove; "Browse catalog" CTA; Approve marks approved only on install. | Duplication and the T2 detour (IN-PM4–6, UX3, B15, B17, B21). | M | S | IA |
| 8 | **Channel template + W3 "Roll out to staff"** with deliverables visible before Enable, side-effect confirm (Copilot), same group gate on all four, extension key on Enable, served `update.xml` and policy snippet, IT package. | T5 partial; rollout docs wrong (IN-PM7, PM10, UX12, B13, B14, B18). | M–H | M–L | wizard/UI |
| 9 | **Docs:** `integrations-how-to.md`, `credentials.md`, `client-rollout.md`, admin-ui section; fix browser-extension, Jira, and every "Integrations → Credentials" path; "Learn more" on every page; `docsUrl` → `/admin/docs`. | No task guide exists for web search, MCP, group restriction or credentials (IN-TW1–3, TW9, B23). | H | M | docs |
| 10 | **Visual and language consolidation:** gateway and client pages on `AdminSettingsPage`; `formStyles` buttons and `text-2xl`; gateway input borders; Office label; extract `StarterPromptsEditor`/`CopyField`/`IntegrationStatusCard`; one name per sign-in mode; "Outlook add-in"; Remove-only wording; 116 missing de keys; *Sie* throughout. | Three visual generations; English-only pages in German (IN-UI1–3, TW4, TW5, TW8, B8, B10, B24). | M | M | UI |

## Appendix — verification log

Lead checks (no entities created; cookie file only, in `integrations/lead/`):
- **Live API (curl, logged in as admin):** `GET /api/admin/integrations/catalog/com.intrafind%2Fbrave-search` has no `singleton` key, `supportedAuthModes ['none','service-account']` (IN-B2). `GET …/com.intrafind%2Fjira` → `authModes ['oauth-user']`, `supportedAuthModes ['none','service-account']` (IN-B5). `POST …/com.intrafind%2Fifinder/_test` without an ID → `SINGLETON_ID` "installed once, as "ifinder""; with `id: "ifinder"` → `INVALID_VALUES` with `errors[].pointer` `/values/baseUrl`, `/values/authMode`, `/values/defaultSearchProfile` (IN-B2, IN-B4). Catalog returns 56 entries and no `custom/*` left over; credentials list empty; installed: drawio, excalidraw, x500bund, entra (disabled), ihub, staan (enabled).
- **Code:** `configs.js:365, 370` (wholesale `oauth`/`mcpServer`) and the gateway's `prev`-spreading updaters (IN-B1); `officeIntegration.js:396-399` (`requireNonEmpty` on displayName only, IN-B6); `credentials.js:248-273` (no reference check, IN-B3); `browserExtension.js:250-253` (key opt-in, IN-B13); `copilotAgent.js:272-279` (OAuth + MCP gateway enabled, IN-B18); `protocols/common.js:28-40` vs `integrationDiagnostics.js:116-121` (IN-B19); `McpServerConnection.js:185, 196, 208-211` (token resolved at transport build, IN-B25); `AdminIntegrationBuilderPage.jsx:101, 289, 339-344` (guard, tabs, Create on every step); `contents/config/groups.json` (8 groups `*`, anonymous `ihub` + `type:web-search`); `useAdminAuth.jsx:27-29` (any error → not authenticated).
- **Not re-tested by the lead:** IN-B16 (Jira green on fake values), IN-B15/B17 (admin's live repros `s25.js`, `s27.js`), visual bugs IN-B10/B11/B26 (UI screenshots).
