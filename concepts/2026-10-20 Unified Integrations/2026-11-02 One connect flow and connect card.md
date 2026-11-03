# 2026-11-02 · One connect flow and one Connect card (#2917)

**Status:** Implemented (draft PR for intrafind/ihub-apps#2917, stacked on #3140 / #2914) · Part of [Unified Integrations](README.md) · Builds on [03 · Product concept](03-product-concept.md) §7.3, [04 · Architecture](04-architecture.md) §4 and [Connection service and OAuth client](2026-11-02%20Connection%20service%20and%20OAuth%20client.md)

Implementation notes for the user API of the integrations, the one connect flow and the one Connect card. Written so that the next PR (intrafind/ihub-apps#2922, Settings → Integrations) can build on `GET /api/integrations` without reading the whole diff.

## What exists now

```
server/routes/integrations/userIntegrations.js   GET /api/integrations, GET /api/integrations/:id,
                                                 POST /api/integrations/:id/connect | reconnect | disconnect
server/services/integrations/userIntegrations.js the listing: access filter, actions, connection status (pure helpers
                                                 connectionStatusOf, sharedModeOf, effectsOf)
server/routes/integrations/oauthIntegrationFactory.js   only the vendor-registered callback aliases now
server/routes/mcpOAuth.js                        only the CIMD document and the MCP callback alias now
server/services/integrations/auth/integrationAuthRequired.js   integrationConnectPath / integrationReconnectPath,
                                                 `scopes` on the error and the result
server/services/chat/chatSeams.js                authRequiredOf(rawResult, toolDef): the protocol-neutral card marker

client/src/api/userIntegrationsApi.js            fetchUserIntegrations, fetchUserIntegration, requestConnectUrl, disconnectUserIntegration
client/src/features/integrations/connect/
  ConnectCard.jsx                                the one card (and ConnectCards for a message)
  authPrompts.js                                 normalize / project `integrationAuthRequired`
  connectResult.js                               read `integration_connected` / `integration_error` once per page
  connectRetry.js, useConnectRetry.js            retry once after a connect
  integrationInfo.js                             cached GET /api/integrations/:id, startIntegrationConnect, permissionsByEffect
```

Removed: `useIntegrationAuth.js`, `IntegrationConnectionCard.jsx`, `IntegrationAuthPrompts.jsx`, `McpConnectCard.jsx`, `mcpConnectPrompts.js`, `mcpConnectUrl.js`, `mcpConnectionStatus.js`; the per-provider `/auth`, `/status`, `/disconnect` routes, Jira's `/refresh`, and `/api/mcp/oauth/authorize|connections|disconnect`. The callback aliases stay.

## `GET /api/integrations` (the shape #2922 builds on)

`{ "integrations": [ entry, … ] }`, sorted by name; `GET /api/integrations/:id` answers `{ "integration": entry }` or 404.

```jsonc
{
  "id": "jira",                      // installation id
  "definition": "com.intrafind/jira",
  "type": null,                      // "storage" | "web-search" | "people-directory" | null
  "protocol": "native",              // native | mcp | openapi | a2a | script
  "name": "Atlassian Jira",          // label, localized (?lang=, else Accept-Language)
  "description": "…",
  "icon": null,                      // http(s) icon URL only; companion icons (icon.svg) are not served yet
  "capabilities": ["tools"],
  "actions": [{ "name": "searchTickets", "title": "Search issues", "description": "…", "sideEffect": "read" }],
  "effects": ["read", "write"],
  "connection": {
    "mode": "personal",              // personal | sso | service_account | shared_key | none
    "status": "connected",           // personal: connected | not_connected | needs_reconnect; else = mode
    "reason": null,                  // not_connected | expired | insufficient_scope
    "account": "daniel@example.com", // "connected as", null until known
    "scopes": ["read:jira-work"],
    "connectedAt": "…", "expiresAt": "…", "lastUsedAt": "…",
    "signInHost": "auth.atlassian.com",
    "connectable": true
  }
}
```

Rules:

- **Who sees what.** `installedIntegrationService.resolveAllEnabled()` (enabled, definition loaded and compatible, migration not blocking) filtered by `mayUseIntegration(instance, user)` — the groups' `permissions.integrations`, nothing else. Admins see only what their groups grant (no admin exception in the listing).
- **Actions** come from `toolLoader.loadTools()`, grouped by `_integration.instanceId`: what the models are offered (admin-disabled actions are not there). A per-user MCP server lists its catalog (may be empty until someone connected).
- **Status** comes from `IntegrationConnectionService.resolve()` and the index record. `revoked` (disconnected) resolves as `not_connected` now (changed in this PR; it was `expired`).
- **Account.** Read once from the vendor (`descriptor.accountLabel` → Jira `getUserInfo`, the storage services' `getUserInfo`) the first time a connected entry without a label is listed, then kept on the record (`externalAccount.label`). Not done in the callback, so connecting stays one token exchange. Failures are not retried for 10 minutes per worker (`accountLabelFailures`).
- **Mode heuristics** (`sharedModeOf`): `auth.mode` `service-account` or `oauth-client` → `service_account`; else a sensitive or `credential` install field (other than the OAuth client secret fields) named like an API key → `shared_key`, any other such field → `service_account`; nothing → `none`.

## The connect flow

- `POST /:id/connect` `{ returnUrl? }` → `{ url }`; `POST /:id/reconnect` `{ returnUrl?, scopes? }` → `{ url }` (scopes are unioned with the granted ones by `beginConnect`; same connection id, `createdAt` kept); `POST /:id/disconnect` → `{ success, removed, revoked }`.
- Checks in order: signed in (401), not delegated (403 for OAuth clients / agents), JSON body (415 — CSRF: a cross-site form cannot send `application/json` without a preflight), id shape (404), `returnUrl` same-origin http(s) (400 `INVALID_RETURN_URL`, not silently replaced), installed + enabled + `mayUseIntegration || isAdminUser` (404 `INTEGRATION_NOT_FOUND`), descriptor kind `oauth-user` (400 `NOT_CONNECTABLE`), then `beginConnect` which applies the descriptor's own `mayConnect` (MCP app bindings, storage grants). Flow errors: 404 for `integration_not_found`, 502 for discovery/registration, 409 for `public_url_mismatch`, else 400; body `{ error, code }`.
- Rate limit: 20 starts per **user** per minute (`connectLimiter`, keyed `user:<id>`; tests call `connectLimiter.resetKey`).
- MCP's public base: `connectionProviders` gives the MCP descriptor a `connectContext(req, user)`; `beginConnect` calls it when no `publicBase` is passed (the old `/api/mcp/oauth/authorize` passed it itself).
- The router is mounted at `/api/integrations` **before** the provider routers, so an installation id equal to a slug (`office365`) still reaches `/:id/connect`. `GET /:id` calls `next()` for ids that are not installations, so `/api/integrations/connections`, `/api-keys`, … keep working.
- One result shape after the callback: `integration_connected=<id>` / `integration_error=<code>&integration=<id>` (`resultParams`), codes = `OAUTH_FLOW_ERROR_CODES` unmapped.

## The card and the retry

- Server: every tool result `{ error: 'INTEGRATION_AUTH_REQUIRED', integration, reason, scopes? }` whose `integration` is the tool's own installation (`_integration.instanceId` or `_mcp.serverId`) becomes `tool/completed.authRequired = { integration, name, reason, action?, scopes? }` and is stored on the answer as `integrationAuthRequired` (was `mcpAuthRequired`). Adapter/transport failures never have this shape, so they never get a card.
- Client: `runToMessage` projects it to `message.integrationAuthRequired`; `ChatMessage` renders `ConnectCards`. The card loads `GET /api/integrations/:id` (cached 30 s per id) for name, permissions, sign-in host and live status; says "connected as …" instead of asking when the user is connected by now.
- Connect: `requestConnectUrl(id, { returnUrl: current page without result params, reconnect, scopes })`, then `window.location.assign(url)`.
- Return: `Layout`'s `useOAuthCallbackCleanup` calls `consumeConnectResult()` (reads once per path, strips the params, `popstate` for the router). `AppChat` calls `useConnectRetry({ chatId, messages, ready: !hydrating, busy: processing, send })` after `handleSubmit`; `claimRetry` sends the follow-up "I connected X. Please try again." exactly once when the answer with the card for that integration is the last message (sessionStorage key `ihub.integrationRetry.<chat>.<message>`).
- Why a follow-up message and not a server-side re-run of the stored call: the stored transcript holds text only, and the server-side resume of a stored call is what the tool-approval PR (#3136, `ChatService._storePendingApproval`) adds. Once both are merged, the retry could run the exact stored call through that path instead; the client trigger (`useConnectRetry`) stays.

## Not in this PR

- Settings → Integrations rebuilt on `GET /api/integrations` (#2922). Here it was switched minimally: one list call, the new connect/disconnect, the new result params; its layout is unchanged.
- Serving companion icons (`icon.svg`) of definitions: `icon` is only set for http(s) URLs.
- The MCP `authRequired` branch in `scheduler/tasks/runSeams.js` is dead now (no tool produces the marker); left in place to avoid a conflict with #3136, which rewrites that file.

## How to test

- `node --test server/tests/integrations/userIntegrationsRoutes.test.js` — listing access filter, modes, connect/reconnect/disconnect, return URL, CSRF/JSON, adapter result shape.
- `node server/tests/oauth-integration-factory.test.js`, `node server/tests/office365-callback-routes.test.js` — security parity through the real routes, 409 from the browse routes.
- `npx node@24 --experimental-vm-modules node_modules/jest/bin/jest.js tests/mcp/oauthUserRoutes.test.js` (from `server/`; Node 22 cannot load it, `require(esm)`).
- `npx jest --config tests/config/jest.config.js tests/unit/client/connect-card.test.jsx` — the card, the result reader, retry once and never for adapter failures.
- E2E: `tests/e2e/integration-connect.spec.js` (opt-in `CONNECT_E2E=1`, Chromium, a throwaway instance; stub model + MCP server + authorization server on port 4178).
