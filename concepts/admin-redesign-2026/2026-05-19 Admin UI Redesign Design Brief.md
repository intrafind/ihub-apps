# UI/UX Brief: iHub Apps Admin Redesign

**Author:** Design System Custodian
**Date:** 2026-05-19
**Status:** Design proposal, paired with PM brief, pending engineering synthesis
**Audience:** Engineering (implementation), Product (alignment), Junior designers (continuation)

---

## Executive Summary

The iHub Apps admin has grown from a handful of pages to 30+, but the chrome has not evolved with it. A flat top-tab bar with three pinned items and a "More" dropdown of 20+ entries is the dominant pain: discoverability is poor, hierarchy is invisible, and the dashboard is a tile launcher with no signal. The redesign moves to a **collapsible left-rail sidebar with grouped sections, a global Cmd+K command palette, an enterprise-grade overview dashboard, and three reusable page templates** (List/CRUD, Settings, Integration Hub). It introduces consistent "needs attention" surfaces, a setup checklist for fresh instances, and an opinionated information architecture that splits LLM provider credentials from identity management. Phase 1 ships the chrome and dashboard; Phase 2 unifies page patterns; Phase 3 layers in the command palette and power-user features.

This brief is opinionated by design. Where the user asked for a recommendation, you get one with rationale, not a menu.

---

## 1. Design Principles & Inspiration

### Enterprise admin UIs worth borrowing from

| Product | Specific pattern to borrow | Why it fits iHub |
|---|---|---|
| **Stripe Dashboard** | Left rail with collapsible section groups, persistent search at the top of the rail, "test mode" pill in the topbar | Stripe carries ~40 admin surfaces gracefully; the rail breathes by collapsing/expanding sections instead of dropdowns |
| **Vercel Dashboard** | Project-scoped left nav, contextual sub-nav per section, top breadcrumb with project switcher | iHub has "instance-scoped" admin; the same pattern of a context selector + section nav reads well |
| **Linear Settings** | Two-pane settings: left list of sub-sections, right detail pane with sticky save bar | This is the gold standard for sectioned forms with dirty-state UX — perfect for Authentication, OAuth, UI Customization |
| **GitHub Org Settings** | Settings sidebar grouped by domain (Access, Code, Security, Integrations); breadcrumbs everywhere | Mirrors our IA grouping almost 1:1; their breadcrumbs anchor users in deep settings trees |
| **Supabase Dashboard** | Compact left rail with icon+label, deep but discoverable sub-nav, "Reports" tab with stats-as-cards | Their density level is right for technical admins — info-rich, no luxury whitespace |
| **PlanetScale** | "Insights" landing page with stat cards above fold + activity feed below | Direct template for our new Overview dashboard |
| **Okta Admin** | Cmd+K command palette covering every admin action, including config toggles | The bar to clear for our search-first navigation |
| **Microsoft Entra** | Status badges on nav items ("3 alerts" inline), centralized health/notification pane | Models our "needs attention" indicators well |
| **AWS Console (2023 redesign)** | Persistent search-first UX, favorites/pinning per user, recently visited services | Their pinning pattern is the right answer to "customization for power users" |
| **Notion Workspace Settings** | Two-column form pattern with section anchors in a right-aligned mini-TOC | Useful for very long settings pages (e.g., System) |

### The 7 design principles for the new admin

1. **Progressive disclosure over flat dumps.** Group 30+ pages into 6 navigable sections. Never show more than 7 to 9 sibling items at one tier without sub-grouping.
2. **Search-first navigation.** Cmd+K is the fastest path for anyone past their first week. Every action, page, and entity is reachable by typing.
3. **Stats and signal on landing, not just links.** The Overview shows the health of the instance, surfaces what needs attention, and offers quick actions. It is not a launcher of tiles.
4. **One CRUD pattern to rule them all.** Apps, Models, Prompts, Users, Groups, Tools, Sources, Pages, Short Links all use the same list page anatomy. Learn it once.
5. **Inline status, not hidden status.** Misconfigurations, expired credentials, overdue backups, and pending updates surface as badges on nav items and banners on relevant pages — not buried in detail pages.
6. **Density by default, breathing room on request.** Enterprise admins read tables, not heroes. Default to compact density with an explicit "comfortable" toggle. Whitespace is functional, not decorative.
7. **Consistency over cleverness.** Every list page has the same toolbar shape. Every settings page has the same save bar. Every hub page has the same status pill. Surprise is friction.

