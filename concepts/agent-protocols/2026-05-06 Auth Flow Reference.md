# Auth Flow Reference — MCP and A2A on iHub Apps

**Date:** 2026-05-06
**Companion to:** [Agent Protocol Strategy](2026-05-06%20Agent%20Protocol%20Strategy.md)
**Status:** Draft

This document captures the concrete shapes — endpoints, payloads, sequence diagrams, scope catalog — for the auth flows described in the strategy doc. Engineers building Phase 1 and Phase 2 should be able to implement straight from this.

---

## 1. The four auth paths

| # | Path | Used by | iHub authMode | Token issued by |
|---|------|---------|---------------|------------------|
| A | OAuth 2.1 Authorization Code + PKCE | Claude Desktop, Cowork, Cursor, ChatGPT custom connectors, browser hosts | `oauth_authorization_code` | `/api/oauth/token` (grant_type=authorization_code) |
| B | OAuth 2.1 Authorization Code + PKCE with localhost loopback | Claude Code, other interactive CLIs that can launch a browser | `oauth_authorization_code` | `/api/oauth/token` (grant_type=authorization_code) |
| C | Personal Access Token (PAT) — long-lived JWT bound to a user | Headless scripts, scheduled jobs, A2A peers acting on behalf of a user | `oauth_static_api_key` (extended to support user binding) | `/api/admin/oauth/clients/:id/generate-token` (extended) or new user-facing endpoint |
| D | Client Credentials | Pure server-to-server, no user identity | `oauth_client_credentials` | `/api/oauth/token` (grant_type=client_credentials) — already shipped |

A and B are the same flow — only the redirect URI differs. C and D both produce long-lived bearer tokens; the difference is whether `sub` is a user ID or a client ID. The iHub `jwtAuth` middleware already branches on `authMode` and constructs `req.user` correctly for D; extending to C is a one-handler change.

---

## 2. Sequence diagrams

### 2.1 Path A — Claude Desktop adds iHub as a custom connector

