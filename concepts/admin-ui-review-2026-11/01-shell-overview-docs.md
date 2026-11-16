# Admin shell, Overview, What's New & Documentation — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** the admin shell on every `/admin/*` route (sidebar, mobile drawer, breadcrumb, Cmd+K palette, `g`/`n`/`?` shortcuts and cheatsheet, demo-account and low-disk banners, unsaved-changes guard); `/admin` (Overview); `/admin/changelog` (What's New); `/admin/docs` and `/admin/docs/<page>.md` (Documentation). Adjacent entry points, because they decide how an admin arrives: the `/setup` wizard and the main app's user menu → "Admin Panel".

All five panel notes were present and used. Screenshot and script names below refer to the panel's scratch folders (`shell-overview-docs/{pm,ux,ui,tw,admin}/`). The shared instance rate-limited admin calls (HTTP 429; `adminApi` 100/min in `contents/config/platform.json:254-257` at the time; the verifier found it raised to 100000 by the end of the run) for long stretches. The 429 is an environment limit; how each page *renders* a failed request is a finding, because a company behind one NAT or a proxy without `trust proxy` hits the same limit.

## Summary

The shell is the admin's map (about 45 pages in 8 sections, a Cmd+K palette, `g` shortcuts). The Overview should answer "is my platform healthy and what do I do next?". What's New and Documentation are the self-service layer. Visually the part is clean and modern, and the release tree and version-matched in-product docs are real assets. But nothing here is wired to platform state. The Overview's "Getting started" checklist is hard-coded and appears only when the app count is 0. That never happens on a real install (28 apps ship), but it does happen whenever the apps request fails, so a healthy instance under load looks freshly installed. The fact that blocks every new install, "no chat model is enabled", shows only as a grey "Models 0 / 3" next to a reassuring "Providers 7 / 7". Every docs URL 404s on reload or when shared. Cmd+K is a hand-maintained English page list that has drifted from the sidebar and cannot find a setting. No admin page links into the docs, and the docs teach `platform.json` rather than the UI. The biggest wins are cheap: one `staticRoutes.js` fix, honest error states, a server-computed setup/attention panel, a "?" help link per page, and a palette built from the sidebar's own data.

## 1. What this part does

**Admin shell.** A left rail (`AdminSidebar.jsx`) with logo, "Back to iHub", a search field that opens the palette, and 8 collapsible sections whose items are sorted by translated label (`AdminSidebarNavData.js:393`). "What's New & Docs" is the second section (`:67`), above all work. Global banners (demo accounts, low disk) sit above every page. On phones the rail becomes a drawer under an "Admin Panel" top bar. Every admin, every session.

**Cmd+K and shortcuts.** The palette fuzzy-matches 35 hard-coded English page labels and 4 actions (`AdminCommandPalette.jsx:10-53`) plus a live entity search over apps, prompts, models, groups, users, projects and providers. `g`+letter jumps to 7 sections; `n` is "new item"; `?` opens a cheatsheet (`useAdminKeyboardShortcuts.js`). Power users, daily.

**Overview `/admin`.** KPI cards (Apps, Users, Model calls last 30 days, Version/update), Quick actions, Recent activity (8 audit rows), "Common pages", a "First-run onboarding" card and "Platform status" (enabled/total per area). A "Getting started" checklist replaces KPIs and status when `appCount === 0` (`AdminOverview.jsx:763-799`, `useOverviewData.js:80,159`). The landing page of every admin visit.

**What's New `/admin/changelog`.** Release tree from `docs/releases/`, "Installed" marker, per-release TOC, breaking changes first, Copy/Download, `?version=` links. The server already computes `previousVersion` and `isNew` (`server/routes/admin/changelog.js:64-90,159`). Used per upgrade.

**Documentation `/admin/docs`.** The shipped `docs/*.md` for the installed version, with the `SUMMARY.md` tree and server-side search (`server/utils/docsLibrary.js`); `/docs` redirects here (`staticRoutes.js:78`). This page is itself **unreleased** (`docs/releases/next/features.md:667`), so fixes before the next tag need no extra changelog entry.

**Entry points.** A fresh `/` goes to the `/setup` wizard (welcome → sign in → provider + key + Test Connection → finish links). Afterwards the only way in is avatar menu → "Admin Panel" (`UserAuthMenu.jsx:330-345`). The main app's "Documentation" link goes to GitHub `main` (`contents/config/ui.json:55`), not the version-matched docs.

## 2. Is it intuitive? — verdict

| Page | Score (1–5) | Why |
|---|---|---|
| Entry from the main app | 2 | Only via avatar menu. The "No models available" pill (`ChatInput.jsx:1172-1176`) is plain text even for admins. |
| Sidebar | 3 | Sensible sections. Alphabetical sort puts Agents (preview) above Apps and "Advanced" (warning icon) first in Platform, and reorders per language. Four icons each reused 3–4 times. Help sits above all work. (TW: 4, §10.) |
| Cmd+K palette | 2 | Matches English page and entity names only. UX ran 21 realistic queries; 15 found nothing ("oidc", "who can see", "logo", "api key"). "sso" → System Resources; "docs" → Document Templates. |
| Shortcuts / cheatsheet | 2 | Keyboard *access* works (admin: 4). Advertised `g g` and `n` do nothing; 300 ms chord window; "⌘ then k". |
| Overview | 2 | Judges nothing. No checklist or "nobody can chat" warning on a real fresh install; fakes a fresh install under load; quick actions mislabelled. |
| What's New | 3 | Strongest page (PM: 4). Opens on "Unreleased" (38 developer-facing breaking changes) on dev builds; ~100-link TOC wall; literal backticks; no audience filter or "since my upgrade" view. |
| Documentation | 3 | Rich, version-matched, in-app links. URLs 404 on reload; page scrolls its own search box off-screen; ranking buries canonical pages; flat ~180-entry TOC; nothing links in. (UI: 2.) |
| Mobile 390px | 2 | Drawer works, no horizontal overflow, but the demo banner wraps one word per line over more than a screen on every page (TW: 1). |
| `/setup` wizard | 3 | Clear CTA, but ends at "key saved" plus an "Add your models" hand-off to the Models page (no default, no test chat), no custom endpoint, Skip is a native `confirm()` that can disable onboarding for everyone. |

**Overall.** For an admin who knows the product, the shell is efficient and polished, and the unsaved-changes guard works on shell navigation (UX: typing in `/admin/apps/new` then clicking "Groups" shows "Stay / Leave"). For an admin who doesn't know how to do something, the part fails at its three jobs: it doesn't say what is wrong (Overview), it can't find what they ask for (Cmd+K, docs search), and help isn't connected to the pages (no help links, JSON-first guides, broken deep links).

## 3. Task walkthroughs

