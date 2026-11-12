# Admin UI review — November 2026

**Date:** 2026-11-12 · **Scope:** every `/admin/*` page of iHub Apps, the `/setup` wizard, and the admin documentation in `docs/` · **Status:** review complete and adversarially verified. No code was changed. Thirteen decisions are open in [Decisions for you](#decisions-for-you).

This entry point answers the original questions (is the admin intuitive, what does it do, what is broken, what to rearrange, where other approaches or wizards fit, and whether the docs teach it) and merges the eight part reports into one plan. Every claim cites a report finding: `SH-B1` is report 01, broken item 1; `ID-PM1` is report 04, product-manager finding 1; `SH W1` is report 01, wizard 1.

| Prefix | Report | Prefix | Report |
|---|---|---|---|
| SH | [01 Shell, Overview, docs](01-shell-overview-docs.md) | IN | [05 Integrations](05-integrations.md) |
| AI | [02 Apps, Models, Prompts](02-apps-models-prompts.md) | CU | [06 Customization](06-customization.md) |
| AX | [03 Skills, Projects, Workflows, Agents, Marketplace](03-skills-projects-workflows-agents-marketplace.md) | OB | [07 Observability](07-observability.md) |
| ID | [04 Access and identity](04-access-identity.md) | PL | [08 Platform](08-platform.md) |

---

## How this review was done

**Panel and parts.** Five personas reviewed each of eight parts: a senior product manager (PM), a senior UX designer, a senior UI designer, a senior technical writer (TW), and an iHub admin who walked realistic tasks end to end. Every report has the same sections: §1 what the part does, §2 page scores (1–5), §3 task walkthroughs, §4 what is broken (P0–P3), §5 findings by persona, §6–§8 rearrangement, other approaches and wizards, §9 documentation, §10 disagreements, §11 top 10 recommendations, and a verification appendix.

**Method.** Panels read the client, server, shipped defaults and docs (including `docs/releases/next/`); drove a running instance with Playwright (screenshots, computed styles, request interception, 390 px and dark-mode passes); used curl against the admin API; and walked 6–8 tasks per part as the admin.

**Verification.** Panel leads re-checked disputed facts. An adversarial verifier then tried to refute every §4 row in code and live, and checked every recommendation for existing implementations. It removed 5 rows (AX-B19, CU-B26, OB-B14, OB-B29, PL-B16), narrowed SH-B15, AX-B2, IN-B18, IN-B23, CU-B19, PL-B6, PL-B7 and PL-B20, upgraded AX-B36, ID-B31, CU-B10 and OB-B28 to Confirmed, downgraded CU-B27 to Suspected, and narrowed many recommendations to "reuse what exists" (`AdminSettingsPage`, `ConfirmDialog`, `fetchAdminModels`, `formStyles.js`; AI and PL appendices).

**Caveats.**

- **One shared local instance and one IP.** The admin API limit (100/min) and sign-in limit (30 per 15 min) produced frequent 429s until the admin limit was raised mid-run (SH, AX headers). How pages *behave* after a failed request is still reported, because an admin behind one NAT hits the same limit (PL-B18).
- **LLM providers were unreachable** (the sandbox proxy answers unknown hosts with 502; no model traffic), so model tests, chat export, MCP rotation and Usage data were only partly exercised (AI appendix, OB header, CU T5, IN-B25).
- **A server restart logged sessions out** during the run. "Admin Access Required" screens seen by the Platform panel were traced to clients that were not signed in, so that finding was refuted (PL-B16).
- **Preview features were switched on for the review.** Before the panels started, the organiser turned on the off-by-default flags `skills`, `workflows`, `agentFactory`, `userProjects`, `compareMode`, `chatSharing`, `toolSearch`, `voiceMode` and `appAsTool`, so every admin page could be reviewed. Only `toolsService` stayed off. The rate limits were raised to 100,000 per window for the whole instance mid-run, not only the admin limit. Both are review-environment settings, not findings.
- **OAuth clients were off** on the instance, so the OAuth client pages were judged partly from code (ID header).
- **Test entities** (`zz-*`) were deleted. One shipped registry was deleted through an unnamed confirm and restored within a minute (AX-B14).

**Prior work.** [`../admin-redesign-2026/`](../admin-redesign-2026/README.md) holds the 2026-05 brief and Product Strategy & IA; its planned read-only and observability roles were never built (OB appendix). [`../2026-05-28 Admin UI Phase 3 Roadmap.md`](../2026-05-28%20Admin%20UI%20Phase%203%20Roadmap.md) item 3B-3 plans the shared form components, `AdminButton` and indigo primary that would fix many defects below (CU-UI1, ID-UI2); they are not built.

---

## The answer in one page

**Is it intuitive?** No, not for an admin who doesn't already know it. Page scores average 2.4–3.1 of 5 per part, and most of the ~50 walked tasks ended partial or failed: sharing a docs link (SH T8), restricting an app to a group (AI T2), creating an agent and approving its action (AX), "why can't X see Y" (ID T6), restricting an MCP server (IN T2), a short link with a prefilled prompt (CU T6), tracing a complaint (OB T2), finding a setting (PL T7). For an expert the shell is efficient (SH §2), and the newest pages (Models tab, Projects, Document templates, EU AI Act, System Resources, Audit Log) are the pattern to copy.

**What does it do?** A full operator console of about 45 pages in 8 sections (SH §1): models, apps, prompts, skills, projects, workflows, agents and a marketplace; users, groups, sign-in and OAuth; 56 integration definitions, client add-ins and an MCP gateway; branding, localization, pages, templates and short links; usage, feedback, logs, telemetry, health, chats, tasks and audit; features, voice, network security, EU AI Act, backup and updates.

**What is broken?** 225 verified defects (222 Confirmed, 3 Suspected): 1 P0 and 46 P1. The worst class: a page that failed to load still offers Save, and Save writes defaults over the real config, including a one-click lockout (ID-B1). Next come forms that silently change data (AI-B1, ID-B3, CU-B1), controls with no effect (AX-B1, CU-B2), one-click destructive actions (PL-B1, AI-B2) and invisible inputs (AI-B3, ID-B7, CU-B6).

**What should be rearranged?** The admin is organised by storage file and sorted A–Z by translated label, while admins think in jobs (AI §2, ID §2, CU §2, OB §2, SH-UX5). Use one task order defined once for sidebar, Cmd+K and help; add **Runs & approvals**, a **Channels** hub and a **Governance & privacy** section; move each JSON-only setting onto its topic's page.

**Where should other approaches be used?** Honest load states instead of editable defaults; one sticky save bar with an unsaved-changes guard; pickers instead of free-text IDs (AX-B3, CU-B12); a server "explain access" view (ID-PM1); drawers for details (AX-UX10, OB-PM1); a time-boxed debug session (OB-UX2); named, dependency-aware confirmations (AX-B14, IN-B3).

**Where should wizards be added?** The day-1 spine: First working chat / Connect a provider (SH W1 + AI W1), Corporate network (PL W1), Secure this installation as a checklist (ID W1 + SH W3). Then OIDC (ID W2), New app (AI W2), skills, workflows and agents (AX W1–W3), MCP and web search (IN W1, W2), privacy profile (OB W2), debug session (OB W3) and restore (PL W2). No wizard for editing, lookups, policy screens or toggles.

**Is there documentation for an admin who doesn't know how?** Not usable today. No admin page links to the docs (TW-1 in seven reports; AX §9), docs URLs 404 on reload (SH-B1), search buries canonical pages (SH-TW2), most task docs teach `platform.json`, `admin-ui.md` covers 18 of 36 nav items (SH-TW4) and contradicts the UI (SH-TW3, PL-B21), and one compliance doc is wrong about stored uploads (OB-B5).

---

## The parts at a glance

**How to read the table:**

- **Intuitiveness** is the mean of each report's §2 page scores (lead's arithmetic; a range counts as its midpoint).
- **Tasks** are success / partial / failed, from §3.
- **Breakages** are the §4 rows left after verification.

