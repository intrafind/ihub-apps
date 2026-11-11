# AI-use acknowledgement in the client integrations - PM + engineering analysis

> **Paths superseded (step 9).** The acknowledgement APIs now live under `eu-ai-act`: `/api/eu-ai-act/acknowledgements/me`, `/api/admin/eu-ai-act/acknowledgements/...`, `/api/admin/eu-ai-act/users/{userId}/acknowledgements`. See `README.md` (Step 9) and `eu-ai-act-switch.md`. The text below keeps the paths of the time it was written.

Epic #3324 (EU AI Act Art. 50), step 2 (#3326, PR #3590). Read against `origin/claude/ai-act-3329-admin-page` on 2026-11-11. Paths are repo-relative, line numbers are from that branch and will drift: re-grep before editing. Nothing was run on a real Office, Chrome, Teams or Nextcloud host; every claim below is from code reading, and "UNVERIFIED" marks what needs a manual check.

## 0. Premise check (read this first)

The brief assumes "a user who only uses the Outlook add-in is blocked with enforcement on". The code says otherwise:

- `isMachinePrincipal()` exempts any principal with `clientId` set (`server/services/aiAcknowledgement/aiAcknowledgementService.js:146-150`). An authorization-code token is a user-delegated token and carries `clientId: decoded.client_id` (`server/middleware/jwtAuth.js:625-641`). The middleware returns `next()` for it (`server/middleware/aiAcknowledgementRequired.js:78`).
- Office/Outlook, the browser extension and the Nextcloud embed all sign in with OAuth authorization code + PKCE (`client/src/features/office/api/officeAuth.js:122-133`). So **they never get a 428**. They are not blocked. They are never asked, so they never produce evidence. The step-2 author's "they just show the apiErrors text on a 428" is therefore not what happens today: a 428 does not occur for them.
- The real defect is the opposite of the brief: **an Outlook-only user can use AI forever without confirming**, which defeats the audit purpose (A3 in the 3326 brief chose the exemption for machine callers and caught the delegated token by accident, `3326-ai-acknowledgement.md` A3).
- Teams and iframe/embed mode (cookie/SSO sessions) are human principals: enforced (428), and they mount the full `<App />`, so the dialog already exists there.

| Surface | Sign-in | `req.user` flags | 428 today | Dialog today |
|---|---|---|---|---|
| Outlook task pane + pop-out dialog | OAuth code+PKCE, public client "Office Add-in" | `isOAuthAuthCode`, `clientId` | No (exempt) | No (no provider in root) |
| Browser extension side panel | same, via `chrome.identity.launchWebAuthFlow` | same | No (exempt) | No (same `OfficeApp` root) |
| Nextcloud embed (iframe, `full-embed.html`) | OAuth code+PKCE via `window.open` popup | same | No (exempt) | Yes, client-driven only (full `<App />` + provider); not enforced. UNVERIFIED |
| Teams tab | Teams SSO -> iHub JWT, user persisted (`server/middleware/teamsAuth.js:250`) | normal user | Yes | Yes (full `<App />`). UNVERIFIED in a tenant |
| Embed mode (`?embed=true` iframe, iFinder etc.) | normal session (cookie/proxy/OIDC) or anonymous | normal user / guest | Yes | Yes (full `<App />`); guest in a cross-site frame loops (R2) |
| M365 Copilot agent | OAuth code, scopes `mcp:*`, MCP gateway | delegated | n/a: MCP is not behind the middleware | No, cannot be (non-goal NG2) |
| Personal API key, OAuth client_credentials, `/v1`, MCP, A2A | machine | `isPersonalApiKey` / `isOAuthClient` | No, by design | No, by design |

