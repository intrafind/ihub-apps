# Admin App Editor: Open App, Save vs. Save & Exit, Test Mode

**Date:** 2026-09-24
**Status:** Implemented (saved-config test mode)
**Issue:** [#2510](https://github.com/intrafind/ihub-apps/issues/2510)

---

## Problem

Iterating on an app in the admin took four steps per change: edit, **Save App** (which also left
the editor), find and open the app to test it, then find the app in the admin again. There was no
link from the admin to the running app, and no way to try a change without leaving the editor.

## What was built

1. **Open app** in the editor header (existing apps) and as a row action in the apps list. It
   links to `/apps/:appId` through `buildPath`, so subpath deployments work, and opens in a new tab.
2. **Save** stores the app and stays in the editor (success toast, dirty state reset); **Save &
   Exit** is the old behaviour. `Ctrl/Cmd+S` triggers Save. Saving a new app with Save replaces
   `/admin/apps/new` with `/admin/apps/:id`, so later saves use `PUT` and History, Download, Open
   app and Test appear.
3. **Test** opens a panel with the app's real chat page: beside the editor from the `lg`
   breakpoint, full screen below it. It reloads after every save.

## Decision: the test panel runs the saved config (option A)

The issue offered two options:

- **A — saved config only.** Embed the chat UI for `/apps/:appId` and reload it after each save.
- **B — draft config.** Run the chat against the editor's in-memory config through an admin-only
  server path that accepts an app override.

**We chose A.** Reasons:

- **Parity for free.** The panel is the production page, not a second renderer. Start screen,
  variables, uploads, tools, sources and model selection behave exactly as users see them.
- **No new server surface.** The chat resolves the app by id from `configCache.getApps()` in
  several places — `RequestBuilder`, `sessionRoutes`, `appToolsGateway`, `ChatService`, the
  conversation and feedback routes. A draft override would have to reach all of them, be
  validated with `appConfigSchema`, stay admin-only, and keep test chats out of history and usage
  stats. That is a larger, security-relevant change for a convenience feature.
- **Save no longer costs a round trip.** With Save staying in the editor, "change → save → the
  panel reloads → test" is one click plus typing.

Accepted trade-offs, stated in the UI and in `docs/admin-ui.md`:

- A new app must be saved once before it can be tested (the Test button appears after that save).
- Every test runs against the live app. Admins who want to try risky changes can clone the app.
- Test chats are regular chats of the admin (history, usage).
- Unsaved changes are not in the test; the panel shows a hint while the editor is dirty.

Option B stays possible later. It would replace the iframe's app lookup, not the panel.

## Disabled apps

`configCache.getApps()` leaves disabled apps out, so the chat page answers 404 for them. The Open
app button is therefore disabled with a tooltip for disabled apps (in the editor: based on the
saved state), and the test panel explains that the app must be enabled and saved. Letting admins
open disabled apps would need the same server changes as option B.

## How the embed works

- The iframe loads `buildPath('/apps/:appId?ihubPreview=1')`.
- `client/src/utils/appPreviewMode.js` reads the flag once, when the module loads, and only when
  the page is framed. In-app navigation drops the query string (a new chat, `/c/:chatId`), so a
  per-render check would lose it. Outside a frame the flag is ignored, so a pasted link opens the
  normal page.
- `integrationSettings.js` treats preview mode like the Nextcloud embed: no header, footer or
  sidebar, and nothing written to `localStorage`. The existing embed flag in `sessionStorage`
  could not be reused, because a same-origin iframe shares `sessionStorage` with the admin tab
  around it, which would then lose its own header.
- The iframe is same-origin, so the admin's session cookie authenticates it. A reverse proxy that
  sends `X-Frame-Options: DENY` (or `frame-ancestors 'none'`) blocks the panel; `SAMEORIGIN` works.
- The unsaved-changes guard (`useUnsavedChanges`) intercepts the admin router only. Opening,
  closing or navigating inside the panel never trips it, and leaving the editor still does.

## Files

- `client/src/features/admin/pages/AdminAppEditPage.jsx` — Save / Save & Exit / `Ctrl+S`, new-app
  URL replace, Open app, Test toggle, split layout
- `client/src/features/admin/components/AppTestPanel.jsx` — the panel
- `client/src/features/admin/pages/AdminAppsPage.jsx` — Open row action
- `client/src/features/admin/components/data-table/DataTableRowActions.jsx` — `target` on link
  actions, row-dependent `title`, disabled links render as disabled buttons
- `client/src/utils/appPreviewMode.js`, `client/src/utils/integrationSettings.js` — preview mode
