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

## System Page Reorganized into Focused Platform Pages

The monolithic System page has been split into four dedicated pages under Platform:

- **Security** — SSL certificates, CORS configuration, cookie settings, value encryption
- **Backup & Restore** — configuration export and import
- **Updates** — version information, update check, and rollback
- **Advanced** — force client refresh and escape-hatch operations

`/admin/system` redirects to `/admin/security`.
