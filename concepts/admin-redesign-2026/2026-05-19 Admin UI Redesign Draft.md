# Admin UI Redesign — Synthesised Draft

**Document type:** Redesign proposal (synthesis of PM and Design briefs)
**Date:** 2026-05-19
**Status:** Draft for review
**Audience:** Product, Design, Engineering leadership; stakeholders to align before Phase 1 build

> This document is the **single deliverable** combining the product strategy brief and the UX design brief. Both source documents live in this folder and are referenced where deeper rationale is needed.

---

## 1. The problem in one paragraph

iHub Apps has grown from a focused app builder into a full enterprise AI platform. The admin surface tracked that growth feature-by-feature but never re-architected — today there are **30+ admin pages** crammed into a flat top-tab bar with one home, three pinned tabs (Apps, Models, Prompts) and a **"More" dropdown of 20+ items**. The landing page is a **12-tile launcher** with no grouping, no status, and no signal. There is no global search, no command palette, no audit log surface, and no guided setup for new instances. The System page has become a junk drawer holding encryption, SSL, CORS, backups, and version info side-by-side. Integrations have both a hub page and legacy direct routes. OAuth has both a "hub" route and Server/Clients subpages. New admins are lost; experienced admins survive on muscle memory.

The fix is not another feature. The fix is **information architecture**.

---

## 2. Vision: what the admin of the future looks like

> An enterprise admin lands on iHub Apps and sees instantly whether the instance is healthy, what they need to do, and where to do it. Every action is reachable in two clicks or one keystroke. Every page follows the same shape. New admins are guided; power admins are out of your way.

Five guiding promises:

1. **Task-oriented, not data-oriented.** Sections group by what admins do, not where bytes live.
2. **Health-first landing.** The home page answers "is everything okay?" before "where do I go?"
3. **One CRUD shape, learn it once.** Apps, Models, Users, Groups, Sources, Tools all share a list-page anatomy.
4. **Search-first navigation.** Cmd+K reaches anything in the system.
5. **Enterprise table-stakes by default.** Audit log, status surfaces, dry-run, bulk operations, sub-roles.

---

## 3. Information architecture — the final cut

### 3.1 Top-level structure

Seven left-rail sections (including Overview):

```
⌂ Overview
⊞ AI Workspace
🔐 Access & Identity
🔌 Integrations
🎨 Customization
📊 Observability
⚙ Platform
```

### 3.2 What lives where

| Section | Pages | Notes |
|---|---|---|
| **⌂ Overview** | Single page (dashboard) | Replaces today's tile launcher. See §4. |
| **⊞ AI Workspace** | Apps, Models, **Providers**, Prompts (+ Global Variables as tab), Tools, Sources, Skills (FF), Workflows (FF), Marketplace (FF) | Everything users see in the app. Providers join here because they are infrastructure for Models, not human identity. |
| **🔐 Access & Identity** | Users, Groups, Authentication (Local/OIDC/LDAP/NTLM/Proxy as sub-nav), OAuth (Server + Clients merged into tabs) | The "who can sign in, what are they grouped as" hub. |
| **🔌 Integrations** | Single hub page with cards: Office365, Google Drive, Nextcloud, Jira, Outlook add-in, Browser extension, Nextcloud Embed | Hub IS the section landing. Each integration is a Settings page reached from the hub. **Legacy direct routes removed** with a 1-minor-version redirect window. |
| **🎨 Customization** | UI Customization, Pages, Short Links | Everything about how iHub presents itself to users. |
| **📊 Observability** | Usage Reports, **Audit Log (NEW)**, Logging, Telemetry | Three siblings unified. Audit log is added; sources from telemetry until a dedicated feed lands. |
| **⚙ Platform** | Features (flags), Security (encryption + SSL + CORS — merged), Backup & Restore (promoted out of System), Updates (promoted out of System), Advanced (true escape hatches) | The System "junk drawer" is dismantled. |

### 3.3 Resolved IA decisions

The PM and Design briefs diverged on two points. Resolution for the draft:

**Providers → AI Workspace.** Designer's recommendation accepted. Providers are LLM credential storage — infrastructure for Models, not human identity. Sit next to Models conceptually. Cross-link from Models settings. *PM brief notes this as an open question; the draft picks the designer's answer.*

