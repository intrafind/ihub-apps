# Admin UI Redesign — 2026

**Status:** Draft for review
**Date:** 2026-05-19
**Branch:** `claude/redesign-admin-ui-AmW2j`
**PR:** [#1484](https://github.com/intrafind/ihub-apps/pull/1484)

## Why we are doing this

The iHub Apps admin has grown to 30+ pages. Today they sit in a flat top-tab bar with three pinned items (Apps, Models, Prompts) and a "More" dropdown that hides the other 20+. The landing page is a 12-tile launcher with no grouping and no signal. New admins are lost; experienced admins live in muscle memory and Cmd+L.

This redesign moves the admin to a **task-oriented, enterprise-grade workspace** — left-rail navigation, a real operations dashboard, three reusable page templates, a Cmd+K command palette, and consistent "needs attention" surfaces.

## Documents in this folder

1. **[Redesign Draft](2026-05-19%20Admin%20UI%20Redesign%20Draft.md)** — The synthesised proposal. **Start here.**
2. **[Product Strategy & IA](2026-05-19%20Admin%20UI%20Redesign%20Product%20Strategy%20&%20IA.md)** — PRD-style brief: personas, JTBDs, IA rationale, phased rollout, enterprise gap analysis.
3. **[Design Brief](2026-05-19%20Admin%20UI%20Redesign%20Design%20Brief.md)** — UX/UI brief: navigation pattern, dashboard wireframes, page templates, command palette, visual direction, accessibility.

## Key recommendations at a glance

- **7 top-level sections** (left rail): Overview, AI Workspace, Access & Identity, Integrations, Customization, Observability, Platform.
- **Dashboard replaces the launcher**: status banner, "needs attention", KPI cards, setup checklist (fresh instances), recent activity. Tile launcher demoted to a collapsible drawer at the bottom.
- **Three reusable page templates**: List/CRUD, Settings, Integration Hub. Every admin page becomes one of these.
- **Command palette (Cmd+K)** for global search, navigation, and quick actions.
- **System "junk drawer" is dismantled** into Security, Backup & Restore, Updates, Advanced.
- **OAuth hub + Server + Clients merged** into one tabbed page.
- **Audit Log added** as first-class observability surface.
- **Sub-admin roles deferred to Phase 3** — ship IA changes first.
- **Documentation alignment is a required parallel workstream.** Many users today edit JSON in `contents/` directly because `docs/` does not document the admin UI. Without rewriting docs to be UI-first, the redesign delivers a surface nobody is taught to use. See draft §12.

## Phased rollout

| Phase | Scope | Target |
|---|---|---|
| 1 | New chrome (sidebar, topbar) + Overview dashboard, all existing pages re-routed unchanged | 4 weeks |
| 2 | Page-template unification, bulk actions, command palette, wizards for top 5 JTBDs | 8 weeks |
| 3 | Sub-admin roles, audit log retention, change history, dry-run, bulk import/export | 10 weeks |

## Open decisions for the user

These need a call before implementation begins. The draft includes recommendations for each.

1. **Providers placement** — AI Workspace (recommended) or Access & Identity?
2. **Customization as its own section** (recommended) or folded into Platform?
3. **Legacy integration routes** — remove with 1-minor-version redirect (recommended), or keep indefinitely?
4. **Sub-roles timing** — Phase 3 (recommended) or sooner?
5. **Audit Log scope** — full new feature in Phase 1 or stub from telemetry?
6. **Documentation alignment timing** — hard gate for Phase 1 ship, or 30-day fast-follow (recommended)? See draft §12.