```
┌──────────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐
│Claude Desktop│  │ Browser  │  │ iHub Apps    │  │ User/Browser│
│   (client)   │  │          │  │ (server)     │  │             │
└──────┬───────┘  └────┬─────┘  └──────┬───────┘  └──────┬──────┘
       │               │               │                  │
       │ User pastes https://ihub.example.com/mcp         │
       │               │               │                  │
       │ POST /mcp (no token)                             │
       ├──────────────────────────────►│                  │
       │                               │                  │
       │ 401 + WWW-Authenticate:                          │
       │   Bearer resource_metadata=                      │
       │   "https://ihub.example.com/.well-known/         │
       │    oauth-protected-resource"                     │
       │◄──────────────────────────────┤                  │
       │                               │                  │
       │ GET /.well-known/oauth-protected-resource         │
       ├──────────────────────────────►│                  │
       │                               │                  │
       │ 200 { resource, authorization_servers: [...],     │
       │       scopes_supported, ... }                    │
       │◄──────────────────────────────┤                  │
       │                               │                  │
       │ GET /.well-known/openid-configuration             │
       ├──────────────────────────────►│                  │
       │                               │                  │
       │ 200 { authorization_endpoint, token_endpoint,    │
       │       registration_endpoint, ... }               │
       │◄──────────────────────────────┤                  │
       │                               │                  │
       │ POST /api/oauth/register  (DCR — RFC 7591)       │
       │  { client_name: "Claude Desktop",                │
       │    redirect_uris: ["https://claude.ai/cb"],      │
       │    grant_types: ["authorization_code",           │
       │                   "refresh_token"],              │
       │    token_endpoint_auth_method: "none",           │
       │    application_type: "native" }                  │
       ├──────────────────────────────►│                  │
       │                               │                  │
       │ 201 { client_id: "claude_desktop_xyz", ... }      │
       │◄──────────────────────────────┤                  │
       │                               │                  │
       │ generate code_verifier (64 chars)                 │
       │ code_challenge = SHA256(code_verifier)            │
       │                               │                  │
       │ open browser to:              │                  │
       │   /api/oauth/authorize?       │                  │
       │     client_id=...&            │                  │
       │     response_type=code&       │                  │
       │     redirect_uri=...&         │                  │
       │     code_challenge=...&       │                  │
       │     code_challenge_method=S256│                  │
       │     scope=mcp+mcp:apps+       │                  │
       │       mcp:tools+offline_access│                  │
       │     state=...                 │                  │
       ├──────────────►│               │                  │
       │               │ GET /api/oauth/authorize?...     │
       │               ├──────────────►│                  │
       │               │               │                  │
       │               │ user not authenticated → redirect to login
       │               │◄──────────────┤                  │
       │               │ GET /login?returnUrl=...         │
       │               ├──────────────►│                  │
       │               │               │ render login form │
       │               │◄──────────────┤                  │
       │               │ POST /login (creds)              │
       │               ├──────────────►│                  │
       │               │               │ session set      │
       │               │ 302 returnUrl │                  │
       │               │◄──────────────┤                  │
       │               │ GET /api/oauth/authorize?...     │
       │               ├──────────────►│                  │
       │               │               │ render consent   │
       │               │ "Claude Desktop wants:           │
       │               │   - Invoke iHub apps             │
       │               │   - Use iHub tools               │
       │               │   - Stay connected"              │
       │               │◄──────────────┤                  │
       │               │ POST /api/oauth/authorize/decision approve │
       │               ├──────────────►│                  │
       │               │               │ generate code    │
       │               │ 302 redirect_uri?code=...&state=...
       │               │◄──────────────┤                  │
       │               │ GET https://claude.ai/cb?code=...│
       │ ◄─────────────┤               │                  │
       │                               │                  │
       │ POST /api/oauth/token                             │
       │  grant_type=authorization_code                    │
       │  code=...                                         │
       │  redirect_uri=...                                 │
       │  client_id=claude_desktop_xyz                     │
       │  code_verifier=...                                │
       ├──────────────────────────────►│                  │
       │                               │                  │
       │ 200 { access_token: "eyJ...", token_type: Bearer,│
       │       expires_in: 3600,                          │
       │       refresh_token: "rt_...",                    │
       │       scope: "mcp mcp:apps mcp:tools offline_access" }
       │◄──────────────────────────────┤                  │
       │                               │                  │
       │ POST /mcp                                         │
       │  Authorization: Bearer eyJ...                     │
       │  { jsonrpc: 2.0, method: tools/list, ... }        │
       ├──────────────────────────────►│                  │
       │                               │ jwtAuth → req.user │
       │                               │ filterByPermissions │
       │ 200 { result: { tools: [...] } }                  │
       │◄──────────────────────────────┤                  │
```

### 2.2 Path B — Claude Code uses localhost loopback

Identical to Path A except:

- `redirect_uris` registered with DCR include `http://127.0.0.1` with no specific port (per RFC 8252 / OAuth 2.1 native apps best-current-practice).
- Claude Code spins up an ephemeral local HTTP listener (e.g. `http://127.0.0.1:53291/cb`) for the duration of the flow.
- iHub's authorize endpoint accepts loopback redirect URIs (Task 4 — public clients with PKCE).
- The browser's redirect lands on the local listener; Claude Code captures the code and continues exactly like Path A.

The user-visible difference is "Claude Code opened my browser, I clicked Approve, the browser said 'You can close this window now'."

### 2.3 Path C — User generates a Personal Access Token in iHub UI

```
┌──────┐                       ┌─────────────┐
│ User │                       │ iHub UI     │
└──┬───┘                       └──────┬──────┘
   │ login (existing)                 │
   ├─────────────────────────────────►│
   │                                  │
   │ Settings → Personal Access Tokens│
   ├─────────────────────────────────►│
   │                                  │
   │ "Create token: name='claude-cli',│
   │  expires=90 days,                │
   │  scopes=[mcp:apps, mcp:tools]"   │
   ├─────────────────────────────────►│
   │                                  │ generate JWT:
   │                                  │  authMode=oauth_static_api_key
   │                                  │  sub=user_id
   │                                  │  scopes=[...]
   │                                  │  exp=now+90d
   │                                  │
   │ 200 { token: "ihub_pat_...",     │
   │       displayed_once: true }     │
   │◄─────────────────────────────────┤
   │                                  │
   │ paste into ~/.claude/config.toml │
   │                                  │
   ▼

later, Claude Code calls:
  POST /mcp
  Authorization: Bearer ihub_pat_...
  → existing jwtAuth recognizes oauth_static_api_key with user binding
  → req.user populated from sub
  → MCP route handler runs
```