**Customization as its own section.** Designer's structure accepted. Folding "UI Customization", "Pages", and "Short Links" into Platform (PM's lighter structure) overloads Platform with presentation concerns that share nothing with backups/security. Keeping Customization separate is cleaner conceptually and within section-size limits.

This yields 7 sections including Overview — at the upper bound of comfort, but defensible.

### 3.4 What is merged, promoted, demoted

**Merged:**
- OAuth Hub + Server + Clients → single OAuth page with tabs
- Logging + Telemetry + Usage + Audit → Observability
- Encryption + SSL + CORS → Platform → Security
- Integrations hub absorbs all per-integration routes (legacy direct routes removed)
- Global Variables collapses into Prompts as a tab

**Promoted (out of "More"):**
- Backup & Restore (was buried in System)
- Updates (was buried in System)
- Users (now primary entry into Access & Identity)
- Features (flags) (was buried in More)

**Demoted (kept but de-emphasised):**
- Pages, Short Links — useful but low-frequency; live under Customization
- Skills, Workflows, Marketplace — remain feature-flagged

**Removed:**
- OAuth "hub" landing page (the section itself is the hub)
- Integrations legacy direct routes (`/admin/office365` etc.) — replaced by hub + redirects

---

## 4. The new Overview page

The 12-tile launcher is replaced by an **operations dashboard**. Stats first, signal second, navigation third.

### 4.1 Wireframe (mature instance)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Overview                                                                    │
│  iHub Apps  •  v3.4.1  •  Up 14d 6h                            [30d ▾]      │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │ Apps    │ │ Users   │ │ Chats   │ │ Tokens  │ │ Errors  │ │ Latency │    │
│  │  42     │ │ 318     │ │ 12,847  │ │ 4.2M    │ │ 0.18%   │ │ 1.2s    │    │
│  │ ▲ 3 mo  │ │ ▲ 24 mo │ │ ▲ 18%   │ │ ▲ 22%   │ │ ▼ 0.4pp │ │ ▼ 80ms  │    │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
│                                                                              │
│  ⚠ Needs your attention                                                      │
│  ────────────────────────────────────────────────────────────────────────── │
│  ●  Anthropic provider key invalid — last test failed 2h ago  [Fix →]       │
│  ●  Backup overdue (last: 8 days ago, target: weekly)         [Run now →]   │
│  ●  iHub v3.5.0 available (security patch)                    [Review →]    │
│  ○  3 users awaiting group assignment                         [Assign →]    │
│                                                                              │
│  Quick actions                                                               │
│  [+ New app]  [+ Invite user]  [+ Add model]  [View logs]                   │
│                                                                              │
│  Recent activity                                          [View audit log →] │
│  ────────────────────────────────────────────────────────────────────────── │
│  14:32  J. Doe       updated app "Sales Assistant"                          │
│  14:18  System       backup completed (228 MB)                              │
│  13:51  A. Smith     created group "EU Compliance"                          │
│  13:42  S. Patel     rotated API key for OpenAI provider                    │
│  12:09  System       model "claude-opus-4-7" sync OK                        │
│                                                                              │
│  ───── Jump to section  ▾ (collapsed launcher remains accessible) ─────     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 What appears

- **Stat cards** (6): Apps, Users, Chats, Tokens, Errors, Latency. Each shows current value + trend delta over the selected window (today/7d/30d/90d). Every card deep-links to a filtered Observability view.
- **Needs your attention**: ordered list of actionable items. Severity dots (red critical, amber warning, blue info). Each row has a single primary action verb. Max 5 shown; "See all (N) →" when more. Empty state: "All systems healthy." with a freshness timestamp.
- **Quick actions**: 4 most-common admin starters. Customizable per user in a later phase.
- **Recent activity**: last 5 admin actions. Sourced from telemetry until a dedicated audit-log feed exists.
- **Collapsible launcher** (footer drawer): the old tile grid lives on, but grouped by the new IA — closed by default for muscle-memory users.

### 4.3 Fresh-instance variant