---

## 2. Navigation Pattern

### Recommendation: confirmed — collapsible left-rail sidebar

You leaned toward a collapsible left sidebar. **I agree, and I'll push the recommendation further: not "hybrid", just a clean single-rail sidebar.** Rationale:

- **Top-tabs do not scale past ~6 items.** You are already at 24 surfaces and growing. Top-tabs force the "More" dropdown which is the root cause of discoverability pain.
- **Hybrid (thin icon rail + contextual sub-nav)** looks elegant but doubles the chrome and forces a mental model of "section vs. page". For 30 pages it is more cognitive work, not less. Hybrid works for products with 6 to 8 deep verticals (Slack, Discord). iHub's admin is broad but shallow.
- **Single collapsible rail** is the dominant enterprise pattern (Stripe, Vercel, Supabase, GitHub Settings, Linear) precisely because it scales gracefully.

### Section layout

```
Overview
AI Workspace          (expandable)
Access & Identity     (expandable)
Integrations          (expandable)
Customization         (expandable)
Observability         (expandable)
Platform              (expandable)
```

Six top sections, plus Overview. Final IA in section 7 below.

### Sub-item behavior

- **Section is expandable on click**, not on hover. Hover is unreliable on touch, jittery on desktop.
- **Active section is auto-expanded** on page load. The user's current location is always visible.
- **Other sections collapse by default**, but their state is remembered per user (localStorage) so power users can pin two sections open.
- **No second-level groups inside a section.** Every section is at most 9 items. If it grows past 9 we split the section, we do not nest deeper.
- **Active page** highlighted with a left accent bar (3px wide, indigo-600) and a subtle background tint. Sibling text remains readable.

### Collapse modes

- **Expanded (default, ~256px wide):** icon + label.
- **Collapsed (~64px wide):** icon only, label appears in a flyout tooltip on hover. Section group flyout opens on hover for collapsed state — this is the one place hover is acceptable because the rail is clearly an icon rail.
- **State persisted per user.** Toggle button at the bottom of the rail.

### Mobile pattern

- **< 768px:** Sidebar becomes an off-canvas drawer. Topbar gains a hamburger icon (left) and a search icon (right, opens command palette).
- **Bottom nav: no.** Enterprise admins on mobile are a tiny audience and bottom nav fits 4 to 5 sections, not 6 to 7. Off-canvas drawer is the right call.

### Command palette and search

- **Search input lives at the top of the left rail in expanded mode** (placeholder: "Search admin... Cmd+K"). Click or Cmd+K opens the full palette as a centered modal.
- In collapsed mode, the search icon is the second item from the top, below the logo.
- In the topbar, Cmd+K is also surfaced as a small pill on the right side ("Search Cmd+K") so it is discoverable for users who never expand the rail.

### Breadcrumbs

- **Yes, but minimal.** Show breadcrumbs only when depth > 2 (e.g., `Apps / Customer Service Bot / Variables`). On list pages (depth 1 within a section), the H1 is enough.
- Breadcrumbs sit in the topbar, left-aligned, below the topbar's horizontal rule — they are part of page header context, not the global chrome.

### ASCII wireframe — chrome

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [iHub Apps]  Admin           Breadcrumbs >                  [v3.4]  [Search Cmd+K]  [Bell 3]  [Avatar] │
├────────────────┬─────────────────────────────────────────────────────────────┤
│                │                                                             │
│ [Search...   ] │  Page H1                                          [Primary] │
│                │  Subtitle / count                                           │
│ ⌂ Overview     │  ───────────────────────────────────────────────────────── │
│                │                                                             │
│ ▼ AI Workspace │  [Filters]  [Search]                          [View ⊞ ☰]   │
│   • Apps    12 │  ───────────────────────────────────────────────────────── │
│   • Models   8 │                                                             │
│   • Prompts 32 │   Content area (list, form, hub grid, dashboard)            │
│   • Tools   14 │                                                             │
│   • Skills   2 │                                                             │
│   • Sources 11 │                                                             │
│   • Workflows  │                                                             │
│   • Marketplace│                                                             │
│                │                                                             │
│ ▶ Access & ID  │                                                             │
│ ▶ Integrations │                                                             │
│ ▶ Customization│                                                             │
│ ▶ Observability│                                                             │
│ ▶ Platform   ⚠ │                                                             │
│                │                                                             │
│                │                                                             │
│ [«Collapse]    │                                                             │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

