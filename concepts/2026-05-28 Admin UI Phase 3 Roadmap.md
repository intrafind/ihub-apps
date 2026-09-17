# Admin UI Phase 3 Roadmap

**Date:** 2026-05-28  
**Status:** Planning — ready to execute  
**Context:** Follows Phase 1 (sidebar redesign, overview dashboard) and Phase 2 (Cmd+K, change history, audit log, overview stats, subpath fixes). Informed by a UX research audit, UI design audit, and PM review.

---

## Background

iHub Apps admin UI was rebuilt in two phases. Phase 1 replaced the old flat nav with a collapsible left-rail sidebar and a new overview dashboard. Phase 2 added the Cmd+K command palette, per-entity change history drawers, audit log page, overview platform status panel, and fixed scrolling/subpath issues.

A three-way audit (UX researcher + UI designer + PM) found the interface functional but not enterprise-grade. It looks like a Tailwind template, not a product. The roadmap below fixes that in three phases, from most critical to most cosmetic.

---

## Quick Wins — Ship Immediately (< 1 day each)

No design needed. Purely mechanical fixes.

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| QW1 | Replace all 11 `window.confirm` calls with the existing `ConfirmDialog` component | `AdminAppsPage`, `AdminGroupsPage`, `AdminUsersPage`, + 8 others | 3–4h |
| QW2 | Fix audit log row truncation — add click-to-expand row showing full summary | `AdminAuditLogPage.jsx` | 1–2h |
| QW3 | Fix model test result dark mode — `text-gray-700` missing `dark:text-gray-300` on error text | `AdminModelsPage.jsx` line ~542 | 30min |
| QW4 | Add subtitle/context to Cmd+K results — provider name for models, enabled status for apps | `AdminCommandPalette.jsx` → `flattenSearchResults()` | 2h |

---

## Phase 3A — Safety & Compliance

**Goal:** Remove blockers that kill enterprise deals and prevent production incidents.  
**Target:** 4–6 weeks  
**Success:** Compliance teams can audit the platform. Admins can't accidentally destroy config.

### 3A-1: Unsaved Changes Guard

**What:** Detect when a form has been modified but not saved. Warn on navigation away.  
**Why:** Data loss is the #1 trust-killer in admin tools. An edit that gets abandoned silently is a production incident waiting to happen.

**Implementation:**
- Build a `useUnsavedChanges(initialData, currentData)` hook that computes `isDirty` by deep-comparing the two objects
- Use React Router's `useBlocker` API to intercept in-app navigation when `isDirty` is true
- Use the browser's `beforeunload` event for tab close / external navigation
- Show the existing `ConfirmDialog` component with message: "You have unsaved changes. Leave anyway?"
- Apply to all 7 edit pages: `AdminAppEditPage`, `AdminModelEditPage`, `AdminPromptEditPage`, `AdminProviderEditPage`, `AdminSourceEditPage`, `AdminToolEditPage`, `AdminGroupEditPage`, and user edit

### 3A-2: Audit Log — Expandable Rows + CSV Export

**What:** Two additions to the existing audit log page.  
**Why:** Truncated audit rows are useless for compliance. "Show me all model changes last month" currently requires a support ticket.

**Implementation (expandable rows):**
- Replace `max-w-md truncate` on the summary `<td>` with a click-to-expand row
- Expanded state shows full summary as `<pre>` text
- If the event has a `diff` object, render the same diff view used in `ChangeHistoryDrawer`

**Implementation (CSV export):**
- Add `GET /api/admin/audit-log/export` route with the same filter params as the list endpoint (`from`, `to`, `admin`, `resource`, `action`)
- Return `text/csv` with headers: `timestamp, admin, action, resource, resourceId, summary`
- Add "Export CSV" button in the filter bar of `AdminAuditLogPage`

### 3A-3: Breadcrumbs on All Edit Pages

**What:** `Admin / Models / gpt-4o-mini` breadcrumb trail on all detail/edit pages.  
**Why:** Admins don't know where they are. Back-button dependency breaks workflows.

**Implementation:**
- Create a single `AdminBreadcrumb` component that accepts an array of `{ label, href }` objects
- The entity name comes from `formData` already loaded into each page (use ID as fallback during loading)
- Add to all edit pages: `Admin / {Section} / {Entity Name}`
- This also fixes the ChangeHistoryDrawer context problem — admins can see which entity they're viewing history for

