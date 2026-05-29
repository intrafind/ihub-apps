# Features — 5.4.0

## Redesigned Admin Navigation — Collapsible Left-Rail Sidebar

The flat horizontal tab bar with a 20-item "More" dropdown has been replaced with a
collapsible left-rail sidebar organized into seven logical sections:
**Overview, AI Workspace, Access & Identity, Integrations, Customization, Observability, Platform**.

- Sidebar collapses to icon-only mode; state persists across page reloads
- Active section auto-expands on page load
- Mobile: off-canvas drawer with hamburger toggle
- Dark mode supported throughout

## Admin Overview Dashboard

The 12-tile app launcher has been replaced with an operations dashboard:

- **Stat cards**: total apps, active users (last 30 days), total conversations, platform version
- **Needs your attention**: surface for update alerts and actionable issues
- **Quick actions**: one-click access to common admin tasks
- **Setup checklist**: shown on fresh instances to guide initial configuration

## Admin Overview Dashboard — Platform Status and Accurate User Count

The overview dashboard now shows accurate registered user counts and a full platform status panel.

- **Users card** displays the number of registered users (not session IDs) with active sessions (last 30 days) as a subtitle
- **Platform status panel** shows enabled/total counts for providers, models, sources, and tools; group count; active authentication methods (Local, OIDC, LDAP, Proxy, Anonymous); and OAuth server status
- Update notifications are informational only and no longer appear in "Needs your attention"

## Cmd+K Command Palette — Entity Search

The Cmd+K (or Ctrl+K) command palette now searches across all entity types:

- Apps, models, prompts, providers, sources, and tools are all searchable
- Results navigate directly to the entity's edit page
- Works correctly under subpath deployments (e.g. `/ihub/`)

## Change History for All Configuration Entities

All entity edit pages (apps, models, prompts, sources, tools) now include a **History** button in the page header. Opening it shows a before/after diff of every saved change.

- Only changed fields are shown in the diff viewer — unchanged fields are hidden
- History is recorded for both form edits and raw JSON editor edits
- The History button appears at the top of the edit form next to Download and Back

## Audit Log Timestamps

The audit log now displays the correct timestamp for each event. Previously, the timestamp column was blank due to a field name mismatch between the server and client.

## Sidebar Independent Scrolling

The admin sidebar now scrolls independently from the main content area. Selecting an item from the bottom of the sidebar no longer scrolls the page content. The sidebar scrollbar auto-hides when not in use.

## System Page Reorganized into Focused Platform Pages

The monolithic System page has been split into four dedicated pages under Platform:

- **Security** — SSL certificates, CORS configuration, cookie settings, value encryption
- **Backup & Restore** — configuration export and import
- **Updates** — version information, update check, and rollback
- **Advanced** — force client refresh and escape-hatch operations

`/admin/system` redirects to `/admin/security`.

## Breadcrumbs on All Admin Edit Pages

Every admin edit page now shows a breadcrumb trail (e.g. **Admin › Models › gpt-4o-mini**) so admins always know where they are and can navigate back without relying on the browser's Back button.

## Unsaved Changes Guard

All 16 admin edit pages now warn before navigating away with unsaved changes. A confirmation dialog appears whenever an admin tries to leave a page with a modified form, preventing accidental data loss.

- Triggers on in-app navigation (clicking sidebar links, breadcrumbs, Cancel button)
- Also triggers on browser tab close and page refresh
- Admins can choose to leave (discard changes) or stay

## URL-Persisted Filter State

Admin list pages now store their filter and search state in the URL. Filters survive navigation — drill into a record, come back, and the filters are still set. Filtered views can also be bookmarked and shared.

Applies to: Apps, Models, Users, Workflows, Tools, Skills, Audit Log, Marketplace, Short Links, Workflow Executions.

## Keyboard Shortcuts

The admin UI now supports keyboard shortcuts for faster navigation:

| Shortcut | Action |
|----------|--------|
| `g` then `a` | Go to Apps |
| `g` then `m` | Go to Models |
| `g` then `p` | Go to Prompts |
| `g` then `u` | Go to Users |
| `g` then `g` | Go to Groups |
| `g` then `s` | Go to Sources |
| `g` then `l` | Go to Audit Log |
| `n` | New item (on list pages) |
| `?` | Show keyboard shortcut cheatsheet |
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Admin UI Design System — Dark Mode, Micro-interactions, and Design Tokens

The admin UI has received a comprehensive visual polish pass:

- **Full dark mode coverage** — every admin page, table, form, badge, and status indicator now has correct dark-mode colors. Previously several agent, workflow, and user pages were missing dark variants.
- **Micro-interactions** — all admin buttons now scale down slightly on press (`active:scale-97`) with a 150ms transition for responsive tactile feedback.
- **Design tokens** — admin color values (`admin.accent`, `admin.surface`, `admin.border`, `admin.muted`) are now defined as Tailwind theme tokens, ensuring consistent color usage across the admin interface.
