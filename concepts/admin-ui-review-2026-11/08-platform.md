# Platform: Features, Voice input, Security, EU AI Act, Backup & Restore, Updates, Advanced — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/features`, `/admin/voice-input`, `/admin/security`, `/admin/eu-ai-act`, `/admin/backup`, `/admin/updates`, `/admin/advanced`, and the legacy `/admin/system`, which redirects to `/admin/security` (`client/src/App.jsx:879`).

All five panel notes were delivered. One limit applies to the whole panel. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min, shipped default) returned 429 for most of the session. EU AI Act and Updates were seen only partly working, and their findings come mostly from code. How each page *behaves* after a 429 is reported as a finding, because the same thing happens to a real admin behind a NAT or an untrusted reverse proxy. The panel created no entities and saved no settings. The admin downloaded one backup ZIP to inspect it and then deleted it.

## Summary

Platform is the operator console: preview-feature switches, speech services, inbound and outbound network security, EU AI Act transparency, configuration export and import, binary updates, and two maintenance switches. It is the least consistent part of the admin. The seven pages use five header patterns, four primary-button colours and three save models (per page, per card, save-on-click). None of them links to the docs. The high-stakes actions are the least protected:
- Choosing a ZIP restores it immediately, and the export holds the encryption key, the JWT keys and the password hashes.
- A Security section that failed to load still offers Save, and saving writes empty defaults.
- Two read-modify-write saves silently erase the proxy-JWT `jwkUrl`.
- Force client refresh fires without a confirmation.

Common Monday-morning tasks are only partly served. A private CA has no UI path, and the only TLS control is "ignore certificates". Session timeout, upload size and `trustProxy` cannot be found, and the last two have no UI at all. Updates never says "you are up to date".

There are good patterns to copy. The EU AI Act page has an honest configuration check with fix links, and a switch-off dialog worth copying. The Outbound Proxy card shows "In effect right now" and the source of each value. The staged binary update has signature checks and typed confirmation.

## 1. What this part does

- **Features** (`/admin/features`): 23 global on/off switches from `server/featureRegistry.js`, grouped into Preview, AI Capabilities, Content, Analytics and Platform. A single Save sits at the bottom of a page about 2,870px tall. The admin uses it at setup and after each release, when new preview flags appear.
- **Voice Input** (`/admin/voice-input`): it owns three products:
  - the default dictation service behind the microphone button (Browser, Azure Speech or a streaming model);
  - read-aloud (text-to-speech) and its model;
  - Voice Mode (preview).

  It also holds Azure Speech credentials and a test bench (microphone check, live dictation, record-and-transcribe). One Save, placed mid-page under the Azure card, saves all of it. The endpoints themselves live under Models. The admin uses this page once at setup.
- **Security** (`/admin/security`): one `AdminSettingsPage` with a left section nav and 8 sections: SSL/TLS, Cookies, CORS, Rate limits, SSRF allowlist, Tool approval, Outbound proxy and the Value Encryption tool. There are 7 independent Save buttons with 5 different labels (`AdminSecurityPage.jsx:267-318`). The admin uses it on day 1 to get outbound traffic working, then rarely.
- **EU AI Act** (`/admin/eu-ai-act`): 8 stacked cards (about 4,740px). They hold the master switch with a recorded reason, a configuration check with "Open settings →" fix links, the AI notice, the acknowledgement settings, acknowledgement records with CSV export, watermark keys, provenance settings, and an output verification form. The admin uses it once at setup and again during audits.
- **Backup & Restore** (`/admin/backup`): two buttons. "Export Configuration" downloads a ZIP of the whole `contents/` folder (`server/routes/admin/backup.js:120`). "Import Configuration" replaces it. The admin uses it before every update and, rarely, during an incident.
- **Updates** (`/admin/updates`): version tiles and an "Update Available" banner. For binary installs only, there is also download → verify → apply → restart detection, plus Install from file and Rollback. The admin checks it monthly.
- **Advanced** (`/admin/advanced`): two unrelated cards. "Don't show the onboarding" saves on click; "Force Client Refresh" reloads every connected client. The admin rarely uses it.

## 2. Is it intuitive? — verdict

Scores are the panel median, with the range across personas in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| Features | 3 (2–3) | Easy to scan as a grouped list. It gives no basis for a decision: nothing on risk, default, dependencies, or what appears in the UI when a flag is on. "Requires Chat History" exists only as prose and is not enforced. Save sits about 2,600px below the first toggle, and leaving the page loses changes without a warning. |
| Voice Input | 2.5 (2–3) | The copy is honest and the test bench is excellent. But the title "Voice Input (Speech-to-Text)" hides two of the page's three products. Azure is offered at the top while the switch that enables it is at the bottom. "Admin → Models" appears 4 times as plain text with no link. Several fields have no border. |
| Security | 3 (2–3) | The section nav is the right skeleton, and the Proxy card is the best card in the part. But each section looks different and has its own Save (one of them invisible). There is no path for a private CA. Sections that failed to load can still be saved. Each heading appears twice. |
| EU AI Act | 4 (3–4) | The best page in the part. The configuration check and the line "green = configured as designed, not legally compliant" are exemplary. It lacks an in-page nav, two cards point to the page itself, and there is no export to hand to legal. |
| Backup & Restore | 2 (2) | Export is one click. Import is a hidden instant restore. The page doesn't say the ZIP is as sensitive as the server, and the automatic pre-import snapshots are invisible. |
| Updates | 2 (2–3) | The binary flow is thorough. Every other case is opaque: no "up to date" message, no "check now", no last-checked time, no error, and on source/npm installs there is no instruction at all. |
| Advanced | 2.5 (2–3) | The name says nothing about the two items. One auto-saves; the other has fleet-wide impact and no confirmation. |

**Overall verdict:** not intuitive for a first-time operator. Each page is understandable on its own. The part as a whole fails the jobs that cross pages: corporate network (3 Security sections plus a doc), voice (Voice + Features + Models), backup before an update (Backup + Updates), and finding one setting (3 Authentication sections plus the app editor plus JSON). The admin persona completed only 1 of 7 tasks fully through the UI.

## 3. Task walkthroughs

The admin walked these tasks in the running UI. The other personas confirmed the sticking points in code.

1. **Decide which preview features to turn on and understand the risk.** 3 steps (nav → read 23 rows → docs search "feature flags", which lands on Platform Configuration).
   - Where it hurt: no default, risk or dependency information. The admin had to read `featureRegistry.js` to learn the defaults. Descriptions contain JSON and paths (`features.feedback: false`, `contents/data/run-log`).
   - Outcome: **partial** (frustration 3/5).
2. **Route outbound traffic through a corporate proxy and trust a private CA for a self-hosted LLM.** 7 steps (Security → scroll to Proxy → fields → Run test → test says "Direct — no proxy configured" while the banner says traffic goes through the environment proxy → scroll about 4,000px up to SSL → the toggle reveals a whitelist → no CA option).
   - Where it hurt: the contradictory test (PL-B13); the only TLS option is "ignore certificates"; the recommended fix (`NODE_EXTRA_CA_CERTS`/OS store, `docs/ssl-certificates.md:24-100`) needs shell access and a restart, and a docs search for "private CA" doesn't return that page.
   - Outcome: **partial** (4/5).