Tokens are revocable from the same UI (existing `/api/oauth/revoke` works, and the UI shows last-used timestamps).

### 2.4 Path D — Pure machine identity

Already shipped per `2026-01-19 OAuth2 Client Credentials External API Authentication.md`. No changes for MCP — works as-is for purely machine-driven A2A peers (e.g. a backend service that calls iHub on no specific user's behalf). For A2A peers acting on behalf of a user, prefer Path C.

---

## 3. RFC 9728 Protected Resource Metadata

### 3.1 Endpoint

```
GET /.well-known/oauth-protected-resource
```

Public, no auth.

### 3.2 Response shape

```json
{
  "resource": "https://ihub.example.com/mcp",
  "authorization_servers": [
    "https://ihub.example.com"
  ],
  "jwks_uri": "https://ihub.example.com/.well-known/jwks.json",
  "scopes_supported": [
    "mcp",
    "mcp:apps",
    "mcp:tools",
    "mcp:workflows",
    "mcp:sources:read",
    "mcp:chat",
    "openid",
    "profile",
    "email",
    "offline_access"
  ],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://ihub.example.com/docs/mcp",
  "resource_signing_alg_values_supported": ["RS256"],
  "resource_name": "iHub Apps MCP Server",
  "resource_policy_uri": "https://ihub.example.com/legal/privacy"
}
```

### 3.3 The 401 challenge

When `/mcp` is hit without a token (or with an invalid token), respond:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="iHub MCP",
   resource_metadata="https://ihub.example.com/.well-known/oauth-protected-resource",
   error="invalid_token"
Content-Type: application/json

{"error": "invalid_token", "error_description": "Bearer token required"}
```

The `resource_metadata` parameter is what tells the MCP client where to look. Without it, the client falls back to `/.well-known/oauth-protected-resource` on the resource's host — same place — but the explicit pointer is the spec-correct path.

---

## 4. RFC 7591 Dynamic Client Registration

### 4.1 Endpoint

```
POST /api/oauth/register
Content-Type: application/json
```

Behavior governed by `platform.oauth.registrationPolicy` (`open` | `closed` | `with-iat` | `trusted-domains`). Default: `with-iat`.

### 4.2 Request — minimal (public client, native app)

```json
{
  "client_name": "Claude Desktop",
  "redirect_uris": [
    "https://claude.ai/oauth/callback",
    "https://claude.com/oauth/callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "native",
  "scope": "mcp mcp:apps mcp:tools mcp:sources:read offline_access"
}
```

If `with-iat` policy is active, include:

```
Authorization: Bearer iat_...
```

### 4.3 Response

```json
{
  "client_id": "claude_desktop_a1b2c3",
  "client_id_issued_at": 1746543600,
  "client_name": "Claude Desktop",
  "redirect_uris": ["https://claude.ai/oauth/callback", "https://claude.com/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "native",
  "scope": "mcp mcp:apps mcp:tools mcp:sources:read offline_access",
  "registration_access_token": "rat_...",
  "registration_client_uri": "https://ihub.example.com/api/oauth/register/claude_desktop_a1b2c3"
}
```

For confidential clients (`token_endpoint_auth_method: "client_secret_post"`), `client_secret` is also returned.

### 4.4 Validation rules (server-side)

Hard rules — registration fails if violated:

- `redirect_uris` must be HTTPS *or* `http://127.0.0.1[:port]` *or* `http://localhost[:port]`. No other plain-HTTP allowed.
- For public clients (`token_endpoint_auth_method: "none"`): `code_challenge` must be S256 in the authorization request (enforced at authorize time, not register time).
- `grant_types` must be a subset of `["authorization_code", "refresh_token", "client_credentials"]`. Implicit and password grants rejected.
- `response_types` must be `["code"]`.
- If `application_type: "web"`: redirect URIs must use HTTPS, no localhost.
- If `application_type: "native"`: localhost permitted.

Soft rules — accepted but logged:

- Unknown extension fields are ignored.
- Unknown grant types in the request are filtered out of the response.

### 4.5 Optional CIMD path (future)

If/when we add CIMD (SEP-991), the client registration step is replaced by the AS fetching the metadata document at the URL the client provides as its `client_id`:

```
POST /api/oauth/authorize?
  client_id=https://claude.ai/.well-known/oauth-client.json&
  ...
```

iHub fetches that URL with strict timeouts and SSRF protection, validates the JSON, caches it. No DCR endpoint needed for CIMD-aware clients. The two can coexist.

---

## 5. Scope catalog and consent screen

### 5.1 Catalog

| Scope | Required to | Consent screen string (en) | Consent screen string (de) |
|-------|-------------|----------------------------|----------------------------|
| `openid` | Receive an id_token | Verify your identity | Ihre Identität bestätigen |
| `profile` | Receive `name` claim | View your name | Ihren Namen sehen |
| `email` | Receive `email` claim | View your email address | Ihre E-Mail-Adresse sehen |
| `offline_access` | Receive a refresh token | Stay connected (refresh access automatically) | Verbunden bleiben (Zugriff automatisch erneuern) |
| `mcp` | Connect to the MCP endpoint at all | Connect to iHub via Model Context Protocol | Über MCP mit iHub verbinden |
| `mcp:apps` | List + invoke apps | Run iHub apps you can access | iHub-Apps ausführen, auf die Sie Zugriff haben |
| `mcp:tools` | List + invoke tools | Use iHub tools you can access | iHub-Werkzeuge nutzen, auf die Sie Zugriff haben |
| `mcp:workflows` | List + invoke workflows | Run iHub workflows you can access | iHub-Workflows ausführen |
| `mcp:sources:read` | Read source documents | Read knowledge sources you have access to | Wissensquellen lesen, auf die Sie Zugriff haben |
| `mcp:chat` | Free-form chat completions | Use iHub as a delegate model for chat | iHub als Delegat-Modell für Chat verwenden |

### 5.2 Consent screen layout

The consent screen (Task 5 of the OAuth Authz Code Flow) gets one extension: when any `mcp:*` scope is present, render a "Permissions" panel with the human-readable strings above. Bullet list, no marketing copy. Below it, the standard "Approve / Deny" buttons and a "Remember my decision" checkbox.

Trusted clients (`platform.oauth.trustedClients` or per-client `trusted: true`) skip consent. Anthropic's Claude Desktop and Claude Code are good candidates for the trusted list once we've vetted their behavior — but that's a customer-by-customer policy decision, not a default.

---

## 6. Token claims — what jwtAuth sees

### 6.1 OAuth Authorization Code (Path A/B) access token payload

```json
{
  "iss": "https://ihub.example.com",
  "sub": "user_abc123",
  "aud": "https://ihub.example.com/mcp",
  "exp": 1746547200,
  "iat": 1746543600,
  "auth_time": 1746543580,
  "client_id": "claude_desktop_a1b2c3",
  "authMode": "oauth_authorization_code",
  "scope": "mcp mcp:apps mcp:tools offline_access",
  "name": "Daniel Manzke",
  "email": "daniel.manzke@intrafind.com",
  "groups": ["users", "admins"]
}
```

`aud` set to the MCP endpoint URL gives us RFC 8707 audience-binding. `jwtAuth` rejects tokens whose `aud` doesn't match the resource being accessed — the same token cannot be replayed against `/api/admin/*`.

### 6.2 PAT (Path C) access token payload

```json
{
  "iss": "https://ihub.example.com",
  "sub": "user_abc123",
  "aud": "https://ihub.example.com",
  "exp": 1754319600,
  "iat": 1746543600,
  "authMode": "oauth_static_api_key",
  "boundClientId": "pat_user_abc123_claude_cli",
  "scope": "mcp mcp:apps mcp:tools",
  "name": "Daniel Manzke",
  "email": "daniel.manzke@intrafind.com",
  "groups": ["users", "admins"]
}
```

`boundClientId` is a synthetic client ID used to support per-PAT revocation, audit, and naming in the UI. The existing `oauth_static_api_key` handler in `jwtAuth.js` is extended to populate `req.user` from `sub` (user) instead of `client_id` (machine) when this claim is set.

### 6.3 What `enhanceUserWithPermissions` does

```js
// pseudocode — actual implementation in server/utils/authorization.js
function enhanceUserWithPermissions(user, oauthClient) {
  const groupPerms = resolveGroupInheritance(user.groups);   // already in production
  const clientPerms = oauthClient
    ? { allowedApps: oauthClient.allowedApps, allowedModels: oauthClient.allowedModels }
    : { allowedApps: ['*'], allowedModels: ['*'] };           // PAT defaults to user's full access

  user.permissions = {
    apps: intersect(groupPerms.apps, clientPerms.allowedApps),
    models: intersect(groupPerms.models, clientPerms.allowedModels),
    tools: groupPerms.tools,
    workflows: groupPerms.workflows,
    adminAccess: groupPerms.adminAccess && oauthClient?.adminAccess === true
  };
  return user;
}
```

Already implemented for `oauth_authorization_code` (Task 8). For PATs, we want the same intersection but anchored on the user's full permissions — admins issuing a PAT can optionally narrow the `allowedApps`/`allowedModels` further, and that narrowing applies to that PAT only.

---

## 7. MCP Streamable HTTP — message framing

The MCP spec defines a JSON-RPC 2.0 envelope over HTTP, with a single endpoint that handles both client → server requests and (optionally) server → client streams.

### 7.1 Client → server (most calls)

```
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer eyJ...

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Server responds with `Content-Type: application/json` for one-shot calls or `Content-Type: text/event-stream` for streaming responses (e.g. a long tool call with progress events).

### 7.2 Server → client streams (optional, for unsolicited messages)

```
GET /mcp
Accept: text/event-stream
Authorization: Bearer eyJ...
```

Server holds the connection open and pushes events. Useful if iHub wants to notify a client about completed background tasks. Phase 2 nice-to-have, not Phase 1.

### 7.3 Methods we implement

| Method | Phase | Maps to |
|--------|-------|---------|
| `initialize` | 1 | Capability handshake |
| `tools/list` | 1 | Walk apps + tools + workflows, filter by permissions |
| `tools/call` | 1 | Dispatch to chatService / toolExecutor / workflowEngine |
| `resources/list` | 1 | Filtered sources |
| `resources/read` | 1 | Source handler |
| `prompts/list` | 2 | Prompts library |
| `prompts/get` | 2 | Prompts library |
| `completion/complete` | 2 | Free-form chat (requires `mcp:chat` scope) |
| `logging/setLevel` | 2 | Already have structured logging — easy |
| `notifications/progress` (server-to-client) | 1 | For streaming app/workflow runs |

### 7.4 Tool call example

```json
// → request
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "app__legal_summarizer",
    "arguments": {
      "document": "...",
      "audience": "executive"
    }
  }
}

// ← progress notification (one or more, if streaming)
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "42",
    "progress": 0.4,
    "message": "Generating summary..."
  }
}