The `⚠` on Platform is the inline status indicator pattern (described in section 6). The count next to each item ("Apps 12") is an optional density-aware metadata badge — shown when expanded, hidden when collapsed.

---

## 3. Dashboard / Overview Redesign

The 12-tile launcher is a dead end. The new Overview is an **enterprise health dashboard**: stats first, signal second, navigation third.

### ASCII wireframe — Overview (mature instance)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Overview                                                                    │
│  iHub Apps  •  v3.4.1  •  Up 14d 6h                                          │
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
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ + New app    │ │ + Invite user│ │ + Add model  │ │ View logs    │        │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │
│                                                                              │
│  Recent activity                                          [View audit log →] │
│  ────────────────────────────────────────────────────────────────────────── │
│  14:32  J. Doe       updated app "Sales Assistant"                          │
│  14:18  System       backup completed (228 MB)                              │
│  13:51  A. Smith     created group "EU Compliance"                          │
│  13:42  S. Patel     rotated API key for OpenAI provider                    │
│  12:09  System       model "claude-opus-4-7" sync OK                        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Stat card spec

- 6 cards, 1 row on desktop (>= 1280px), 3x2 on tablet, 2x3 on mobile.
- Each card: label, large value, trend delta (arrow + delta) over selected window (default: last 30 days).
- Window selector in the page header (today / 7d / 30d / 90d).
- Clicking a card deep-links to the relevant detail (Tokens → Usage Reports, Errors → Logging).

### Needs-your-attention spec

- A list, not a card grid. Severity dots: red ● critical, amber ● warning, blue ○ info.
- Maximum 5 items shown; "See all (12) →" link if more.
- Each row has a single primary action verb ("Fix", "Run now", "Review", "Assign"). No kebab menus here — keep it skimmable.
- If empty: "All systems healthy." with a small green checkmark icon and a `last checked 2m ago` timestamp.

### Quick actions

- 4 buttons. Top-down user research will refine — sensible defaults: New app, Invite user, Add model, View logs.
- Customizable per user in v2 (out of Phase 1).

### Recent activity

- 5 rows from the audit trail. If audit log does not exist yet (it does not — recommend adding it), seed from existing telemetry events.
- "View audit log →" link sends user to Observability > Audit Log.

### Fresh instance vs. mature instance

**Fresh instance (Day 1):**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Welcome to iHub Apps                                                        │
│  Let's get your instance ready.                                              │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Setup checklist                                                  3 / 7 done │
│  ────────────────────────────────────────────────────────────────────────── │
│  ✓  Install complete                                                         │
│  ✓  Local admin account created                                              │
│  ✓  Default groups configured                                                │
│  ○  Configure an LLM provider                            [Add provider →]   │
│  ○  Create your first AI app                             [Create app →]     │
│  ○  Connect an identity provider (optional)              [Set up SSO →]     │
│  ○  Review platform settings                             [Open settings →]  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Skip setup, I'll explore on my own                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  Learn the basics                                                            │
│  → 2-min tour    → Documentation    → Examples gallery                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Stat cards hidden until there is data (avoid showing 0 / 0 / 0 / 0).
- Checklist collapses to a 1-line banner at top of dashboard once 100% complete: "Setup complete. [Hide]"
- Empty states throughout the admin link back to the relevant checklist step.

**Mature instance** = the full dashboard above. Threshold: count of apps > 0 AND number of users > 5 AND age > 7 days.

---

## 4. Page-level Patterns

Three reusable page templates. Every page in the admin will be one of these three.

### 4.1 List / CRUD Page

Used by: Apps, Models, Prompts, Tools, Skills, Sources, Pages, Short Links, Users, Groups, Workflows.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Apps                                                       [+ New app  ▼]   │
│  42 apps  •  38 enabled                                                      │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  [Search...]  [Category ▾] [Status ▾] [Owner ▾]   [Sort ▾]    [☰ ⊞]  [⋯]   │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  ☐  Name              Status    Owner       Updated      Models    Actions  │
│  ────────────────────────────────────────────────────────────────────────── │
│  ☐  Sales Assistant   ● live    J. Doe      2h ago       3       [Edit] [⋮]│
│  ☐  Compliance Bot    ● live    A. Smith    1d ago       1       [Edit] [⋮]│
│  ☐  Onboarding Q&A    ○ draft   S. Patel    3d ago       —       [Edit] [⋮]│
│  ☐  Marketing Helper  ● live    J. Doe      4d ago       2       [Edit] [⋮]│
│                                                                              │
│  Showing 1-25 of 42                                       ‹ 1  2  ›          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Anatomy:**