### 3A-4: Consistent Loading and Empty States

**What:** One skeleton loader component and one empty state component, used everywhere.  
**Why:** Three different spinner patterns across three adjacent pages makes the interface feel fragmented and unreliable.

**Implementation:**
- `<AdminPageSkeleton rows={n} />` — animated pulse skeleton table with `n` rows. Replace full-page spinners on all list pages: Apps, Models, Prompts, Users, Groups, Sources, Providers, Audit Log
- `<AdminEmptyState icon title description action />` — single component. Action prop renders a button or link. Replace all hand-rolled inline SVG empty states
- Sub-form spinners inside pages can keep their current loaders

---

## Phase 3B — Daily Admin Productivity

**Goal:** The admin who opens iHub 5× per week feels faster than before, not just safer.  
**Target:** 6–8 weeks after Phase 3A ships  
**Success:** Time-to-complete common flows measurably shorter. Component library prevents new CSS inconsistency.

### 3B-1: Form Validation Error Summary

**What:** On form submit with errors, show a summary banner at the top listing each failing field as a link.  
**Why:** A 10-field form with 3 errors forces admins to hunt. Per-field inline errors already exist — this adds navigation to them.

**Implementation:**
- On failed submit, collect all `validationErrors` into a list
- Render an error banner at the top: "3 errors found: Name, API Key, Token Limit" where each is a link
- Links call `document.getElementById(fieldId).scrollIntoView({ behavior: 'smooth' })`
- Auto-scroll to the top of the form on submit failure
- The `validateWithSchema()` utility already returns structured errors — just aggregate them

### 3B-2: URL-Persisted Filter State

**What:** Filters stored in URL query params so they survive navigation and can be bookmarked/shared.  
**Why:** Set filters, drill into a record, navigate back — filters reset. Workflow interrupted.

**Implementation:**
- Build a `useFilterState(paramName, defaultValue)` hook wrapping React Router's `useSearchParams`
- Apply to: `AdminAuditLogPage`, `AdminAppsPage`, `AdminModelsPage`, `AdminUsersPage`
- Example URL: `/admin/users?status=inactive&authMethod=ldap`
- Test against OIDC redirect flows — the `useOAuthCallbackCleanup` hook may interact with this

### 3B-3: Component Library — Button + Input

**What:** `<AdminButton>` and `<AdminInput>` components to replace ~40 call sites of copy-pasted Tailwind strings.  
**Why:** Buttons look different across pages. Error states on inputs are reinvented inline on every form. This is the highest-leverage design investment.

> **Important order:** Do components before design tokens. Tokens derived from components. Not the other way around.

**`<AdminButton variant="primary|secondary|danger|ghost" size="sm|md" loading isDisabled>`**
- `primary`: `bg-indigo-600 hover:bg-indigo-700 active:scale-95 shadow-sm`
- `secondary`: `bg-white border border-gray-300 hover:bg-gray-50 active:scale-95`
- `danger`: `bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 active:scale-95`
- `loading`: shows inline spinner, disables button
- All variants: `transition-all duration-150` (not 300ms), `focus-visible:ring-2`

**`<AdminInput error helperText disabled>`**
- Error state: `border-red-300 dark:border-red-600 focus:ring-red-500`
- Error message rendered below input in `text-sm text-red-600`
- Disabled: `bg-gray-50 dark:bg-gray-900 text-gray-500 cursor-not-allowed`
- Also build `<AdminSelect>` with same API

**Enforcement:** Add ESLint rule banning `bg-indigo-600` directly on `<button>` elements — all button colors must go through `<AdminButton>`.

### 3B-4: Keyboard Shortcuts

**What:** `g+a` for Apps, `g+m` for Models, `n` for New item on list pages, `?` for cheatsheet modal.  
**Why:** Power users expect shortcuts. Cmd+K is good but not enough.

**Implementation:**
- `useAdminKeyboardShortcuts` hook with a sequence-key system (300ms window between keys for `g+letter` combos)
- `?` opens a static modal listing all shortcuts
- `n` on list pages triggers the same action as the "New X" button (navigate to `/admin/apps/new` etc.)
- Register/unregister on mount/unmount to avoid conflicts with form inputs (check `event.target.tagName !== 'INPUT'`)