No other chat client exists: no mobile shell or native app (the only service worker, `client/src/services/swRegistration.js`, is the web app's cache), no script in `scripts/` posts to the chat API, and `/api/inference`/`/v1` are machine APIs. The web app's PWA/mobile browser view is the web app (covered by step 2). I found no integration beyond the five you listed plus the Copilot agent (`docs/microsoft-365-copilot-agent.md`), which I treat as out of scope.

---

## Part 1 - Product

### 1.1 Why
The confirmation is the deployer's evidence for Art. 4 AI literacy: "each user was told, at which version, when". Evidence exists only for users who pass through a surface that asks. Today the three OAuth-delegated surfaces are unrestricted and unlogged, so the compliance report (`Admin -> EU AI Act`, acknowledgement counts) shows "pending" for people who use iHub every day, and "acknowledged" cannot be claimed for the population. The PO decision "build it into our client integrations" means: every surface a person types a prompt into must ask once, record on the same per-user record, and honor `enforce`.

### 1.2 User stories (MoSCoW)
Must
1. As an Outlook user, I want to confirm the AI-use notice in the task pane before my first message, so that I never have to leave Outlook and my confirmation counts.
2. As a browser-extension user, I want the same in the side panel, so that sending a page to AI is not silently allowed.
3. As a Nextcloud user working in the embedded iHub, I want the same, so that the files I send are covered by the confirmation.
4. As a Teams user, I want the same in the tab, and to read the policy even though Teams controls navigation.
5. As a user of several clients, I want one confirmation for all of them, so that I am not asked per client (the record is per user).
6. As a user who closed the dialog, I want a clear note in the composer and a way to reopen it, and I do not want to lose my typed text or my email context.
7. As a compliance officer, I want enforcement to hold for these clients as for the web app (a bypass through the add-in is not acceptable), and `enforce:false` to behave as "ask once per session" everywhere.
8. As a user whose host blocks pop-ups, I want to read the policy anyway (link opens via the host API, else the address is shown to copy).

Should
9. As an admin, I want the Office, extension, Nextcloud and Teams admin pages and docs to say that the notice appears and is enforced there.
10. As an auditor, I want to see which client a confirmation came from (not stored today; see OQ4).

Could: confirm from the Outlook pane while the chat is popped out (works through the shared root, see 2c).

### 1.3 Success criteria (testable)
- In each of Outlook pane, Outlook pop-out, extension panel, Nextcloud embed, Teams tab: a user without a current confirmation sees the dialog before the first message leaves the client; after Confirm the same message is sent without retyping; `users.json` has `aiAcknowledgements[]` with the shown `version` and `textHash`.
- With `enforce:true`, a forged send from an Office or extension token without confirmation gets `428`, and a send after `POST /api/ai-acknowledgements/me` succeeds (server test per token type).
- Cancel keeps the draft and the host context (mail/page); no 401/"session expired" side effect for a not-yet-signed-in pane.
- Policy link: opens in the system browser from Outlook (all hosts), extension, Teams; when it cannot, the address is visible and copyable.
- One confirmation in client A means client B does not ask at its next send (after focus or the pre-send re-check).
- DE and EN complete; the dialog works at 320 px and with keyboard only; no new axe violations.
- No regression for the web app (existing `tests/unit/client/ai-acknowledgement.test.jsx`, `tests/e2e/ai-acknowledgement.spec.js`).

### 1.4 Non-goals
- NG1 No separate or per-client notice text, no per-client version.
- NG2 No acknowledgement for Copilot agent, MCP, A2A, personal API keys, client_credentials, inference API (nobody can click). Consequence stated openly: a user who only uses Copilot never confirms. Revisit as an MCP tool-result hint later.
- NG3 No native Office dialog (`displayDialogAsync`) or Teams task module UI (see 2f).
- NG4 No visual design (UX/UI own it), no change to the notice text or versioning.
- NG5 Not fixing unrelated Teams SDK issues (R9).

### 1.5 Risks, ambiguities, proposed resolutions
| # | Risk / ambiguity | Resolution |
|---|---|---|
| R1 | Several clients, one user | One record per user (`users.json`); every client reads `GET /api/ai-acknowledgements/me`. A client that holds stale state re-checks before opening the dialog and on window focus, so a confirmation made in the web app is picked up without a second prompt. Cross-tab `BroadcastChannel` already covers same-origin tabs; Outlook pane vs pop-out dialog and extension vs web are different origins/WebViews, so they rely on the re-check. |
| R2 | Anonymous/guest in embeds | Office, extension, Nextcloud and Teams always have a signed-in user (record-based, no cookie needed). Only embed mode can be anonymous. Guest proof is the `ihubAiAck` cookie, `SameSite=lax` (`guestAcknowledgement.js:111-117`, guest id `chatOwner.js:134-138`): a **cross-site** iframe drops it, so Confirm succeeds, the next send gets 428 again and the user is asked at every message. Resolution (client, now): after Confirm re-read the state; if still unacknowledged show "Your browser blocks cookies in this frame. Open iHub in its own tab to confirm" with `openExternalUrl`. Recommend authenticated embeds. Server `SameSite=None;Partitioned` for embed guests is OQ3 (size M, not recommended now). |
| R3 | 320 px pane | The dialog is an in-page overlay (no Office dialog). Requirements for UX: text region scrolls, Confirm and Cancel stay reachable without scrolling the page, no horizontal scroll, focus lands on the heading. Test at 320x568. |
| R4 | Policy cannot open | `window.open` returns `null` in the pane and extension panel (see `client/src/utils/externalNavigation.js:12-18`). Use the existing host-aware opener and fall back to showing the address with a copy button. Also require the notice text itself to carry the essentials; the link is supplementary. A relative `policyUrl` (`/path`, allowed by `isSafePolicyUrl`, `aiAcknowledgementService.js:249-252`) cannot open from `chrome-extension://` or `openBrowserWindow`: make it absolute on the server (2g). |
| R5 | Consent in a hosted iframe (Teams, Nextcloud, embed mode) | The confirmation is a server record bound to the authenticated user, not to the frame, so the frame is only the UI. Evidence quality depends on the host being trusted: Nextcloud already pins `frame-ancestors` to the admin allowlist (`server/routes/nextcloudEmbedPages.js`); for embed mode the admin must set `frame-ancestors` (`docs/embed-mode.md`, "Notes for hosts"). Say so in the docs. |
| R6 | Blocked users with no way out | Never show a bare 428 text. If the dialog cannot render (provider missing, `GET /me` failed, popups impossible) show the localized message plus "Open iHub in the browser" (`openExternalUrl(baseUrl)`), because the web app will ask there. |
| R7 | Upgrade surprise | Outlook, extension and Nextcloud users were never blocked; after the server change they are, until they confirm. Put it in `docs/releases/next/breaking-changes.md` (extend the existing "Users Are Asked to Confirm the Use of AI Once" entry) and tell admins `enforce:false` / `enabled:false` for gradual rollout. |
| R8 | Pane open during Request again | Same as the web app: 428 -> reactive path -> dialog -> retry once; draft restored if declined. |
| R9 | Teams SDK | `TeamsWrapper.jsx:39` and `TeamsTab.jsx:151` call v1-style `microsoftTeams.initialize()` while `client/package.json` pins `@microsoft/teams-js ^2.58` (v2 exposes `app.initialize()`). UNVERIFIED whether the tab initialises in a real tenant. Do not build `microsoftTeams.app.openLink` on it before a manual check. |

### 1.6 Open questions for the PO
- OQ1 Which delegated tokens are gated? Recommended: the three first-party UI clients (Office Add-in, Browser Extension, Nextcloud Embed), identified by the client ids stored in `platform.officeIntegration.oauthClientId`, `browserExtension.oauthClientId`, `nextcloudEmbed.oauthClientId`; every other delegated client stays exempt (NG2). Alternative: gate all delegated tokens and let a client opt out. Alternative is simpler to explain but can break unknown integrators that call the chat POST with a user token (CLAUDE.md: ask before compat behavior).
- OQ2 Accept that Copilot-only users never confirm (NG2)?
- OQ3 Cross-site anonymous embeds: accept the "open in own tab" fallback (recommended) or invest in partitioned cookies?
- OQ4 Record the client kind in the entry/audit (`client: office|extension|nextcloud|teams|web`)? Needs a `.strict()` schema change (`aiAcknowledgementRoutes.js:40-48`); additive, size S.

---

## Part 2 - Engineering

### 2a. Authentication and whether the 428 middleware applies
Mounted on `POST /api/apps/:appId/chat/:chatId` (`server/routes/chat/sessionRoutes.js:858-862`, after `chatAuthRequired`), workflow execute and chat step (`server/routes/workflow/workflowRoutes.js:820, 1053`), agent runs (`server/routes/agents/runs.js:163`). A no-op when `enabled` or `enforce` is false (`aiAcknowledgementRequired.js:77`).

| Surface | How it authenticates | Middleware applies? | Needs dialog? | Needs policy link? |
|---|---|---|---|---|
| Outlook pane / pop-out | `Authorization: Bearer` from `office_ihubtoken` (`officeAuthBridge.js:71-78`), OAuth code token; `req.user.id` = the user's `users.json` key (`jwtAuth.js:542, 625-626`) | **No** (`clientId` set -> exempt). It must become yes (2g.1) | Yes | Yes |
| Extension panel | same token, `installExtensionAuth.js:48-` reuses the Office interceptor; host permissions `<all_urls>` (`browser-extension/manifest.json`) | **No** -> must become yes | Yes | Yes |
| Nextcloud embed | same Bearer from `office_ihubtoken` (`client/nextcloud/full-app-entry.jsx:167`), user-delegated | **No** -> must become yes | Dialog already mounted via `<App />`; verify | Yes |
| Teams tab | `POST /api/auth/teams/exchange` -> iHub JWT (`teamsAuth.js:224-286`), set as cookie and returned; `validateAndPersistExternalUser` gives a `users.json` record (`:250`) | **Yes** (human principal) | Already mounted; verify | Yes |
| Embed mode | whatever iHub login the host uses; anonymous allowed if the platform allows it | **Yes** | Already mounted | Yes |
| Personal API key / client_credentials (`jwtAuth.js:329-344, 504-520`) | machine | No, correct | No | No |

`GET`/`POST /api/ai-acknowledgements/me` use only `authRequired` (`aiAcknowledgementRoutes.js:88, 142-146`) and `evaluateAcknowledgement` never checks machine flags, so an OAuth-delegated Office token can read and confirm the notice today with no server change: the dialog would work end to end, it is the enforcement and the UI that are missing.

### 2b. Endpoints and today's UI on 428 / 409
- Office/extension chat: `useOfficeChatAdapter.js:96` -> `useAppChat` -> `sendAppChatMessage` = `POST /api/apps/:appId/chat/:chatId` (SSE for the stream). Nextcloud, Teams, embed: same through `AppChat.jsx`. No workflow/agent UI in Office.
- 428 handling lives in `useAppChat.js:356-377` but only when `useAiAcknowledgement()` is non-null (`:117`). In Office/extension it is `null` (no provider), so a 428 would fall into the generic error branch (`:378-`) and render the `apiErrors` text. This never triggers today only because of the exemption. Once 2g.1 lands, it triggers, so the provider must be there first.
- 409 only comes from `POST /me`; no embedded surface calls it today.
- Draft loss: `OfficeChatPanel.submitMessage` clears the input right after `adapter.sendMessage` (`OfficeChatPanel.jsx:528-549`) and passes no `onSendRefused` (`useOfficeChatAdapter.js:96`), unlike `AppChat.jsx:923-928`. A declined reactive retry would lose the text.
- Start page hand-off: `OfficeChatPanel.jsx:663-709` auto-sends the text typed on the start page through `submitMessageRef`; if the gate declines there the text must go back into the input (`setInputValue(text)`, as in the non-send branch `:706`).

### 2c. Roots and reuse
| Surface | Root | Providers mounted | Consequence |
|---|---|---|---|
| Outlook pane | `client/office/taskpane-entry.jsx:82-97` -> `OfficeApp` in `MemoryRouter` | `OfficeConfigContext`, `EmbeddedHostProvider` only. No `AuthProvider`, `PlatformConfigProvider`, `UIConfigProvider`, no `Layout` | no provider; chat comes from `useAppChat` |
| Outlook pop-out dialog | `startPopout` `taskpane-entry.jsx:110-138` -> same `renderOfficeApp` -> `OfficeApp` | same | one fix covers it |
| Extension panel | `client/extension/sidepanel-entry.jsx:150-159` -> `OfficeApp` | same | same fix covers it |
| Nextcloud | `client/nextcloud/full-app-entry.jsx:250-257` -> `EmbedRoot` -> `<App />` (`:133`) | `App.jsx:901-917`: `AppProviders` > `AuthProvider` > `AdminAuthProvider` > `AiAcknowledgementProvider` | provider present; `Layout` hidden by embed mode |
| Teams | same `<App />`; `TeamsWrapper` inside the provider (`App.jsx:905-909`) | full | present |
| Embed mode | `<App />` | full | present |

`AiAcknowledgementProvider` (`client/src/shared/contexts/AiAcknowledgementContext.jsx:64-288`) is already safe outside the web providers: `useOptionalAuth()` is null-safe (`authContextValue.js:21-23`), `useUIConfig() || {}` (`:67`), `i18n` is initialised by the Office entries, `BroadcastChannel`/`sessionStorage` are guarded. It needs three small additions to be reusable (2f). It does not need `PlatformConfigContext`: `enabled`/`enforce` come from `GET /me` itself.

Wiring in `OfficeApp` (one place for three surfaces): wrap `<Routes>` at `OfficeApp.jsx:531-` with `<AiAcknowledgementProvider active={!!authData} ...>`. It must not fetch while signed out: a 401 from `GET /me` goes through `officeAuthBridge.js:95-` -> `refreshTokenOrExpireSession` -> `onSessionExpiredCallback` and would show "Your session has expired" on the login screen.

### 2d. Host constraints
- Outlook (Office.js): dialog in-pane is a normal React overlay (the `Modal` primitive, `client/src/shared/components/Modal.jsx`, `aria-modal`, focus trap; no portal into the host). `window.open` is a silent no-op in the pane (`externalNavigation.js:12-18`). The pop-out is an Office dialog with no `openBrowserWindow`: it asks the pane (`officeRemote`, `externalNavigation.js:131-140`). `displayDialogAsync` needs `messageParent` plumbing and cannot be shared with the extension; rejected (2f).
- Extension (MV3): extension pages get `script-src 'self'`, so the bundled React dialog is fine. Fetches to iHub use `host_permissions: <all_urls>` and bypass CORS (`docs/browser-extension.md`, CORS troubleshooting); the dev/unpacked fallback needs the extension origin in `cors.origin`, and `setup.js:385-396` already allows `Authorization`. `chrome.tabs.create` works without the `tabs` permission. No content script is involved (page text is read with `chrome.scripting.executeScript`, `extensionHost.js:84`), so nothing to inject the dialog into: the side panel is the only place.
- Teams: tab iframe; `window.open`/`target=_blank` from a tab can be swallowed by the Teams client depending on version. The SDK way is `microsoftTeams.app.openLink(url)` (requires a successful init, see R9). SSO and the cookie are irrelevant to the acknowledgement because the record is keyed by user id.
- Nextcloud: iframe created by `nextcloud-app/src/main.ts:59-65` has `allow="clipboard-write"` and **no `sandbox`**, and the embed already uses `window.open` for its OAuth popup (`nextcloudAuthDialog.js:25`), so popups and `target=_blank` work; clipboard copy works. Third-party storage: the OAuth token is in the iframe's own `localStorage`; cookies are not needed for a signed-in user.
- Embed mode: depends on the host's `sandbox`; assume `allow-popups`; if blocked, the "show the address" fallback applies.

### 2e. Opening the policy link
`client/src/features/chat/components/AiAcknowledgementDialog.jsx:90-105` renders a plain `<a target="_blank">`. That is a dead link in the Outlook pane and the extension panel. Replace the click with `openExternalUrlSettled(url)` (`externalNavigation.js:113`), which already does:
- Outlook pane: `Office.context.ui.openBrowserWindow` (`:144-146`); pop-out: through the pane (`:131-140`); extension: `chrome.tabs.create` (`:155-165`); web, Nextcloud, embed: `window.open(..., 'noopener,noreferrer')` (`:172-181`).
- Keep the `href` for middle-click and SR semantics in the web app (`preventDefault` only when the helper handled it).
- When the helper resolves `false`, or `canConfirmExternalOpen()` is false (pop-out, `:95-97`), show the URL as selectable text plus a Copy button (same pattern as `OfficeChatPanel.jsx:901`).
- Teams: add a `teams` branch to `detectExternalNavigationHost()` (`:46-69`) using `isTeamsEnvironment()` (`client/src/utils/teamsEnvironment.js`) and a lazy `import('@microsoft/teams-js')` -> `app.openLink`, falling through to `window.open`. Only after R9 is verified.
- Server: resolve a `/path` policy URL to an absolute URL (2g.2). Reject non-http(s) in the client again (same guard as `hasHttpUrl`, `sourceActions.js:67`).

### 2f. Architecture recommendation
**Recommended: one shared embed-aware gate (the existing provider + dialog), mounted by every embedded root; no per-client native dialogs.**
- Why: one dialog, one set of i18n/a11y/tests, same `ensureAcknowledged` / `handleAcknowledgementRequired` semantics (proactive plus 428 retry, 409 stale handling, draft restore). Nextcloud, Teams and embed mode already get it for free through `<App />`. `OfficeApp` is the single root of three surfaces (Outlook pane, Outlook pop-out, extension).
- Why not native dialogs: `displayDialogAsync` is a separate WebView (no shared React state, `messageParent` only, per-host dialog limits, unavailable in the extension), the extension would need a second implementation, and the Teams task-module equivalent a third, tripling text/hash/stale handling that must stay byte-exact for evidence.

Provider changes (all additive, web app unchanged):
1. `active` prop (default `true`): when `false` do not call `GET /me`. Office passes `!!authData`.
2. `viewerKey` and `identity` overrides: Office has no `AuthProvider`, so today `viewerKey` is `''` forever (`:69`) and `anonymous = !auth?.isAuthenticated` is true (`:265`), which would wrongly print "applies to this browser session only" for a signed-in Outlook user. Accept `viewerKey` and `anonymous` props from the host root; `OfficeApp` passes the signed-in state; remount with `key` on login/logout.
3. Staleness: re-read `GET /me` before opening the dialog when the cached state is "not acknowledged", and on `window` `focus`/`visibilitychange` (R1). Cheap (no-store, tiny).
4. Cookie-blocked detection (R2) and the "Open iHub in the browser" fallback (R6) in the dialog's error branch.
5. Dialog: policy opening per 2e.

Office wiring (`client/src/features/office/components/OfficeChatPanel.jsx`):
- Make `submitMessage` (`:463-`) gate first, mirroring `AppChat.jsx:2564-2571`: `if (gate && !(await gate.ensureAcknowledged({ hasPendingMessage: true }))) { restore text; return; }` before params are built and before `setInputValue('')` (`:547`). It is the single seam: typed send, start-page auto-send (`:696-701`), start form, resend all go through it.
- Pass `onSendRefused` to `useOfficeChatAdapter` -> `useAppChat` to restore the draft (as `AppChat.jsx:923-928`); forward the option in `useOfficeChatAdapter.js:96`.
- Render `<AiAcknowledgementNote />` (`client/src/features/chat/components/AiAcknowledgementNote.jsx`) next to `ChatInput` (`OfficeChatPanel.jsx:1239`) and on the start page composer (`OfficeStartPage.jsx`); check it at 320 px.
- Mail/page context: no change needed, it is read at send time (`useOfficeChatAdapter.js:105-`), after the gate.

### 2g. Server changes
1. **Gate first-party delegated tokens (needed).** In `jwtAuth.js` auth-code branch, after the client lookup (`:581-583`) set `user.isFirstPartyUiClient = isFirstPartyUiClient(decoded.client_id, platform)` (new helper comparing to the three `oauthClientId`s of OQ1). Change `isMachinePrincipal` to `isOAuthClient || isPersonalApiKey || isAgent || (clientId && !isFirstPartyUiClient)`. No migration (ids already live in `platform.json`; `officeIntegration` is in `server/defaults/config/platform.json:341`). The 428 problem body already carries `details.requiredVersion`; no payload change. Size S. This is a behavior change, not a compat shim (R7).
2. **Absolute `policyUrl` in `GET /me` (needed).** `aiAcknowledgementRoutes.js:114`: if it starts with `/`, return `buildPublicBaseUrl(req)` (`server/utils/publicBaseUrl.js:75`) + base path + path. Additive. Size XS. Mind `buildServerPath`/sub-path deployments.
3. **No new "status" endpoint.** `GET /me` is already the lightweight pre-send check (no-store, per language, `acknowledged` computed without the machine exemption). Clients pass `?language=`.
4. **CORS/rate limit:** nothing to change for the packaged extension (host permissions); `Authorization` is already allowed. `/api/ai-acknowledgements` has no explicit rate limiter mount in `setup.js:479-499`; check the default limiter covers it (focus re-checks add traffic).
5. **Optional (OQ4):** `client` field in the POST body and audit details.
6. Keep exempt: personal API keys, client_credentials, agents, third-party delegated clients, `/v1`, MCP, A2A, Copilot agent.

### 2h. Tests, docs, i18n, checklist
Tests
- Server (`server/tests/aiAcknowledgement.test.js`, extends the existing machine-principal cases at `:183-188, :304-`): `isMachinePrincipal` for first-party vs third-party delegated; middleware 428 for a first-party code token, `next()` for third-party; jwtAuth sets the flag from the three platform ids; `GET /me` absolute `policyUrl` behind `X-Forwarded-*`; guest cookie unchanged.
- Client unit (`tests/unit/client/`, model on `office-chat-handoff.test.jsx`, `office-app-routing.test.jsx`, `ai-acknowledgement.test.jsx`): provider `active={false}` makes no request; `viewerKey` change refetches; Office send gated, Cancel restores the draft, start-page hand-off declined restores the text, reactive 428 retries once; dialog policy click uses `openExternalUrlSettled` (mock) and shows the address when it resolves false; cookie-blocked branch; extension host with a `chrome.tabs.create` stub; Nextcloud/Teams roots render the dialog (jsdom).
- Playwright (`tests/e2e/`): feasible for the embedded roots because they are plain pages. `/office/taskpane.html` and `/extension/sidepanel.html` need a stubbed `Office`/`chrome` via `addInitScript` and a seeded token (mint one by running the PKCE flow with `page.request` against `/api/oauth/authorize` + `/api/oauth/token` as the default admin). `/nextcloud/full-embed.html#providerId=...` and `?embed=true` need no stub. Spike 0.5 day before committing. Cross-site third-party-cookie blocking and real Office/Teams hosts cannot be automated.
- Manual matrix (record result per cell in the PR): hosts Outlook classic Windows, new Outlook, Outlook for Mac, Outlook on the web; Chrome and Edge side panel (Firefox only if the build supports it); Teams desktop, web, mobile; Nextcloud 28 and 33 (file action and nav entry); iFinder-style iframe same-site and cross-site (signed in and anonymous). Scenarios: first send asks; Confirm sends the same message; Cancel keeps draft and context and shows the note; policy link opens or shows the address; Request again with the pane open; confirm in client A then open B (no prompt); DE; dark mode; 320 px; keyboard only and screen reader; pop-out dialog confirm then back in the pane.

Docs: `docs/ai-act.md` (the "Exempt" bullet at `:74` and "Enforcement" list: add the per-surface table above), `docs/outlook-add-in.md` and `docs/office365-integration.md` (user flow: first message shows the notice, blocked until confirmed; admin note on rollout), `docs/browser-extension.md`, `docs/nextcloud-embed.md`, `docs/embed-mode.md` (guest/cross-site cookie limit, `frame-ancestors` for evidence quality), `teams/README.md` and `docs/user-guide.md` (short). No new file, so no `docs/SUMMARY.md` change.

Release note: via `/document-feature`; extend the existing breaking-changes entry ("Users Are Asked to Confirm the Use of AI Once", `docs/releases/next/breaking-changes.md:864-874`) with "also in the Outlook add-in, browser extension and Nextcloud embed; those were not asked or blocked before", plus a features entry only if the first entry is not yet shipped (then fold it in, per the skill).

i18n (`shared/i18n/en.json` and `de.json`, both): reuse the existing `aiAcknowledgement.*` keys and `apiErrors.AI_ACKNOWLEDGEMENT_REQUIRED`. New: `aiAcknowledgement.policyBlocked` ("The policy could not be opened here. Copy this address into your browser."), `aiAcknowledgement.copyAddress`, `aiAcknowledgement.cookieBlocked`, `aiAcknowledgement.openInBrowser`, `aiAcknowledgement.unavailableHere` (fallback of R6). DE must be written, not left as default.

Ordered checklist (rough size, dev days)
1. PO answers OQ1-OQ4 (blocks 2).
2. Server: first-party flag and `isMachinePrincipal` change, absolute `policyUrl`, tests (0.5).
3. Provider: `active`, `viewerKey`/`anonymous` overrides, pre-open and focus re-check, cookie-blocked and fallback states (1).
4. Dialog: host-aware policy opening plus address fallback (0.5).
5. Office wiring: provider in `OfficeApp`, gate in `submitMessage`, `onSendRefused`, note in panel and start page (1).
6. Teams `openLink` branch, after the manual check of R9 (0.25, may drop).
7. Unit tests (1), Playwright spike and specs for Office/extension/Nextcloud/embed (1).
8. Docs, i18n EN+DE, release note (0.5).
9. Manual matrix on real hosts (1, needs Outlook, Teams tenant, Nextcloud).
Total about 6 days including manual verification; steps 2-5 are about 3 days and unblock enforcement. Run `npm run lint:fix && npm run format:fix` before committing; new files get the SPDX header.

Sequencing warning: do **not** ship step 2 without steps 3-5. Enforcing 428 for Outlook, extension and Nextcloud while their UI cannot show the dialog is exactly the blocked-user scenario the brief feared.
