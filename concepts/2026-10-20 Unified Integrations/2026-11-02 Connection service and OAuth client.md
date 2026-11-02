# 2026-11-02 · Connection service and OAuth client (#2914)

**Status:** Implemented (draft PR for intrafind/ihub-apps#2914) · Part of [Unified Integrations](README.md) · Builds on [04 · Architecture](04-architecture.md) §1.4, §2, §4, §7

Implementation notes for the one connection service and the one per-user OAuth client that Jira, Office 365, Google Drive, Nextcloud and per-user MCP servers now share. Written so that the next PR (intrafind/ihub-apps#2917: one Connect card, `GET /api/integrations`, connect/disconnect routes) can build on it without reading the whole diff.

## What exists now

```
server/services/integrations/auth/
  OAuthUserClient.js             the protocol: PKCE, authorization URL, code exchange, refresh,
                                 revocation (RFC 7009), RFC 9207 iss check, scope step-up
  strategies/fixedEndpoint.js    known endpoints + admin-registered client (Jira, the storage providers)
  strategies/mcpDiscovery.js     RFC 9728 → RFC 8414 discovery, pre-registered client → CIMD → DCR (moved from mcpOAuthService)
  IntegrationConnectionService.js  the index + connect / callback / refresh / disconnect / resolve
  connectionProviders.js         per installation: stack, kind, issuer, fingerprint, where the secret lives, strategy
  tokenSecrets.js                secretRef format, storage ids (hashed for ids the token store rejects)
  oauthFlowStore.js              pending sign-ins, server-side, single use (namespace integration-oauth-flows)
  connectionReindex.js           one-time re-index of contents/integrations/<service>/ at startup
  integrationAuthRequired.js     INTEGRATION_AUTH_REQUIRED (the one "connect first" code)
  ServiceAccountAuth.js          credentialRef resolution: bearer, basic, header, API key, client credentials
server/routes/integrations/oauthCallback.js   GET /api/integrations/oauth/callback + the alias handler
server/validators/integrationConnectionSchema.js  the Connection record (closes gap 1 of #2912)
```

The name `IntegrationConnectionService` (not `ConnectionService`) because `server/services/oauth/ConnectionService.js` already exists for something unrelated: the OAuth clients users connected to iHub as an authorization server.

## Decisions

1. **Moved, not rewritten.** The MCP discovery and client registration code moved into `strategies/mcpDiscovery.js` unchanged. Token requests are one implementation (`tokenRequest` in `OAuthUserClient.js`) for every stack; client authentication follows the RFC 8414 negotiation the MCP SDK uses (`selectClientAuthMethod`), the fixed strategies pin `client_secret_post` (what Jira, Microsoft, Google and Nextcloud always got). Raw token responses are kept (Nextcloud's `user_id`).
2. **Tokens do not move.** The index record's `secretRef` names the file `TokenStorageService` already had (`tokenstore:jira/<user>`, `tokenstore:office365/<user>__<installation>`, `tokenstore:mcp/<storageId>__<server>`). Each stack keeps its payload shape (camelCase for Jira/cloud, the MCP SDK shape with `binding` for MCP). New writes add a `binding` (`issuer`, `authorizationServerUrl`, `clientId`, `fingerprint`) to the camelCase payloads; old files without one keep working.
3. **State + PKCE verifier server-side.** The `state` is an opaque random handle; the flow (user, installation, verifier encrypted with the token store key, redirect URI, issuer, client, return URL) lives in the storage namespace `integration-oauth-flows`, is deleted by the callback that consumes it (only the request whose delete succeeds goes on: single use), and expires after 15 minutes. This replaced the signed tickets `utils/integrationOAuthState.js` and `services/mcp/mcpOAuthTicket.js` (both deleted). Without a storage provider the store is memory-only (single process).
4. **One callback, aliases kept.** Every path runs `IntegrationConnectionService.completeConnect`. An alias that names an installation (`/api/integrations/<provider>/<id>/callback`, `/api/mcp/oauth/callback/<id>`) or a stack (`/api/integrations/jira/callback`) refuses a flow started for another one. The redirect URI *sent* is unchanged (configured, else derived per alias), so no vendor app needs re-registration.
5. **iss check.** Enforced for MCP (discovered issuer, RFC 9207 as before). Not enforced for the fixed-endpoint providers: one authorization server per callback, and Microsoft names its issuer with the tenant GUID while installations may hold a domain.
6. **Refresh semantics unified to the cloud ones.** Delete tokens only on `invalid_grant` (or a missing refresh token, or a refresh token bound to another client). `invalid_client`, 5xx, 429, network errors keep the tokens and surface `integration_unavailable`. Jira used to delete on any refresh failure; it now behaves like the storage providers. Refresh is single-flight per connection and worker; the MCP client manager keeps its own single-flight (it owns the per-user connection pool) and reports to the index through `recordMcpEvent`.
7. **Fingerprint invalidation.** Each descriptor computes a fingerprint of the settings tokens are issued under (Jira: client id; Office 365: tenant + client; Google: client; Nextcloud: server URL + client; MCP: `registrationFingerprint`). A record whose fingerprint differs from the installation's is invalidated on use: tokens deleted, status `needs-reconnect`, `reason: expired`.
8. **Shared connections are service accounts only** (decided 2026-10-31). `resolve` returns the principal's own OAuth connection or the installation's `auth.mode: service-account` credential (`secretRef: credential:<ref>`); never another user's token. iFinder / iAssistant resolve as `kind: sso` with no secret (their per-request token exchange stays in `iFinderTokenProvider.js`).
9. **Re-index is not a config migration.** No config file changes shape; the index is runtime state in the pluggable storage. So no `V210` migration: a startup re-index with a marker in `runtime-imports` (`integration-connections`), run under the storage lock `runtime-import:integration-connections`, idempotent (never overwrites a record). Mapping per [04 · Architecture](04-architecture.md) §7; a legacy unscoped cloud file maps to the only installation of its service, or is skipped and logged when there are several (the user keeps using it through the token store's legacy fallback). The service also indexes a token file it meets without a record (`_ensureRecord`), so nothing depends on the re-index having run.
10. **One error code.** `INTEGRATION_AUTH_REQUIRED { integration, reason: not_connected | expired | insufficient_scope, message, connectUrl }` replaces `JIRA_AUTH_REQUIRED` and `MCP_AUTH_REQUIRED` (tool results, MCP App 409s) and `INTEGRATION_RECONNECT_REQUIRED` (scheduled-run reasons). MCP results keep the `authRequired` marker the chat's Connect card reads until #2917.
11. **Scope step-up (MCP).** `McpServerConnection` remembers a `403 insufficient_scope` challenge on the provider; `McpClientManager._stepUpError` turns it into `reason: insufficient_scope` with the union of granted and challenged scopes (`stepUpScopes`), and the Connect URL carries `scope=`. Once the user holds those scopes a further refusal is final (no loop).
12. **Audit.** `connection.create` / `connection.revoke` = resource `connection`, actions `create` / `revoke` (`revoke` added to the audit action enum).

## Public interface (for #2917)

```js
import {
  getIntegrationConnectionService,
  connectionIdFor,          // (integration, principal) => 'conn_<40 hex>'
  returnPathWith,           // (returnUrl, params) => same-origin path
  resultParams              // (descriptor | stack, { ok, code }) => result query params
} from 'server/services/integrations/auth/IntegrationConnectionService.js';

const connections = getIntegrationConnectionService();

// Index
await connections.getConnection(id);                                  // record | null
await connections.listConnections({ integration?, userId? });         // records
await connections.listUserConnections(installationId);                // admin view rows
await connections.putConnection(record);  await connections.updateConnection(id, patch);
await connections.forgetUser(userId);                                 // account deletion

// Lifecycle
await connections.beginConnect({ installationId, user, req, returnUrl?, scopes?, publicBase?, trustedBase? });
//   → { authorizationUrl: URL, returnUrl, descriptor }   throws OAuthFlowError (code)
await connections.reconnect(sameParams);                              // step-up: pass scopes
await connections.completeConnect({ req, alias?: { installationId?, stack?, resultKey? } });
//   → { ok, redirectTo, code? }   never throws
await connections.disconnect({ installationId, userId, req? });       // → { removed, revoked }

// Use
await connections.resolve(principal, installationId, { requiredScopes? });
//   → { ok: true, kind: 'oauth-user'|'service-account'|'sso', connection }
//   | { ok: false, error: IntegrationAuthRequiredError { integration, reason, connectUrl } }
await connections.getUserTokens({ installationId, userId, forceRefresh?, usedAccessToken? });
//   → stored payload (Jira / cloud); throws IntegrationAuthRequiredError | integration_unavailable
await connections.patchStoredTokens({ installationId, userId, patch });
connections.authRequiredResult(error, extra?);                        // structured tool result
await connections.invalidateInstallation(installationId, { status? });
await connections.recordMcpEvent({ installationId, userId, event: 'refreshed'|'dropped', payload?, reason? });
```

`describeInstallation(installationId)` (`connectionProviders.js`) answers what kind of connection an installation takes; `#2917`'s `GET /api/integrations` can list connection status per installation from `resolve` without touching tokens.

## What #2917 removes (not here)

The per-provider `/auth`, `/status`, `/disconnect` routes and the chat cards (`IntegrationConnectionCard`, `McpConnectCard`, `useIntegrationAuth`) still exist and delegate to the service. #2917 replaces them with `POST /api/integrations/:id/connect`, `…/disconnect`, `…/reconnect`, `GET /api/integrations` and one Connect card reading `INTEGRATION_AUTH_REQUIRED`. The per-stack result parameters (`jira_connected`, `office365_error`, `mcp_connected`, …) are produced by `resultParams` and can then collapse into one.

## How to test

- `node --test server/tests/integrations/oauthUserClient.test.js` — PKCE, exchange, refresh, revocation, iss, step-up.
- `node --test server/tests/integrations/integrationConnectionService.test.js` — resolve rules, repointed installation, single-flight refresh, terminal vs transient, audit, schema.
- `node --test server/tests/integrations/connectionReindex.test.js` — fixture with Jira, Office 365, a legacy unscoped Nextcloud file, an ambiguous legacy Google file, a hashed MCP file; idempotence, marker, lock.
- `node server/tests/oauth-integration-factory.test.js` — security parity for the four providers through the real routers.
- `npm run test:mcp` (the routes test needs Node 24 locally: `npx node@24 --experimental-vm-modules node_modules/jest/bin/jest.js tests/mcp/oauthUserRoutes.test.js` from `server/`).