### 3B-5: Setup Wizard Next-Steps Screen

**What:** Add a step 5 to `SetupWizard.jsx`: "You're ready — here's what to do first."  
**Why:** Wizard currently completes and drops admins cold on the overview dashboard. Day 1 churn risk.

**Implementation:**
- Step 5: three CTA cards — "Create your first app" → `/admin/apps/new`, "Invite users" → `/admin/users`, "Configure SSO" → `/admin/auth`
- Zero backend changes

---

## Phase 3C — Design System & Polish

**Goal:** The UI looks designed, not assembled. Required before enterprise marketing screenshots or public demos.  
**Target:** Parallel, ongoing alongside 3B  
**Success:** WCAG AA focus indicators on all pages. Zero color-contrast failures in dark mode.

### 3C-1: Dark Mode Completion Pass

- Standardize on `dark:ring-*` for focus states (never `dark:border` for focus rings)
- Remove all `focus:outline-none` without a replacement focus indicator (confirmed: sidebar nav items in `AdminSidebar.jsx`)
- Add `dark:text-gray-300` / `dark:text-gray-400` wherever `text-gray-700` / `text-gray-600` appears without a dark variant
- Run aXe in CI to catch regressions

### 3C-2: Micro-interactions Pass

Three specific changes — each small, compound effect is significant:
1. `active:scale-95` on all buttons (currently 3 instances, need ~40 — done automatically once `<AdminButton>` ships)
2. Sidebar chevron rotation on expand/collapse: replace icon swap with CSS `rotate-90` transform + `transition-transform duration-200`
3. Replace all `transition-all duration-300` on interactive elements with `transition-colors duration-150` — 300ms hover feedback is measurably sluggish

### 3C-3: Typography Standardization at Section Level

- `h1` (page titles): already consistent at `text-2xl font-bold`
- `h2/h3` (section labels inside form cards): currently mix `text-lg font-medium` and `text-base font-semibold` — create `<AdminSectionTitle>` component and apply globally
- Label text: `text-sm font-medium text-gray-900 dark:text-gray-100` — consistent everywhere

### 3C-4: Design Tokens (after component library ships)

- Once `<AdminButton>` and `<AdminInput>` are in use, extract color decisions as CSS variables: `--color-primary`, `--color-danger`, `--color-surface`, `--color-border`
- Required before any customer-facing theming or white-label work
- Do NOT do this before the component library is settled

---

## Items to Defer

| Item | Reason |
|------|--------|
| **SCIM provisioning** | Right scope for Phase 4. Requires full endpoint suite + schema negotiation. Budget 6–8 weeks standalone. |
| **Cost attribution in usage reports** | Needs admin-configurable pricing table per model (provider rates change frequently). 3-day standalone feature, not part of UI polish. |
| **Audit log undo transactions** | Change history + rollback already exists. ConfirmDialog with item count is sufficient safety for now. |
| **Empty state illustrations** | Use heroicons at launch. Add commissioned illustrations after Phase 3A ships if NPS flags it. |

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| Component library refactor breaks existing pages | Migrate pages incrementally. Keep old inline class patterns valid until every callsite migrated. No big-bang swap. |
| URL filter state conflicts with OIDC redirect flows | Test `useSearchParams` against `useOAuthCallbackCleanup` hook before shipping. |
| Breadcrumbs flash "Loading..." during slow entity load | Use entity ID from `useParams()` as fallback label until name loads. Don't block breadcrumb render on API response. |

---

## What Was Already Done (Phases 1 & 2)

For reference — do not rebuild these:

- Collapsible left-rail sidebar with 7 sections, icon-only collapse, mobile drawer
- Overview dashboard: stat cards (apps, users, conversations, version), platform status panel, quick actions
- System pages split into: Security, Backup & Restore, Updates, Advanced
- Cmd+K command palette searching apps, models, prompts, providers, sources, tools
- Change history drawer on all edit pages (apps, models, prompts, sources, tools) with diff view
- Audit log page with timestamps
- Sidebar independent scrolling, auto-hide scrollbar
- Subpath (`/ihub/`) compatibility for all admin API calls
- `saveSnapshot()` calls on create/update/delete for all entity types
- `/admin/overview/stats` endpoint aggregating configCache data
- What's New section in sidebar (below Overview)
- History button at top of all edit pages
