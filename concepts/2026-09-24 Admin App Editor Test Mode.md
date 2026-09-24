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
3. **Test** opens a panel with the app's real chat (`AppChat`, embedded): beside the editor from
   the `lg` breakpoint, full screen below it. It restarts with a new chat after every save.

## Decision: the test panel runs the saved config (option A)

The issue offered two options:

- **A — saved config only.** Embed the chat UI for the app and restart it after each save.
- **B — draft config.** Run the chat against the editor's in-memory config through an admin-only
  server path that accepts an app override.

**We chose A.** Reasons:

- **Parity.** The panel renders the production chat component, not a second renderer. Start
  screen, variables, uploads, tools, sources and model selection behave as users see them.
- **No new server surface.** The chat resolves the app by id from `configCache.getApps()` in
  several places — `RequestBuilder`, `sessionRoutes`, `appToolsGateway`, `ChatService`, the
  conversation and feedback routes. A draft override would have to reach all of them, be
  validated with `appConfigSchema`, stay admin-only, and keep test chats out of history and usage
  stats. That is a larger, security-relevant change for a convenience feature.
- **Save no longer costs a round trip.** With Save staying in the editor, "change → save → the
  panel restarts → test" is one click plus typing.

Accepted trade-offs, stated in the UI and in `docs/admin-ui.md`:

- A new app must be saved once before it can be tested (the Test button appears after that save).
- Every test runs against the live app. Admins who want to try risky changes can clone the app.
- Test chats are regular chats of the admin (history, usage).
- Unsaved changes are not in the test; the panel shows a hint while the editor is dirty.

Option B stays possible later. It would change how the embedded chat's requests resolve the app
(a draft override on the server), not the panel.

## Disabled apps

`configCache.getApps()` leaves disabled apps out, so the chat page answers 404 for them. The Open
app button is therefore disabled with a tooltip for disabled apps (in the editor: based on the
saved state), and the test panel explains that the app must be enabled and saved. Letting admins
open disabled apps would need the same server changes as option B.

## Decision: render `AppChat` in the page, not an iframe

A first version loaded `/apps/:appId` in a same-origin iframe. It was rejected in review: a second
copy of the whole SPA inside the admin page (boot, auth check, config fetches), a hidden
query-string flag to strip the chrome, and a dependency on the proxy's framing headers
(`X-Frame-Options`). The panel now renders `AppChat` directly, and `AppChat` has an `embedded` mode
for it.

`AppChat` is written as the page for `/apps/:appId`, so embedding it meant cutting its ties to the
route and to the tab's memory of the app. With `embedded`:

- **Route.** The app id comes from a prop. The host's query string is not read (it would apply
  `?prefill=`, `?model=`, `?var_*=` meant for the app page) and never rewritten; `chatId` from the
  route does not apply.
- **Navigation.** Nothing navigates the host away. The back button and "Edit app" are hidden (the
  admin is already editing it); the canvas and a citation's "open in app" open a new tab; the
  automatic jump to the canvas after a long answer is off, because it would be an unasked-for tab.
- **What the tab remembers.** Nothing is read or written: the chat id (`ai_hub_chat_id_<app>`),
  the settings and variables (`ai_hub_app_settings_<app>`), the recent apps, a start-page handoff,
  the iAssistant conversation id. Each mount mints an in-memory chat id, and `useAppSettings`
  takes `isolated`, which also leaves the header color alone. So a test starts from the app's own
  defaults, as a new user would see it, and the app's own page is untouched afterwards.
- **Links.** A message's copy-link and the share dialog point at the app's page
  (`linkPath` / `appPagePath`), not at `/admin/apps/…`.
- **Layout.** The chat's breakpoints measure the viewport, but beside the editor it gets about
  half of it. The input variables therefore stack above the chat instead of taking a side column.

The panel fetches the app with `fetchAppDetails` like `AppRouterWrapper` does, passes it as
`preloadedApp`, and is keyed by a counter that the editor bumps after every save, so each save
refetches the saved app and starts a new chat. Only chat apps are rendered; iframe and redirect
apps point to Open app.

The unsaved-changes guard (`useUnsavedChanges`) intercepts the admin router only. The embedded chat
never navigates, so opening, using or closing the panel never trips it, and leaving the editor
still does.

## Files

- `client/src/features/admin/pages/AdminAppEditPage.jsx` — Save / Save & Exit / `Ctrl+S`, new-app
  URL replace, Open app, Test toggle, split layout
- `client/src/features/admin/components/AppTestPanel.jsx` — the panel
- `client/src/features/apps/pages/AppChat.jsx` — `embedded` mode
- `client/src/shared/hooks/useAppSettings.js` — `isolated` option
- `client/src/utils/chatId.js` — `mintChatId`
- `client/src/features/apps/components/SharedAppHeader.jsx`,
  `client/src/features/chat/components/ChatHeader.jsx`, `ChatActionsMenu.jsx` — optional back and
  Edit app buttons, canvas override
- `client/src/features/chat/components/ChatMessage.jsx`, `ChatMessageList.jsx`, `ComparePanel.jsx`,
  `CompareModeView.jsx` — `linkPath` for the copy-link action
- `client/src/features/admin/pages/AdminAppsPage.jsx` — Open row action
- `client/src/features/admin/components/data-table/DataTableRowActions.jsx` — `target` on link
  actions, row-dependent `title`, disabled links render as disabled buttons