3. **Set up EU AI Act transparency and explain it to legal.** 6 steps (nav → check → notice → acknowledgement → watermark: "Set Output marking on a vLLM model", with no link → look for an export).
   - Where it hurt: cards linking to the page they are on; guessing that output marking lives under Models; no artefact for legal.
   - Outcome: configuration **success**, legal handover **failed** (2/5).
4. **Take a backup before upgrading and know how to restore.** 2 steps to export, 3 more to learn how to restore (page → docs → code).
   - Where it hurt: the downloaded ZIP held 127 files, including `.encryption-key`, `.jwt-private-key.pem` and `config/users.json`. Import has no confirmation. The pre-import snapshots can only be restored from the shell (`docs/admin-ui.md:529-536`).
   - Outcome: backup **success**, restore **partial** (3/5).
5. **Check for updates and learn what happens.** 2 steps (nav → "View Release on GitHub").
   - Where it hurt: this source install shows a green "Update Available" with no action and no explanation. There is no "Check now", no last-checked time and no link to Backup or What's New.
   - Outcome: **partial** (3/5).
6. **Enable speech-to-text for chat.** 8 steps (nav → read → Enable Azure → host and region *look* filled → key → Test fails with "Azure region is not configured" → unclear whether Save under the Azure card saves everything → dropdown).
   - Where it hurt: value-looking placeholders (PL-B17); Save placement; no Models link; input lost when navigating away.
   - Outcome: **partial**: the browser default works, Azure failed (4/5).
7. **Find session timeout and max upload size.** 6 steps (Cmd+K twice, with no results → docs search → Authentication page → app editor → `requestBodyLimitMB` exists only in JSON).
   - Where it hurt: session timeout appears 3 times (Local, LDAP per provider, NTLM). The global `auth.sessionTimeoutMinutes` (used for OIDC and proxy logins) has no UI. `docs/admin-ui.md` points to the wrong page.
   - Outcome: **failed** using the UI alone (4/5).

## 4. What is broken