Steps counted by the iHub admin unless noted; frustration 1–5 (5 = worst).

- **T1 — Fresh install → first chat app.** Wizard (4 clicks + key), skip, avatar → Admin Panel → Overview (no checklist) → "Add Model" (a list) → Models strip → Providers… ≈ 12 steps. Hurt: Test Connection said "Invalid API key" (for the dummy key used here that was a genuine 401, see SH-B15); Overview said "Providers 7 / 7"; the real blocker "Models 0 / 3" was grey and below the fold. The Models page's 3-step strip is good but invisible from the Overview. **Partial**, 3.
- **T2 — Find "who can see app X".** Cmd+K ×5 ("who can see", "visibility", "permissions", "access", "oidc") → docs search ×3 ("app permissions" → Security Guide, rank 7) → Apps → Chat → scroll 8 screens ≈ 11 steps, 5 guesses. The "Group access" card is section 22 of 22 at y≈6,760 px (`AdminAppEditPage.jsx:626`). Found only via `admin-ui.md`. **Success, slow**, 4.
- **T3 — What changed in the latest release?** What's New → opens on "Unreleased" → pick 5.6.4 = 3 steps. Unsure whether "Unreleased" applies; "v5.6.5 available" notes unreachable. **Partial**, 3.
- **T4 — Configure OIDC from the docs.** Docs → Auth & Security → OIDC (4 steps) → guide opens "Enable OIDC in `contents/config/platform.json`" (`docs/oidc-authentication.md:19-66`) → `/admin/auth` → map JSON keys to fields by guesswork. The form neither links the guide nor shows the redirect URI. **Partial**, 4 (UX reached the same result).
- **T5 — Admin at 390px.** Drawer works; the banner had to be dismissed before anything was visible; `/admin/docs` opens ~1,700 px past search and TOC (PM). **Partial**, 3.
- **T6 — Keyboard only.** Skip link, `?`, `g a`, palette arrows/Enter work. No shortcut for Overview, Providers, Docs, What's New; `g g` dead. **Success**, 2.
- **T7 — German admin jumps to Users (TW).** Cmd+K "Benutzer" → "No results found" (labels are English). **Failed** via palette.
- **T8 — Share a docs page (PM, UI, TW).** Copy `/admin/docs/oidc-authentication.md`, open in a new tab → plain "File not found". **Failed.** Lead re-verified with curl (`/admin/docs` 200, the page URL 404).

