# 2026-11-02 · Chat picker and server-side defaults (#2923)

**Status:** Implemented (draft PR for intrafind/ihub-apps#2923, stacked on #3150 / #3147) · Part of [Unified Integrations](README.md) · Builds on [03 · Product concept](03-product-concept.md) §7.2 and [One connect flow and connect card](2026-11-02%20One%20connect%20flow%20and%20connect%20card.md)

Implementation notes for the chat's integrations picker, the chips under the composer and the per-user default.

## What exists now

```
server/services/integrations/integrationPicker.js            pickerRowsForApp, appCandidateRefs, appIntegrationDefaults
server/services/integrations/IntegrationPreferencesRepository.js   per (user, app) default, namespace integration-preferences
server/routes/integrations/userIntegrations.js               GET /picker?app=, GET|PUT /preferences?app=

client/src/features/integrations/picker/
  IntegrationPicker.jsx       the "+" menu body: search, Attach, Use in this chat, default, manage
  IntegrationChips.jsx        chips under the composer (inline scope dropdown for scopePicker: inline)
  pickerState.js              isRowOn / setRowOn (refs + coveredBy), effect summary, scope map
  useIntegrationPicker.js     rows, reload after a sign-in, connect in a new tab
  useIntegrationDefaults.js   GET preferences + the one-time import of the browser's value
```

## Rows

`GET /api/integrations/picker?app=` answers one row per owner of the app's tools for this user: an installation (`_integration.instanceId`), an MCP server (`_mcp.serverId`), a remote agent (`_a2a`), or a plain tool reference. The server loads `getToolsForApp(app, lang, { user, websearchEnabled: false })` and keeps a tool only when one of the app's references selects it (`isBoundToolEnabled`), so injected tools (sources, workflows, skills, other apps) and `ask_user` have no row.

- `refs` is the reference that selects the whole owner (installation id, MCP server id, agent reference, or the app's own reference for a plain tool). `coveredBy` lists the app's other references that also select it — a binding key such as `type:storage` or a definition id that covers several installations. Switching one installation off replaces the binding by the other installations' ids (`setRowOn`), so per-installation switches work under a shared binding.
- Name, icon, capabilities and connection of an installation come from `listUserIntegrations` (the Settings → Integrations listing). `effects` come from the `sideEffect` of the actions the app offers.
- Scope entries (`GET /api/integrations/scopes`) are joined by `row.integration === scope.id`; a scope-only integration (iAssistant) is a row of its own.

## State

- Per chat: the chat's `settings` (`enabledTools`, `websearchEnabled`, `integrationScopes`), written by every turn, as before. A switch, a scope pick or an `@` pick changes only that.
- Per user and app: `integration-preferences/ip_<hash(user)>__<appId>`, `{ enabledTools?, websearchEnabled?, integrationScopes?, knownRefs, updatedAt }`. `knownRefs` is what the app offered at save time; `effectivePreferences` turns on what the app added since. Written only by **Use as default for new chats** (the open chat's set) and by the one-time import (`import: true`, write-if-absent).
- `useAppSettings` reads the default as layer 1 (gated until it loads) and no longer reads or writes the three keys in `sessionStorage` (`ai_hub_app_settings_<appId>`); `useIntegrationDefaults` reads them once, before the settings hook's save effect rewrites them, imports and removes them. The brief and the issue say `localStorage`: the browser value actually lived in `sessionStorage`.
- Scheduled tasks and workflows: unchanged — a task stores `enabledTools`, `websearchEnabled`, `integrationScopes` when created (#3117), a workflow node its `config.integrationScopes`; neither reads chat state or the default.

## Connect from the picker

`Connect →` switches the row on in this chat, opens `about:blank` in the click (popup blockers), asks `POST /api/integrations/:id/connect` with the current chat as `returnUrl`, and sends the new tab to the vendor (`opener` cleared). The new tab lands on the same chat; `useIntegrationPicker` there reads `integration_connected` once, switches the row on and posts on the `BroadcastChannel` `ihub.integrations.connect`. The first tab reloads its rows on that message and when the user returns to it after a connect started there. Without a new tab (blocked) the current tab goes and comes back.

## Not in this PR

- The server's `GET /api/tools?appId=` is no longer used by the chat (the app creation wizard still calls `/api/tools`); left in place.
- On-demand mode for apps with many integrations (#2889).
- A per-app default editor in Settings → Integrations; the default is saved from the chat.