1. **Page header.** H1 title, count subtitle, primary action button (split button if multiple create paths, e.g., "+ New app ▼" with "Blank app", "From template", "Import").
2. **Toolbar.** Search input (left), filters (next), sort, view toggle (list/grid), overflow `⋯` for less-common actions (export, import, bulk archive).
3. **Bulk action bar.** When >= 1 row selected, the toolbar morphs into a contextual bar: `4 selected — [Disable] [Move...] [Delete] [Export] [✕ Clear]`. It slides in from above the table, replacing the filter row visually but not collapsing layout (no jump).
4. **Table.** First column is checkbox. Last column is per-row actions: an inline primary action (`Edit`) + a kebab menu (`⋮`) with secondary actions (Duplicate, Disable, Permissions, Delete).
5. **View toggle.** List (default for dense data: Users, Models) vs. Card grid (default for visual data: Apps, Prompts). Persisted per user per page.
6. **Empty state.** Centered illustration (line art, not photo), one-line description, primary CTA button matching the page header CTA, and a "Learn more →" doc link.
7. **Pagination.** Server-side, 25/50/100 per page selector. Infinite scroll explicitly not used — predictable URLs matter for an admin.

**Detail / edit pattern:**

- **Drawer for light edits** (rename, toggle enabled, change owner). Right-side drawer, ~480px wide, sticky footer with Cancel / Save.
- **Full page for heavy edits** (app config with variables, system prompts, tools, etc.). Tabs within the full page for sub-areas. Full page URL is deep-linkable.
- Rule of thumb: if the form has > 8 fields or > 1 conceptual section, it is a full page. Otherwise it is a drawer.

### 4.2 Settings Page

Used by: Authentication, OAuth, UI Customization, System, Features, Providers (config-level), Telemetry, Logging config.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Authentication                                                              │
│  Configure how users sign in to iHub Apps                                    │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  [Sections]                       │  General                                 │
│  ─────────────────────────────────│  ────────────────────────────────────── │
│  • General                        │                                          │
│  • Local accounts                 │  ▼ Anonymous access                      │
│  • OIDC                           │     [ ] Allow anonymous users            │
│  • LDAP                           │     Default groups: [anonymous]          │
│  • NTLM                           │                                          │
│  • Proxy auth                     │  ▼ Session                               │
│  • Session & tokens               │     Timeout (minutes): [60]              │
│                                   │     Sliding renewal:   [✓]               │
│                                   │                                          │
│                                   │  ▼ Token policy                          │
│                                   │     ...                                  │
│                                   │                                          │
│  ────────────────────────────────────────────────────────────────────────── │
│  ● You have unsaved changes                  [Discard]  [Save changes]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Anatomy:**

1. **Left sub-nav (sections within the settings page).** Linear-style. Scrolls to anchor or replaces right pane content depending on length. Use replacement pattern when section has > 20 form fields (System, OAuth), anchor pattern otherwise.
2. **Right pane: sectioned form.** Each section is a card-less group with a header and short description. Form fields use a 2-column label-input layout on >=1024px, stacked on smaller widths.
3. **Sticky save bar.** Always at the bottom. Hidden when clean. Shows: dirty indicator dot, message ("You have unsaved changes"), Discard button (secondary), Save button (primary). Save bar must be visible above any modal/drawer it might trigger.
4. **Dirty-state warning.** Browser `beforeunload` listener when dirty. In-app navigation away triggers a confirmation modal: "Discard unsaved changes?"
5. **Test-and-save pattern for credentials.** Any section with credentials (OIDC, LDAP, providers) shows a `Test connection` button next to Save. Save is disabled until test passes for first-time setups (existing config can save without re-testing, with a warning toast).

### 4.3 Integration Hub / Landing Page