## 4. What is broken

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| SH-B1 | Confirmed | Every `/admin/docs/<page>.md` URL returns a plain-text 404 "File not found" on reload, bookmark, new tab or shared link: the SPA fallback treats any path with an extension as a missing asset. Contradicts `docs/admin-ui.md:132`. (PM, UI, TW) | `server/routes/staticRoutes.js:109-110`; `.md` links from `utils/docsLinks.js:93`; modifier-clicks passed to the browser at `:189`. Lead curl: 404 | P1 |
| SH-B2 | Confirmed | When the apps request fails (429/5xx), the Overview silently becomes a "fresh install": KPIs, activity, Common pages and status vanish, "Getting started 2/6" appears, no error or retry. (all five) | `useOverviewData.js:43,86` (`allSettled`, rejected → `[]`), `:80,159`; `AdminOverview.jsx:763-799`; `pm/10-overview.png`, `ux/shots/m-overview.png` | P1 |
| SH-B3 | Confirmed | The checklist never appears on a real fresh install (28 default apps; lead counted) and its ticks are constants: "Admin account ready" is ticked while the same page warns that `admin` still uses the shipped password. (all five) | `AdminOverview.jsx:82-119` (`done: true` at :86, :92); `admin/shots/12` | P1 |
| SH-B4 | Confirmed | Platform status shows "Providers 7 / 7" while no provider has a key (it counts `enabled !== false`); "Models 0 / 3" is neutral grey. (admin, PM, UX, TW) | `server/routes/admin/overview.js:39,113`; `admin/shots/12` vs `21` | P2 |
| SH-B5 | Confirmed | At 390px the demo-accounts banner squeezes ~40 words into a one-word column (~1,000 px) with links overlapping, on every page. (PM, UI, TW, admin) | `AdminDemoAccountsAlert.jsx:126-133`; `ui/shots/crop_m_admin_top.png`, `admin/shots/70` | P2 |
| SH-B6 | Confirmed | Cmd+K's page list drifted: no Workflows, Credentials, MCP gateway, Feedback; What's New is "Changelog"; untranslated ("Benutzer" → nothing); not filtered by flags, `admin.pages.*` or content-admin scope (offers pages that 403); users route to the list. (all five) | `AdminCommandPalette.jsx:10-46,80`; vs `AdminSidebar.jsx:28-30,257-266` | P2 |
| SH-B7 | Confirmed | `g g` (Groups) never navigates: the second `g` re-enters the `key === 'g'` branch before the pending check. (UX; lead verified) | `useAdminKeyboardShortcuts.js:12,69-77` | P2 |
| SH-B8 | Confirmed | `n` "New item" is advertised but wired nowhere (hook called once without `onNew`). (UX, UI, TW) | `useAdminKeyboardShortcuts.js:62`; `AdminLayout.jsx:52`; `docs/admin-ui.md:57-58` | P2 |
| SH-B9 | Confirmed | A cold load of `/admin` ignores the saved/OS dark theme: `useDarkMode` mounts only via the main Layout's `DarkModeToggle`. (UI, admin — two repros) | `client/src/hooks/useDarkMode.js:56-59`; `Layout.jsx:384`; `ui/dbg.js`, `admin/t23.js`; verifier: cold load with `colorScheme: 'dark'` → `<html class="">` | P2 |
| SH-B10 | Confirmed | Failures show as raw text or false emptiness: Docs, docs search and What's New print "Request failed with status code 429" (Changelog has no retry); the palette catches entity errors and says "No results found". The server's problem+json `detail` is ignored. (UX, UI, TW, admin) | `AdminDocsPage.jsx:200`; `AdminChangelogPage.jsx:515`; `AdminCommandPalette.jsx:214`; `ux/shots/m-docs.png` | P2 |
| SH-B11 | Confirmed | The docs page scrolls `<main>` ~214 px on load, hiding the H1 and the only search field (and the TOC on mobile). (UI, admin, PM) | `AdminDocsPage.jsx:226-238`; `ui/dbg2.js`; `ui/shots/crop_m_docs_1.png` | P2 |
| SH-B12 | Confirmed | Cmd+K is not a dialog: no `role="dialog"`/`aria-modal`, no listbox roles, no focus trap (Tab reaches the page behind); on mobile the drawer stays open under it. (UI, admin) | `AdminCommandPalette.jsx:338-352`; `ui/shots/mobile_drawer_palette.png` | P2 |
| SH-B13 | Confirmed | 85 shell strings exist only as inline defaults, missing from both `en.json` and `de.json` (Overview 43, palette 11, cheatsheet 2, ChangeHistoryDrawer 22, AdminLayout 7; verifier recount incl. plural suffixes): English in German, not overridable. Contradicts the unreleased note "No More Untranslatable Texts" (`docs/releases/next/features.md:1561`). (TW; lead spot-checked 4 keys) | `tw/keys.py`, `verify/keys.js`; `tw/shots/de-overview.png` | P2 |
| SH-B14 | Confirmed | Audit Log chip: "Edit under Platform → Advanced." Advanced has no audit settings. (PM) | `AdminAuditLogPage.jsx:173` | P2 |
| SH-B15 | Confirmed (narrowed) | Setup Test Connection gives no cause-specific errors: an invalid Google key returns 400 and shows "Provider returned status 400" (reproduced via `POST /api/setup/_test`); every 401 *and* 403 (e.g. a key without permission, a blocking gateway) reads "Invalid API key". The panel's "proxy 403" repro did not hold: the dummy key got a genuine 401 from OpenAI. (admin; verifier) | `server/routes/setup.js:49-55`; `verify/setuptest.sh` | P3 |
| SH-B16 | Confirmed | Quick actions: "New App" → list, "Add Model" → list, "Invite User" → list (no invite feature). The palette's "New App" opens the raw editor and skips `AppCreationWizard`. (all five) | `AdminOverview.jsx:189-210,242`; `AdminCommandPalette.jsx:49`; `AdminAppsPage.jsx:200,789` | P3 |
| SH-B17 | Confirmed | Recent activity shows "POST /api/admin/apps → 400" under a green "create" pill; raw action ids; English-only relative times. (UI, TW, admin) | `AdminOverview.jsx:494-515,542-549`; `admin/shots/93` | P3 |
| SH-B18 | Confirmed | Cheatsheet shows chords as "⌘ then k" and ⌘ on every OS; sidebar says "Cmd+K" on phones too. (UI, TW, admin) | `AdminShortcutsModal.jsx:5-28`; `AdminSidebar.jsx:398` | P3 |
| SH-B19 | Confirmed | What's New opens on "Unreleased" whenever `next/` has entries (dev/main builds). Tagged builds omit the empty `next/`. (all; lead verified) | `AdminChangelogPage.jsx:511`; `changelog.js:64-72` | P3 |
| SH-B20 | Confirmed | Changelog shows literal backticks around inline code. (UI) | `AdminChangelogPage.jsx:406` (no `prose-code:before:content-none`) vs `AdminDocsPage.jsx:328` | P3 |
| SH-B21 | Confirmed | Docs page nests a second `<main>` (violates `docs/accessibility.md:56`). (PM, UI) | `AdminDocsPage.jsx:297`; verifier: 2 `<main>` elements on `/admin/docs` | P3 |
| SH-B22 | Confirmed | Mobile drawer doesn't trap focus despite the comment (the effect only handles Escape). (UX) | `AdminSidebar.jsx:286-298`; `ux/walk4.js` | P3 |
| SH-B23 | Confirmed | Sidebar auto-expand ignores `activeFor` (e.g. `/admin/providers` doesn't re-open AI Workspace). (UX suspected; lead confirmed) | `AdminSidebar.jsx:156-168` vs `:60` | P3 |
| SH-B24 | Confirmed | `/admin/does-not-exist` renders the global 404 without the shell; "Return Home" leaves the admin. (admin) | `App.jsx:895`; `admin/shots/92` | P3 |
| SH-B25 | Confirmed | The end-user Disclaimer popup also blocks admin pages. (PM suspected; lead confirmed no route check) | `shared/components/Layout.jsx:233-235` | P3 |
| SH-B26 | Confirmed | `admin-ui.md` contradicts the UI in 9 places (SH-TW3). Lead re-checked :30, :93, :102, :132. | see SH-TW3 | P3 |
| SH-B27 | Confirmed | Checklist uses the external-link icon for internal links; German "bis **er**" for neuter "Onboarding". (PM, UX, UI, TW) | `AdminOverview.jsx:168`; `de.json` `admin.onboarding.stateShown` | P3 |

## 5. Findings by persona

### Product manager

- **SH-PM1 — The Overview counts but never judges.** Fresh install: 28 apps (19 enabled), Models 0 / 3, Providers 7 / 7, all neutral. Recommendation: `GET /api/admin/overview/health` → `{ items: [{ id, severity, done, title, href }] }` (no usable chat model, keyless providers, demo accounts, auth unchanged, update/breaking changes, integration updates, disk). Reuse the wizard's "can the enabled models answer" probe (`SetupWizard.jsx:151`). Show while `setup.configured !== true` or any blocking item exists — never based on `appCount`.
- **SH-PM2 — The shell is chatty against a 100/min limit.** About 7 shell requests per page load (auth/status ×2, integrations/requests, website-corpus/domains, system/storage, demo-accounts ×2); ~13 on the Overview (`admin/t8`). Recommendation: one `/api/admin/shell` call for badges and banners.
- **SH-PM3 — Capabilities with no UI.** JSON-only per `server/defaults/config/platform.json`: `admin.pages.*`, `swagger.enabled`/`requireAuth`, `requestConcurrency`, `requestBodyLimitMB`, `pdfExport`, `workflowState` retention, `audit.retentionDays`/`includeEmail`/`verbosity`/`winstonMirror`. "Advanced" holds two unrelated cards. Recommendation: rename it "Platform settings" with schema-driven cards from `platformConfigSchema.js`; until then, retract "You do not need to edit JSON files" (`admin-ui.md:5`).
- **SH-PM4 — No path into the app wizard.** `AppCreationWizard` is local state on the Apps page (`AdminAppsPage.jsx:200`); add a `?create=1` (or route) and point Overview, palette and setup-finish links at it.
- **SH-PM5 — Nothing reacts to an upgrade.** `previousVersion`/`isNew` are unused by sidebar, Overview and Version card. Recommendation: "N new" badge on What's New and an Overview item "Upgraded 5.5.9 → 5.6.4: 2 breaking changes to review".
- **SH-PM6 — Content admins can't read docs.** Docs/changelog routes use `adminAuth` (`server/routes/admin/docs.js:44-78`); the sidebar hides the section from content admins (`AdminSidebar.jsx:28-30`). Recommendation: `contentAdminAuth` on docs read routes.
- **SH-PM7 — Recent activity is login noise.** 5 of 6 rows "Local login succeeded" (`pm/20-overview.png`). Show config changes only, group repeats, link rows to `AuditEntryDetailDrawer`.

### UX designer

- **SH-UX1 — The fresh-install blocker is hidden.** Put a blocking banner above the KPIs ("No model is enabled — users can't chat yet. [Connect a provider]"); for admins, turn the main app's "No models available" pill into a link to Admin → Models.
- **SH-UX2 — Tick checklist steps from data that exists:** `ApiKeyStatusBadge` (key present), `/admin/overview/stats` (models enabled), group grants (app visible to non-admins), auth mode, `/admin/auth/demo-accounts`, onboarding state. Keep "Setup progress (4/6)" reachable after dismissal.
- **SH-UX3 — Make the palette a search.** Generate entries from `getAdminNavSections()`; add per-item `keywords` (Authentication: oidc, sso, ldap, saml, entra; UI Customization: logo, theme, footer, disclaimer; Groups: permissions, access, who can see); a settings index of anchors (`/admin/auth#oidc`); a final "Search docs for '…'" row; word-start ranking instead of subsequence matching (`AdminCommandPalette.jsx:63-72`).
- **SH-UX4 — "Who can see app X" needs a direct answer.** An effective-access summary at the top of the app editor and a "Visible to" column on the Apps list (the Access & Identity panel owns any full inspector).
- **SH-UX5 — Sidebar sort.** Replace `localeCompare` with a fixed task order defined once and shared with palette and docs (§6).
- **SH-UX6 — Wizard Skip hides a global decision in a native dialog** ("OK: don't show it again. Cancel: skip for this session only.", `SetupWizard.jsx:264-273`). Use `ConfirmDialog` with "Skip for now" / "Turn off the setup wizard for everyone".
- **SH-UX7 — Per-card recovery.** Each Overview card independent, with `AdminLoadError` + Retry; 429 → "The server is busy — try again in N s" from `Retry-After`/`detail`.

### UI designer

- **SH-UI1 — One page frame.** Three widths in this part: Overview `max-w-5xl` (`AdminOverview.jsx:751`), Changelog `max-w-6xl` (`AdminChangelogPage.jsx:126`), Docs `max-w-7xl` (`AdminDocsPage.jsx:250`). The banner is fixed at `max-w-5xl`, so its left edge (x=350) misaligns with content (382 / 308 / 290). Recommendation: an `AdminPage` frame (`wide`/`narrow`, one gutter, header with title/action/help slots, banner slot, built-in `AdminLoadError` and `AdminPageSkeleton`).
- **SH-UI2 — Shared components barely adopted.** `AdminLoadError` on 33 of 74 pages (not these three); `AdminPageSkeleton` 3; `AdminEmptyState` 1; Changelog has its own `ErrorBox` (`:136-150`) and `Badge`. `window.confirm` remains in four admin files. Lint against it.
- **SH-UI3 — Icons.** `SparklesIcon` ×4, `LinkIcon` ×4, `CpuChipIcon` ×3, `DocumentTextIcon` ×3 (`AdminSidebarNavData.js:107-260`); "Advanced" uses `ExclamationTriangleIcon`. Use unique icons (Agents `Bolt`, Skills `AcademicCap`, MCP gateway `ServerStack`, Advanced `WrenchScrewdriver`).
- **SH-UI4 — Sidebar head.** Two "Back to iHub" links (`AdminSidebar.jsx:326-336,380`); search vanishes when collapsed (`:389`). Keep the logo as the back link and a search icon in collapsed mode.
- **SH-UI5 — Palette visuals.** Green selection (`:391`) where the admin is indigo; `capitalize` mangles e-mails (`:398,404`); edge-to-edge at 390px with keyboard hints.
- **SH-UI6 — KPI cards** reserve an `opacity-0` hover-only "View details" row (`AdminOverview.jsx:70-73`), invisible to keyboard users; dark tiles (`bg-*-900/30`) nearly vanish. Drop the row, use `dark:bg-*-500/15`.
- **SH-UI7 — Three link styles on one screen** (`AdminOverview.jsx:526,595`, grey Common pages). One style: indigo, underline on hover.
- **SH-UI8 — What's New:** collapse each section to headlines with "Show all (38)", filter chips (Breaking/New/Fixes; Admin/User/API), collapsible entries.
- **SH-UI9 — Docs layout:** collapsible TOC with the current part open, search at the top of the TOC, page header only on the docs home, a right-hand mini-TOC at ≥xl, TOC in a "Contents" disclosure on mobile.
- **SH-UI10 — Mobile top bar** says "Admin Panel" on every page (`AdminLayout.jsx:23-43`); add page title and a search icon.
- **SH-UI11 — Polish:** untranslated breadcrumb `aria-label` (`AdminBreadcrumb.jsx:19`); 16 px cheatsheet close target (`AdminShortcutsModal.jsx:73-79`); `/setup` uses blue, `rounded-xl` and an emoji (`SetupWizard.jsx:294-312`) against the admin's indigo.

### Technical writer

- **SH-TW1 — No contextual help.** Outside the Docs and Changelog pages, only the sidebar item and palette entry link to `/admin/docs` (lead grep). The redesign brief's "Learn more →" in empty states (`concepts/admin-redesign-2026/2026-05-19 Admin UI Redesign Design Brief.md:274`) was never built. Recommendation: `helpPath` per nav item, rendered in the page header and `AdminEmptyState`; CI test that every anchor exists.
- **SH-TW2 — Docs search misses real questions.** Substring scoring, heading 10 > title 6 (`docsLibrary.js:251`): "oidc" → OIDC guide 6th; "create app" → ADFS first; "who can see app" → `apps.md#iassistant-configuration`; "entra" matches "centraliz…". Recommendation: whole-word matching, title/H1 boost, boost `admin-ui.md`/`GETTING_STARTED.md`, synonyms (SSO→OIDC, Entra→Azure AD, who can see→Group access, Benutzer→Users), group by page.
- **SH-TW3 — `admin-ui.md` is wrong in 9 places:** :93 "Conversations" (card: "Model calls"); :102 checklist "disappears once complete"; :30 chevron "at the bottom" (it's at the top); :24 omits Document templates; :74 palette opens the user (it opens the list); :57-58 documents dead `n`; :501 lists "sources", omits Rollback; :132 reload promise; `AUTHENTICATION_QUICK_START.md:153` uses group `"admin"` (shipped id `admins`). Have the `document-feature` skill flag `admin-ui.md` when admin pages change.
- **SH-TW4 — The guide covers half the sidebar.** 18 of 36 items have no section (Skills, Workflows, Agents, Authentication, OAuth, Integrations, MCP gateway, Credentials, Localization, Pages, Document templates, Short Links, Feedback, Logging, Telemetry, Chat History, EU AI Act, Advanced). `oidc-authentication.md` mentions Admin → Authentication only at :439/:447, has 10 JSON blocks and no screenshots.
- **SH-TW5 — Copy that promises actions.** "New App" → **Create app** (wizard); "Add Model" → **Add models** (import dialog); "Invite User" → **Add user**; "View Usage" → **Usage reports**.
- **SH-TW6 — Demo-account warning.** Two wordings (banner vs card), a bare "admin, user" list, and the German text quotes an English label hard-coded in `LocalAuthSection.jsx:81`. Proposed EN: "**Demo accounts are open.** The accounts *admin* and *user* still have their default password and are listed on the login page. [Change passwords] [Hide demo accounts]". DE: "**Demo-Konten sind offen.** Die Konten *admin* und *user* haben noch ihr Standardpasswort und werden auf der Anmeldeseite angezeigt. [Passwörter ändern] [Demo-Konten ausblenden]".
- **SH-TW7 — What's New speaks to developers** ("Every 201 Carries a Location"). Add an `audience` tag (admin/user/api) to release entries, an "API & integrators" filter collapsed by default, and a "What you need to do" line per breaking change.
- **SH-TW8 — Terminology.** The admin is "Admin Panel", "Admin", "admin UI", "admin area" (DE "Admin-Panel"/"ADMIN-BEREICH") → **Administration**. Release notes are "What's New", "Changelog", "Release notes" → **What's New**. First run is "First-run onboarding", "setup wizard", "Getting started", "Setup checklist" → **Setup wizard** (`/setup`) and **Setup progress** (Overview). Verbs: **Create** what you author, **Add** what you connect. Sentence case throughout.
- **SH-TW9 — Single-key shortcuts can't be turned off** (`?`, `n`, `g`): WCAG 2.1.4 / BITV. Add a toggle in the cheatsheet.

### iHub admin

- **SH-ADMIN1 — No first-run path after the wizard** (T1); wants the server-computed checklist of SH-PM1 with "send a test prompt" as the last step.
- **SH-ADMIN2 — Wizard covers 4 clouds and a URL-less "Local".** Azure OpenAI, gateways and vLLM must skip. Add a "Custom / OpenAI-compatible endpoint" card with a URL, optional key, and a test that lists models. The test sends a server-side request to an admin-supplied URL, so it needs the SSRF guard. Resolve and validate the host once (`assertPublicTarget`, `server/utils/ssrfGuard.js:300`), allowing a private address only when the host is on the admin allowlist `platform.ssrf.allowedHosts` (`allowPrivate`). Then pin the direct connection to the validated addresses with `createPinnedLookup` (`ssrfGuard.js:403`) so the hostname can't be resolved again to a different address (DNS rebinding). `assertSafeHost` alone is not enough, because it discards the addresses it checked (`server/services/mcp/safeFetch.js:244`). Send the request through `httpFetch()` for the proxy and SSL whitelist, with that pinned lookup, and don't follow redirects. When an outbound proxy is configured, the proxy resolves the destination and is the trust boundary, as `ssrfGuard.js:395-397` already documents. Self-hosted endpoints on private addresses are the main use case: when the guard blocks one, the error should say "This address is on your internal network. Add it under Security → SSRF allowlist" and link there, rather than fail silently.
- **SH-ADMIN3 — The way in is hidden.** Add "Administration" to the main sidebar for admins and point "Documentation" (`ui.json:55`) at `/admin/docs` for admins.
- **SH-ADMIN4 — "Who can see" is 11 steps** (T2). Move "Group access" up in the app editor or add an in-page section nav (Apps part).
- **SH-ADMIN5 — OIDC guesswork** (T4). The OIDC form already has Google/Microsoft/Keycloak/Custom templates and, when the Callback URL is empty, shows the *relative* path "Auto-generated: /api/auth/oidc/{name}/callback" (`OidcProvidersSection.jsx:11-60,329-333`). Show the *absolute* redirect URI (origin + base path, as the post-logout field already does at `:86`) with Copy, and link the guide.
- **SH-ADMIN6 — Missing shortcuts:** `g o` (Overview), `g h` (help), `g n` (What's New); render Ctrl/⌘ per platform.
- **SH-ADMIN7 — "v5.6.5 available" has no notes.** Only the installed build's notes ship; link to the version's GitHub release.

## 6. What should be rearranged

1. **Move "What's New & Docs" from section 2 to a pinned sidebar footer** ("Help · What's New · Shortcuts") with a "new" dot after upgrades. It is rarely used and pushes work down; at 900 px Users/Groups need scrolling (`pm/20-overview.png`). (all)
2. **Fixed task order inside sections**, not `localeCompare` (`AdminSidebarNavData.js:393`): Apps, Models, Prompts, Projects, Skills, then a "Preview" divider (Workflows, Agents, Marketplace); Users, Groups, Authentication, OAuth; **Advanced last** in Platform. Define it once; the palette and `admin-ui.md`'s nav table read the same list.
3. **Overview, top to bottom:** Needs attention / Setup progress (merging the checklist, the onboarding card, the duplicate demo warning, the update notice and "0 models enabled") → shorter KPIs → Recent changes beside Platform status (as health). **Remove "Common pages"**, which duplicates the sidebar.
4. **Show the demo warning once on the Overview**, as an attention item; keep a slimmer banner elsewhere.
5. **Move onboarding settings off Platform → Advanced** into Setup progress ("Turn the setup wizard off").
6. **Rename "Advanced" → "Platform settings"** and home the JSON-only keys there (SH-PM3).
7. **App editor: move "Group access" up** (Apps part; it decides T2).
8. **Docs:** search above the TOC; split the TOC into "Set up & operate" and "Reference & development"; legacy pages under "Older topics".
9. **What's New:** Installed release first and selected; "Unreleased" last and collapsed. The Version card links to What's New when there is something new, to Updates when an update exists.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Hard-coded checklist gated on `appCount === 0` | Server-computed attention/setup items with severity and one "Fix" link each | Only the server knows whether a model can answer; fixes SH-B2/B3/B4 together. |
| Platform status as enabled/total | "Providers: 0 usable (7 without key)", "Models: 0 enabled — chat will not work" | Counts look healthy when nothing works. |
| Cmd+K as a hand-copied English page list | Index from nav data + keywords + settings anchors + entities + docs headings, grouped, with a docs fallback | Admins search for settings; the copy drifted. |
| Docs as a separate destination | "?" links per header, field and empty state; later a docs side drawer reusing the renderer | Follow OIDC steps next to the form without leaving it. |
| Substring docs search | Whole-word, title-boosted, synonyms | "oidc" must return the OIDC guide first. |
| What's New defaulting to `versions[0]` | "Since your last upgrade" digest from `isNew`, audience filter, badge | Operators want "what must I do". |
| No UI for long-tail platform keys | Schema-driven cards from `platformConfigSchema.js` | One renderer closes ten gaps. |
| Native `confirm()` for a global skip | In-app dialog with labelled buttons | Consequential choice hidden in prose. |
| Per-page error handling (silent / raw / "No results") | `AdminLoadError` per card, 429 mapped from `detail` | Never infer state from a failed request. |
| "Who can see" by scrolling a 22-section editor | Access summary + "Visible to" column + palette keywords | A lookup, not a setup task. |

## 8. Wizards to add

**W1 — "First working chat"** (extends `/setup`; relaunchable from Setup progress). For every new install — the path that loses the most installs (PM).
1. Provider: OpenAI, Azure OpenAI, Anthropic, Google, Mistral, **Custom / OpenAI-compatible**, Local.
2. Key and/or endpoint URL; Test Connection lists models, with errors by cause (401 key rejected; 403 blocked — check proxy; TLS — see SSL whitelist; timeout — host unreachable).
3. Enable models (recommended chat model pre-selected).
4. Pick the default model and send a one-line test prompt; show the answer.
5. Choose which starter apps stay enabled and who sees them (default `authenticated`, "Everyone who signs in").
6. Done: "Open Chat" and "Next: secure sign-in →".
Creates the encrypted key, enabled models, default, app enablement and access; ticks Setup progress. Replaces the dead checklist and the native skip `confirm()`. *Already there (verifier):* the finish step asks `GET /api/admin/models/_key-status` whether enabled models can be called and, when none is enabled, highlights "Add your models", which opens the Models import dialog for the connected provider (`SetupWizard.jsx:150-170,564-590`; `AdminModelsPage.jsx:151-155`). Step 3 is therefore a hand-off today; W1 brings it into the wizard and adds steps 4–5, the custom endpoint and the cause-specific errors.

**W2 — "Connect company sign-in (OIDC)"** (owned by the Access & Identity part; listed because docs and Overview point to it). Starts at `/admin/auth` → "Add identity provider" and from the OIDC doc.
1. Preset: Entra ID, Google, Keycloak, Okta/Auth0, ADFS, generic. 2. Show the computed redirect URI with Copy. 3. Issuer → discovery check; client ID and secret. 4. Group claim and mapping with inheritance preview. 5. **Test sign-in** in a popup showing claims and groups. 6. Enable, keeping local admin login on by default; offer to hide demo accounts.
Replaces JSON-first setup (T4). Proposed in `concepts/admin-redesign-2026/… Product Strategy & IA.md:55,238`, never built as a wizard. *Already there (verifier):* provider templates for Google, Microsoft, Keycloak and Custom (`OidcProvidersSection.jsx:11-60`) and a relative auto-generated callback path (`:329-333`); missing are Okta/Auth0/ADFS presets, the absolute redirect URI with Copy, discovery, claim/group preview and test sign-in.

**W3 — "Before you open iHub to others"** (a checklist inside Needs attention, not a modal). Live-checked items with Fix links: change shipped passwords, hide demo accounts, decide anonymous access, choose sign-in (W2), require auth for Swagger, HTTPS/reverse proxy and `trust proxy`.

**W4 — Post-upgrade review** (light). From "Upgraded X → Y": step through admin-tagged breaking entries, each with "Reviewed" and a link to the affected page.

**Where a wizard would be wrong:** Cmd+K, sidebar and shortcuts (power-user speed); "who can see app X" (a lookup; §10); the Docs and What's New pages (fix search and defaults); single-toggle platform settings (schema forms).

## 9. Documentation

**What exists.** `docs/admin-ui.md` covers the shell, Cmd+K, shortcuts, Overview, What's New and Docs with 16 screenshots, but has 9 wrong statements (SH-TW3), misses 18 of 36 sidebar items (SH-TW4) and claims no JSON is needed (`:5`). `docs/GETTING_STARTED.md` explains the wizard and default access well but stops at "Look around", says "26 apps" (28 ship) and "Admin → Providers" (now under Models). `docs/concepts.md:9-16` has a good mental-model table. `docs/oidc-authentication.md` (699 lines) and `AUTHENTICATION_QUICK_START.md` are thorough but JSON-first with no UI steps. `SUMMARY.md` is grouped by subsystem only. The renderer is good; deep links (SH-B1) and ranking (SH-TW2) are not.

**Gaps — a new admin cannot learn:** install → working chat end to end in the UI; SSO/OIDC/LDAP in the admin UI; "who can see X" and how to change it (content exists but search can't find it); go-live hardening; which settings are JSON-only; phone use (keyboard use *is* covered, twice: `admin-ui.md:36` and `:562`); Change History rollback. German admins aren't told the docs are English-only.

**Proposed pages.**
1. **`admin-first-hour.md` — "Your first hour as an iHub admin"** (UI only, screenshots): open Administration → connect a provider → enable a chat model and set the default → try Chat → change passwords and hide demo accounts → decide who sees what → choose sign-in → where to get help. Mirrors W1.
2. **`how-to-control-access.md` — "Control who can see an app, model or prompt"**: mental model (groups, inheritance, `*`, implicit `anonymous`/`authenticated`); from the app (Group access); from the group; how to check (sign in as `user`); traps.
3. **Rewrite `AUTHENTICATION_QUICK_START.md` → "Set up sign-in in the admin UI"**: local accounts; OIDC with an Entra ID example (redirect URI, fields as labelled, Test, group mapping); LDAP; proxy; turning off anonymous; troubleshooting. JSON moves to a collapsible "Configuration file equivalent". Same pattern for `oidc-authentication.md` §Configuration.
4. **`admin-how-do-i.md` — "How do I…?"** with task-phrased headings ("Who can see this app?", "Turn on SSO", "Hide an admin page", "Change the logo"); becomes the admin docs home and helps ranking.
5. **`platform-settings-json-only.md`** until SH-PM3 ships.
6. **`SUMMARY.md`:** a "How-to (admin tasks)" part under Quick Start (required for new files).
7. **Updates:** fix SH-TW3; add the 18 missing sections and a "Mobile" section to `admin-ui.md` and merge its two keyboard sections (`:36`, `:562`); fix `GETTING_STARTED.md` and continue it into page 1.

**Contextual help (page → doc).** Setup progress items → `admin-first-hour.md#<step>`. `/admin/auth` header, OIDC form, redirect URI field → `oidc-authentication.md` UI section. `/admin/groups` and the app editor's Group access card → `how-to-control-access.md`. `/admin/models` strip and providers → `admin-first-hour.md#connect-a-provider`. `/admin/apps` header and empty state → `admin-ui.md#managing-apps`. Platform settings cards → `platform.md#<key>`. Every page header → its nav item's `helpPath`.

**Help text (current → proposed).**
- Audit chip: "Configured in platform.json → audit. Edit under Platform → Advanced." → "Retention is set in `platform.json` → `audit`; there is no form yet. [How to change it]".
- Overview subtitle: "Platform overview and quick actions" → "Status of this iHub installation and what to do next".
- Onboarding card: "First-run onboarding / Shown until completed" → "Setup wizard: shown to everyone who opens iHub until an admin finishes it"; "Onboarding settings" → "Turn the setup wizard off".
- Palette empty: "No results found." → "No page or item matches "{{q}}". Search the documentation →".
- Activity row: "create · POST /api/admin/oauth/clients → 400" → "Failed: create OAuth client (validation error)" with a red pill.
- Unsaved guard: "You have unsaved changes. Leave anyway?" (Leave/Stay) → "Leave without saving? Your changes on this page will be lost." (Leave without saving / Keep editing).
- Demo banner: SH-TW6. German docs page: "Die Dokumentation ist auf Englisch verfügbar."

## 10. Where the panel disagreed

**Facts the lead settled.**
- *Rate limit (UI: 500/min; others: 100/min).* The code default is 500 (`server/middleware/rateLimiting.js:152`); this instance configures 100 (`contents/config/platform.json:254-257`). Either way, ~13 calls per Overview load is fragile.
- *`g g` (UX: broken; admin treated it as working).* Broken, proven in `useAdminKeyboardShortcuts.js:69-77`.
- *Pages linking to docs (UX "one", PM/TW "zero").* Zero admin pages; only the sidebar item, palette entry and the Docs/Changelog pages' own link rewriter.
- *"Unreleased" default (UI: suspected).* Confirmed whenever `next/` has entries; tagged builds hide an empty `next/`, hence P3.
- *Sidebar auto-expand and Disclaimer on admin pages (suspected).* Both confirmed in code.
- *PM's "link New App to `/admin/apps?create=1`".* That parameter doesn't exist yet; adjusted to "add it" (SH-PM4).
- *Mobile banner severity (UI/TW P1, PM/admin P2).* P2: dismissable per session, but on every page; in the quick-fix bundle.

**Opinions and resolutions.**
- *Alphabetical sidebar.* TW scored the sidebar 4 because A–Z "works in both languages"; the other four want task order. Resolution: task order. A–Z reorders across languages and puts Agents and Advanced first; alphabetical lookup is the palette's job.
- *Keyboard (admin 4; UX, UI, TW 2).* Both right: keyboard *access* works, advertised *shortcuts* don't. Fix `g g`, wire or drop `n`, widen to ~1 s, add TW's single-key toggle.
- *First run: wizard or checklist?* Admin and PM want `/setup` extended; UI wanted a wizard to replace the checklist; TW and UX want a live checklist. Resolution: the server-computed Setup progress is the source of truth and survives a skipped wizard. W1 is the guided path through its first items and can be relaunched from it. No second wizard on the Overview.
- *"Who can see": inspector wizard (UX) or summary (admin, TW).* No wizard; summary, list column and keywords now. A full inspector is for the Access & Identity panel.
- *Docs for whom (PM, TW).* Open docs read routes to content admins now; the same docs are public on GitHub Pages, so nothing is disclosed. Public end-user help is a separate product decision.
- *"Common pages": delete (PM, UX, TW) or "Recently visited" (UI).* Delete; recent pages already live in the palette (`admin_recent_pages`).
- *Help link vs drawer.* Phase 1: "?" links to the docs page (works in new tabs once SH-B1 is fixed). Phase 2: the drawer.

## 11. Top recommendations

| # | Recommendation | Why | Impact H/M/L | Effort S/M/L | Type (fix/UX/UI/IA/wizard/docs) |
|---|---|---|---|---|---|
| 1 | **Fix docs deep links:** exempt `/admin/docs/**` from the extension rule in `staticRoutes.js:109-110` (or drop `.md` from routes); e2e cold-load test at root and under a subpath. | Every shared or reloaded doc link 404s; prerequisite for help links (SH-B1). | H | S | fix |
| 2 | **Honest failure states:** never derive "fresh" or "empty" from a rejected request; `AdminLoadError` + Retry per Overview card and on Docs, Changelog and the palette; readable 429s from `detail`/`Retry-After`; one `/admin/shell` call. | A loaded instance looks brand new or "has no Chat app" (SH-B2, SH-B10, SH-PM2). | H | S | fix |
| 3 | **Server-computed Setup progress + Needs attention** replacing `SetupChecklist` (usable provider, enabled chat model, default, test chat, demo passwords, sign-in, upgrade, disk); health wording in Platform status; demo warning once; drop "Common pages"; truthful quick actions. | The blocker on every new install is invisible; ticks are fake (SH-B3, SH-B4, SH-PM1, SH-UX1, SH-TW5). | H | M | UX |
| 4 | **Contextual help:** `helpPath` per nav item → "?" in each page header and `AdminEmptyState`, CI anchor check; absolute redirect URI with Copy (today only a relative path) + guide link on `/admin/auth`; main-app Documentation → `/admin/docs` for admins; docs open to content admins. | No admin page links to help today (SH-TW1, SH-ADMIN3/5, SH-PM6). | H | S | docs |
| 5 | **Rebuild Cmd+K from `getAdminNavSections()`:** keywords, settings anchors, docs fallback, word-start ranking, permission/flag/i18n filtering, dialog semantics and focus trap, indigo selection. | 15 of 21 realistic queries fail; 4 pages missing (SH-B6, SH-B12, SH-UX3). | H | M | UX |
| 6 | **Teach the UI in the docs:** fix 9 wrong statements; write "First hour", "Control who can see", "How do I…?"; UI-first auth and OIDC guides; 18 missing sections; whole-word, title-boosted search with synonyms. | Admins are sent to `platform.json` or to wrong instructions (SH-TW2–4, T2, T4). | H | M | docs |
| 7 | **Shell quick-fix bundle:** banner stacking + shorter copy; `useDarkMode` in `AdminLayout`; `g g`, `n`, ~1 s window, OS-aware chords, single-key toggle; no docs auto-scroll; changelog code styling; red failed activity rows; one `<main>`; drawer focus trap; 85 missing en/de keys; "bis er". | Many confirmed S-effort defects hit daily (SH-B5, B7–B9, B11, B13, B17, B18, B20–B22, B27). | M | S | fix |
| 8 | **Extend `/setup` to a first working chat (W1):** custom endpoint (SSRF guard with the admin allowlist and a pinned lookup, then `httpFetch()`, no redirects), cause-specific test errors, enable models in the wizard (today a hand-off to the Models import dialog), default, test prompt, starter apps and audience; in-app skip dialog. | The wizard hands off before chat works; enterprise endpoints must skip (SH-ADMIN2, SH-UX6, SH-B15). | H | M | wizard |
| 9 | **Sidebar IA and upgrade awareness:** task order, Advanced last, Help as footer, unique icons, collapsed search; What's New defaults to installed/new, sidebar badge, Overview "Upgraded X → Y", audience filter and "What you need to do". | Stable positions across languages; upgrades go unnoticed (SH-UX5, SH-UI3/4, SH-PM5, SH-TW7). | M | M | IA |
| 10 | **"Platform settings" page for JSON-only keys** (schema-driven: `admin.pages`, swagger, audit retention, workflowState, request limits, pdfExport); fix the Audit Log chip now. | Ten operator settings lack UI; one tooltip points to a page that doesn't have them (SH-PM3, SH-B14). | M | M | IA |

## Appendix — verification log

No panel-lead verification log existed; this appendix holds the adversarial verifier's results (2026-11-12). Scripts and output: `shell-overview-docs/verify/` (`v1.js`, `keys.js`, `setuptest.sh`, `dark-admin.png`, `docs.png`, `mobile-admin.png`).

### Adversarial verification

**Refuted or narrowed (no row removed; nothing was wholly wrong):**
- SH-B15 — premise refuted, defect narrowed: the "proxy 403" was a genuine OpenAI 401 for the dummy key (`curl` with a fake key → 401; `POST /api/setup/_test` → "Invalid API key" for openai/anthropic/mistral). The real, reproduced defect is the uninformative message for other causes (Google invalid key → "Provider returned status 400"). Status Confirmed (narrowed), P2 → P3; T1 wording corrected.
- §9 gap "keyboard use" — refuted: `admin-ui.md` documents shortcuts at `:36` and again at `:562`. Gap narrowed to phone use; recommendation changed to "add Mobile, merge the two keyboard sections".
- W1 / Rec 8 / §2 "/setup stops at key saved" — partly already built: the finish step probes `_key-status` and routes to the Models import dialog when no model is enabled (`SetupWizard.jsx:150-170,564-590`). Narrowed.
- W2 / SH-ADMIN5 / Rec 4 "show the redirect URI" — partly already built: OIDC templates (Google, Microsoft, Keycloak, Custom) and a relative auto-generated callback path exist (`OidcProvidersSection.jsx:11-60,329-333`). Narrowed to absolute URI + Copy, more presets, discovery, test sign-in.

**Path:line corrections:** SH-B9 `shared/hooks/useDarkMode.js` → `client/src/hooks/useDarkMode.js:56-59`; SH-B15 `setup.js:50-52` → `:49-55`; SH-B20 `AdminDocsPage.jsx:327` → `:328`; SH-B21 `:298` → `:297`; SH-B22 `AdminSidebar.jsx:268` → `:286-298`; SH-TW3 `admin-ui.md:75` → `:74`; SH-B13 count ~90 / Overview 48 → 85 / Overview 43. Rate limit note: `contents/config/platform.json:254-257` now reads `limit: 100000` (was 100 during the panel runs).

**Confirmed by reproduction in the running app (`verify/v1.js`, curl):** SH-B1 (`/admin/docs` 200, `/admin/docs/oidc-authentication.md` 404 "File not found"); SH-B4 (stats return `providers.enabled === total`, counted by `enabled !== false`); SH-B5 (390 px: alert 834 px tall, message `<p>` 8.6 px wide); SH-B6 ("credentials", "feedback", "benutzer", "oidc" → "No results found."; "workflows" matches only an entity); SH-B7 (`g g` on `/admin/apps` stays put; `g u` works); SH-B9 (cold dark load, no `dark` class); SH-B11 (`<main>` scrollTop 214 on `/admin/docs`); SH-B12 (0 `[role=dialog]` with palette open); SH-B17 (audit entries "POST /api/admin/shortlinks -> 404" with action `create`, coloured green by action only, `AdminOverview.jsx:494-501,538-547`); SH-B19 (What's New opens on "Unreleased changes", 38 breaking); SH-B21 (2 `<main>`); SH-B24 (`/admin/does-not-exist` → 404 page, 0 `<nav>`); TW2 ("oidc" → `oidc-authentication.md` 6th).

**Confirmed by code:** SH-B2 (`useOverviewData.js:43-80,86-159`: rejected → `[]` → `appCount 0` → fresh); SH-B3 (28 apps in `server/defaults/apps`; `done: true` at `AdminOverview.jsx:86,92`); SH-B8 (hook called without `onNew`, `AdminLayout.jsx:52`); SH-B10 (no interceptor maps `detail`; `err.message` is axios' text; palette `catch` → `[]` at `AdminCommandPalette.jsx:214-215`); SH-B14 (`AdminAdvancedPage.jsx` holds only onboarding + force refresh); SH-B16 (no `?create`, no invite feature anywhere); SH-B18 (`AdminShortcutsModal.jsx:26-27,99`; `AdminSidebar.jsx:399,476`); SH-B23 (`AdminSidebar.jsx:156-168` ignores `activeFor` at NavData `:106`); SH-B25 (`Layout.jsx:233-235`, `DisclaimerPopup` has no route check); SH-B26/TW3 (`admin-ui.md` :5, :24, :30, :57-58, :74, :93, :102, :132, :501; quick-start group `"admin"` at `:153-154` vs shipped `admins`); SH-B27 (`ArrowTopRightOnSquareIcon` at `:168`; on the Overview card the DE chip "bis er" follows the neuter title "Onboarding beim ersten Start").

**Recommendations checked for existing implementations (none found unless listed above):** no `helpPath` or in-page link to `/admin/docs` outside nav/palette (grep); no `/api/admin/overview/health`, `/admin/shell` or attention endpoint (only `/overview/stats`); palette not built from `getAdminNavSections()`; no client use of `isNew`/`previousVersion` outside the Changelog page; docs/changelog routes use `adminAuth` (`docs.js:44-78`, `changelog.js:148,170`); no UI for `swagger`, `requestConcurrency`, `requestBodyLimitMB`, `pdfExport`, `workflowState`, `audit.*` (grep in `client/src/features/admin`); `AdminLoadError` absent from the three pages (on 33 of 74); `window.confirm` in 4 admin files; sidebar still `localeCompare` (`AdminSidebarNavData.js:393`); `ui.json:55` points Documentation to GitHub `main`.

**Doc gaps checked (§9):** no `admin-first-hour`, access how-to, "How do I…?" or JSON-only-settings page in `docs/`; `admin-ui.md` has no section for any of the 18 listed nav items; no Mobile section; Change History rollback not documented (only Backup and Updates mention rolling back); `GETTING_STARTED.md:87` says "26 apps", `:55` "Admin → Providers"; `oidc-authentication.md` is 699 lines with 10 JSON blocks and mentions Admin → Authentication only at `:439,447`.