// ← final result
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "content": [
      { "type": "text", "text": "1. The contract terminates on..." }
    ],
    "isError": false
  }
}
```

---

## 8. Test plan (for Phase 1 and Phase 2)

### Phase 1 — PAT path

- [ ] Issue a PAT for a test user via the iHub UI.
- [ ] `claude mcp add ihub https://ihub.example.com/mcp --header "Authorization: Bearer <pat>"` — connection succeeds.
- [ ] `tools/list` returns only the apps/tools/workflows the test user can see.
- [ ] Invoke an app via `tools/call`, verify chat history is recorded under the user's account.
- [ ] Invoke a tool that requires `mcp:tools` scope when the PAT doesn't have it — receive 403 with `error: insufficient_scope`.
- [ ] Revoke the PAT via the UI; subsequent calls return 401.
- [ ] Test with `mcp-inspector` from the official MCP SDK to confirm protocol compliance.

### Phase 2 — OAuth path

- [ ] DCR with valid metadata succeeds; redirect URIs are persisted.
- [ ] DCR with invalid redirect URI (HTTP non-loopback) is rejected.
- [ ] DCR with `with-iat` policy and missing IAT is rejected.
- [ ] Authorization request without `code_challenge` for a public client is rejected.
- [ ] Consent screen shows MCP scopes in human language.
- [ ] Approving consent issues a code redeemable once.
- [ ] Token has `aud` set to the MCP endpoint and is rejected at `/api/admin/*`.
- [ ] Refresh token flow rotates correctly per Task 6.
- [ ] Using `mcp-remote` with the iHub MCP URL completes the full flow without manual steps.
- [ ] Claude Desktop adding `https://ihub.example.com/mcp` as a custom connector completes the full flow.