The credits column uses PM, UX, UI, TW, ADM; "all" means all five personas.

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| PL-B1 | Confirmed (code) | Choosing a ZIP in "Import Configuration" immediately POSTs `/admin/backup/_import` and replaces all of `contents/` (users, keys, data). There is no confirmation, preview or version check. *all* | `AdminBackupPage.jsx:68-110`, `:243-249` (`onChange={handleImportConfig}`). Not executed: restore is forbidden. | P1 |
| PL-B2 | Confirmed (download) | The export is an unencrypted ZIP of everything except `.backups`: `.encryption-key`, `.jwt-private-key.pem`, `.jwt-secret`, `config/users.json` (password hashes), audit log, chats and blobs. The page says "All data and source files" (`en.json:2077`). Anyone with the file can decrypt every secret and forge tokens. *PM, UX, TW, ADM* | `server/routes/admin/backup.js:120-121, 292-310`; ADM ran `unzip -l` on a UI download: 127 files | P1 |
| PL-B3 | Confirmed (code + repro; verifier repro) | SSL, SSRF, CORS, Cookies and Proxy keep their defaults after a failed load and show the error above an editable form, with Save enabled (`disabled={saving}` only). One click writes an empty list over the real one. *UX, ADM* | `SSLConfig.jsx:12-15, 36-41, 300`; `SsrfConfig.jsx:229`; `CorsConfig.jsx:354`; `CookieSettingsConfig.jsx:171`; `ProxyConfig.jsx:685`. Lead repro: 7× "Request failed with status code 429" above editable forms on /admin/security. Verifier: with the SSL and SSRF GETs answered 429, both Save buttons are visible and enabled, and SSRF shows "No hosts allowed". | P1 |
| PL-B4 | Confirmed (code) | "Don't show the onboarding" (Advanced) and the Provenance Save (EU AI Act) GET the *redacted* platform config and POST it back. The GET strips `proxyAuth.jwtProviders[].jwkUrl` and the POST keeps `newConfig.proxyAuth`, so proxy-JWT login silently breaks. The AI notice and acknowledgement cards already `delete platform.proxyAuth`. *UX; verified by lead* | `AdminAdvancedPage.jsx:38-42`; `euAiAct/ProvenanceSettingsCard.jsx:191-198`; `server/routes/admin/configs.js:256-266, 358`; correct: `AiNoticeSettingsCard.jsx:58-59` | P1 |
| PL-B5 | Confirmed (verifier: computed `background-color: rgba(0,0,0,0)`, `color: #fff`) | The Cookies "Save Configuration" button uses `bg-primary-600`, but `@theme` defines no `primary` ramp, so it renders as white text on white (dark mode: bare text). UI said invisible and ADM "barely visible"; settled as invisible. *UI, ADM* | `CookieSettingsConfig.jsx:172`; `client/tailwind.css:33-60` | P1 |
| PL-B6 | Confirmed | Voice, TTS and update fields have no border (`border-gray-300` without `border`; there is no `@tailwindcss/forms` plugin, so Preflight's 0 width applies) and no designed focus ring (`focus:ring-*` without `ring-2`). This fails WCAG 1.4.11. Verification narrowed it: a focused field still gets the browser's default outline (`outline-style: auto`), so 2.4.7 is not failed. *UI* | `AdminVoiceInputPage.jsx:260, 533`; `voice/VoiceModeSettings.jsx:20`; `voice/DictationTest.jsx:21`; `voice/RecordingTest.jsx:16`; `tts/TtsVoicesPanel.jsx:257`; `updates/InstallFromFileCard.jsx:315`; `updates/StagedUpdatePanel.jsx:240` | P1 |
| PL-B7 | Confirmed (code + verifier repro) | The Import control is broken for keyboard users. An `opacity-0` file input sits over a `<button>` with no handler. Tab first lands on the invisible input: Enter there opens the picker, but nothing shows where focus is. The next Tab stop is the visible "Import Configuration" button, where Enter does nothing. `UploadConfigButton.jsx:7-11` fixes exactly this pattern but isn't used. Note that it hard-codes `accept=".json"` (`:21`), so it needs an `accept` prop before Backup can use it. *UI* | `AdminBackupPage.jsx:242-290` | P2 |
| PL-B8 | Confirmed (code) | Force Client Refresh reloads every client on one click. The success text "New salt: {{salt}}" contradicts the warning ("next page interaction" vs "page load"). *all* | `AdminAdvancedPage.jsx:59-82, 212-247`; `en.json:2048` | P2 |
| PL-B9 | Confirmed (pixel) | Features errors show green in German. The colour comes from `includes('Failed'\|'Error')`, and "Fehler beim …" matches neither. *all* | `AdminFeaturesPage.jsx:154`; TW measured rgb(0,130,54) in DE vs rgb(231,0,11) in EN | P2 |
| PL-B10 | Confirmed (code) | Updates never shows "up to date", "last checked" or "check failed/disabled", and has no "Check now" (`docs/admin-ui.md:556` promises one). `lastCheckedAt`, `error` and `versionCheckDisabled` are never read. *PM, UX, UI, ADM* | `AdminUpdatesPage.jsx:401` (banner only when `updateAvailable && !error`, no else) | P2 |
| PL-B11 | Confirmed | On an npm/source install, Updates shows a green "Update Available" with no action and no instruction. Containers get a notice; source installs get nothing. *UI, TW, ADM* | `AdminUpdatesPage.jsx:338` (`canUpdateInPlace = isBinary && !isContainer`), `:401-470` | P2 |
| PL-B12 | Confirmed (code) | Hosts on the SSL whitelist also bypass the SSRF private-address guard, even when "Ignore invalid certificates" is off. With the toggle off the list is hidden, so old entries grant SSRF trust invisibly. *PM; verified by lead* | `server/utils/httpConfig.js:158-163`; `SSLConfig.jsx:212-213` | P2 |
| PL-B13 | Confirmed (code + repro) | The Proxy banner says traffic goes through the environment proxy, but "Run test" reports "Direct — no proxy configured", and "No bypasses" sits beside 25 NO_PROXY entries "in effect". The draft config is built from form fields only, without the environment fallback. *ADM; settled by lead* | `ProxyConfig.jsx:258-263`; `server/routes/admin/proxy.js:581-598` vs `httpConfig.js:359-381` | P2 |
| PL-B14 | Confirmed (repro) | No page in scope guards unsaved changes, although `features/admin/hooks/useUnsavedChanges.js` exists. Voice shows "You have unsaved changes" and still lets the admin leave. *UX, UI, ADM* | UI `dd.log`; ADM `voice_leave.png` | P2 |
| PL-B15 | Confirmed | Errors show the raw axios text "Request failed with status code 429" instead of the problem+json `detail`. A Features load failure has no Retry. The SSL *load* error uses the save-error key. *all* | `SSLConfig.jsx:36-39`; `CookieSettingsConfig.jsx:32`; `AdminFeaturesPage.jsx:30-33` | P2 |
| PL-B17 | Confirmed (repro) | Azure Host and Region placeholders (`westeurope`) look like values; Test connection then fails with "Azure region is not configured". *ADM* | `AdminVoiceInputPage.jsx:604, 618` | P2 |
| PL-B18 | Confirmed (count) / Suspected (prod) | About 7 shell `/api/admin` calls fire on every navigation, and EU AI Act fetches `configs/platform` 4–5 times. The shipped `adminApi` limit is 100/min, against a code fallback of 500. Two admins behind one NAT trigger PL-B3 and B15. *PM, ADM* | `server/defaults/config/platform.json:238-241`; `server/middleware/rateLimiting.js:152` | P2 |
| PL-B19 | Confirmed (verifier repro: `ih-dark-mode=dark` stored, cold `/admin/backup` loads with no `data-theme`) | Dark mode is not applied on a cold `/admin` load. Only `useDarkMode` (via `DarkModeToggle`) applies the theme, and the admin layout doesn't mount it (cross-cutting). *UI* | UI `dd.log`; `hooks/useDarkMode.js:44-73`; `client/index.html` has no theme script | P2 |
| PL-B20 | Confirmed | At 390px the CORS Add button overflows (right edge 393px; verifier measured SSRF Add at 383px, inside the viewport but past the 16px gutter), and the demo-accounts alert wraps one word per line (+830px, cross-cutting). The Security nav is `hidden lg:block`, leaving a 10,280px scroll. *UI* | `CorsConfig.jsx:~180-190`; `SsrfConfig.jsx:~170-180`; `AdminDemoAccountsAlert.jsx:126-129`; `AdminSettingsPage.jsx:86` | P2 |
| PL-B21 | Confirmed | `docs/admin-ui.md` is wrong for this part. It describes TLS upload, SameSite and session expiry (none exist) and omits 4 Security sections. It describes "Defaults" and "vLLM Realtime" voice cards that don't exist, promises "Check for updates", and leaves EU AI Act out of the nav table. *all* | `docs/admin-ui.md:26, 330-337, 542-550, 552-560` | P2 |
| PL-B22 | Confirmed (verifier counted 27 single-line `t('key', …)` calls missing from both `en.json` and `de.json`; TW's script found 33) | 33 strings in scope have no locale key, so German shows English. That includes the whole CORS card, "Save Changes", the Backup and Advanced subtitles, and the Rollback dialog title. *TW* | TW `i18ncheck.py`; `shots/de-security.txt` | P2 |
| PL-B23 | Suspected | The sign-in limit (30 per 15 min, successful logins counted) can lock out a site behind one egress IP at the morning peak; it locked the panel out for more than 10 minutes. *PM* | `server/defaults/config/platform.json` `rateLimit.authApi`; PM `shoot4.log` | P2 |
| PL-B24 | Confirmed | The AI notice and acknowledgement cards on `/admin/eu-ai-act` say "Manage on the EU AI Act page" and link to the page they are on (`hideWhenOn` exists but isn't passed). *all* | `AiNoticeSettingsCard.jsx:97`; `AiAcknowledgementSettingsCard.jsx:104` | P3 |
| PL-B25 | Confirmed | Security headings are duplicated and inverted: section `<h2 text-lg>` followed by a component `<h2 text-xl>` ("Rate Limits / Rate limits"). *UI, UX* | `AdminSettingsPage.jsx:122`; `SSLConfig.jsx:130`; `RateLimitConfig.jsx:156`; `ProxyConfig.jsx:342` | P3 |
| PL-B26 | Confirmed | Cmd+K searches a hard-coded English page list. "cors" matches *Check for Updates*; "proxy", "ssl", "session timeout" and "upload" find nothing; "Run Backup" only navigates. *UX, ADM, PM* | `AdminCommandPalette.jsx:7-52` | P3 |
| PL-B27 | Confirmed | The Security scroll-spy highlights "Cookies" while SSL fills the viewport. UI marked it Suspected (no repro); the lead reproduced it (SSL at 112–618px, `aria-current` = Cookies). It happens when sections change height after their async loads. *UI, ADM* | `AdminSettingsPage.jsx:46-62`; `platform/lead/spy.js` | P3 |
| PL-B28 | Confirmed | A release note points to "Admin → Advanced → AI acknowledgement"; the card has moved to EU AI Act. *TW* | `docs/releases/next/breaking-changes.md:874` | P3 |
| PL-B29 | Confirmed | The Disclaimer modal title is invisible in dark mode (cross-cutting). *UI* | `shared/components/DisclaimerPopup.jsx:50-51` | P3 |

**Facts the lead settled.**
- **Sidebar order:** the Platform group is sorted alphabetically by the *translated* label (`AdminSidebarNavData.js:389-394`, which sorts every group, not only Platform), so English and German differ. UX had listed the source order.
- **Security buttons:** 8 sections, 7 Save buttons, 5 labels (panel counts ranged from 5 to 8).
- **Feature count:** the registry has 23 flags, 9 of them preview (the panel counted 20–22).
- **Voice docs:** no "vLLM Realtime" card exists in the code at all. ADM had suspected it appears conditionally; TW was right that the doc is stale.

## 5. Findings by persona

Breakages are in §4 and are not repeated here.

### Product manager

- **PL-PM1 — The private CA is not a first-class path.** The UI offers only "ignore certificates" plus a whitelist, while `docs/ssl-certificates.md:24-98` recommends trusting the CA. A cert store already exists for People Directory (`server/services/peopleDirectory/certStore.js`). *Do:* add "Trusted CA certificates" (PEM upload, subject and expiry, applied in `createAgent()`, a restart badge if needed) and demote "ignore" to a per-host fallback.
- **PL-PM2 — Backup is a one-shot download.** The 3 pre-import snapshots in `contents/.backups/` can't be listed or restored. There is no scope choice and no passphrase, and the metadata version is a hard-coded `'1.0'` (`backup.js:326`). "Last backup N days ago" on Overview was planned (2026-05-19 IA doc) but never built. *Do:* a restore-points list, export scopes, an optional passphrase, and the iHub version plus host in the metadata.
- **PL-PM3 — Feature flags have no metadata.** The registry holds only `id/name/description/category/default/preview`. The PUT doesn't enforce "Requires Chat History" (`server/routes/admin/features.js:68-90`), and "Integrations" is badged Preview but on by default. *Do:* add `requires` (enforced), `risk`/`dataImpact`, `configureAt` and `docs`; per-group targeting later.
- **PL-PM4 — Settings with no UI** (0 hits in `client/src`):
  - `requestBodyLimitMB` (50 MB) is the server's request body cap. (Verification removed the example given here: the 51,200 MB per-app limit at `appConfigSchema.js:259` is for video, of which the browser sends only the audio, so it does not conflict with the body cap.)
  - `auth.sessionTimeoutMinutes` sets the session length for OIDC and proxy logins (`tokenService.js:97`).
  - `trustProxy`: the help text says to edit the JSON (`en.json:2270`).
  - Also `update.allowUnsigned`/`trustedPublicKeys`, `swagger.*`, the `artifacts.*`/`skills.*` limits and `pdfExport.watermark.text`.
- **PL-PM5 — No deliverable for legal on EU AI Act.** *Do:* "Export compliance summary (PDF/Markdown)" built from `/api/admin/eu-ai-act/status` plus conformity history: duties → measures, notice and acknowledgement text and version, watermark-capable models, retention.
- **PL-PM6 — Within this part, restart-required is shown only for rate limits** (`RateLimitConfig.jsx:169`; outside the part, Chat History also reads `restartRequired`, `AdminChatHistoryPage.jsx:333`). *Do:* `restartRequired` on every save, plus a "Restart pending since HH:MM" banner. Advanced also lacks a redacted support bundle and a "Reload configuration" action.

### UX designer

- **PL-UX1 — Three save models in one part.** Pages save per page (Features, Voice), per card (Security ×7, EU AI Act ×3–4) or on click (Advanced). Security uses `AdminSettingsPage` but passes no `dirty`/`onSave`, so its sticky bar (`AdminSettingsPage.jsx:132-166`) never shows. *Rule:* settings use the sticky Save/Discard bar plus `useUnsavedChanges`; actions are explicit buttons with confirmation.
- **PL-UX2 — Failed loads must not be editable.** Render `AdminLoadError` with Retry in place of the form. Map 429 to "The server is limiting requests from this address — try again in N s", using `RateLimit-Reset`.
- **PL-UX3 — Voice orders its dependencies backwards.** "Azure Speech (not enabled)" is offered at the top, but enabling it is in the last card. Dictation tests run against the saved configuration, read aloud before saving. *Do:* tabs Dictation / Read aloud / Voice mode, each opening with a requirements strip ("✗ no TTS model → [Add model]"). Show Azure inline under the picker, and turn "Admin → Models" into links (`AdminVoiceInputPage.jsx:310, 431, 508, 517`).
- **PL-UX4 — The SSL form steers admins to the insecure option.** The toggle does nothing until a host is added (`en.json:2130`), and Proxy repeats the pattern ("On its own this switch proxies nothing"). *Do:* make the host list the control and put a "Trust a company CA (recommended)" block above it. Proxy is "on" when a URL is set.
- **PL-UX5 — Two backup systems that don't know each other.** Updates keeps its own snapshot (`StagedUpdatePanel.jsx:245-247`). *Do:* one "Restore points" table listing pre-import and update snapshots.
- **PL-UX6 — EU AI Act mixes setup, operations and a tool.** *Do:* sections Status / Transparency / Marking / Verify on `AdminSettingsPage`, so the `#ai-notice` fix links land visibly in a nav.

### UI designer

- **PL-UI1 — No shared page frame.**
  - Five header patterns: a `text-3xl` band (Features `:90-99`, EU AI Act `:46-58`); a header inside a card (Voice `:300-314`); plain `text-2xl` (Backup `:120`, Updates `:350`, Advanced `:91`); and `AdminSettingsPage` (Security).
  - Three widths: `max-w-4xl`, `6xl` and `7xl`.
  - Features (`:88`) and Voice (`:297`) paint their own `bg-gray-50/900` slab over `gray-950`.

  *Do:* all seven pages on `AdminSettingsPage` at `max-w-6xl`, with `headerActions`, `docsHref` and section `keywords`.
- **PL-UI2 — Four primary colours.**
  - indigo-600: Features, Voice, Tool approval, EU AI Act.
  - blue-600 with a check icon: SSL `:250`, CORS `:358`, SSRF `:176`, Rate limits `:306`, Proxy `:522/593`.
  - green-700: Backup `:207`, Updates `:449`.
  - orange-700: Force refresh `:219`.
  - Plus the missing `primary` token (PL-B5).

  The theme defines `--color-admin-accent` (`tailwind.css:36`). *Do:* use the button tokens that already exist in `features/admin/components/formStyles.js` (`PRIMARY_BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `DANGER_BUTTON_CLASS`, already used by 15 admin files; primary is `blue-600` today). Settle their colour on `admin-accent` or blue once, and replace the per-page classes. Restore, Force refresh and Switch off use `danger`.
- **PL-UI3 — Security sections are four visual species.** They differ in icon gutter, card or no card, and an amber "warning" box for plain instructions. Booleans are switches in SSL and CORS but checkboxes in Cookies and Proxy. `yellow-*` is used instead of `CALLOUT_CLASS` (SSL `:147`, SSRF `:116`). *Do:* one card anatomy, no inner `<h2>` (PL-B25), only `CALLOUT_CLASS` tones.
- **PL-UI4 — Wrong status tones.** "Update Available" uses success green with a check-circle (`AdminUpdatesPage.jsx:402-405`). The Preview badge is amber on Voice and blue on Features. *Do:* the info tone for updates, and one `<PreviewBadge>`.
- **PL-UI5 — Reuse over re-implementation.** CORS, SSRF and both Proxy lists each re-implement "input + Add + list". One `HostListInput` chip editor would fix PL-B20 once. Below `sm`, hide the icon gutters (they take 64 of 358px).
- **PL-UI6 — The model dialog already exists.** The EU AI Act switch-off dialog has "switched off / stays" columns, a required reason, an acknowledgement and a red confirm. Restore and Force refresh should copy it.

### Technical writer

- **PL-TW1 — Zero contextual help.** The in-scope pages have no links to `/admin/docs`, although `features/admin/utils/docsLinks.js` builds them and the redesign draft asked for "Learn more →" (`concepts/admin-redesign-2026/2026-05-19 Admin UI Redesign Draft.md:233`). The map is in §9.
- **PL-TW2 — Misleading microcopy:** the SSL toggle promises a global bypass; the Cookies text is a double negative; "New salt"; "All data and source files"; help text that sends admins to JSON (`features.textToSpeech: false` has no app-editor toggle). The rewrites are in §9.
- **PL-TW3 — Terminology drift.**
  - Whitelist vs allowlist on one page.
  - SSL vs TLS.
  - "Backup" means four things. Name them *configuration export*, *pre-import snapshot*, *previous version* and *integration migration backup*.
  - Flag names don't match the nav: Prompts Library / Prompts, Tool Calling / Tools, Agent Factory / Agents.
  - Docs use three nav-path conventions.
  - German drifts between EU-KI-Verordnung and EU AI Act, and between Nutzer, Nutzende and Benutzer.

  *Do:* use *allowlist* and *TLS*, and write nav paths as **Admin → Platform → Page → Section**.
- **PL-TW4 — Error copy has no pattern.** One EU AI Act page uses three error forms; Security uses five Save labels with mixed casing. *Do:* use the helper that already exists, `apiErrorMessage(error, t, fallback)` in `client/src/utils/apiErrorMessage.js`. It reads the translated `code`, then the problem+json `detail`, and Backup already uses it. (`getAdminApiErrorMessage` in `api/adminApi.js` is a second helper.) Add the templates "Couldn't load {thing}. {detail} [Retry]" and "Save {thing}".
- **PL-TW5 — Flag descriptions don't answer "should I?".** They run from 7 to 60 words and contain jargon (`app__<id>`, HITL, `contents/data/run-log`). *Do:* give each flag *What users get* / *What it needs* / *Risk & data* plus "Learn more". Use a single Preview signal.
- **PL-TW6 — House style to copy:** the Outbound Proxy card. It shows where each value comes from, what is "In effect right now", and a classified test with a "Next step" (`ProxyConfig.jsx:277-318, 645`).

### iHub admin

- **PL-ADMIN1 — One honest connectivity test.** "Test my LLM endpoint" against the *effective* configuration (draft plus environment, labelled as such). It reports DNS → proxy → TLS chain and issuer → SSRF → HTTP and names the failing layer (fixes PL-B13).
- **PL-ADMIN2 — Updates for every install type.** A "How to update this installation" box: npm (`git pull && npm run install:all && npm run prod:build` + restart), container (pull + recreate), binary (the existing flow). Link it to `INSTALLATION.md#update-procedures`, and add `lastCheckedAt`, "Check now" and in-product What's New.
- **PL-ADMIN3 — Voice save placement.** The single Save under the Azure card saves the whole page (`AdminVoiceInputPage.jsx:671`); the admin assumed it saved only Azure. *Do:* a sticky bar with a change count, and "e.g." placeholders (PL-B17).
- **PL-ADMIN4 — EU AI Act small fixes.** Link "Set Output marking on a vLLM model" to the model editor. Reword the empty state "No languages configured. Add a language to get started" (it reads as "off").
- **PL-ADMIN5 — Cut self-inflicted rate limiting.** Cache `auth/status`, `system/storage` and `demo-accounts` for 60 s. Load EU AI Act from one call. Ship `adminApi` at the code fallback (500) (PL-B18).

## 6. What should be rearranged

1. **Group the Platform sidebar by job, in a fixed order, not alphabetically per language** (`AdminSidebarNavData.js:389-394`):
   - **Settings:** Features, Voice & speech, Security.
   - **Governance:** EU AI Act, Tool approval.
   - **Maintenance:** Backup & restore, Updates, Maintenance (was Advanced).

   This gives support and docs a stable "third item" in every language.
2. **Security: regroup the in-page nav by direction and put the related sections next to each other.**
   - **Outbound:** Outbound proxy → TLS trust (was SSL) → SSRF allowlist.
   - **Inbound:** CORS → Cookies & sessions → Rate limits & trusted proxy hops.

   Today Proxy is section 7 and SSL section 1, about 4,000px apart, although task 2 needs both. Keep one page (see §10).
3. **Move Tool approval out of Security** into the Governance group, next to EU AI Act. It is an AI-use policy, not transport security.
4. **Move the Value Encryption tool to Maintenance**, with a "When do you need this?" line: only for `.env` values, since platform secrets are encrypted automatically on save. Link it from Credentials.
5. **Rename "Voice Input" → "Voice & speech"** (DE "Sprache & Audio") and split it into tabs: Dictation (with Azure inline under the picker), Read aloud, Voice mode, Test.
6. **Rename "Advanced" → "Maintenance"** and give it force refresh, onboarding, the encryption tool, support bundle and reload configuration. Keep onboarding here, behind a normal Save.
7. **Put the backup inside the update flow.** Add "Download a backup first" as step 1 of the Updates "Update available" card. Make Backup list the update snapshots too, so the two pages share one notion of restore points. Don't merge the pages (see §10).
8. **Add a "Server & limits" section** (under Security › Inbound, or Maintenance) for `requestBodyLimitMB`, `trustProxy` and the global session length. Add a read-only "Session length per sign-in method" row on Security › Cookies & sessions that links to Authentication.
9. **EU AI Act:** sections Status / Transparency / Marking / Verify with a section nav, and hide the self-referencing state notes.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| File input that restores on `onChange` | Restore wizard with preview and typed confirmation (§8); Force refresh via `ConfirmDialog` | Catastrophic or fleet-wide, one click today (PL-B1, PL-B8) |
| Single "Export Configuration" button | Export dialog: scope (configuration only / configuration + data), "include keys" + passphrase, plain list of what's inside | The file is as sensitive as the server (PL-B2) |
| "Ignore Invalid SSL Certificates" toggle + hidden whitelist | "Trust a company CA (recommended)" with status + PEM upload; below it, "Skip verification for these hosts" where the list is the control | The UI teaches the insecure fix; the toggle alone does nothing (PL-PM1, PL-UX4) |
| Proxy test on the raw draft | One "Test a URL" against the effective config with DNS/proxy/TLS/SSRF/HTTP verdicts | One answer to "why can't iHub reach my LLM?" (PL-B13, PL-ADMIN1) |
| 7 Save buttons, 5 labels; per-page saves with no guard; auto-save checkbox | `AdminSettingsPage` sticky save bar + per-section dirty dots + `useUnsavedChanges`; per-section save only where a restart is needed | One mental model; no silent loss (PL-UX1, PL-B14) |
| 23 flat switches with prose dependencies | List rows with maturity, "Requires X" chip (switch disabled or chained enable), "Configure →", "Learn more", and a details drawer; filters On/Off/Preview/Changed | Turns the list into a decision tool (PL-PM3, PL-TW5) |
| Voice Mode needs a Features flag *and* a Voice setting | Enable both from the Voice mode tab in one action; show the flag state inline | Two switches for one intent (PL-UX3) |
| Cmd+K: hard-coded English page list | Settings index from `AdminSettingsPage` section `keywords` + i18n labels + synonyms; "Run Backup" actually downloads | Task 7 failed (PL-B26) |
| Updates silent unless an update exists | Status-first header: "Up to date · 5.6.4 · checked 10:04 [Check now]" / "Check failed: release server unreachable → Proxy" | PL-B10 |

## 8. Wizards to add

**1. Connect through a corporate network** *(the highest-value wizard)*
- **Starts:** as an optional step in `/setup` (`SetupWizard.jsx`, before the provider test), and from a "Set up network access" button at the top of Security › Outbound.
- **Who:** every on-premises admin on day 1. "unable to verify the first certificate" is the classic first ticket.
- **Steps:**
  1. Which URL must iHub reach? (prefilled with the configured LLM endpoints) → run the layered test.
  2. If the target is unreachable: "Do you use an HTTP proxy?" → proxy URL (shows any environment value it would inherit) → bypass list → test again.
  3. If TLS fails: "Is it signed by your company CA?" → upload PEM (or copyable `NODE_EXTRA_CA_CERTS` instructions plus a restart notice). Fallback, marked not recommended: skip verification for this host only.
  4. If the host resolves to a private IP: offer to add it to the SSRF allowlist, and say why.
  5. Review the diff of `proxy`, `ssl`, `ssrf` → save → final test ✓.
- **Ends with:** a passing end-to-end request through the effective configuration; saves proxy, trusted CA and allowlists. **Replaces:** three Security sections about 4,000px apart plus `ssl-certificates.md`.

**2. Restore from backup**
- **Starts:** Backup & restore → "Restore…" (danger zone), or [Restore] on a row in the restore-points list.
- **Who:** an admin in an incident or a migration. Rare, and catastrophic if done wrong.
- **Steps:**
  1. Choose a source: uploaded ZIP, an automatic pre-import snapshot, or an update snapshot.
  2. Preview: iHub version, source host, export date, file count, and a change summary (apps +3/−1, platform.json changed, users replaced). Warn "⚠ the encryption key differs: secrets will not decrypt".
  3. "Download the current state first" (on by default; a snapshot is also taken automatically).
  4. Type the instance name or RESTORE.
  5. Progress → result → "Reload admin", with an "Undo (restore the snapshot just taken)" button.
- **Validates** structure, version and key mismatch before writing anything. **Replaces:** the instant file input and the shell procedure in `docs/admin-ui.md:529-536`.

**3. Prepare for update** *(a checklist stepper on the Update-available card, not a modal wizard)*
- **Who:** the monthly updater.
- **Steps:**
  1. Read what's new between current and target (in-product changelog), with breaking changes highlighted.
  2. Download a backup (inline).
  3. Install, depending on the install type: binary download → verify → apply (existing `StagedUpdatePanel`); container: copyable pull command; source: copyable commands.
  4. Post-update health check: version, migrations applied, models reachable, with a rollback link.
- **Replaces:** a green banner with only a GitHub link.

**4. Set up voice**
- **Starts:** the Voice & speech empty state ("Voice isn't set up yet").
- **Who:** an admin enabling dictation once.
- **Steps:**
  1. Pick the dictation source: Browser / Azure / streaming model. For Azure, enter key and region inline and run Test connection. For a model, open the model editor pre-filled from a template (Voxtral/vLLM, Whisper/OpenAI, Gemini, Azure) and return here.
  2. Microphone check plus a live dictation test (existing `voice/*` components).
  3. Optional read aloud: pick or create a TTS model, then test.
  4. Optional voice mode: enable the feature flag *and* the setting in one step, then "Try it".
- **Validates:** each provider with a real test call; saves only after a green test.

**Where a wizard would be wrong:**
- **EU AI Act:** the configuration check already is a checklist with fix links, and the page is used again during audits. Add a first-visit "guided" mode of that checklist and the legal export, not a modal wizard (see §10).
- **Features:** 23 independent switches revisited every release. Offer presets ("GA only", "Standard", "Pilot: all previews") shown as a diff before applying, not a wizard.
- **CORS, Cookies, Rate limits, SSRF and Tool approval:** power-user policy screens that are edited one value at a time. They need clear copy, Learn-more links and a safe save model, not steps.
- **Advanced/Maintenance:** single actions, which need confirmations rather than flows.

## 9. Documentation

**What exists, and how good it is**
- **`docs/admin-ui.md`, Platform chapter: wrong or stale.**
  - Security (`:542-550`) describes features that don't exist and leaves out 4 real sections.
  - Voice (`:330-337`) describes cards that don't exist.
  - Updates (`:552-560`) is 4 bullets.
  - Features (`:312-316`) covers 16 of the 23 flags.
  - The navigation table (`:26`) leaves out EU AI Act.
  - Backup (`:521-540`) gets the manual restore right but calls the archive "configuration JSON files".
- **Good reference docs, but the UI never links to them:**
  - `ssl-certificates.md`, which covers CA trust but is titled "Self-Signed…" and ranks poorly for "private CA".
  - `proxy-configuration.md`, `rate-limiting.md` and `tool-approval.md`.
  - `ai-act.md`, which is accurate but written for engineers (API names, cache TTLs).
  - `provenance.md`, `microphone-feature.md`, `voice-transcription.md` and `text-to-speech.md`.
  - `value-encryption-tool-ui.md`.
  - `INSTALLATION.md#binary-installation-updates`, which is excellent for binary installs.
- **JSON only:** `platform.md` documents 2 of the 23 flags. CORS, cookies and `requestBodyLimitMB` appear only as JSON.
- **Missing:** force refresh, a backup topic, a feature-flag reference, a corporate-network guide, and a "where is setting X?" index. An EU AI Act brief for legal is only partly missing: `ai-act.md:6-11` opens with a Duty / What iHub does / What the operator does table, but the page then turns to engineering detail, and there is no artefact to hand over. `encryption-key-management.md` doesn't say that the admin export contains the key.

**Tasks a new admin cannot learn from the docs today**
- Which preview features to turn on, and what each one risks or stores.
- Setting up a proxy plus a private CA through the UI.
- That the backup holds secrets, and how to restore a pre-import snapshot or restore onto a new server.
- How to update a source or container install *from the Updates page*. The procedures exist in `INSTALLATION.md#docker-installation-updates` and `#npm-installation-updates`, but nothing links to them, and the npm section restarts with `npm run dev`, not a production build.
- Where session timeout, upload size, the request body limit and the proxy hop count are set.
- What force refresh does.
- What to hand to legal.

**New pages** (add them to `docs/SUMMARY.md` under Administration):
1. **`docs/feature-flags.md`, "Choosing platform features":**
   - Preview vs stable.
   - One table per category: ID, default, what users and admins see, what it requires, data stored or external calls.
   - Recommended starting sets.
   - What turning a flag off does to existing data.
2. **`docs/backup-restore.md`, "Back up and restore iHub":**
   - What the export contains, with a sensitivity column.
   - Where to keep the ZIP.
   - Restoring on the same server vs a new one (the keys travel with the backup).
   - Pre-import snapshots, and how they differ from update rollback.
   - Volume and Kubernetes caveats (moved from admin-ui.md).
3. **`docs/corporate-network.md`, "Running behind a corporate proxy with a private CA":**
   - Symptoms.
   - Decision tree: trust the CA (recommended) or skip verification per host.
   - Proxy and bypass list.
   - The SSRF allowlist, including the coupling to the TLS host list (PL-B12).
   - How to read the test result.
4. **`docs/ai-act-legal-summary.md`, "EU AI Act: summary for your legal team":**
   - What Art. 50 asks, what iHub does (no API names), and what the operator decides.
   - Which records are kept and for how long.
   - How to answer an auditor.
   - "Configured as designed ≠ compliant".
5. **Rewrite `admin-ui.md` → Platform:**
   - Fix the Security, Voice, Updates and Features sections.
   - Add EU AI Act and Maintenance.
   - Add a **"Where is…?"** table: session timeout (per sign-in method → Authentication), upload size (per app → app editor › Upload), request body limit, proxy hop count, read-aloud opt-out.
   - Write nav paths as **Admin → Platform → Page → Section**.

Also fix `docs/releases/next/breaking-changes.md:874` (PL-B28), and add screenshots for Security, EU AI Act, Backup, Updates and Advanced.

**Contextual help in the product.** Add a `docsHref` to `AdminSettingsPage` and to each section, built with `docsLinks.js`:

| Page / section | Links to |
|---|---|
| Features (header and each row) | `feature-flags.md#<id>` |
| Voice & speech | `microphone-feature.md`, `text-to-speech.md`, `voice-transcription.md` |
| Security › TLS trust / Outbound proxy | `ssl-certificates.md#recommended-approach-import-certificates` / `proxy-configuration.md`, and `corporate-network.md` from the wizard |
| Security › Rate limits / Tool approval | `rate-limiting.md#changing-the-limits` / `tool-approval.md` |
| EU AI Act | `ai-act.md#admin-page`; the legal export links to `ai-act-legal-summary.md` |
| Backup / Updates / Value Encryption | `backup-restore.md` / `INSTALLATION.md#binary-installation-updates` / `value-encryption-tool-ui.md` |

**Help text to rewrite (current → proposed)**
- **SSL toggle.** Current: "Ignore Invalid SSL Certificates — When enabled, allows connections to services with self-signed or invalid SSL certificates." Proposed: "**Skip certificate checks for these hosts.** Use only when you can't make the server trust your company CA. Every host not listed is still verified, and listed hosts may also resolve to private addresses. Recommended instead: trust your CA → Learn more."
- **Cookies.** Current: "Disable Secure Cookie Flag — When enabled, removes the 'secure' flag…". Proposed: "**Allow sign-in over plain HTTP (not recommended).** Turn this on only for internal installations without HTTPS. Anyone on the network can then read session cookies."
- **Backup.** Current: "All data and source files". Proposed: "Everything in `contents/`: configuration, users and password hashes, encryption and signing keys, audit log, chats and uploads. **Anyone with this file can decrypt your stored secrets.**"
- **Force refresh.** Current: "…New salt: {{salt}}. All clients will refresh on their next page load." Proposed: "Refresh sent. Signed-in users reload on their next page load."
- **Rate limits.** Current: "…(trustProxy in platform.json)…". Proposed: a real "Trusted proxy hops" field. Until it exists: "Set only in platform.json (`trustProxy`) → Learn more."
- **Voice title.** Current: "Voice Input (Speech-to-Text)". Proposed: "Voice & speech", with the subtitle "Dictation, read aloud and voice mode". Write the Azure placeholder as "e.g. westeurope".
- **EU AI Act notice, empty state.** Current: "No languages configured. Add a language to get started". Proposed: "Using the built-in text (shown below). Add a language to override it."
- **Updates on a source install.** Current: nothing. Proposed: "This installation runs from source. To update, run `git pull`, `npm run install:all` and `npm run prod:build`, then restart. Download a backup first → Backup."
- **Everywhere:** use one Save label per section ("Save {thing}") in sentence case. Add the 33 missing locale keys. Extend the existing CI check `tests/unit/client/translation-keys-exist.test.jsx` to cover `features/admin`: today it skips that folder and every `admin.` key (PL-B22).

## 10. Where the panel disagreed

- **EU AI Act: wizard or not?** PM and UX proposed a setup wizard; TW said no wizard is needed; UI and the admin called the configuration check "already a checklist". **Resolution:** no modal wizard. The check *is* the guide. Add a first-visit guided mode that walks its items, plus the legal export. The page is revisited during audits, and a wizard would hide the operational cards.
- **Split Security into two pages, or regroup one page?** PM and the admin want separate "Network" and "Access protection" pages; UX, UI and TW want grouped sections inside one page. **Resolution:** one page with grouped nav (Outbound / Inbound), and Tool approval and Value Encryption moved out. With those two gone, six sections remain, which a section nav handles well. Two pages would separate CORS from the outbound sections it is often confused with, and would double the save-model work.
- **Merge Backup and Updates?** PM proposed "Versions & Backups"; the others proposed cross-links under a Maintenance group. **Resolution:** keep two pages, and embed "Download backup" as step 1 of the update flow plus a shared restore-points list. Backup also serves migrations and incident restore, which have nothing to do with updates.
- **Where Voice belongs.** The admin wants it under AI Workspace next to Models; the others want it in Platform. **Resolution:** keep it in Platform › Settings, because it sets platform-wide defaults and secrets. Fix the coupling with links and requirement strips instead of moving it.
- **Features presentation.** UI and the admin proposed a card grid with a drawer; UX proposed expandable rows; PM and TW proposed metadata in the rows. **Resolution:** keep a scannable list (23 items compare better in rows than in cards), add metadata slots and a details drawer. No card grid.
- **The long tail of hidden settings.** PM wants a schema-validated platform.json editor; the admin wants specific fields. **Resolution:** first add fields for the settings admins actually look for (`requestBodyLimitMB`, `trustProxy`, global session length) and a *read-only* effective-config viewer. Defer a raw editor: it would hit the same redacted round-trip that causes PL-B4, and it bypasses the encrypt-on-save path.
- **Value Encryption destination.** PM, TW and UI said Advanced/Maintenance; the admin said Credentials; UX and UI also floated an inline "Encrypt…" next to every secret field. **Resolution:** Maintenance, linked from Credentials. Inline encryption is wrong, because admin-saved secrets are already encrypted at rest, and an inline button would suggest otherwise.
- **Rate-limit default.** The admin wants to raise `adminApi` to 500; others treated the 429s as an artefact of the test environment. **Resolution:** the fan-out is real (about 7 shell calls per navigation, 4–5 duplicate fetches on EU AI Act). Cut the fan-out *and* align the shipped default with the code fallback; PL-B3 and PL-B15 make a 429 dangerous, not just slow.
- **Severity of the borderless fields (PL-B6).** UI rated it P1 for accessibility; others didn't mention it. **Resolution:** kept at P1. It is a WCAG failure on a whole page, and the fix is mechanical.

## 11. Top recommendations

| # | Recommendation | Why | Impact | Effort | Type |
|---|---|---|---|---|---|
| 1 | **Make saves safe.** Disable or replace forms that failed to load with `AdminLoadError` + Retry (PL-B3). Delete `proxyAuth` in the Advanced and Provenance read-modify-writes, or move them to partial POSTs (PL-B4). Fix the invisible Cookies Save (PL-B5). Colour status by type, not by string (PL-B9). | Four ways to silently break production config or mislead the admin, each a small fix | H | S | fix |
| 2 | **Confirm before destructive actions.** Restore preview + typed confirmation via `UploadConfigButton`, with a new `accept` prop (PL-B1, PL-B7). The existing `shared/components/ConfirmDialog.jsx` on Force refresh (PL-B8). Modelled on the EU AI Act switch-off dialog. | The part's highest-stakes actions have no guard | H | S | fix/UX |
| 3 | **Honest, safer backups.** Sensitivity callout and a plain list of contents; export scopes; optional passphrase; iHub version in the metadata; restore-points list with the pre-import and update snapshots; new `backup-restore.md`. | The export holds every key, and restoring a snapshot needs a shell (PL-B2, PL-PM2) | H | M | UX/docs |
| 4 | **Corporate network flow.** Trusted-CA upload and status; host-list-as-control for per-host skip; one layered test against the *effective* config (fixes PL-B13); make the SSL→SSRF coupling visible (PL-B12); `trustProxy` field; offered in `/setup` and on Security; `corporate-network.md`. | The #1 day-1 blocker; the UI teaches the insecure fix | H | M | wizard/fix |
| 5 | **Wire contextual help and fix the wrong docs.** `docsHref` "Learn more" on every page and section (map in §9); rewrite the admin-ui.md Platform chapter with a "Where is…?" table; fix the stale release note. | 0 links today; the docs describe UI that doesn't exist (PL-B21) | H | S | docs |
| 6 | **One settings frame and save model.** All seven pages on `AdminSettingsPage`, with sticky save bar, `useUnsavedChanges`, mobile section nav, the existing `PRIMARY_/SECONDARY_/DANGER_BUTTON_CLASS` tokens from `formStyles.js` everywhere, `INPUT_CLASS` everywhere (fixes PL-B6). `AdminSettingsPage` already has the sticky bar but does not call `useUnsavedChanges`; wire the two together once, no duplicate headings. | Five header patterns, four primary colours, three save models; silent data loss (PL-B14) | H | M | UI/UX |
| 7 | **Updates as a flow.** Up-to-date / last-checked / check-failed states with "Check now" (PL-B10). The server already returns `lastCheckedAt`, `error` and `versionCheckDisabled` (`server/routes/admin/version.js:58-76`), so the states are client work; only "Check now" needs a server change (a forced refresh). Per-install-type instructions linking to the `INSTALLATION.md` update sections (PL-B11); pre-update checklist (backup → what's new → install → health check); info tone, not success. | The monthly task is a dead end on every non-binary install | M | S | UX/wizard |
| 8 | **Findability of settings.** Section `keywords` and i18n labels in Cmd+K with synonyms; a "Server & limits" section (`requestBodyLimitMB`, global session length); session-length row on Security linking to Authentication. | Task 7 failed through the UI alone (PL-B26, PL-PM4) | M | M | IA |
| 9 | **Features as a decision tool.** Registry `requires` (enforced on PUT), `risk`/`dataImpact`, `configureAt`, `docs`; row slots for these; Default/Changed badge; presets as a diff; `feature-flags.md`. | Admins can't judge risk or dependencies (PL-PM3, PL-TW5) | M | M | UX/docs |
| 10 | **Regroup the Platform IA.** A fixed-order sidebar with Settings / Governance / Maintenance; Security grouped Outbound/Inbound; Tool approval to Governance; encryption tool to Maintenance; "Voice & speech" with tabs, requirement strips, Models links and inline Azure; "Advanced" → "Maintenance"; legal export on EU AI Act. | Related tasks are thousands of pixels or three pages apart | M | M | IA/wizard |

## Appendix — verification log

An adversarial verifier re-checked every §4 breakage, the recommendations in §5, §8 and §11, and the doc gaps in §9 on 2026-11-12. It read the cited code and reproduced items in the running app. Scripts are in `SCRATCH/platform/verify/` (`v1.js`, `b20.js`).

**Removed (refuted)**
- **PL-B16 — Refuted.** "Any failure of `/admin/auth/status` shows Admin Access Required" is wrong. On failure, `useAdminAuth.jsx:28-31` sets only `isAuthenticated=false` and leaves `authRequired` at `false`, and `AdminLayout.jsx:133` shows the screen only when `authRequired && !isAuthenticated`. Repro: with `/api/admin/auth/status` answered 429, `/admin/backup` rendered normally. The panel's captures say "Please log in with an admin account", a line that appears only when the client is not signed in. So those sessions had no valid login (the `authApi` lockout, PL-B23), and the screen was the correct response.

**Corrected or narrowed (kept in the tables)**
- PL-B6: WCAG 1.4.11 confirmed (computed `border-top-width: 0px` on Voice selects and inputs). 2.4.7 refuted: focused fields get the browser's `outline-style: auto`.
- PL-B7: narrowed. The invisible input *is* keyboard-reachable and opens the picker; the visible button is the dead Tab stop. `UploadConfigButton` needs an `accept` prop to reuse it.
- PL-B20: only the CORS Add button overflows (393px). SSRF Add is at 383px. Line reference fixed: `AdminSettingsPage.jsx:86`.
- PL-B22: confirmed. The verifier counted 27 single-line keys, against TW's 33.
- PL-PM4: the 51,200 MB example was dropped (it is a video limit, and only the audio is uploaded).
- PL-PM6: scoped to this part (Chat History also shows `restartRequired`).
- Sidebar sort: the reference was `AdminSidebarNavData.js:389-394`, and it applies to every group.
- PL-B18 and §10: dropped the PL-B16 dependency.

**Confirmed as written**
- PL-B1, B2, B4, B8, B10, B11, B12, B13, B14, B15, B21, B24, B25, B28, B29 are confirmed in code.
- PL-B3, B5, B9, B19 and B26 were also reproduced by the verifier:
  - B9: the German load error rendered in green, `oklch(0.527 0.154 150)`.
  - B26: Cmd+K "cors" returns only "Check for Updates"; "proxy" and "ssl" return "No results found."
- PL-B17 and PL-B27 are taken from the panel/lead repros. Their code is consistent with the finding: `azureSpeechToken.js:43`, and the IntersectionObserver in `AdminSettingsPage.jsx:46-62`.
- PL-B23 stays Suspected.

**Recommendations: what already exists (report narrowed accordingly)**
- Button tokens `PRIMARY_/SECONDARY_/DANGER_BUTTON_CLASS` already exist in `formStyles.js`, so PL-UI2 and Rec 6 now reuse them instead of a new `<Button>`.
- `apiErrorMessage()` already exists in `client/src/utils/apiErrorMessage.js`, so PL-TW4 now reuses it instead of a new `describeApiError()`.
- A translation-key CI test already exists (`tests/unit/client/translation-keys-exist.test.jsx`), but it skips `features/admin`. §9 now says to extend it.
- `ConfirmDialog` (shared) and `AdminLoadError` exist, and Rec 1 and 2 already build on them.
- The `check-update` API already returns `lastCheckedAt`, `error` and `versionCheckDisabled`, so Rec 7 is mostly client work.
- `INSTALLATION.md` already documents Docker and npm updates, so §9 now says the gap is linking from the Updates page.
- `ai-act.md:6-11` already has a duty/measure/operator table, so the legal brief gap is narrowed.

**Recommendations: confirmed not implemented**
- `docsHref` / "Learn more" links: grep finds no `/admin/docs/…` link in any admin page.
- `useUnsavedChanges` on in-scope pages: it is used only by resource editors, and `AdminSettingsPage` does not call it.
- Backup restore points or listing: `backup.js` has only `export` and `_import`.
- A network or CA step in `/setup`: `SetupWizard.jsx` has 4 steps and none is about networking.
- A trusted-CA store for outbound HTTP: only People Directory has `certStore.js`.
- Cmd+K `keywords`: none exist.
- Feature `requires`, presets or metadata: the registry fields are `id/name/description/category/default/preview`, and the PUT does not enforce dependencies.
- A Voice setup wizard and an EU AI Act compliance export: neither exists.
- Doc pages for feature flags, backup/restore, corporate network and force refresh: no such pages in `docs/`.
- The proposed anchors (`ssl-certificates.md#recommended-approach-import-certificates`, `rate-limiting.md#changing-the-limits`, `ai-act.md#admin-page`, `INSTALLATION.md#binary-installation-updates`) all exist.

**Method**
- Code: read each cited `path:line`, plus the server side where behaviour depends on it (`configs.js` GET redaction and POST merge, `httpConfig.js`, `proxy.js`, `rateLimiting.js`, `version.js`, `features.js`, `backup.js`).
- App: Playwright against http://localhost:3000 as `admin`. Failures were simulated with `page.route()` (429/500 on single GETs), so the shared rate limit was not exhausted. Nothing was saved, imported or created.