| Part | Covers | Intuitiveness · tasks | Breakages | P0 / P1 | Biggest problem | Biggest win |
|---|---|---|---|---|---|---|
| [01](01-shell-overview-docs.md) | Shell, Cmd+K, Overview, What's New, Docs | 2.4 · 2/4/2 | 27 | 0 / 3 | The Overview fakes a fresh install under load, and docs URLs 404 (SH-B1–B3) | Server-computed Setup progress; "?" links (SH §11) |
| [02](02-apps-models-prompts.md) | Apps, app wizard, Models, Providers, Prompts | 2.8 · 1/4/1 | 25 | 0 / 3 | The app wizard fails on `en-US`/`de-DE` (AI-B1); "only HR" can't be expressed (AI-PM1) | Models tab and Test panel; short new-app flow (AI W2) |
| [03](03-skills-projects-workflows-agents-marketplace.md) | Skills, Projects, Workflows, Agents, approvals, Marketplace | 2.8 · 1/3/2 | 35 | 0 / 7 | The agent schedule is discarded (AX-B1); JSON mode drops edits (AX-B2) | Copy the Projects pattern everywhere |
| [04](04-access-identity.md) | Users, Groups, Authentication, OAuth | 2.7 · 1/2/3 | 31 | **1** / 8 | Failed load + Save = lockout (ID-B1); groups can't restrict signed-in users (ID-B5) | An access explainer (ID-PM1); LDAP's "Test a login" |
| [05](05-integrations.md) | Integrations hub, builder, MCP gateway, Credentials, add-ins | 2.8 · 2/3/1 | 26 | 0 / 5 | Brave, Jira and storage fail on first click (IN-B2, B4, B5); blind credentials (IN-B3) | Install dialog and test diagnostics (IN §2) |
| [06](06-customization.md) | UI Customization, Localization, Pages, Templates, Short links | 2.6 · 3/2/1 | 26 | 0 / 8 | Short links fail their job (CU-B1, B2, B9, B10); a stale save deletes pages (CU-B3) | Document templates (4/5); Brand iHub (CU W1) |
| [07](07-observability.md) | Usage, Feedback, Logging, Telemetry, System, Chats, Tasks, Audit | 3.1 · 1/3/2 | 27 | 0 / 6 | Logging and Telemetry save defaults after a failed load (OB-B1, B2); questions logged at `info` (OB-B4) | System Resources, Audit Log; a privacy hub (OB §11) |
| [08](08-platform.md) | Features, Voice, Security, EU AI Act, Backup, Updates, Advanced | 2.7 · 1 of 7 fully; T7 failed, T3 half failed | 28 | 0 / 6 | A ZIP restores on pick (PL-B1); the export holds every key (PL-B2) | EU AI Act check; Proxy "In effect right now" |
| **Total** | | | **225** (3 Suspected) | **1 / 46** | | |

---

## Cross-cutting themes

Ten themes recur in at least three parts. Each has one root cause in shared code and one platform fix.