Used by: Integrations (top-level), and conceptually also by OAuth Clients (list of OAuth integrations the hub exposes).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Integrations                                                                │
│  Connect iHub to your tools and services                                     │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  [Search...]   [Category ▾]   [Status ▾]                                    │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Productivity                                                                │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐                  │
│  │ [icon] Office  │ │ [icon] Google  │ │ [icon] Nextcl. │                  │
│  │ 365            │ │ Drive          │ │                │                  │
│  │ ● Connected    │ │ ○ Not setup    │ │ ● Connected    │                  │
│  │ Tested 14m ago │ │                │ │ Tested 2h ago  │                  │
│  │ [Configure]    │ │ [Connect]      │ │ [Configure]    │                  │
│  └────────────────┘ └────────────────┘ └────────────────┘                  │
│                                                                              │
│  Workflow                                                                    │
│  ┌────────────────┐ ┌────────────────┐                                      │
│  │ [icon] Jira    │ │ [icon] Outlook │                                      │
│  │ ● Connected    │ │ ⚠ Token expired│                                      │
│  │ Tested 1h ago  │ │ Tested 3d ago  │                                      │
│  │ [Configure]    │ │ [Reconnect]    │                                      │
│  └────────────────┘ └────────────────┘                                      │
│                                                                              │
│  Browser & Extensions                                                        │
│  ┌────────────────┐ ┌────────────────┐                                      │
│  │ Outlook add-in │ │ Browser ext.   │                                      │
│  │ Available      │ │ Available      │                                      │
│  │ [Download]     │ │ [Download]     │                                      │
│  └────────────────┘ └────────────────┘                                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Anatomy:**

1. **Category headings.** Productivity, Workflow, Browser & Extensions, etc. Sort within category: connected first, then not-setup, then unavailable.
2. **Integration card.** Square-ish (~240x180). Logo, name, status pill (Connected / Not setup / Token expired / Error), tested-at timestamp, single primary CTA. Click anywhere on the card opens the integration's detail/settings page.
3. **Status pill colors.** Green (connected & healthy), neutral (not setup), amber (warning, e.g., expired token), red (error, e.g., last test failed).
4. **Configure CTA → settings page.** The integration's detail page uses the **Settings Page** template (4.2). This is the key consolidation: the hub is just a landing, all detail is a settings page. Removes the redundancy between "Integrations" and the per-integration pages.

---

## 5. Command Palette (Cmd+K)

Triggered by Cmd/Ctrl+K from anywhere. Modal, centered, ~640px wide, 60vh max height.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Search admin, run commands, or jump to anything...                          │
├──────────────────────────────────────────────────────────────────────────────┤
│  Recent                                                                      │
│  ⏱  Apps                              Apps section                           │
│  ⏱  Sales Assistant                   App                                    │
│  ⏱  Authentication                    Settings                               │
│                                                                              │
│  Pages                                                                       │
│  ⌂  Overview                          Section: Overview                      │
│  ⊞  Apps                              Section: AI Workspace      ⌘1          │
│  ◈  Models                            Section: AI Workspace      ⌘2          │
│                                                                              │
│  Actions                                                                     │
│  +  Create new app                                                           │
│  +  Invite user                                                              │
│  +  Add LLM provider                                                         │
│  ⚙  Toggle feature flag...                                                   │
│  ↻  Run backup now                                                           │
│  ↻  Restart server                                                           │
│                                                                              │
│  Entities                                                                    │
│  👤  jane.doe@acme.com                User                                   │
│  ⊞  Sales Assistant                   App  •  3 models                       │
│  ◈  claude-opus-4-7                   Model  •  Anthropic                    │
│  🗂  KB-Compliance-2026                Source                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  ↑↓ Navigate  ↵ Open  ⌘↵ Open in new tab  Esc Close                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Spec

- **Sections (in order):** Recent (last 5), Pages, Actions, Entities (Apps, Users, Models, etc.). Sections hidden if empty after filter.
- **Fuzzy match across:** page titles, page descriptions, action verbs, entity names. Use `fuse.js` style scoring.
- **Quick actions surface verbs:** "Create new app", "Invite user", "Add LLM provider", "Toggle feature [name]", "Run backup now", "Restart server", "View logs", "Open audit log".
- **Keyboard shortcuts.**
  - `Cmd+K` open palette
  - `Cmd+1..6` jump to section (Overview / AI Workspace / Access / Integrations / Customization / Observability — Platform deliberately not on a number, requires intentional nav)
  - `Cmd+B` toggle sidebar collapse
  - `Cmd+/` focus search field in palette
  - `g a` then type → "go to apps" (Linear-style chord shortcuts in v2)
- **Recently visited.** Stored in localStorage per user. Top 5 distinct entries.
- **Entity search.** Server-side endpoint (`/api/admin/search?q=`). Returns first 5 of each entity type. Type pills next to results.
- **Action result UX.** Some actions open a confirmation modal ("Run backup now? This will take ~2 minutes."). Destructive actions always confirm; safe actions execute immediately with a toast.