### Security edge cases

- [ ] Token from a different `aud` is rejected.
- [ ] Token issued before client secret rotation is rejected (existing — verify still holds for MCP path).
- [ ] DCR endpoint is rate-limited per IP.
- [ ] PRM document is served without auth and without leaking internal hostnames.
- [ ] CSRF on consent decision is enforced (existing).
- [ ] PKCE downgrade attack (`plain` instead of `S256`) is rejected.
- [ ] User's group changes propagate to next MCP call (no stale permissions in cache).

---

## 9. Implementation file map

The strategy doc estimates Phase 1 at ~1 week and Phase 2 at ~2 weeks. Concretely:

### Phase 1

```
server/
├── routes/
│   └── mcpRoutes.js                          NEW   — Streamable HTTP endpoint
├── services/
│   └── mcp/
│       ├── McpServer.js                      NEW   — JSON-RPC handler
│       ├── McpToolBuilder.js                 NEW   — walk configCache, emit tool descriptors
│       ├── McpToolDispatcher.js              NEW   — route to chatService/toolExecutor/workflowEngine
│       └── McpResourceProvider.js            NEW   — wrap sources for resources/list and resources/read
├── middleware/
│   └── jwtAuth.js                            MODIFY — add user-bound static API key support
├── utils/
│   └── oauthTokenService.js                  MODIFY — generateUserPersonalAccessToken()
└── server.js                                 MODIFY — register /mcp routes
client/
└── src/features/settings/
    └── PersonalAccessTokensPage.jsx          NEW   — user UI for PAT management
contents/config/
└── platform.json                             MIGRATE — add mcp section (V008?)
docs/
└── mcp.md                                    NEW   — user-facing setup guide
```