**1. Save after a failed load; whole-block or redacted writes.** The most dangerous theme. *Evidence:* ID-B1 (P0), IN-B1, OB-B1, OB-B2, PL-B3, IN-B6, CU-B5; lost updates CU-B3 (pages deleted), PL-B4 (`jwkUrl` erased), OB-B10. *Cause:* pages seed defaults, the `catch` only sets a message, Save is gated by `disabled={saving}` alone, and the server replaces whole blocks (`configs.js:357-375`). `server/utils/etag.js` exists but no route checks `If-Match` (I grepped: 0 hits); `AdminLoadError` is on 33 of 74 pages (SH appendix). *Fix — a config resource:* a `useAdminConfigSection` hook that renders no form unless `ready`; `PATCH /api/admin/configs/platform/{section}` with `If-Match` and a merge that keeps redacted secrets; audit entries and snapshots written there (OB-B6); a server refusal of auth configs that leave the caller no sign-in route (ID §11 #1).

**2. Errors shown as empty, fresh or raw, amplified by rate-limit fan-out.** *Evidence:* SH-B2 (Overview becomes a "fresh install"), AX-B9 ("Add Registry" beside a 373-item registry), AI-B11, ID-B16, ID-B24, IN-B7, CU-B21, OB-B22; raw axios text SH-B10, ID-B14, AX-B15, PL-B15. About 7 shell calls per navigation (13 on the Overview) meet a shipped `adminApi` limit of 100/min against 500 in code (checked: `server/defaults/config/platform.json:238-241`, `rateLimiting.js:152`; PL-B18). *Fix:* a data boundary that never shows "Create your first…" on error; an axios interceptor that maps problem+json `detail`/`code` and retries once on `Retry-After`; one `/api/admin/shell` call; a per-user limit (decision 9).

**3. The unsaved-changes guard is opt-in.** *Evidence:* AX-B6, ID-B11, CU-B4, IN-B12, OB-B16 (all 8 pages), PL-B14 (all 7), AI-B20, while `docs/admin-ui.md:513` promises it everywhere. *Cause:* `AdminSettingsPage` has a dirty bar but never calls `useUnsavedChanges` (PL-UX1); `Modal` closes on Escape and backdrop by default. *Fix:* frames compute `dirty` and call the guard themselves; `Modal` takes a `dirty` prop.

**4. Invisible controls and lost dark mode.** *Evidence:* borderless inputs AI-B3 (~40 fields), ID-B7, AX-B25 (22 of 27), IN-B10, CU-B6, PL-B6; white-on-white Save PL-B5; dark labels ID-B9; cold-load dark mode SH-B9 = ID-B8 = OB-B17 = PL-B19. *Cause:* Tailwind 4 Preflight zeroes borders, there is no forms plugin, class strings omit `border`, and `INPUT_CLASS` goes unused; `useDarkMode` mounts only in the main layout. *Fix:* a scoped base CSS rule and the theme hook in `AdminLayout` now; then `AdminField`/`AdminInput`/`AdminButton` (roadmap 3B-3), a lint rule and a Playwright border check.

**5. Destructive actions without a named confirmation or dependency check.** *Evidence:* unconfirmed AI-B2, PL-B1, PL-B8, OB-B7, OB-B8, AX-B23, IN-B18; unnamed AX-B14 (it deleted the shipped registry), AI-B12, AX-B13, CU-B14, ID-B12, IN-B3; no invariant ID-B2, ID-B4. *Cause:* native `confirm()`/`alert()`/`prompt()` (AI-B12, CU-B24, ID-B15), a free-text-only `ConfirmDialog`, ad-hoc in-use checks. *Fix:* a server "used by" and invariant layer (409 `RESOURCE_IN_USE` with `usedBy[]`); a dialog that names the item and its dependants, modelled on the EU AI Act switch-off dialog (PL-UI6) and the Projects delete guard; ESLint `no-alert`.

**6. Forms that don't round-trip; controls the server ignores.** *Evidence:* AI-B1, ID-B3, CU-B1, AX-B2, AX-B3, AX-B5, CU-B8, CU-B19, ID-B18; dead controls AX-B1, CU-B2, CU-B7, AX-B11, CU-B11, AI-B5, AI-B7, IN-B2, IN-B5, SH-B3, SH-B4. *Fix:* a round-trip contract test per editor (load, save unchanged, JSON identical); field primitives that parse on blur; admin DTOs in `shared/`; CLAUDE.md's "server decides, client renders" applied to config, and fields with no reader deleted.

**7. Unworkable configurations are accepted.** *Evidence:* AX-B4, AX-B17, AX-B8, AI-B9, AX-B21, AX-B15, ID-B19, CU-B12, IN-B21, PL-PM3. *Fix:* referential validation on save (IDs exist, models enabled, options non-empty, cron parses, required features on) returning problem+json `errors[]` with pointers, which also fixes IN-B4; admin-scoped pickers (`fetchAdminModels` exists).

**8. Access is misrepresented and nothing computes it.** *Evidence:* shipped `authenticated` grants `*` and grants only add up, yet the editor says a group "only has its own permissions" (ID-B5); no model access card (AI-PM1); no group grants workflows (AX-B10); one MCP server needs ~7 group edits (IN-PM1); machine clients default to `*` (ID-B6); "why can't X see Y" is slow or fails in four parts (ID T6 failed, AI T6 partial, SH T2 took 11 steps, AX-UX2). *Fix:* one explainer, `POST /api/admin/users/{id}/_explain-access`, behind a user Access tab, an Availability check and "Visible to" pills (ID-PM1, AI-UX1); inherited chips everywhere (ID-UX3); item-level audience is your call (decisions 1–3).

**9. No help in place; docs teach JSON.** *Evidence:* zero help links; SH-B1; search (SH-TW2, AX-TW8, CU-TW8, OB-TW8); `admin-ui.md` (SH-TW3, SH-TW4, AI-B25, ID-B23, PL-B21); wrong in-product pointers (SH-B14 = OB-B12, IN-B23). *Fix:* the [documentation plan](#documentation-plan).

**10. German is half missing.** *Evidence:* keys missing from both locale files: SH-B13 85, AI-B14 287, AX-B7 ~320 strings (verifier: 217 keys in six pages, plus the hard-coded AgentRunsPage; P1), ID-TW3 120 plus ~80 literals, IN-TW8 ~115 (verifier recount), CU-B22 196, OB-B18 18, PL-B22 27. Missing keys can't be overridden by admins (CU-B22); German errors render green (PL-B9). *Cause (checked):* `translation-keys-exist.test.jsx` skips `features/admin` (`:19`) and every `admin.` key (`:64`). *Fix:* remove both exclusions behind a baseline that can only shrink.

**Leverage.** By my recount of the safety analysis, five platform fixes remove 32 of the 47 P0/P1 items: the config resource (11), form primitives plus base CSS (8), the used-by service and dialog (5), round-trip and referential validation (5), and a base-path lint plus redirect helper (3).

---

## What is broken — the must-fix list

All 47 P0 and P1 items, grouped by pattern; the letters match the analysis behind the themes.

**Severity is inconsistent across parts.** Save-after-failed-load is P0 in ID-B1, P1 in three parts (IN-B1, OB-B1, OB-B2, PL-B3) and P2 in IN-B6 and CU-B5. Borderless inputs are P1 in four parts and P2 in AX and IN. **Treat each class at its worst instance.**

| Pattern | ID | Sev | What happens |
|---|---|---|---|
| A Save after failed load | ID-B1 | **P0** | `/admin/auth` shows defaults as "All valid"; one Save locks the admin out |
| | IN-B1 | P1 | MCP gateway Save replaces the `mcpServer`/`oauth` blocks |
| | OB-B1 | P1 | Telemetry Save wipes the OTLP config |
| | OB-B2 | P1 | Logging Save can switch audit IP masking off |
| | PL-B3 | P1 | SSL, SSRF, CORS, Cookies and Proxy save empty lists |
| B Lost updates | CU-B3 | P1 | A stale `/admin/ui` save deletes Pages entries |
| | PL-B4 | P1 | Advanced and Provenance post the redacted config and erase the proxy-JWT `jwkUrl` |
| C Destructive / invariants | AI-B2 | P1 | Enable All / Disable All are unconfirmed; Disable All clears the default model |
| | PL-B1 | P1 | Choosing a ZIP immediately replaces all of `contents/` |
| | ID-B2 | P1 | No last-admin or self guard on edit; you can untick your own sign-in method |
| | ID-B4 | P1 | Deleting an inherited-from group freezes the group cache |
| | IN-B3 | P1 | A credential in use is deleted silently; the installation still shows "set" |
| D Data corrupted | AI-B1 | P1 | The app wizard writes under `en-US`/`de-DE`; Create fails on most browsers |
| | AX-B2 | P1 | Agent JSON mode drops every structural edit |
| | AX-B3 | P1 | Commas can't be typed into group fields; approvals reach nobody |
| | AX-B5 | P1 | Ask a Person shows `[object Object]`; editing destroys the German label |
| | ID-B3 | P1 | Saving a disabled user re-enables them |
| | CU-B1 | P1 | Editing a short link never changes its target |
| E No real effect | AX-B1 | P1 | The agent schedule is discarded and never fires |
| | CU-B2 | P1 | A short link's prefilled prompt is silently dropped |
| | CU-B7 | P1 | Translation search dead-ends ("Changed only" defaults to on) |
| | SH-B3 | P1 | The setup checklist never shows on a fresh install; its ticks are constants |
| | OB-B3 | P1 | The log component filter hides other components' errors |
| | IN-B2 | P1 | Install-once integrations propose the wrong ID and fail |
| | IN-B5 | P1 | Jira's only sign-in mode shows as "(later release)" |
| F Unworkable config | AX-B4 | P1 | An Ask a Person step with zero options can never be answered |
| G No unsaved guard | AX-B6 | P1 | The workflow canvas loses work silently |
| | ID-B11 | P1 | `/admin/auth` loses OIDC and LDAP input on a sidebar click |
| | CU-B4 | P1 | `/admin/ui`, overrides and the template editor have no guard |
| H/I States and errors | SH-B2 | P1 | A failed apps request turns the Overview into a "fresh install" |
| | IN-B4 | P1 | Field errors never reach their fields (`details.issues` vs `errors[].pointer`) |
| J Invisible controls | AI-B3 | P1 | About 40 inputs have no border; some dark labels are unreadable |
| | ID-B7 | P1 | User and Group editor inputs have no border |
| | ID-B9 | P1 | `/admin/auth` checkbox labels are near-invisible in dark mode |
| | CU-B6 | P1 | Short link, page and translation inputs are invisible |
| | PL-B5 | P1 | The Cookies Save button is white on white |
| | PL-B6 | P1 | Voice, TTS and update fields have no border (WCAG 1.4.11) |
| L Access | ID-B5 | P1 | Groups can't restrict signed-in users, but the editor says they do |
| | ID-B6 | P1 | Machine OAuth clients default to all apps and models |
| M Base path | SH-B1 | P1 | `/admin/docs/<page>.md` 404s on reload (`staticRoutes.js:109-110`) |
| | CU-B9 | P1 | Short-link Copy and Test drop the base path |
| | CU-B10 | P1 | Short-link redirects leave the base path |
| N Privacy / accountability | OB-B4 | P1 | Every chat question and username is logged at `info` |
| | OB-B5 | P1 | The DPO doc says uploads aren't stored; they are |
| | OB-B6 | P1 | Logging and tracking-mode changes leave no audit diff |
| | PL-B2 | P1 | The backup ZIP holds the encryption key, the JWT keys and password hashes |
| P German | AX-B7 | P1 | Skills, Workflows and Agents are English-only in German (~320 strings; 217 missing keys by the verifier's count) |

**Also pull in these P2s:** IN-B6, CU-B5 (save after failed load); PL-B8, OB-B7, OB-B8 (unconfirmed platform-wide actions); AX-B14, AI-B12 (unnamed deletes); PL-B9 (green German errors); PL-B12 (TLS allowlist bypasses the SSRF guard); OB-B13 (OTLP ignores the TLS allowlist, against CLAUDE.md); OB-B28; AX-B16.

---

## Proposed information architecture

**Principles:** one fixed job order defined once (today `AdminSidebarNavData.js:389-394` sorts by translated label with `localeCompare`, checked; A–Z lookup becomes the palette's job, SH §10); one nav structure feeds the sidebar, Cmd+K, shortcuts, every `helpPath` and `admin-ui.md`; each setting on its topic page and never a raw `platform.json` editor, which would repeat PL-B4's redacted round-trip and bypass encrypt-on-save (PL §10); queues beside their object with badges; configure and observe kept apart (OB §2); one home per object (IN-PM4, AX-UX6); H1 = nav label, area named "Administration" (AX-UI8, SH-TW8).

```
Overview                                  • attention badge
AI WORKSPACE
  Build:    Apps · Models (Models | Providers) · Prompts · Projects · Skills
  Automate: Workflows · Agents (Agents | Inboxes) · Runs & approvals • NEW
  Marketplace (Browse | Updates | Registries)
ACCESS & IDENTITY   Users · Groups · Sign-in methods · API access
INTEGRATIONS        Connected systems • · Channels NEW · Credentials
CUSTOMIZATION       Branding & layout · Content pages · Localization · Document templates · Short links
MONITORING          Usage reports · Feedback · Audit log · Logs · System health · Scheduled tasks · Telemetry
GOVERNANCE & PRIVACY NEW   Data & privacy NEW · Chats & retention · EU AI Act · Tool approval
PLATFORM            Settings: Features · Voice & speech · Security (Outbound | Inbound)
                    Maintenance: Backup & restore · Updates · Server tools
footer: Help · What's New • · Shortcuts · Theme
```

**Before → after:**

| Today | After | Why |
|---|---|---|
| "What's New & Docs" as section 2 | Sidebar footer | SH §6 |
| A–Z order (Agents before Apps, Advanced first) | Fixed job order | SH §10, SH-UX5 |
| Pending Approvals button, Workflow executions, orphaned `/admin/agents/runs` | **Runs & approvals** (Pending · Runs · Failed), plus a non-admin "My approvals" | AX §10, AX-B31, AX-B24 |
| Authentication | **Sign-in methods**: method cards, per-method Save and Test | ID §11 #6 |
| OAuth | **API access**: Service clients · Apps acting for users · Personal API keys · Server settings | ID §6.7 |
| Integrations › Integrations | **Connected systems**, with no client cards on Installed | IN-TW5, IN §6 |
| MCP gateway + 4 client pages reachable only from tabs | **Channels** hub on one template; OAuth policy moves to API access | IN-PM4, IN-PM10 |
| UI Customization (8 tabs by JSON section) | **Branding & layout** (Branding · Start & apps · Navigation & footer · Messages · Advanced), `?tab=` in the URL | CU §6, CU-UX3 |
| Chat History (3,960 px form) | **Chats & retention**; the sharing policy moves to Security | OB §10 |
| Privacy settings on 5 pages | **Data & privacy** | OB-PM3, OB-PM4 |
| EU AI Act under Platform | Governance & privacy, with "Notices & consent" (absorbs the Disclaimer) | PL §6, CU-PM4 |
| Advanced | **Server tools**: actions plus a read-only effective config. Onboarding toggle → Setup progress | PL §10, SH §6 |

Routes are kept and only labels change. The new routes (`/admin/runs`, `/admin/channels`, `/admin/data-privacy`, `/admin/tool-approval`) live under `/admin`, which `KNOWN_ROUTES` and `index.html` already list. Old routes redirect, as `/admin/system` does. Unknown `/admin/*` URLs render a 404 inside the shell (SH-B24).

**Visibility:** Localization and Document templates get their own `showAdminPage` keys (CU-PM9); OAuth obeys `admin.pages` (ID-B30); content admins see Skills and the docs (SH-PM6).

**Conflicts resolved:** task order over A–Z and job groups over a "Preview" divider (SH §10); Providers stays a Models tab (AI §10); Runs & approvals under Automate (AX §10 #1); per-topic fields plus a read-only viewer over a "Platform settings" page (SH-PM3 vs PL §10); a Governance section for the DPO, works-council and legal audience (OB §10 vs PL §10); one-page app editor with a sticky index, tabbed workflow editor (AI §10, AX §10); one Security page grouped Outbound / Inbound, Backup and Updates kept separate (PL §10).

**Settings without a UI, and where they go:**

| Setting | Home |
|---|---|
| Session timeout, password policy, LDAP/NTLM self-signup | Sign-in methods › Sign-in security (PL-PM4, ID-B20) |
| OAuth client scopes, `dcr.maxClients`, `cimd.*` defaults | API access (ID-B20, IN-PM8) |
| `requestBodyLimitMB`, `requestConcurrency`, `swagger.*`, project scan | Security › Server & limits (SH-PM3, PL-PM4, AX-PM5) |
| `trustProxy`; a trusted company CA | Security › Rate limits; Security › Outbound › TLS trust (PL-PM1) |
| `audit.*`, usage, feedback (default −1 = forever) and workflow-state retention | Data & privacy (OB-B12, OB-PM4) |
| Workflow and agent schedule and webhook triggers | One shared "When it runs" picker (AX-PM1, AX-PM5) |
| App `greeting` and `outputSchema`; model `hint` and `supportsTemperature` | App and model editors (AI-PM4) |
| App categories, prompt-list and language-selector settings | Branding & layout › Start & apps (CU-PM3) |
| `admin.pages.*` and the long tail | Server tools › read-only effective configuration with "where to edit" links |

Until then, retract "You do not need to edit JSON files" (`admin-ui.md:5`, SH-PM3).

**Search (Cmd+K).** Today it searches a hand-copied English list of 35 pages; 15 of 21 realistic queries fail (SH-B6, OB-B19, PL-B26). Rebuild it from `getAdminNavSections()` with translations, aliases and en/de keywords (oidc, sso → Sign-in methods; proxy, tls → Security; dsgvo → Data & privacy); index settings so "session timeout" lands on the field; search skills, workflows, agents, installations and credentials; add wizard-launching actions and a "Search the docs" fallback; give it dialog semantics (SH-B12). Fix `g g`, wire or drop `n`, and add a single-key off switch (SH-B7, SH-B8, SH-TW9).

---

## Wizards and guided flows

**First run.** A server-computed **Setup progress / Needs attention** list (SH-PM1) is the source of truth. It replaces the hard-coded checklist (SH-B3), and it survives a skipped wizard. Each wizard walks one or more of its items, and can be relaunched from them (SH §10, ID §10).

**Shared blocks to build first:**

- a stepper shell that persists across redirects;
- a layered `ConnectionTest` (DNS → proxy → TLS → SSRF → auth → HTTP), with a fix link per layer;
- a secret field: "paste new / use stored" (IN-PM2);
- a `GroupMultiSelect` with an audience preview;
- the existing `ScheduleBuilder`;
- a `SecretRevealDialog` (ID-B15);
- a "Next steps" checklist.

Only `SetupWizard` and `AppCreationWizard` exist today (ID appendix).

| # | Wizard (source) | Must be fixed first | Pri / effort |
|---|---|---|---|
| WZ-1 | First working chat / Connect a provider (SH W1, AI W1) | Cause-specific test errors (SH-B15, AI-B10); models inherit the provider endpoint (AI-PM6); SSRF guard for custom URLs (SH-ADMIN2) | H / M |
| WZ-2 | Corporate network (PL W1), also a branch of WZ-1 on TLS/DNS/proxy failures | Test the *effective* config (PL-B13); show the TLS→SSRF coupling (PL-B12); CA store (PL-PM1) | H / M |
| WZ-3 | Secure this installation, a checklist launched from the demo banner (ID W1, SH W3) | Server lockout refusal (ID-B1, ID-B2); self-service password change | H / S–M |
| WZ-4 | Company sign-in, OIDC (ID W2) | Absolute redirect URI (SH-ADMIN5); tenant presets (ID-B22); test sign-in showing claims | H / L |
| WZ-5 | Brand iHub (CU W1) | Server draft + preview (CU §10); ETag on `ui.json` (CU-B3) | H / L |
| WZ-6 | Add a legal page (CU W2) | Page + footer link in one call | M / M |
| WZ-7 | New app, short (AI W2), owning `/admin/apps/new` for every entry point (SH-B16) | AI-B1, AI-B4, AI-B6, AI-B9; let admins test disabled apps (AI §10) | H / M |
| WZ-8 | Add knowledge to an app (AX W4) | — | M / S–M |
| WZ-9 | New skill (AX W3) | — | H / M |
| WZ-10 | Workflow from a template (AX W2) | AX-B4, AX-B12; one-page editor | H / L |
| WZ-11 | New agent with a dry run (AX W1) | **AX-B1 first**, or the schedule step lies | H / L |
| WZ-12 | Restrict access / group from intent (AI W3, ID W3) | Explainer (ID-PM1); decision 1 | M / M |
| WZ-13 | Register a service client (ID W4) | An empty list means none (ID-B6, decision 4) | M / M |
| WZ-14 | MCP server by URL (IN W1) | Server `restricted` flag (IN-PM1) | H / M |
| WZ-15 | Add web search (IN W2) | IN-B2 | H / M |
| WZ-16 | Roll out to staff (IN W3) | IN-B13, IN-B14, IN-B18 | M–H / M–L |
| WZ-17 | Rotate a credential (IN W4) | "Used by" (IN-PM3); MCP reconnect (IN-B25) | M / M |
| WZ-18 | Short-link builder, one screen (CU W3) | CU-B1, CU-B2, CU-B9, CU-B10, CU-B19 | M / M |
| WZ-19 | Connect OpenTelemetry (OB W1) | OB-B13 | M / M |
| WZ-20 | Privacy profile + DPO report (OB W2) | OB-B4, OB-B6, OB-PM4 | H / M |
| WZ-21 | Debug session, 3 fields (OB W3) | Replaces OB-B3's filter | H / M |
| WZ-22 | Restore from backup (PL W2) | PL-B1, PL-B7; key-compatibility check | H / M |
| WZ-23 | Prepare for update, then review it (PL W3, SH W4) | PL-B10, PL-B11; `audience` tag (SH-TW7) | M / S–M |
| WZ-24 | Set up voice (PL W4) | PL-B17 | L–M / M |

**Where a wizard would be wrong.** Use a wizard only for a one-time, high-stakes job that crosses pages or systems and should end in a live test. A wizard that creates something ends in the full editor, never in a second copy of its fields; AI-B1, AI-B5 and AI-B6 are the cost of breaking that rule (AI §10).

Instead: a sectioned editor with a sticky save bar for existing objects (AI, AX, ID, IN §10); a diagnostic view or drawer for "who can see X" and complaint investigation (SH §10, OB §10); clear copy and safe saves for policy screens such as CORS, SSRF and custom CSS (PL §10); a first-visit mode for already-guided pages such as EU AI Act (PL §10); templates or presets shown as a diff for document templates, feature sets and the monthly report (CU §10, PL §10, OB §11); the expert path (skill `.zip`, plain Telemetry form) kept beside the guided one. One big "Add integration" intent wizard is deferred until WZ-14 and WZ-15 exist (IN §10).

---

## Patterns to replace

| Today | Proposed | Applies to |
|---|---|---|
| A failed load shows an editable form or a fake empty state | `AdminLoadError` + Retry; nothing editable until loaded | SH-B2, ID-B1, IN-B1, IN-B7, CU-B5, OB-B1, OB-B2, PL-B3, AX-B9 |
| Three save models; Save only at the top or bottom | A sticky save bar plus the guard; instant save only for a lone Switch outside forms | CU-B4, AI-UI4, AI-UI5, ID-UI6, PL-UX1, OB-B10 |
| JSON-only settings | Typed cards per topic and a read-only effective config | SH-PM3, AI-PM4, CU-B2, PL-PM4, OB-PM4 |
| Free-text IDs, colours, icons and URLs | Pickers: groups, inbox, `IconPicker`, `ColorField`, `AssetPicker`, `ScheduleBuilder`; auto-slugged IDs | AX-B3, AX-B17, CU-B12, AI-UX8, CU-UX1, AX-UX8, ID-ADMIN6 |
| Create in a new tab or page | Inline create in a drawer; details in drawers | IN-PM2, AX-UX10, OB-PM1 |
| One-way links | "Used by" + "Add to…" from both ends | AX-UX1, IN-UX1, IN-PM3, CU-UX9 |
| `confirm()` / `alert()` / `prompt()` | A named `ConfirmDialog` with dependants and a 409 from the server; `SecretRevealDialog` | AI-B12, AX-B14, ID-B15, IN-B3, CU-B24, PL-B1, PL-B8, OB-B8 |
| Toolbar bulk buttons, eye icons, chips that toggle | Row selection with named bulk actions; `Switch` | AI-B2, AI-UI7, AX-B23, IN-UI4 |
| Hidden prerequisites | A gate checklist owned by the feature (Chat History's `GateRow`) | OB-PM5, AX-UX2, AI-UX1, PL-PM3 |
| Access worked out in the admin's head | A server explainer | ID-PM1, AI-UX1, ID-UX3 |
| Save publishes to everyone | Draft → preview → publish, where asked for | AI-PM2, CU-PM2, AX-B11 |
| A permanent global debug filter | A time-boxed debug session | OB-B3, OB-UX2 |
| Long forms of equal cards | A sticky index with collapsed defaults | AI-UX3, AX-UI6, ID-UI7, OB-UI7 |

---

## Documentation plan

**Coverage verdict.** Every part fails the same way: the UI is not taught, and the docs are not linked.

| Part | Missing or JSON-only | Wrong (examples) |
|---|---|---|
| 01 | Install → working chat; go-live hardening; JSON-only settings list | `admin-ui.md`, 9 statements (SH-TW3); `GETTING_STARTED.md:87` |
| 02 | Diagnose a failed test; local LLMs through the UI | `prompts.md:40` (AI-B7); `apps.md:1511` (AI-B15); base URL (AI-B25) |
| 03 | First workflow; agents; approvals in the UI; app vs skill vs workflow vs agent | `agents.md:5,37` (AX-B1); `marketplace.md:21/38` (AX-B35) |
| 04 | OIDC via the UI; IdP group mapping; CIMD | `admin-ui.md:255` (ID-B23); stale OAuth enable (ID §9) |
| 05 | `credentials.md`; MCP with a token | `browser-extension.md` (IN-B13, IN-B14); `integrations.md:315` |
| 06 | `short-links.md`; branding through the UI | Six errors (CU-B23) |
| 07 | Complaint investigation; debug; DPO evidence | `pii-data-handling.md:29` (OB-B5); stale paths (OB-B27) |
| 08 | Feature flags; backup; corporate network | `admin-ui.md` Platform chapter (PL-B21); a release note (PL-B28) |

Good models to copy: `GETTING_STARTED.md`, the Outlook/Copilot/Nextcloud rollout guides, `document-templates.md`, `projects.md`, the iFinder diagnostics; in the product, the Proxy card, the EU AI Act check and the Copilot page's numbered steps.

**House rules:** UI first, with steps as nav paths and exact field labels, JSON in a collapsed "Configuration file equivalent"; an "Administration" group in `SUMMARY.md` with engineering content moved out (AX §9, OB §9); task-phrased headings (CU-TW8); honest limits (ID-B5, CU-B1, AX-B1); say the docs are English (`docs/de` doesn't exist, checked) and add German search synonyms (OB-TW8); release entries carry an `audience` tag and "What you need to do" (SH-TW7).

**New pages** (none exist today). *Wave 1:* `admin-first-hour.md` (one anchor per Setup progress item), `admin-how-do-i.md` (~50 tasks; the admin docs home), `where-is-setting.md` (setting → UI path or "file only" → restart?) (SH §9, SH-PM3, PL §9), `access-control.md` and `troubleshooting-access.md` (AI §9, ID §9, IN §9), `sign-in-setup.md` (ID §9), `corporate-network.md` (PL §9). *Wave 2:* `setup-first-model.md`, `app-quickstart.md` (AI); `oidc-entra-keycloak.md`, `oauth-clients.md` (ID); `workflows-getting-started.md`, `workflow-nodes.md`, a rewritten `agents.md` (AX); `integrations-how-to.md`, `credentials.md`, `client-rollout.md` (IN); `branding.md`, `pages.md`, `short-links.md` (CU); `observability.md`, `audit-log.md`, `data-protection-guide.md` (OB); `feature-flags.md`, `backup-restore.md`, `ai-act-legal-summary.md` (PL).

**Rewrites:** `admin-ui.md` becomes the map, one section per nav item in sidebar order (what it's for · common tasks · screen anatomy · things to know · learn more), adding the 18 missing sections (SH-TW4) and qualifying the `:513` guard promise; `concepts.md` gains Workflow, Agent and Marketplace rows and a glossary (AX §9); `apps.md`, `models.md`, `prompts.md`, `skills.md`, `local-llm-providers.md`, `customization.md`, `feedback-feature.md` and `telemetry.md` are rewritten UI-first.

**Fix first, by harm:**

1. Compliance: OB-B5 (uploads), OB-B4 (`info` logging), OB-B28 ("anonymous").
2. Security: the stale OAuth enable instructions (ID §9) and the client hint (ID-B6).
3. Wrong outcomes: AX-B1, AI-B7, AI-B15, `integrations.md:315`, `AUTHENTICATION_QUICK_START.md:153` (`admin` should be `admins`, SH-TW3), and IN-B14.

**Contextual help system.**

- **Wiring:** a `helpPath` per nav item and a `docsHref` per settings section and card feed one `DocsHelpLink` ("?", named "Help: {page}") built on the existing `docsLinkTarget()`. Page headers show it automatically (resolving `activeFor`, SH-B23); it also goes on "What to check" links after test failures (AI-TW8) and on `AdminEmptyState`, which has no docs prop today (AX-UI4).
- **Deep links first:** fix SH-B1 by exempting `/admin/docs/` from the extension rule, keep the `.md` URLs, and add cold-load tests at `/` and `/ihub/` (no changelog entry: `/admin/docs` is unreleased, SH §1). "?" opens a new tab until the guards ship.
- **Both directions and access:** docs links into the admin go through `buildPath()`, with page state in URLs (`/admin/ui?tab=footer`, CU-UX3); docs read routes open to content admins (SH-PM6); the main app's "Documentation" goes to `/admin/docs` for admins (SH-ADMIN3); integration `docsUrl` values point at version-matched docs (IN-TW1).
- **CI and search:** every nav item has a `helpPath`, every anchor resolves, every file is in `SUMMARY.md`; search gets whole words, title boost, synonyms and German nav terms (SH-TW2). Phase 2 adds a docs side drawer.

**Microcopy.** One load template ("Couldn't load {thing}. {detail} [Try again]") and one 429 template ("The server is busy. Try again in {n} s."), never "Request failed with status code N" (SH-B10, ID-B14, PL-B15), via one helper, `apiErrorMessage()` (PL appendix). Empty states say how things get created; confirmations name the object, its dependants and the undo path; help text says what a setting does for users, never a JSON path (OB-TW4, PL-TW5).

**Terminology.** Administration (the area); "New ⟨thing⟩" for create; Delete destroys, Remove unbinds (IN-B24); Enabled/Disabled as a Switch; Access, summarised "Visible to: …"; "Everyone signed in / Everyone (anonymous)" (ID-ADMIN1); Admin role None / Content editor / Full administrator (ID-TW5); Service client / Shared account / Runs as for the three "service accounts" (ID-TW4, IN-TW4); Runs (AX-UX6); Duplicate; "Opens in app" (AI-B7); TLS and allowlist in the UI; *Sie* in German (IN-TW8).

**German.** Extend `translation-keys-exist.test.jsx` (drop both exclusions behind a shrinking baseline, require `_one`/`_other` plurals, AX-B30), lint literal JSX text in `features/admin`, return a `messageKey` from server diagnostics (AI-TW8, IN-TW8), and never derive status colour from text (PL-B9).

---

## Design system work

**Verdict.** Every part mixes three design generations: newer pages (Models, Projects, Templates, Marketplace, EU AI Act), older hand-built ones (Providers, OAuth, Credentials, client pages, Logging, Agents), and the five `AdminEditPageShell` editors with broken inputs (AI-UI9, ID §2, IN §2, PL §1). The fix is migration: `formStyles.js`, `AdminSettingsPage`, `AdminEditPageShell`, `AdminTabs`, `DataTable`, `Badge`, `Switch`, `Modal`, `Drawer`, `ConfirmDialog`, `AdminLoadError`, `IconPicker`, `useUnsavedChanges`, `docsLinkTarget()` and the axe baseline already exist (AI, AX, OB, PL appendices).

**Primary colour.** The parts disagree (IN-UI1, CU-UI1, PL-UI2). Choose **indigo via the `admin-accent` token**: it is `#4f46e5` (checked, `client/tailwind.css:36`) and roadmap 3B-3 specifies indigo (CU-UI1). Blue = info, green = completed, amber = act now, red = danger; never green or orange as primary (PL-UI2, AX-UI2).

| Tier | Component | Fixes |
|---|---|---|
| 0 | Retune `formStyles` to the accent; stop using `bg-primary-600`; add a scoped base CSS rule for admin controls | PL-B5, AI-UI1, the borderless class |
| 0 | Theme hook in `AdminLayout`, a pre-paint script and a sidebar theme toggle | SH-B9, ID-B8, OB-B17, PL-B19 |
| 0 | A full-width banner slot, stacked at 390 px | SH-B5, ID-B10, PL-B20 |
| 1 | `AdminField` + `AdminInput`/`Select`/`Textarea`/`Checkbox` (3B-3): bound labels, one asterisk, errors on blur | AI-B3, AI-B16, AI-B18, ID-B7, ID-B21, AX-B25, AX-B29, IN-B10, IN-B11, CU-B6, CU-B18, PL-B6, OB-B26 |
| 1 | `AdminButton` over the tokens, with icon-only buttons requiring `aria-label` | AI-UI1, AX-UI2, AX-UI3, ID-UI2, ID-UI3, IN-UI1, OB-UI4, PL-UI2 |
| 1 | `Switch`; `StatusBadge` with entity states; `DocsHelpLink` | AI-UI7, AX-B23, IN-UX5, PL-UI4, SH-B17 |
| 2 | `AdminPageHeader` (H1 = nav label, one primary action, help slot) | SH-UI1, AI-UI3, AX-UI1, ID-UI1, CU-UI2, OB-UI1, PL-UI1 |
| 2 | `AdminPage` frame with load gating; `AdminSaveBar` wired to the guard | Themes 1–3 |
| 2 | `AdminSettingsPage`: mobile section select, scroll-spy fix, no duplicate H2s, per-section `keywords` | PL-B20, PL-B25, PL-B26, PL-B27 |
| 2 | `AdminEditPageShell` adopted by the remaining editors (Skill, Project, Workflow, Agent, Inbox, Page, Short link, Provider, OAuth client) | AX-UI1, CU-UI3, AI-UI9, ID-UI1 |
| 3 | `AdminTabs` + `?tab=`; `DataTable` in place of hand-rolled tables; `Modal` as the only overlay; `SecretRevealDialog`; `GateChecklist`; `UsedByCard`; `StatCard` | CU-B17, AI-B17, AX-B34, SH-B12, AX-B27, AX-B36, ID-B15, OB-UI3 |
| 4 | `ColorField` (extracted), `AssetPicker`, keyboard-operable `GroupMultiSelect`, `HostListInput`, `CopyField`, `DateRangeControl` | CU-B20, CU-UX1, ID-B21, PL-UI5, IN-B26, OB-UI3 |

**Enforcement:** ESLint bans `confirm`/`alert`/`prompt` and raw primary colours; CI flags `border-gray-300` without `border`; a Playwright check measures border width in light and dark; the axe baseline (`tests/e2e/accessibility.spec.js`) is ratcheted; cold-load e2e runs in dark mode and at 390 px.

**Quick wins (each S):** `INPUT_CLASS` in the six editors of AI-B3, ID-B7, AX-B25, IN-B10, CU-B6, PL-B6; the theme hook (SH-B9); the Cookies button (PL-B5); the 390 px banner (SH-B5); `dark:` variants (ID-B9, AX-B26, OB-B26, PL-B29); a custom React Flow node type (AX-B20); one asterisk, validation on blur (AI-B16, AX-B29, ID-B25); `/admin/ui` and Prompts on `AdminTabs` (CU-B17, AI-B18); status colour by type (PL-B9, SH-B17); grey Disabled (AI-UI7); the plural (AX-B30); one `<main>` (SH-B21); `aria-label`s (AX-UI3, ID-UI3, IN-B11).

---

## Roadmap

Effort: S = days, M = 1–3 weeks, L = more than 3 weeks. Every visible change gets a `docs/releases/next/` entry via the `document-feature` skill (which also decides when none is needed, e.g. SH-B1); config shape changes need a migration in `server/migrations/`.

### Now: next 2–3 weeks (safety and quick fixes)

| What | IDs | Effort |
|---|---|---|
| Gate every config page on a successful load | ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5 | S |
| Lockout refusal; last-admin and self guard; `active` fix; 409 on deleting an inherited-from group | ID-B1, ID-B2, ID-B3, ID-B4 | S |
| Stop redacted and whole-file overwrites | PL-B4, CU-B3, OB-B10 | S |
| Unsaved-changes guards everywhere, starting with `AdminSettingsPage` | ID-B11, CU-B4, AX-B6, OB-B16, PL-B14, IN-B12 | S–M |
| Named confirmations on `ConfirmDialog`; ESLint `no-alert` | PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3 | S |
| Visual P1s (quick wins above) | AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6, SH-B9 | S |
| Contract bugs | AI-B1, AI-B4, AI-B6, IN-B2, IN-B4, IN-B5, AX-B2 (`DualModeEditor`), AX-B3, AX-B4, AX-B5, CU-B1, CU-B2, CU-B7, CU-B8, CU-B9, CU-B10 | S each |
| Workflow quick fixes: canvas node type, built-in `input`, computed Groups column, hide Publish, step names in errors | AX-B10, AX-B11, AX-B12, AX-B20, AX-B32 | S |
| Agent schedule: hide the field and add a doc note now; fix the scheduler next | AX-B1, AX-B21 | S / M |
| Log filter never drops `error`; offer only components the server emits | OB-B3 | S |
| Privacy and security: chat questions out of the logs (decision 7), DPO doc, backup sensitivity callout, TLS→SSRF coupling shown (decision 14 decides the coupling itself) | OB-B4, OB-B5, PL-B2, PL-B12 | S |
| Feedback privacy: stop logging the rater's username and chat ID at `info` (`server/utils.js:360-371`), or log them only behind a default-off setting; stop storing the raw `chatId` in `feedback.jsonl` in modes that promise anonymity, and relabel "Anonymous (hashed)" | OB-B28 | S |
| Honest Overview; docs deep links | SH-B2, SH-B3, SH-B1 | S |
| Least-privilege service-client UI; `SecretRevealDialog` | ID-B6, ID-B15 | S |
| Harmful docs and wrong in-product pointers | OB-B5, AI-B7, AI-B15, SH-B14, IN-B23, CU-B12 | S |
| Translation-key ratchet; cancel interactions with their run | AX-B7, SH-B13, AI-B14, CU-B22, AX-B16 | S |

### Next: this quarter (shared components, IA, top wizards, docs)

| What | IDs | Effort |
|---|---|---|
| Config resource (theme 1) with audit diffs and a platform history view | CU-B3, PL-B4, OB-B6, OB-AD1 | M–L |
| Tier 1–2 components; security forms first, then core editors, then part 03 | Design system work | M |
| Used-by and invariant service, plus the destructive dialog | AI-B12, AX-B13, CU-B14, ID-B12, IN-PM3 | M |
| Round-trip tests and referential validation | AX-B8, AX-B17, ID-B19, IN-B21 | M |
| Access explainer, inherited chips, model access card | ID-PM1, ID-B5, ID-UX3, AI-PM1, AI-UX1 | M |
| IA step 1: fixed order, footer help, renames, palette, `?tab=`, visibility keys | SH-UX5, SH-B6, CU-PM9, ID-B30, SH-PM6 | S–M |
| IA step 2: Runs & approvals, Channels, API access, Security Outbound/Inbound, Server tools | AX-B31, IN-PM4, ID §6.7, PL §10 | M |
| Setup progress / Needs attention; one shell call; readable 429s | SH-PM1, SH-PM2, PL-B18 | M |
| Wizards WZ-1, WZ-2, WZ-3, WZ-7, WZ-21, WZ-22 | Wizard catalog | M each |
| Docs wave 1, the `admin-ui.md` map, the `SUMMARY.md` Administration group | SH-TW1, SH-TW4 | M |
| App editor: sticky index and save bar (reuse `AdminSettingsPage`), Enabled and Access out of the form body | AI-UX3, AI-UI4, AI-UI5, AI-UI6 | M |
| Used by + "Add to app…" on Skill, Workflow and Project; New skill in Admin → Skills; deduped skill picker | AX-UX1, AX-AD2, AX-B22 | M |
| Group members (list, add/remove, count, delete naming members); slugified group IDs | ID-UX4, ID-B12, ID-B13 | M |
| Monthly report preset and one-file export; test traffic out of KPIs; then per-model pricing | OB-AD4, OB-B25, OB-PM2 | S / M |
| Credentials inventory; inline create; MCP reconnect | IN-PM2, IN-PM3, IN-B25 | M |
| Inline approvals and "My approvals"; feedback opens on Responses with a trace drawer | AX-B24, AX-UX10, OB-B15, OB-PM1 | M |
| Updates as a flow | PL-B10, PL-B11 | S–M |

### Later

| What | IDs | Effort |
|---|---|---|
| Governance & privacy, Data & privacy hub, privacy wizard (WZ-20) | OB-PM3, OB-PM4 | M–L |
| Branding re-cut on a server draft (WZ-5, WZ-6) | CU-PM1, CU-PM2, CU-PM5 | L |
| One-page workflow editor (WZ-10), agent wizard (WZ-11), skill wizard (WZ-9), add knowledge (WZ-8) | AX-UX3, AX-PM2 | L |
| OIDC (WZ-4) and service-client (WZ-13) wizards; Admin role select, then a Read-only auditor | ID-PM6, OB-PM7 | L |
| Item-level audience (decision 1); WZ-12 | AI-PM1, IN-PM1, AX-PM4 | M–L |
| Fields for every JSON-only setting; outbound CA store | SH-PM3, PL-PM1, PL-PM4 | M–L |
| Channels template and integration wizards (WZ-14 to WZ-17) | IN-PM10, IN W1–W4 | M–L |
| Drafts for apps and branding; restore points and scoped exports | AI-PM2, CU-PM2, PL-PM2 | M–L |
| Features as a decision tool: registry `requires` (enforced), risk, presets shown as a diff | PL-PM3, PL-TW5 | M |
| Remaining wizards (WZ-18, 19, 23, 24); docs wave 2 and the docs drawer | CU W3, OB W1, PL W3, PL W4 | M each |

---

## Decisions for you

CLAUDE.md requires asking before breaking changes or compatibility shims. Options, then my recommendation.

1. **How does an admin say "only these groups"?** Grants only add up and shipped groups hold `*` (ID-B5, AI-PM1, IN-PM1). (a) Opt-in item `restricted` flag that `*` doesn't cover, grants staying in `groups.json`; (b) deny-lists; (c) group-only plus WZ-12. **Recommend (a).** Nothing changes until an admin restricts an item; then `*` held by OAuth clients, API keys, agents and channels stops covering it.
2. **Keep the shipped `authenticated: *`?** (a) Migration that narrows it (users lose visibility on upgrade); (b) new installs only; (c) keep and show it. **Recommend (c)**, with decision 1 doing the restricting (ID §10).
3. **No group grants workflows (AX-B10).** (a) A granting migration (16 workflows appear for everyone); (b) deny-by-default, with WZ-10 writing the grant. **Recommend (b)**; retiring the unenforced `allowedGroups` needs a migration (AX-PM4).
4. **Machine-client empty list = none?** `oauthClients.js:264-268` turns `[]` into `['*']` (ID-B6). (a) UI fix only; (b) plus `Deprecation`/`Sunset` before the meaning changes; (c) clean break. **Recommend (a) now, then (b) or (c): your choice.**
5. **Admin roles.** (a) Two booleans; (b) a role select over them (None / Content editor / Full administrator), then a Read-only auditor; (c) per-page RBAC. **Recommend (b).** A stored `adminRole` enum later breaks external writers of `groups.json` (ID §10, OB-PM7).
6. **Config writes.** **Recommend** scoped PATCH with *optional* `If-Match` now; making it required breaks scripted callers and needs your approval. Drafts only for apps and branding (AI-PM2, CU §10).
7. **Privacy defaults.** **Recommend** removing the question text from the `CHAT_REQUEST` log line for all installs as a privacy bug fix, with a release note for SIEMs (OB-B4). Moving it to `debug` is not enough, because the proposed debug session (OB-UX2) would turn it back on. If question logging is needed, it gets its own content-logging switch, off by default and independent of the log level. For new installs only: conservative `chatSharing.allowPublic` (OB-PM6), finite `feedbackRetentionDays` (OB-PM4), LDAP self-signup off plus a toggle (ID-B20). Keep the anonymous web-search grant with a warning (IN-ADMIN10).
8. **Can admins read what users said? (OB §10)** **Recommend** metadata plus the 300-character rated snippet, disclosed in the rating UI; full content behind a separate switch, off by default, audited per open.
9. **Rate limits.** **Recommend** raising the shipped `adminApi` from 100 to the code's 500, keyed per user (PL-B18), and reviewing `authApi`, which counts successful logins (PL-B23, Suspected).
10. **Secrets in backups (PL-B2).** (a) Warning only; (b) exclude keys (breaks restore on a new server); (c) "configuration only" or "full", keys only with a passphrase. **Recommend (c)**; confirm that scripted `POST …/export` callers may see a format change.
11. **Names.** "Channels" vs "Clients" for the inbound hub (IN §10's "Clients" collides with OAuth clients); "Observability" → "Monitoring"; US vs UK spelling; "System prompt" vs "System instructions" (AI-TW6); the German word for "user" (PL-TW3). **Recommend** Channels, Monitoring, US, "System prompt", "Benutzer".
12. **Prompt "Linked App" (AI-B7).** **Recommend** relabelling it "Opens in app" and fixing the docs; restricting is a new feature.
13. **Admin API conformance.** Renaming `/api/admin/auth/users` to `/api/admin/users` (ID §6) and answering group and user create with `201` + `Location` instead of `200` (ID-B30) change the contract for scripted callers. **Recommend** the 201 fix now (clients that check for 2xx keep working) and the rename only in the next API revision, with `Deprecation`/`Sunset` on the old path if you want a transition.
14. **TLS allowlist grants SSRF trust (PL-B12).** `isSsrfTrustedHost` (`server/utils/httpConfig.js:158-164`) trusts every `ssl.domainWhitelist` host as if it were in `ssrf.allowedHosts`, even when `ssl.ignoreInvalidCertificates` is off. The source fetcher, website corpus, page reader and watermark detector all use it. (a) Keep it, but show the coupling in the UI (the roadmap quick win); (b) separate the lists: `ssl.domainWhitelist` stops granting SSRF trust, and a migration copies today's entries into `ssrf.allowedHosts` so existing installs keep working; (c) separate the lists with no migration. (b) and (c) change behaviour for installs that rely on the coupling (a private host on the TLS list only), which CLAUDE.md treats as a breaking change. **Recommend (b)**, with a release note and the migration logged in the audit log.

**Maintainer note (not edited here).** CLAUDE.md says platform and auth changes need a restart; in fact OIDC reconfigures live, LDAP applies at the next sign-in, and only NTLM needs a restart (ID-B27, ID §10).

---

## Index of reports

1. [01 Admin shell, Overview, What's New & Documentation](01-shell-overview-docs.md): 27 rows, 0 P0 / 3 P1
2. [02 AI Workspace core: Apps, Models & Providers, Prompts](02-apps-models-prompts.md): 25 rows, 0 / 3
3. [03 AI Workspace advanced: Skills, Projects, Workflows, Agents, Marketplace](03-skills-projects-workflows-agents-marketplace.md): 35 rows, 0 / 7
4. [04 Access & Identity: Users, Groups, Authentication, OAuth](04-access-identity.md): 31 rows, 1 / 8
5. [05 Integrations: hub, builder, MCP gateway, Credentials, client add-ins](05-integrations.md): 26 rows, 0 / 5
6. [06 Customization: UI, Localization, Pages, Document templates, Short links](06-customization.md): 26 rows, 0 / 8
7. [07 Observability: Usage, Feedback, Logging, Telemetry, System, Chats, Tasks, Audit](07-observability.md): 27 rows, 0 / 6
8. [08 Platform: Features, Voice, Security, EU AI Act, Backup, Updates, Advanced](08-platform.md): 28 rows, 0 / 6

**Prior work:**

- [`../admin-redesign-2026/`](../admin-redesign-2026/README.md)
- [`../2026-05-28 Admin UI Phase 3 Roadmap.md`](../2026-05-28%20Admin%20UI%20Phase%203%20Roadmap.md)
- [`../2026-11-07 Models and providers in one admin area.md`](../2026-11-07%20Models%20and%20providers%20in%20one%20admin%20area.md)