---

## 6. Status / Health Indicators

A unified language for "this needs attention" across the chrome.

### Priority levels and visual treatment

| Level | Color | Icon | Use case |
|---|---|---|---|
| Critical | `red-600` | filled dot ● | Service broken, auth disabled, provider invalid, security risk |
| Warning | `amber-500` | filled dot ● | Token expiring, backup overdue, deprecated config |
| Info | `blue-500` | hollow dot ○ | Update available, pending review, optional setup step |
| Success | `green-600` | check ✓ | (used sparingly, mainly in confirmations) |

### Surfaces

1. **Nav item badge.** A small colored dot to the right of a nav label when any page in that section has an issue. Hover reveals "3 alerts in this section". Bubbles up: if a sub-item has an issue, the parent section also shows the highest-severity dot.
2. **Alert bell in topbar.** Aggregates all "Needs attention" items across the instance. Count badge. Clicking opens a panel (slide-in from the right, 400px) listing all items grouped by severity. Each item links to its source page.
3. **Inline page banner.** At the top of any page where an issue lives. Same color system. Banner has: icon, message, single CTA, dismiss `✕` if user-dismissable.
4. **Row-level status pill.** In tables, status column uses the same dot vocabulary. Consistency across page-level banners, table rows, integration cards.

### Examples in the wild (mapped to iHub)

- Provider with invalid key → red banner on `Providers` page + red dot on `Platform > Providers` nav (actually `AI Workspace > Providers` — see IA), + bell count + Overview "needs attention".
- Backup overdue → amber dot on `Platform > Backup` nav + bell count + Overview.
- v3.5 available → blue dot on `Platform > Updates` nav + bell count + Overview.

---

## 7. Information Architecture (Final)

After auditing the inventory, here is the final IA. Pushback included.

```
⌂ Overview
  └─ (single page)

⊞ AI Workspace
  ├─ Apps
  ├─ Models
  ├─ Prompts          (Global variables shown as a tab within Prompts, not separate)
  ├─ Tools
  ├─ Skills           (feature-flagged)
  ├─ Sources
  ├─ Workflows        (feature-flagged)
  ├─ Marketplace      (feature-flagged)
  └─ Providers        ⟵ LLM provider credentials live HERE, not Identity

🔐 Access & Identity
  ├─ Users
  ├─ Groups
  ├─ Authentication   (Local, OIDC, LDAP, NTLM, Proxy — sub-nav within the settings page)
  └─ OAuth            (Server + Clients consolidated; "hub" view collapsed into the same page)

🔌 Integrations
  ├─ All integrations  (the hub landing — Office365, Google Drive, Nextcloud, Jira, Outlook add-in, Browser ext, etc. as cards)
  └─ (no sub-items; each integration is a settings page reached from the hub)

🎨 Customization
  ├─ UI customization
  ├─ Pages
  └─ Short Links

📊 Observability
  ├─ Usage Reports
  ├─ Audit Log         ⟵ NEW: extracted from telemetry/logs to be first-class
  ├─ Logging
  └─ Telemetry

⚙ Platform
  ├─ Features          (feature flags)
  ├─ Security          (was: encryption + SSL + CORS — merged)
  ├─ Backup & Restore  (was: buried in System)
  ├─ Updates           (was: buried in System)
  └─ Advanced          (was: System — now just true escape hatches)
```

### Key IA decisions and rationale

1. **Providers → AI Workspace, not Access & Identity.** You flagged this correctly. Providers are LLM credentials; they are infrastructure for Apps and Models, not human identity. They sit beside Models conceptually.
2. **OAuth consolidated.** "OAuth hub / Server / Clients" collapses into a single OAuth page with tabs (Server config, Clients). The "hub" is no longer needed because Access & Identity is itself the hub.
3. **Integrations hub kept as a single landing.** Each integration becomes a settings page reached from the hub. The duplicated "Integrations hub" page disappears as a separate nav entry — the hub IS the section landing.
4. **System dismantled.** It was a junk drawer. Split into Security, Backup & Restore, Updates, and Advanced (which is now small and intentional).
5. **Audit Log added.** Currently missing. Required for enterprise. Sources data from existing telemetry + new explicit admin-action events.
6. **Global Variables collapsed into Prompts.** They are intrinsic to prompts; a sibling page is overkill.
7. **Marketplace, Skills, Workflows** stay feature-flagged in the same section. The rail respects flags — hidden items do not show.