For Day-1 installs (apps == 0, users < 5, age < 7d), the dashboard becomes a setup checklist:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Welcome to iHub Apps                                                        │
│  Let's get your instance ready.                              3 / 7 done      │
│  ────────────────────────────────────────────────────────────────────────── │
│  ✓  Install complete                                                         │
│  ✓  Local admin account created                                              │
│  ✓  Default groups configured                                                │
│  ○  Configure an LLM provider                            [Add provider →]   │
│  ○  Create your first AI app                             [Create app →]     │
│  ○  Connect an identity provider (optional)              [Set up SSO →]     │
│  ○  Review platform settings                             [Open settings →]  │
│                                                                              │
│  [Skip setup, I'll explore on my own]                                       │
│  → 2-min tour    → Documentation    → Examples gallery                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Stat cards hidden until data exists. Checklist auto-collapses to a one-line banner when complete.

---

## 5. Chrome — left rail and topbar

### 5.1 Wireframe

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [iHub] Admin    Apps / Sales Assistant      [v3.4]  [Search Cmd+K]  [Bell 3] [Avatar] │
├────────────────┬─────────────────────────────────────────────────────────────┤
│ [Search...   ] │  Page H1                                          [Primary] │
│                │  Subtitle / count                                           │
│ ⌂ Overview     │  ───────────────────────────────────────────────────────── │
│                │                                                             │
│ ▼ AI Workspace │  [Filters]  [Search]                          [View ⊞ ☰]   │
│   • Apps    12 │  ───────────────────────────────────────────────────────── │
│   • Models   8 │                                                             │
│   • Providers 4│   Content area (list, settings form, hub grid, dashboard)   │
│   • Prompts 32 │                                                             │
│   • Tools   14 │                                                             │
│   • Sources 11 │                                                             │
│   • Skills   2 │                                                             │
│   • Workflows  │                                                             │
│   • Marketplace│                                                             │
│ ▶ Access & ID  │                                                             │
│ ▶ Integrations │                                                             │
│ ▶ Customization│                                                             │
│ ▶ Observability│                                                             │
│ ▶ Platform   ⚠ │                                                             │
│                │                                                             │
│ [«Collapse]    │                                                             │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

### 5.2 Navigation behavior

- **Single collapsible left rail**, not hybrid (icon rail + sub-nav). For 30 pages the cognitive cost of a hybrid is higher than the visual cost of a single rail.
- **Active section auto-expands** on page load. Other sections collapse by default but state is remembered per user.
- **Expanded:** ~256px, icon + label. **Collapsed:** ~64px, icon only with flyout on hover. Toggle pinned to the bottom of the rail.
- **No second-level groups inside a section.** Max 9 items per section; if exceeded, the section splits.
- **Status dot** appears on the parent section when any sub-page has a critical/warning issue. Dot color matches the highest severity inside.
- **Mobile (<768px):** off-canvas drawer. Hamburger left, search-icon right.
- **Topbar:** breadcrumbs (only when depth >2), version pill, search pill (Cmd+K), alert bell with count, avatar.

### 5.3 Breadcrumbs

Shown only when path depth >2 (e.g., `AI Workspace / Apps / Sales Assistant / Variables`). On list pages, the H1 is enough — no breadcrumb noise.

---

## 6. The three reusable page templates

Every admin page is one of these three. Consistency over cleverness.

### 6.1 List / CRUD page

Used by: Apps, Models, Providers, Prompts, Tools, Skills, Sources, Pages, Short Links, Users, Groups, Workflows.

Anatomy: page header (H1 + count + primary action with split-button options) → toolbar (search + filters + sort + view toggle + overflow) → bulk-action bar (appears on selection) → table or card grid (view-toggleable, persisted per user) → row actions (inline `Edit` + kebab) → pagination (25/50/100; no infinite scroll, URLs matter for admins).

Detail/edit pattern:
- **Drawer** for light edits (≤8 fields, single concept): right-side, ~480px, sticky save footer.
- **Full page** for heavy edits (variables, system prompts, etc.): URL is deep-linkable; sub-tabs within the page for sub-areas.

Empty state: line-art illustration, one-line description, primary CTA matching the header CTA, "Learn more →" link.

### 6.2 Settings page

Used by: Authentication, OAuth, UI Customization, Platform → Security, Platform → Advanced, Telemetry, Logging config.

Anatomy: page header → two-pane body — left sub-nav (sections within this settings page, Linear-style) + right pane (sectioned form with `mt-8` between sections, 2-col label/input on ≥1024px) → **sticky save bar** at bottom: dirty indicator dot + "You have unsaved changes" + [Discard] + [Save].

Patterns:
- `beforeunload` listener when dirty.
- In-app navigation triggers confirmation modal on dirty.
- **Test-and-save** for any section with credentials: `Test connection` button; first-time setups require successful test before Save enables. Existing configs save without re-testing, with a warning toast.
- Replacement-pane mode when a section has >20 fields (System, OAuth); anchor-scroll mode otherwise.

### 6.3 Integration Hub page

Used by: Integrations.

Anatomy: page header → filter row (search + category + status) → category-grouped card grid. Within each category: Connected first, then Not setup, then Unavailable.

Card: logo, name, status pill (Connected/Not setup/Token expired/Error), "Tested 14m ago" timestamp, single primary CTA ([Configure] / [Connect] / [Reconnect] / [Download]). Click anywhere on the card opens the integration's Settings page (template §6.2).

**Key consolidation:** the hub IS the section landing; per-integration pages use the Settings template. The current redundant "Integrations hub + per-integration page + legacy direct route" mess collapses into one pattern.

---

## 7. Cmd+K command palette

Triggered from anywhere by Cmd/Ctrl+K. Modal, centered, ~640px wide.

Sections (in order, each hidden when empty after filter):

1. **Recent** — last 5 distinct visits/actions per user (localStorage).
2. **Pages** — every admin page, fuzzy-matched. Shows the section name and a keyboard shortcut hint.
3. **Actions** — verbs: "Create new app", "Invite user", "Add LLM provider", "Toggle feature [name]", "Run backup now", "Restart server", "View logs", "Open audit log".
4. **Entities** — server-side fuzzy search across apps, users, models, groups, prompts, sources. First 5 of each.

Keyboard:

- `Cmd+K` open
- `Cmd+1..6` jump to top section (Overview / AI Workspace / Access / Integrations / Customization / Observability — Platform deliberately not on a number)
- `Cmd+B` toggle sidebar collapse
- `Cmd+/` focus palette search
- `g a`, `g u`, `g m` chord shortcuts (Phase 3)

Action UX: destructive actions confirm in-palette; safe actions execute with a toast.

---

## 8. Status and "needs attention" surfaces

Unified vocabulary across the entire admin:

| Level | Color | Icon | Use case |
|---|---|---|---|
| Critical | red-600 | ● | Auth disabled, provider invalid, security risk |
| Warning | amber-500 | ● | Token expiring, backup overdue, deprecated config |
| Info | blue-500 | ○ | Update available, pending review, optional step |
| Success | green-600 | ✓ | Confirmation only, used sparingly |

Surfaces:

1. **Nav-item badge.** Dot to the right of a label. Bubbles up to parent section (highest severity wins).
2. **Topbar alert bell.** Aggregates everything. Click → slide-in panel (400px right) grouped by severity, each item linking to its source page.
3. **Inline page banner.** At the top of any page with an issue. Same color system, single CTA, optional dismiss.
4. **Row-level status pill.** In tables, status column uses the same dot+text vocabulary so the signal is never color-only (color-blindness safe).

---

## 9. Visual direction (summary)

- **Color:** mostly neutral (`slate` or `zinc`) + one brand accent (`indigo-600`) + the four status colors. Buttons and cards are not colored; brand color is reserved for primary buttons, active nav, focused inputs.
- **Typography:** Inter (system fallbacks). Three sizes carry 95% of the UI: `text-sm` body/tables, `text-base` form fields, `text-xl` H1. Tabular numerals for all stats. Max two font weights per surface.
- **Density:** compact by default (36px row/field height, 32px button height, `p-4` cards). Per-user "Comfortable" toggle bumps to 44px / `p-6`.
- **Icons:** Lucide (consistent line weight, MIT, broad coverage).
- **Dark mode:** first-class. Use `slate-900`/`950` family — pure black is harsh on OLED. Brand indigo desaturates one step (`indigo-400`) in dark to avoid vibration.

---

## 10. Accessibility (WCAG 2.1 AA)

Five musts plus one bonus:

1. **Keyboard navigation across the whole chrome.** Skip-to-content, tab order, Enter/Space to expand sections, arrow keys within sections, Cmd+K from anywhere, Esc to close, focus trapping in modals.
2. **Focus indicators always visible.** 2px ring (`ring-2 ring-indigo-500 ring-offset-2`) on every interactive element. No `outline: none` without replacement.
3. **ARIA on nav + palette.** `<nav aria-label>`, `aria-expanded`/`aria-controls` on section toggles, `aria-current="page"` on active link, palette as `role="dialog" aria-modal="true"`, `combobox` input with `aria-activedescendant`.
4. **Color contrast.** Body ≥4.5:1, status pills ≥3:1. Dot + text combo, never color alone. Trend arrows use `▲`/`▼` glyphs plus color.
5. **Live regions for save state & errors.** Toasts in `aria-live="polite"`. Field errors in `role="alert"` with `aria-invalid` + `aria-describedby`. Save-bar dirty indicator has screen-reader text.
6. **Respect `prefers-reduced-motion`.** Sidebar expand, drawer transitions, palette open all degrade to instant.

---

## 11. Phased rollout

| Phase | Scope | Target | Backend changes |
|---|---|---|---|
| **Phase 1 — Chrome & Overview** | Left rail with 7 sections, topbar (breadcrumbs, bell, search pill), new Overview dashboard (stats / attention / quick actions / activity / setup checklist), visual tokens, dark mode parity, a11y baseline. All existing pages migrate under new nav unchanged. Legacy routes redirect. | 4 weeks | None (existing endpoints suffice; audit log seeds from telemetry) |
| **Phase 2 — Page templates & flows** | Apply List/CRUD template to all list pages; Settings template to Authentication/OAuth/UI/Security/Advanced; Integration Hub to Integrations. Bulk actions across list pages. Empty states. Wizards for the top 5 JTBDs (Publish App, Connect SSO, Rotate Key, Onboard Group, Bulk Edit). Command palette ships. Global search. | 8 weeks | Optional: bulk endpoints, `/api/admin/search`, "test connection" endpoints where missing |
| **Phase 3 — Sub-roles & enterprise polish** | Sub-admin roles (read-only first, then scoped write). Dedicated Audit Log feed + retention + export. Change history per config. Generalised dry-run. Bulk import/export. Pinning/favorites. Chord shortcuts. In-product changelog. | 10 weeks | Audit-log persistence, change-history store, role-scoped permission filters |

> **Parallel workstream throughout all three phases: documentation alignment.** See §12. Today many users edit JSON in `contents/` directly because `docs/` does not document the admin UI. Without this workstream, the redesign delivers a surface users are never taught to use.

### Phase 1 success criteria

- Time-to-find-setting drops from ~30s to <10s (admin survey, n≥10)
- "Where is X?" support tickets down 50%
- Zero increase in broken-link reports (verified via redirect logs)

### Phase 3 success criteria

- ≥3 customers using sub-roles within 90 days
- Cmd+K weekly active usage ≥30% of admin sessions
- Audit log queried in ≥40% of admin investigations

---

## 12. Documentation alignment (parallel workstream)

The redesign has a documentation problem to solve in parallel. Today, **many users edit JSON files in `contents/` directly** — apps, models, prompts, groups, platform config — even though the admin UI already exposes everything they need. The root cause is not that the UI is missing functionality; it is that **`docs/` has almost no information about the admin UI itself**. Users follow the docs, the docs show them JSON snippets, so they edit JSON.

This has knock-on effects:

- Users miss validation that the UI would have caught (Zod schema errors only surface at server start)
- Users miss the encryption-at-rest behavior for secrets (the UI encrypts on save; hand-edited JSON leaves secrets plaintext)
- Users miss config-cache invalidation paths (the UI triggers reloads automatically)
- Migration / inheritance / feature flags behave differently when set via UI vs. hand-edit
- Every doc that shows "edit `apps/xyz.json`" is a missed teaching moment for the admin UI

### What this means for the redesign

Documentation alignment is a **required follow-up** to the IA redesign, not optional. Without it, the redesign delivers a beautiful admin that users still circumvent because the docs never tell them to use it.

### Scope of documentation work

**During Phase 1 (in parallel with chrome + Overview ship):**

- Audit every file in `docs/` for references to direct JSON editing. Tag each as: (a) "should be done in admin UI", (b) "advanced/escape-hatch — keep JSON path", or (c) "out-of-date entirely".
- For category (a), rewrite to show the admin UI flow as the primary path. JSON shown only as reference for what the UI produces.
- For category (b), explicitly mark as "Advanced — most users should use Admin → [section]" with a link.

**During Phase 2 (alongside page-template unification):**

- For every admin page that lands on a new template, add or refresh its corresponding `docs/` chapter with screenshots and a task-oriented walkthrough ("How do I publish an app?", "How do I rotate a provider key?", "How do I connect SSO?").
- Cross-link: every JSON schema doc gets a "Do this in the UI instead" banner at the top with a link to the relevant admin page.
- Add a new `docs/admin-ui.md` (or section in `docs/SUMMARY.md`) that becomes the entry point for "I am an admin — where do I start?"

**During Phase 3 (alongside sub-roles + audit log):**

- Document sub-role boundaries with capability matrices
- Document audit log retention and export
- Document the command palette and keyboard shortcuts

### Success criteria

- Direct JSON edits by admins drop measurably (proxy metric: support tickets mentioning manual JSON edits)
- Admin UI usage telemetry shows ≥80% of admin actions go through UI flows for the operations we have UI for
- Every admin page in the new IA has a corresponding docs section, reachable from a single `docs/admin/` index
- Doc PRs land in step with feature PRs (added to PR review checklist)

### Risk if we skip this

If we ship the redesign without documentation alignment, the most common scenario will be: an admin reads the docs, sees a JSON example, edits the file directly, hits a validation or cache error, and concludes "the admin UI is broken" — when in reality they never used it. We will have rebuilt the surface that nobody is being taught to use.

### Open question

Do we treat documentation alignment as a hard gate for Phase 1 ship, or as a fast-follow within 30 days of Phase 1 GA? **Draft recommendation:** fast-follow with a public README/changelog note pointing to the new admin UI as the canonical path. A 30-day window keeps Phase 1 unblocked while still landing the docs before the redesign reaches broad customer awareness.

---

## 13. Enterprise table-stakes — what we are adding

| Capability | Priority | Phase |
|---|---|---|
| Command palette (Cmd+K) | Must | P2 |
| Global admin search | Must | P2 |
| Admin audit log | Must | P3 (seed in P1) |
| Health probes + "needs attention" widget | Must | P1 |
| Dry-run for risky changes | Should | P2 (rotate key) + P3 (general) |
| Change history per config | Should | P3 |
| Bulk import/export | Should | P3 |
| In-product "what's new" | Should | P3 |
| Configurable email/Slack alerts | Could | P3 |
| Two-person rule for destructive ops | Could | P3 (gated by demand) |

Explicitly **not** building: custom dashboard widget layouts (single opinionated Overview), a new "Settings" mega-page (we are escaping exactly that), per-page column choosers (Phase 3+ if analytics demand).

---

## 14. Open decisions

These need a stakeholder call **before Phase 1 build kick-off**. Draft picks a default for each.

1. **Providers location.** Draft: AI Workspace. PM brief leaned Identity. Designer pushed back; draft sides with Design.
2. **Customization as its own section.** Draft: yes. PM brief folded into Platform; Design split it out. Draft sides with Design.
3. **Legacy integration routes.** Draft: 1-minor-version redirect, then remove. Per CLAUDE.md, breaking changes need an explicit user decision — confirm before implementation.
4. **Sub-role timing.** Draft: defer to Phase 3. PM rationale: don't ship IA + permission-model changes simultaneously.
5. **Audit Log scope in Phase 1.** Draft: seed from telemetry events for the Overview's Recent Activity; the dedicated Audit Log page in Observability ships in Phase 3 with retention/export.
6. **Customizable Quick Actions on Overview.** Draft: instance-default in v1, per-user customization deferred.
7. **Pinning/favorites storage.** Draft: localStorage in Phase 2; server-side per-user persistence in Phase 3.
8. **Marketplace / Skills / Workflows feature flags.** Are they graduating soon? Affects rail real-estate planning. No draft default — needs PM input.

---

## 15. What this redesign is not

- **Not a backend refactor.** Every IA change uses existing endpoints (`server/routes/admin/*`). Audit Log dedicated feed and sub-role permission filters are the only new backend asks (both Phase 3).
- **Not a brand refresh.** Color, type, and density tighten, but the visual language is iHub's existing Tailwind palette — not a logo or identity change.
- **Not a multi-tenant rewrite.** Soft tenancy via groups remains the model. Genuine multi-tenant separation is platform-level and out of scope.

---

## 16. Implementation notes (for the coder phase)

- **Three React shells:** `<ListPage>`, `<SettingsPage>`, `<IntegrationHubPage>`. Slots for header, toolbar, content, footer/save-bar. Pages cannot drift visually.
- **`SidebarContext`** holds collapsed state, expanded sections, pinned items, current alert counts (subscribed to `/api/admin/alerts/summary` polling every 60s).
- **`CommandPaletteContext`** mounted at root; pages register contextual commands via hook.
- **`<StatusDot level="critical|warning|info|success" label="..." />`** primitive used in nav, tables, cards, banners.
- **`useDirtyState()`** hook for Settings pages, registers `beforeunload` automatically.
- **Tailwind tokens, not hex values.** Tune the design system in `tailwind.config.js` only.
- **React Router stays.** New routes added in `client/src/App.jsx` AND `client/src/utils/runtimeBasePath.js` `knownRoutes` (CLAUDE.md requirement).
- **i18n discipline.** All new strings go through `t()` per project convention.

---

## 17. Next steps

1. **Stakeholder review** of this draft (estimate: 60-min walk-through with PM + Eng leadership + 2-3 enterprise admins).
2. **Decisions** on the 9 open questions in §14 (8 IA/feature decisions + 1 on documentation timing in §12).
3. **Phase 1 ticket breakdown** by engineering, scoped to the 4-week target.
4. **Component spike** on the three page shells before opening Phase 1 implementation tickets.
5. **Documentation audit** kicked off in parallel — see §12. Tag every `docs/` page as UI-first, advanced/escape-hatch, or stale, and start rewriting UI-first pages in lockstep with Phase 1.
6. **Feedback loop** with 2-3 enterprise admins after a week of Phase 1 in staging — adjust IA before broader rollout.

---

## Appendix — current → proposed mapping

| Current page | Proposed location |
|---|---|
| Home (12-tile dashboard) | Overview (redesigned) |
| Apps | AI Workspace → Apps |
| Models | AI Workspace → Models |
| Providers | AI Workspace → Providers |
| Prompts (+ Global Variables) | AI Workspace → Prompts (variables as tab) |
| Tools | AI Workspace → Tools |
| Skills (FF) | AI Workspace → Skills |
| Sources | AI Workspace → Sources |
| Workflows (FF) | AI Workspace → Workflows |
| Marketplace (FF) | AI Workspace → Marketplace |
| Users | Access & Identity → Users |
| Groups | Access & Identity → Groups |
| Authentication | Access & Identity → Authentication (Local/OIDC/LDAP/NTLM/Proxy as sub-nav) |
| OAuth hub + Server + Clients | Access & Identity → OAuth (Server + Clients tabbed) |
| Integrations hub | Integrations (the section landing) |
| Office365, Google Drive, Nextcloud, Jira, Outlook add-in, Browser ext, Nextcloud Embed | Integrations → hub cards → Settings page each. **Legacy routes redirect 1 minor version, then removed.** |
| UI Customization | Customization → UI Customization |
| Pages | Customization → Pages |
| Short Links | Customization → Short Links |
| Usage Reports | Observability → Usage Reports |
| Logging | Observability → Logging |
| Telemetry | Observability → Telemetry |
| (new) | Observability → Audit Log |
| Features | Platform → Features |
| System (encryption + SSL + CORS) | Platform → Security (merged) |
| System (backup/restore) | Platform → Backup & Restore (promoted) |
| System (version + updates) | Platform → Updates (promoted) |
| System (remainder) | Platform → Advanced |

---

*Combine with the [Product Strategy & IA brief](2026-05-19%20Admin%20UI%20Redesign%20Product%20Strategy%20&%20IA.md) and the [Design Brief](2026-05-19%20Admin%20UI%20Redesign%20Design%20Brief.md) for full rationale.*