### Phase 2

```
server/
├── routes/
│   ├── wellKnown.js                          MODIFY — add /.well-known/oauth-protected-resource
│   ├── oauth.js                              MODIFY — add /api/oauth/register
│   └── oauthAuthorize.js                     MODIFY — render MCP scopes on consent screen
├── services/
│   └── oauth/
│       ├── DcrPolicy.js                      NEW   — open/closed/with-iat/trusted-domains
│       └── InitialAccessTokenStore.js        NEW   — IAT issuance and validation
├── views/
│   └── consent.js                            MODIFY — MCP scopes rendering
└── middleware/
    └── jwtAuth.js                            MODIFY — enforce aud against expected resource
client/
└── src/features/admin/pages/
    └── AdminOAuthClientEditPage.jsx          MODIFY — show registered DCR clients
contents/config/
├── platform.json                             MIGRATE — add registrationPolicy (V009?)
└── oauth-clients.json                        — DCR-registered clients land here
```

These maps are aspirational — exact split of files may shift during implementation. The key invariant: **Phase 1 introduces no new auth primitives; Phase 2 only adds spec-mandated MCP discovery surfaces on top of what V007 already builds.**

---

## 10. Things this document does NOT cover

- Detailed admin UI mockups for the PAT management page. (TBD when Phase 1 is scheduled.)
- Detailed admin UI for DCR-registered clients (probably mostly read-only; admins can revoke).
- Telemetry and metric naming for MCP traffic.
- iFinder MCP server's specific tool surface (covered separately in Phase 4 docs).
- A2A Agent Card schema and signing details (Phase 5).
- Multi-tenancy story for hosted SaaS deployments.

---

*-- End of Document --*