### Section count: 7 (including Overview)

This is at the upper bound of what's comfortable. If we add an 8th, we squeeze. Section count discipline matters.

---

## 8. Visual Design Direction

### Color usage

Color is functional, not decorative. The palette is **mostly neutral grays** (Tailwind `slate` or `zinc`) with **one brand accent** (indigo-600) and a **status palette** (red-600 critical, amber-500 warning, blue-500 info, green-600 success). Brand color is used only for primary buttons, active nav, focused inputs, and the iHub logo. Buttons, cards, and surfaces are not colored. This is a Stripe-style, restrained admin palette. Light theme uses `slate-50` page background, `white` cards, `slate-200` borders. Dark theme uses `slate-950` page, `slate-900` cards, `slate-800` borders. Status colors stay vivid in both modes.

### Typography

System font stack (Inter where available, system fallbacks otherwise). Three sizes carry 95% of the UI: `text-sm` (14px) for body and tables, `text-base` (16px) for emphasized form fields and section subtitles, `text-xl` (20px) for H1 page titles. H2 section titles are `text-base font-semibold`. Tabular numerals (`font-variant-numeric: tabular-nums`) for all stats, counts, and tables. Line height tight (`leading-tight`) in tables, comfortable (`leading-relaxed`) in form descriptions. Avoid more than two font weights per surface — regular and semibold do the work.

### Spacing and density

Enterprise admins value information density. Default to **compact density**: table row height 36px, form field height 36px, button height 32px, card padding `p-4`. Provide a "Comfortable" toggle in user preferences that bumps row heights to 44px and card padding to `p-6`. Whitespace inside sections is functional — between sections (e.g., between two settings sub-cards) use `mt-8` (32px). Within a section, `mt-4` (16px) between groups. Tables hug the page edges horizontally; no double-padding.

### Iconography

Use **Lucide** (already widely adopted, MIT, consistent line weight, excellent coverage). Heroicons is the second choice. Tabler is broader but visually inconsistent across icons — skip. Icon sizes: 16px in tables and inline, 18px in nav rail, 20px in buttons-with-icons, 24px in section headers. Always pair icons with text labels in the nav; icon-only is reserved for icon buttons (kebab, close, sort) with `aria-label`.

### Dark mode

Dark mode is first-class, not an afterthought. Use the `slate` family in dark mode rather than pure black — pure black creates harsh edges on OLED and tires eyes during long admin sessions. Borders in dark mode are critical: `slate-800` for separators, `slate-700` for hovered/active edges. Charts and stat trend arrows must re-test contrast in dark mode (a green that passes AA on white often fails on dark navy). Brand indigo desaturates by one step in dark mode (`indigo-400` for active states) to avoid vibration on dark backgrounds.

---

## 9. Accessibility (WCAG 2.1 AA)

Top 5 musts for the redesign.

1. **Keyboard navigation across the entire chrome.** Tab order: skip-to-content link → topbar → sidebar (sections expandable with Enter/Space, arrow keys to traverse items within an expanded section) → page content. Cmd+K must open palette from anywhere. `Esc` closes drawers, palette, and modals. Trapped focus in modals, return focus on close.
2. **Focus indicators always visible.** A 2px ring (`ring-2 ring-indigo-500 ring-offset-2`) on every interactive element. No `outline: none` without a replacement. Inputs get a border-color shift PLUS a ring on focus. Custom checkboxes and toggles must show focus indicators that meet 3:1 contrast against their adjacent surface.
3. **ARIA for the nav and command palette.** Sidebar is `<nav aria-label="Admin navigation">`. Expandable sections are `<button aria-expanded="true|false" aria-controls="section-id">`. Active page link gets `aria-current="page"`. Command palette is `role="dialog" aria-modal="true" aria-label="Command palette"`. The palette input is a `combobox` with `aria-autocomplete="list"` and an `aria-activedescendant` pointing to the highlighted result. Status badges on nav items use `aria-label="3 alerts"` so they are not silent visual hints.
4. **Color contrast.** Body text 4.5:1 minimum (AA). Status pills must pass 3:1 against their background; the dot+text combo is preferred over text-only colored badges so the signal is not color-only (color-blindness coverage). Trend arrows in stat cards include an actual `▲` or `▼` glyph plus the color, not color alone.
5. **Form errors and live regions.** Settings pages and CRUD edit pages announce save state via `aria-live="polite"` toast region. Form field errors live in `<p id="field-error" role="alert">` and the input gets `aria-invalid="true" aria-describedby="field-error"`. The save bar's dirty indicator must include screen-reader text ("You have unsaved changes") not just the colored dot.

