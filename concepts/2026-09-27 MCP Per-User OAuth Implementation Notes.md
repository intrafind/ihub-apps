# MCP per-user OAuth (`auth.type: "oauthUser"`) — Implementation Notes

Issue: intrafind/ihub-apps#2545. Status: implemented. User-facing documentation lives in
`docs/mcp-integration.md` → "Per-user sign-in (`oauthUser`)"; this note is the map for whoever
works on the code next.

## What it does

An outbound MCP server whose tools act as the person using them (Okta / Entra ID / Keycloak
"who am I" servers, ticket systems, calendars) needs every user to sign in at the server's own
authorization server. iHub runs that sign-in per user (authorization code + PKCE S256, RFC 8707
`resource`), identifies itself as a pre-registered client, through its own Client ID Metadata
Document (CIMD), or by dynamic client registration (DCR, RFC 7591), and keeps encrypted tokens
per (user, server).

## Where the code is

| Concern | File |
| --- | --- |
| Config schema (`oauthUser`, HTTP transports only) | `server/validators/mcpServerConfigSchema.js` |
| Token files per (user, server), storage-id hashing | `server/services/mcp/mcpUserTokens.js` |
| Signed `state` ticket (HMAC, 15 min, encrypted PKCE verifier) | `server/services/mcp/mcpOAuthTicket.js` |
| Per-server client registration + discovery state (namespace `mcp-oauth-clients`) | `server/services/mcp/mcpOAuthClientStore.js` |
| Shared tool catalog (namespace `mcp-tool-catalog`) | `server/services/mcp/mcpToolCatalogStore.js` |
| Public base URL, callback URL, CIMD document | `server/services/mcp/mcpOAuthPublicUrl.js` |
| SDK `OAuthClientProvider` used by the transports | `server/services/mcp/McpUserOAuthProvider.js` |
| Flow logic: discovery, client identity, start, exchange, revoke, visibility | `server/services/mcp/mcpOAuthService.js` |
| HTTP routes (`/api/mcp/oauth/*`) | `server/routes/mcpOAuth.js` |
| Per-user connection pool, catalog, auth-required result, admin tests | `server/services/mcp/McpClientManager.js` |
| `authProvider` + `catalogOnly` on a connection | `server/services/mcp/McpServerConnection.js` |
| Admin: connected-user count, list/disconnect users, test with own token | `server/routes/admin/mcpServers.js` |
| MCP App views on the caller's connection | `server/routes/mcpAppRoutes.js` (`resolveMcpApp`) |
| `tool/completed.authRequired` + stored `mcpAuthRequired` | `server/services/chat/chatSeams.js`, `ChatService.js`, `chatMaterializer.js`, `ChatRepository.js`, `server/services/loop/contracts/sseV2.js` |
| Client projection + Connect card | `client/src/features/chat/mcpApps/mcpConnectPrompts.js`, `mcpConnectUrl.js`, `McpConnectCard.jsx`, `runToMessage.js`, `runReducer.js`, `ChatMessage.jsx` |
| Settings → Integrations section | `client/src/features/settings/pages/IntegrationsPage.jsx` |
| Admin form + badge + Connect button | `client/src/features/admin/pages/AdminMcpServersPage.jsx` |

## How a request flows

1. **Connect** (`GET /api/mcp/oauth/authorize?serverId&returnUrl`): signed-in, non-anonymous user;
   the server must be an enabled `oauthUser` server the user may use (admins always; otherwise
   `getVisibleToolIds` + `toolVisibleInSet` — an app the user can open lists the server id or one
   of its tools). `mcpOAuthService.startUserAuthorization` discovers (RFC 9728 → RFC 8414, or the
   `authorizationServer` override), resolves the client (config → CIMD → DCR, persisted per
   server), calls the SDK's `startAuthorization` and puts the signed ticket in `state`. 302.
2. **Callback** (`GET /api/mcp/oauth/callback`): ticket signature + expiry, `req.user.id ===
   ticket.userId`, AS `error` → `oauth_failed`, then `exchangeAuthorization` with the verifier
   from the ticket; tokens written; the user's pooled connection is evicted and the catalog is
   refreshed in the background. 302 to `returnUrl?mcp_connected=<serverId>`.
3. **Tool call**: `McpClientManager.callTool` → `_callUserTool` — no user / no token →
   `{ error: 'MCP_AUTH_REQUIRED', message, authRequired }` (returned, not thrown). Otherwise the
   pooled connection `<serverId>::<userId>` with `McpUserOAuthProvider`; the SDK transport sends
   the bearer token and refreshes on 401. `UnauthorizedError` / `McpAuthRequiredError` during a
   call → tokens invalidated, same auth-required result.
4. **Chat**: `chatToolSeam.postTool` adds `authRequired` to `tool/completed` and collects one
   prompt per server; `ChatService` stores them on the answer as `mcpAuthRequired`. The client
   projects them to `message.mcpAuthRequired` and renders `McpConnectCard`, which reads
   `?mcp_connected` / `?mcp_error&mcp_server` once and removes them from the URL.

## Rules worth knowing before changing things

- **Never start a flow from the server side.** `redirectToAuthorization` throws; there is no user
  agent. Only the routes start sign-ins.
- **No cross-user fallback.** Every per-user call goes to the caller's own pooled connection; the
  shared `catalogOnly` connection never connects (its `connect`/`callToolRaw` throw).
- **One public base.** Redirect URI, CIMD URL and the document's `client_id` all come from
  `resolveMcpPublicBase` (`platform.mcpServer.publicUrl`, else `buildPublicBaseUrl(req)`). The
  registration remembers the base it was made for, so pooled connections (no request) use it.
- **Registrations and catalogs are fingerprinted.** A registration made for another URL/auth block
  (`registrationFingerprint`) or a catalog listed from another endpoint is ignored.
- **SSRF.** All SDK HTTP (discovery, DCR, token, revocation) goes through
  `buildMcpOAuthFetch(security)` → `safeFetch`. Keep passing `fetchFn`.
- **Never log tokens, codes or verifiers.** Logs carry `component: 'McpOAuth'`, `serverId`,
  `userId` only.

## Tests

- `server/tests/mcp/oauthUserProvider.test.js` — storage id, token files, provider, ticket, CIMD
  document vs `validateClientMetadata`, schema.
- `server/tests/mcp/oauthUserRoutes.test.js` — the routes with the SDK mocked.
- `server/tests/mcp/oauthUserManager.test.js` — pool, catalog, auth-required, admin tests, chat
  seam projection.
- `tests/unit/client/mcp-connect.test.jsx` — projection, stored messages, card.
- Run: `npm run test:mcp`, `npx jest --config tests/config/jest.config.js tests/unit/client/mcp-connect.test.jsx`.

A local reference server (SDK `mcpAuthRouter` + `requireBearerAuth`, auto-approving authorize,
5-second tokens) was used for an end-to-end check against a running 4-worker iHub: DCR, PKCE,
code exchange on another worker, shared catalog, refresh after expiry and RFC 7009 revocation all
worked. It is not part of the repository; the cookbook servers
(`mcp/authentication/{okta,entra,keycloak}-dcr`) follow the same pattern.

## Open follow-ups

- Catalog entries for per-user servers (`server/services/mcp/serverCatalog.js`) — eligible now,
  none added.
- An admin dialog listing connected users (the API exists: `GET/DELETE
  /api/admin/mcp/servers/:id/connections[/:userId]`; the page shows only the count).
- Token writes are plain file writes; two workers refreshing the same user's token at the same
  moment race (the provider keeps a token another worker refreshed instead of deleting it).