Bonus 6th must: **respect `prefers-reduced-motion`.** Sidebar expand/collapse, drawer transitions, palette open animations all degrade to instant or 50ms fades when reduced motion is set.

---

## 10. Phased Rollout

### Phase 1 — Chrome and Overview (Design ships)

- New sidebar (collapsible, grouped, with status dots)
- New topbar (breadcrumbs, alert bell, search pill)
- New Overview dashboard (stat cards, needs-attention, quick actions, recent activity, setup checklist for fresh instances)
- Visual design tokens applied: typography, spacing, colors, dark mode parity
- Accessibility baseline: focus rings, ARIA on nav, skip link, keyboard traversal

**Why ship first:** Highest impact for least architectural risk. New chrome can wrap unchanged page contents.

### Phase 2 — Page pattern unification (Design ships)

- List/CRUD template applied to: Apps, Models, Prompts, Tools, Users, Groups, Sources, Pages, Short Links (one PR per page, or batched in pairs)
- Settings template applied to: Authentication, OAuth, UI Customization, Platform > Security, Platform > Advanced
- Integration Hub template applied to: Integrations + per-integration settings pages (Office365, Jira, etc.)
- Bulk action bars added across all list pages
- Empty states designed and applied
- View toggles (list vs. card) where applicable

**Why second:** Largest body of work, lower per-PR risk, deliverable incrementally page by page.

### Phase 3 — Command palette and power features (Design ships)

- Cmd+K command palette with Pages, Actions, Entities, Recent
- Keyboard shortcuts (Cmd+1..6, Cmd+B, Cmd+/)
- Alert bell aggregation pane
- Audit Log (new page in Observability)
- "Comfortable / Compact" density toggle in user preferences
- Pinning / favorites in the sidebar (power user customization)
- Chord shortcuts (`g a`, `g u`, etc.)

**Why third:** Highest leverage for power users but lower frequency, can layer on top of stable Phase 1 + 2 foundation.

---

## Implementation Notes (for the coder this brief pairs with)

- **Use Tailwind tokens, not hex values, in components.** All status colors, gray scale, and spacing should reference Tailwind defaults so the design system can be tuned in one place (`tailwind.config.js`).
- **Reusable shells.** Build three React components: `<ListPage>`, `<SettingsPage>`, `<IntegrationHubPage>`. Each accepts header, toolbar, content, and footer slots so pages cannot drift visually.
- **Sidebar state in context.** `SidebarContext` holds: collapsed state, expanded sections, pinned items, current alert counts (subscribed to a `/api/admin/alerts/summary` poll every 60s).
- **Command palette as a portal.** Mount once at the root, controlled by a `CommandPaletteContext`. Any page can register additional contextual commands via a hook.
- **Status badge primitive.** `<StatusDot level="critical|warning|info|success" label="..." />` — used in nav, in tables, in cards, in banners.
- **Save bar as a layout slot.** `<SettingsPage>` exposes a `saveBar` prop and a `useDirtyState()` hook. Browser `beforeunload` registered automatically when dirty.
- **Do not rebuild routing.** Keep React Router. Add new top-level routes in `client/src/App.jsx` and update `client/src/utils/runtimeBasePath.js` knownRoutes for each (per CLAUDE.md).
- **Audit Log requires a new server feature** — flag this with PM. Without it, the Recent Activity card on Overview is sourced from existing telemetry events as a temporary measure.

---

## Open questions to resolve with PM

1. Audit Log scope and retention — is this in-scope for Phase 1 Overview, or stub it from telemetry?
2. Customizable Quick Actions on Overview — per-user or per-instance for v1?
3. Marketplace, Skills, Workflows feature flags — are they staying long-term or graduating soon? Affects sidebar real estate planning.
4. Mobile audience — do we have data on how many admins use mobile? Drives investment in off-canvas vs. mobile-optimized list pages.
5. "Test connection" pattern — does every credential-bearing settings page have a corresponding server-side test endpoint? If not, Phase 2 needs a small server roadmap.
6. Pinning / favorites — store server-side (per user record) or localStorage? Server-side enables cross-device but adds API surface.

---

**End of brief.** This document, paired with the PM brief, is ready to be synthesized into a redesign draft and broken into Phase 1 tickets.
