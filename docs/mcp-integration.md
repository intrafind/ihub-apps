# MCP Integration

iHub speaks the [Model Context Protocol](https://modelcontextprotocol.io)
in **both directions**:

- **Outbound (client)** — iHub connects to external MCP servers and pulls
  their tools into the iHub tool catalog. Tools are surfaced with a
  per-server prefix and dispatched through the standard `runTool` path.
- **Inbound (gateway)** — iHub exposes its own tools, apps, and workflows
  over MCP so MCP-aware clients (Claude Desktop, Cursor, VS Code Copilot,
  custom agents) can use iHub as a tool source.

Both directions share the same `server/services/mcp/` module and rely on
the same SSRF, encryption, and OAuth primitives that the rest of iHub
already uses.

## Outbound — connecting iHub to an external MCP server

### Configuration

External MCP servers are configured in `contents/config/mcpServers.json`
or via the admin UI at **Admin → MCP servers**:

```jsonc
{
  "servers": [
    {
      "id": "github-mcp",
      "name": { "en": "GitHub MCP" },
      "enabled": true,
      "transport": {
        "type": "streamableHttp",
        "url": "https://mcp.github.com/sse"
      },
      "auth": {
        "type": "bearer",
        "token": "ENC[AES256_GCM,...]"
      },
      "toolPrefix": "github__",
      "allowedTools": ["*"],
      "timeoutMs": 30000,
      "reconnect": {
        "enabled": true,
        "maxRetries": 5,
        "initialDelayMs": 1000,
        "maxDelayMs": 30000,
        "growthFactor": 1.5
      }
    }
  ],
  "security": {
    "blockPrivateIps": true,
    "allowedHosts": []
  }
}
```

### Transports

| Transport | When to use |
|-----------|-------------|
| `streamableHttp` | **Recommended.** Canonical MCP HTTP transport per spec 2025-03-26+. Supports session resumption via `Mcp-Session-Id` + `Last-Event-ID`, so a reconnect resumes the stream rather than replaying in-flight requests. |
| `sse` | Legacy SSE transport for older MCP servers. Disable if you call non-idempotent tools — reconnect *replays* requests, which can cause duplicate side effects. |
| `stdio` | Local MCP server invoked as a child process. iHub does not invoke a shell — args go straight to `execve`. |
| `websocket` | Less common. Supported for parity. |

### Authentication

The `auth` block on a server entry supports:

- `{ "type": "none" }` — no auth header.
- `{ "type": "bearer", "token": "..." }` — `Authorization: Bearer <token>`.
- `{ "type": "basic", "username": "...", "password": "..." }`.
- `{ "type": "oauth", "tokenUrl": "...", "clientId": "...", "clientSecret": "..." }`
  — fetches an access token on connect (basic support; not all transports
  yet hook this into the SDK's OAuth provider).

Secrets are **encrypted at rest** with `TokenStorageService` (AES-256-GCM):

- Admin saves go through `encryptSecrets()` before disk write.
- Admin reads return `***REDACTED***` so secrets never leave the server.
- Unlike `platform.json` secrets (which `configCache` decrypts on load),
  `mcpServers.json` secrets stay encrypted in the cache. `McpServerConnection._decryptAuth()`
  decrypts them at connect time, so only the connection code sees plaintext.

Environment-variable placeholders (`${MY_TOKEN}`) work too and are left
unencrypted.

### Security

The shared `safeFetch` wrapper guards every outbound HTTP connection:

1. **DNS resolved once.** The hostname is resolved exactly once before
   we open the TCP connection.
2. **Private IPs blocked.** Loopback (127.0.0.0/8, ::1), RFC1918 (10/8,
   172.16/12, 192.168/16), link-local (169.254/16 — AWS metadata!), IPv6
   ULA (fc00::/7) and link-local are rejected.
3. **IP pinning.** The agent's `lookup` function is replaced with a
   constant that returns the already-validated IP, so re-resolution
   between validation and connect cannot swing the socket to a private
   address (defeats DNS rebinding).

To intentionally point at a private host, list its hostname in
`security.allowedHosts`.

### How tools surface

`McpClientManager.listAllTools()` aggregates `tools/list` across every
enabled, healthy server. Each tool is exposed with `id` = `${prefix}${name}`,
defaulting to `<serverId>__<toolName>` if no `toolPrefix` is set.

`runTool(toolId, params)` detects MCP tools by the `_mcp` marker on the
tool definition and forwards to `McpClientManager.callTool`, which:

- Applies the server's per-call `timeoutMs` via `AbortController`.
- Re-throws on MCP responses with `isError: true` so tool-level failures
  surface as iHub tool errors (not silent success-with-garbage-content).
- Lazy-connects on first use; reconnects with exponential backoff up to
  `reconnect.maxRetries` before marking the server unhealthy.

### Admin operations

- `GET /api/admin/mcp/servers` — list configured servers + per-server
  health (`connected`, `unhealthy`, `consecutiveFailures`, `toolCount`).
- `POST /api/admin/mcp/servers` — create.
- `PUT /api/admin/mcp/servers/:id` — update. Submitting `***REDACTED***`
  in a secret field preserves the existing encrypted value.
- `DELETE /api/admin/mcp/servers/:id`.
- `POST /api/admin/mcp/servers/:id/test` — drop the cached connection,
  reconnect, run `tools/list`, return the resulting status.

## Inbound — exposing iHub as an MCP server

### Enabling the gateway

The gateway needs **two** things switched on (both on Admin → MCP gateway):

1. `platform.mcpServer.enabled: true` — mounts the `/mcp` endpoints.
2. `platform.oauth.enabled.authz: true` — the OAuth authorization server.
   The gateway accepts **only** OAuth bearer tokens, so without this no
   client can ever authenticate. The admin page's *OAuth authorization
   server* toggle sets this together with `oauth.enabled.clients`,
   `oauth.authorizationCodeEnabled` and `oauth.refreshTokenEnabled`.

Optionally enable `platform.oauth.dcr.enabled: true` (*Dynamic client
registration* toggle) so MCP clients such as Claude can register their
OAuth client automatically instead of an admin creating one by hand.

> ⚠️ **Restart required:** the OAuth session middleware is mounted at
> startup. After enabling the OAuth authorization server for the first
> time, restart the server — otherwise the consent flow has no session
> store and authorization fails.

With the gateway enabled the endpoints go live at:

```
POST   /mcp           # Streamable HTTP (canonical)
GET    /mcp           # Streamable HTTP SSE upgrade
DELETE /mcp           # Session termination
GET    /mcp/sse       # Legacy SSE
POST   /mcp/messages  # Legacy SSE client→server
GET    /mcp/.well-known   # Public unauthenticated discovery
```

While disabled, `/mcp` is hard-404 — no probing leaks gateway existence.

### Authentication — OAuth-gated, never anonymous

Every request to `/mcp*` carries an OAuth Bearer token. There is no
anonymous fallback even when `anonymousAuth.enabled` is true elsewhere
on the platform. The middleware accepts only OAuth tokens — local /
LDAP / OIDC / NTLM JWTs are rejected.

Two grant flows produce valid tokens:

1. **Authorization Code + PKCE** (human users via MCP-aware clients).
   The user signs into iHub via whichever identity mode is configured,
   reviews the requested MCP scopes, consents, and the client receives an
   access token bound to that user. Subsequent MCP calls run as that
   user with full group permissions.

2. **Client Credentials** (server-to-server, future Agent-to-Agent).
   The operator registers an OAuth client at `/admin/oauth/clients` with
   `grant_types: ["client_credentials"]`, calls `POST /oauth/token` with
   those credentials, and receives a token for a service-account
   principal.

Both flows use the **same** authorization server and the **same**
permission machinery (`enhanceUserWithPermissions`).

#### How an MCP client bootstraps auth (discovery chain)

MCP clients discover everything from a single unauthenticated probe:

1. `POST /mcp` without a token → `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. The client fetches that **protected resource metadata** (RFC 9728) —
   it names the authorization server and the supported `mcp:*` scopes.
3. The client fetches `/.well-known/oauth-authorization-server`
   (RFC 8414; same document as `/.well-known/openid-configuration`) —
   it lists the authorize/token endpoints, PKCE support, and (when DCR
   is enabled) the `registration_endpoint`.
4. With DCR enabled the client `POST`s `/api/oauth/register` (RFC 7591)
   and receives a `client_id` — no manual client setup.
5. Authorization Code + PKCE runs as usual: the user signs in, consents
   to the `mcp:*` scopes, and the client exchanges the code for tokens.

#### Client ID Metadata Documents (CIMD)

A CIMD client's `client_id` **is an HTTPS URL** pointing at a JSON
document the client publishes. iHub fetches it, checks that the
document's own `client_id` equals the URL, and takes `client_name`,
`redirect_uris`, `grant_types` and `token_endpoint_auth_method` from it.
**Nothing is stored** — the URL is the identity, and it is the same for
every user.

This is what stops Claude registering a client per connection. Claude
picks its identity in a fixed order: pre-registered credentials → CIMD,
but *only* when the authorization-server metadata advertises both
`client_id_metadata_document_supported: true` and `none` in
`token_endpoint_auth_methods_supported` → dynamic registration. The MCP
specification (2025-11-25) makes CIMD a SHOULD and DCR a
backwards-compatibility MAY.

Claude Code's document, as a shape reference:

```json
{
  "client_id": "https://claude.ai/oauth/claude-code-client-metadata",
  "client_name": "Claude Code",
  "client_uri": "https://claude.ai",
  "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Turn it on under **Admin → MCP gateway → Client identification**, or in
`platform.oauth.cimd`:

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `false` | Advertise and accept URL client IDs |
| `allowedClientHosts` | `["claude.ai"]` | Trust policy; `*.example.com` for subdomains, `*` for any HTTPS client (not recommended) |
| `allowedGroups` | `[]` | Who may connect such a client (empty = everyone) |
| `allowedScopes` | `[]` | Grantable scopes (empty = the DCR default list) |
| `allowedApps` / `allowedModels` / `allowedPrompts` | `[]` | Optional narrowing on top of the user's own permissions |
| `tokenExpirationMinutes` | `oauth.defaultTokenExpirationMinutes` | Access-token lifetime for CIMD clients |
| `cacheMaxSeconds` | `86400` | Upper bound for document caching |
| `fetchTimeoutMs` | `5000` | Metadata fetch timeout |

Guarantees worth knowing:

- **CIMD clients are never trusted.** `consentRequired` is always true and
  `trusted` can never be set, so every user signs in and consents.
  `mcpServer.requireConsent` behaves exactly as before.
- **The host allowlist is checked before any network call**, so an
  unlisted `client_id` never causes an outbound request. The fetch itself
  is SSRF-guarded (DNS-pinned, private targets refused), follows no
  redirects, times out, caps the body at 8 KB, and requires JSON.
  Documents are cached per worker with a TTL clamped to
  `[300 s, cacheMaxSeconds]` and served stale for up to 24 h if a refresh
  fails; failures are never cached.
- **Disabling CIMD, or removing a host, is an immediate kill switch.**
  The gateway rebuilds the client from policy on every request, so tokens
  already issued to that client stop working at once — the same as
  suspending a stored client.
- **Loopback redirect URIs match port-agnostically** (RFC 8252 §7.3):
  `http://localhost/callback` in the document accepts
  `http://localhost:53421/callback` at authorize time, since a native app
  cannot reserve a port in advance. Same scheme, same loopback host, same
  path — nothing else is relaxed, and `localhost` and `127.0.0.1` are not
  interchangeable. The consent screen warns when *every* registered
  redirect URI is loopback.
- **Token exchange and refresh never depend on a live fetch.** The
  authorization code already binds `client_id`, `redirect_uri` and the
  PKCE verifier, so an outage at the client's host cannot strand a user
  mid-flow. Only the authorization request itself aborts when the
  document cannot be resolved.

#### Dynamic Client Registration (RFC 7591)

`POST /api/oauth/register` is available when
`platform.oauth.dcr.enabled: true`. It is unauthenticated (that is how
the MCP client ecosystem uses DCR), so the policy is deliberately narrow:

- Only `authorization_code` (+ `refresh_token`) grants can be registered —
  `client_credentials` service accounts still require an admin.
- Redirect URIs must be `https`, loopback `http`, or a private-use native
  app scheme; dangerous schemes are rejected.
- Grantable scopes are limited to identity scopes + `mcp:*`
  (override with `platform.oauth.dcr.allowedScopes`).
- Registered clients are never trusted and always require user consent.
- `platform.oauth.dcr.maxClients` (default 100) caps auto-registered
  clients; the shared `/api/oauth` rate limiter applies.
- Clients registering `token_endpoint_auth_method: "none"` become public
  PKCE clients; `client_secret_post/basic` yields a confidential client
  whose secret is returned once in the registration response.

Auto-registered clients appear in **Admin → OAuth clients** like any
other client and can be narrowed (`allowedApps`, `allowedGroups`, …),
suspended, or deleted there. They carry the *Dynamic* kind badge, and the
list hides them behind the kind filter by default so hand-made service
accounts stay readable.

If DCR stays disabled, create the client manually at
`/admin/oauth/clients` and configure its id/secret in the MCP client.

##### De-duplication

Claude — like most MCP clients — registers on **every fresh connection**
rather than once per deployment. Without de-duplication each user adds
another indistinguishable record and `maxClients` (default 100) becomes a
cap on *users*: the 101st person to connect is told
`Dynamic client registration limit reached`.

A registration with `token_endpoint_auth_method: "none"` is therefore
fingerprinted over its `redirect_uris`, `client_name`, `software_id`,
`grant_types` and `scope`. If an active dynamic client with the same
fingerprint exists, the endpoint answers `201` with that client's
`client_id` and its original `client_id_issued_at`, and only bumps
`metadata.registrationCount` / `metadata.lastRegisteredAt`. The
`client_id` of a public client is not a credential — it is useless to
anyone who does not also control the registered redirect URI and complete
PKCE — which is what makes sharing it between registrations of the same
software safe.

Confidential registrations mint a secret and are never merged; each gets
its own record. `maxClients` now counts distinct records, and a repeat
registration still succeeds once the cap is reached.

One caveat: Claude Code under DCR registers its ephemeral loopback port
(`http://localhost:3118/callback`) literally, so every session is a
distinct fingerprint. Only CIMD, whose document declares
`http://localhost/callback` and is matched port-agnostically, fixes that.

##### Attribution and clean-up of dynamic clients

Registration is unauthenticated, so a dynamic record has no owner. The
first user who completes the consent screen is stamped onto it
(`metadata.firstUserId` / `firstUserName` / `firstConsentAt`) purely so
the admin list can be read; a second user of the same registration does
not overwrite it. For "who is connected to what", use
**Admin → OAuth → Connections**, which is keyed on the grant rather than
on the client.

Nothing is pruned automatically — deleting a client invalidates its
users' consent memory and refresh tokens. **Admin → OAuth → Clients**
offers *Remove unused dynamic clients*, which deletes dynamic records
whose `lastUsed` (or, when never used, `createdAt`) is older than the
number of days you enter.

### Scopes

| Scope | Grants |
|-------|--------|
| `mcp:tools:read` | `tools/list` |
| `mcp:tools:call` | `tools/call` for iHub-native tools |
| `mcp:apps:invoke` | Invoke iHub apps as MCP tools |
| `mcp:workflows:run` | Run iHub workflows as MCP tools |
| `mcp:resources:read` | `resources/list` + `resources/read` |

Scopes are advertised in `/.well-known/openid-configuration` only when
the gateway is enabled. Per-OAuth-client allowlists narrow further: a
client can have the scope but still be restricted to a subset of apps /
models / workflows via the existing OAuth client `allowedApps` / etc.

### Resource exposure flags

`platform.mcpServer.expose`:

```jsonc
{
  "tools": true,      // iHub-native tools
  "apps": true,       // apps as MCP tools (input schema from app.variables)
  "workflows": true,  // workflows as MCP tools (input schema from start node)
  "resources": false  // sources/skills as MCP resources (opt-in)
}
```

A `false` flag blocks the corresponding adapter entirely, even for
callers with the matching scope.

### How iHub resources map to MCP

- **iHub tool** → MCP tool with `id` unchanged, `inputSchema` = the
  tool's existing JSON schema parameters.
- **iHub app** → MCP tool with id `app__<appId>` and `inputSchema`
  derived from the app's `variables` array. App invocation runs
  headlessly through `ChatService.invokeAppInternal()`
  (`server/services/mcp/appInvoker.js`): `RequestBuilder` prepares the
  request exactly as for the web UI (prompt templating, system prompt,
  variables, model selection), the turn runs on the shared
  [agent loop](agent-loop.md) with every model call through `LLMClient`
  (API-key resolution, throttling, retries), and the assistant text is
  returned as a single content block. Tools configured on the app
  execute server-side and structured output applies; interactive tools
  (`ask_user`) are refused with a `NO_USER_AVAILABLE` result because no
  user can answer over `tools/call`.
- **iHub workflow** → MCP tool with id `workflow__<workflowId>` and
  `inputSchema` derived from the start node's `inputVariables`. Dispatch
  goes through the existing `runTool('workflow_<id>', args)` path.
- **iHub sources** → MCP resources at `ihub://source/<sourceId>`.
  `resources/list` enumerates every enabled source the OAuth client
  has scope for; `resources/read` returns the content the source
  produces (filesystem text, URL fetch, iFinder document, page). Sources
  marked `exposeAs: "tool"` show up in the list with a sentinel body
  pointing the agent at the corresponding `source_*` tool — calling
  those over `tools/call` is how dynamic queries (search etc.) work.
- **iHub skills** → MCP resources at `ihub://skill/<skillName>`.
  Returns the skill's `SKILL.md` body. Skill resources (scripts,
  references, assets) are not yet enumerated individually; agents that
  need them can call the `read_skill_resource` tool.

### Who sees which tool

Scopes decide what a token may *do*; group permissions decide what it may
*see*. Both have to line up, and the tool list is default-deny — a tool the
caller has no grant for is never listed, even with `mcp:tools:read`.

A caller sees a tool when either of these holds:

- **An app they can access declares it.** Tool access is scoped through
  apps: if `app.tools` contains `iFinder_getContent` and the caller may
  use that app, the tool is visible. A disabled app grants nothing —
  `configCache.getApps()` filters `enabled: false` before permissions are
  computed.
- **Their group grants it directly** via `permissions.tools` in
  `groups.json`. This is the path for callers who need a tool over MCP or
  A2A without an app in the way.

```json
{
  "groups": {
    "mcp-power-users": {
      "permissions": {
        "apps": [],
        "tools": ["iFinder"]
      }
    }
  }
}
```

Granting the base id (`iFinder`) covers every function of that tool —
`iFinder_search`, `iFinder_getContent`, `iFinder_getMetadata`,
`iFinder_discover`. Granting `iFinder_search` covers only that one. `["*"]`
grants every tool on the platform.

`permissions.tools` is empty for every group after upgrade, so behaviour is
unchanged until an operator opts a group in. Grant it deliberately: a direct
tool grant lets an MCP client call integrations such as iFinder, Jira and
Entra **as the user**, with no app prompt or system prompt mediating the
call. It does not change which tools a chat app may use — that is still the
app's own `tools` list.

### Session model

By default the gateway is stateful: an `initialize` request receives a
session id, echoed by the client on subsequent requests as
`Mcp-Session-Id`. A session is bound to the authenticating user;
subsequent requests on the same session with a token belonging to a
*different* user are rejected with 403 to prevent resource leakage
between concurrent OAuth clients.

`DELETE /mcp` (with `Mcp-Session-Id` header) tears down a session
cleanly — only the user who opened the session may terminate it. SSE
keepalive + reconnect is handled by the SDK. Sessions the client
abandons without a `DELETE` are swept after an hour of inactivity.

Requests the gateway cannot map to a live session get the status the MCP
spec prescribes, so clients can recover on their own:

| Situation | Response |
| --- | --- |
| `Mcp-Session-Id` is unknown, expired, or was opened elsewhere | `404` `Session not found` — the client starts a new session with a fresh `initialize` |
| POST that is not `initialize` and carries no session id | `400 Bad Request: Mcp-Session-Id header is required` |
| `GET /mcp` outside a session | `405 Method Not Allowed` — there is no server-initiated SSE stream to attach to |

#### Stateless mode (clustered and load-balanced deployments)

Session state lives in the worker's process memory, so a session is only
usable on the worker that opened it.

> **Enable stateless mode on any deployment running more than one worker.**
> Connections are distributed across workers round-robin by default
> (`WORKERS` defaults to 4), so a client's `initialize` and its follow-up
> `tools/call` normally land on *different* workers. The second request
> then gets `404 Session not found` and the client cannot make progress.
> This applies to a single instance, not just multi-replica deployments —
> the same is true across replicas behind a load balancer.
>
> The alternative is `STICKY_SESSIONS=true`, which pins each client to one
> worker by hashing its TCP peer address. That only works when clients
> reach iHub directly: behind a reverse proxy or ingress every request
> carries the same peer address, so all traffic collapses onto a single
> worker. Prefer stateless mode.

Enable **stateless mode** via Admin → MCP gateway → Transports, or
`platform.mcpServer.transports.streamableHttp.stateless: true`:

```json
{
  "mcpServer": {
    "transports": {
      "streamableHttp": { "enabled": true, "stateless": true }
    }
  }
}
```

Every request then builds its own short-lived MCP server, no session id
is issued, and no affinity is required. Trade-off: `GET /mcp` answers
`405`, so the server cannot push notifications to the client. The
gateway does not use server-initiated messages today, and MCP clients
treat the `405` as "this server has no push channel".

### Discovery

Unauthenticated metadata endpoints help MCP-aware clients auto-configure:

```bash
curl https://ihub.example.com/.well-known/openid-configuration
# advertises mcp_endpoint + mcp:* scopes when gateway is enabled

curl https://ihub.example.com/.well-known/oauth-authorization-server
# RFC 8414 alias of the same document — MCP clients try this path first;
# includes registration_endpoint when DCR and the authorization server
# are both enabled

curl https://ihub.example.com/.well-known/oauth-protected-resource/mcp
# RFC 9728 — names the authorization server + scopes protecting /mcp
# (also referenced by the 401 WWW-Authenticate challenge on /mcp)

curl https://ihub.example.com/mcp/.well-known
# MCP-specific metadata: issuer, mcp_endpoint, transports, scopes_supported,
# oauth_authorization_server link
```

### Audit & usage attribution

Every call dispatched through the gateway flows through the existing
`actionTracker` event stream. The bearer-token claims (client id,
subject, scopes, auth mode) are attached to `req._mcpToken` for
downstream audit consumers.

## Migration from MCP_SERVER_URL

Earlier versions of iHub supported a single-server stub via the
`MCP_SERVER_URL` environment variable. That code path was removed; on
the first server start after upgrading, migration **V042** auto-promotes
a set `MCP_SERVER_URL` into the new `mcpServers.json` as a server with
`id: "legacy-mcp-server"` and `transport.type: "streamableHttp"`. After
the migration runs, the env var is ignored — manage the server via
`/admin/mcp/servers` instead.

## Connecting Claude (claude.ai / Claude Desktop)

Checklist on the iHub side (all on **Admin → MCP gateway**):

1. Enable the MCP gateway.
2. Enable the OAuth authorization server (restart once after first enable).
3. Under **Client identification**, enable **Client ID Metadata
   Documents** and leave `claude.ai` in the trusted hosts. Leave
   **Dynamic client registration** on as well if other MCP clients that
   do not support CIMD need to connect.
4. If iHub runs behind a proxy, set the **Public URL** so discovery
   metadata advertises the externally reachable address. iHub must be
   reachable over HTTPS for claude.ai.

Then in Claude: **Settings → Connectors → Add custom connector** and
paste `https://your-ihub/mcp`. Claude walks the discovery chain,
identifies itself with its metadata document on `claude.ai` — creating no
record in `oauth-clients.json` — and sends the user through iHub's
sign-in and consent screen, which shows the client name and the host.
Subsequent MCP calls run as that user with their normal group
permissions, and a reconnect within `consentMemoryDays` skips the consent
screen because the client identity no longer changes between connections.

Claude Code works the same way, with the loopback callback described
under [Client ID Metadata Documents](#client-id-metadata-documents-cimd).

### One pre-registered client per Claude organisation

A Claude Team or Enterprise organisation can pin a single OAuth client
instead of relying on registration at all. This is the right answer when
you want a stable, auditable client per organisation, and it needs no
server-side feature — only a client and a setting on Claude's side.

Create the client at `/admin/oauth/clients`:

- **Client type**: `public` (Claude keeps no secret; PKCE binds the flow)
- `grantTypes`: `["authorization_code", "refresh_token"]`
- `redirectUris`: `["https://claude.ai/api/mcp/auth_callback"]`
- `scopes`: the desired `mcp:*` scopes (plus `openid profile email`)
- optionally `allowedGroups` / `allowedApps` to narrow who and what

Then, in Claude, the organisation's admin enters that **client ID** under
**Add custom connector → Advanced settings**. Every user in the
organisation shares the one client and still goes through their own iHub
sign-in and consent, which is exactly what the consent store keys on. A
confidential client works too — enter the secret alongside the ID — but
public + PKCE is the recommended shape.

Limits: individual (Free/Pro) users have to paste the client ID
themselves, and each Claude organisation is one manual setup.

Other MCP clients (Cursor, VS Code, custom agents) follow the same
pattern — point them at `https://your-ihub/mcp`; clients that only take
a discovery URL can use
`https://your-ihub/.well-known/openid-configuration`.

Troubleshooting:

- `401 mcp_disabled` / hard 404 on `/mcp` → gateway not enabled.
- `400 OAuth is not enabled on this server` from
  `/api/oauth/authorize` or `/api/oauth/token` →
  `oauth.enabled.authz` is still false.
- Client fails right after registration → DCR disabled
  (`/api/oauth/register` is a hard 404 while off) and no manual client
  configured.
- Claude still calls `/api/oauth/register` with CIMD on → the discovery
  document is not advertising the flag. Check
  `/.well-known/oauth-authorization-server` for both
  `client_id_metadata_document_supported: true` and `none` in
  `token_endpoint_auth_methods_supported`; the flag only appears when
  `oauth.cimd.enabled` **and** `oauth.enabled.authz` are both true.
- "This client is not allowed on this server", naming a hostname → that
  host is not in `oauth.cimd.allowedClientHosts`. Add it there (the page
  prints the exact hostname to add) or leave it refused.
- `invalid_client` on a URL `client_id` right after enabling CIMD →
  the document failed validation. The `OAuthClientResolver` log line
  carries the reason: a `client_id` that does not match the URL it was
  served from, a `token_endpoint_auth_method` other than `none`, a
  redirect URI with a rejected scheme, a redirect, a non-JSON response, or
  a body over 8 KB. Nothing is cached, so fixing the document is enough.
- `401` on `/mcp` for every existing connection right after an OAuth
  change → CIMD was switched off, or a host was dropped from the
  allowlist. That is the intended kill switch; users reconnect once it is
  restored.
- `400 invalid_client_metadata: Dynamic client registration limit reached`
  → `oauth.dcr.maxClients` (default 100) is full. Repeat registrations of
  software already on file still succeed; this only blocks a genuinely new
  client. Raise the cap, or run *Remove unused dynamic clients* on
  **Admin → OAuth → Clients**.
- Consent screen loops or CSRF errors → server was not restarted after
  enabling OAuth (session middleware missing).
- `403 insufficient_scope` on `/mcp` → the token carries no `mcp:*`
  scope; check the scopes on the OAuth client and re-authorize.
- Sign-in and consent succeed but the client still reports it cannot
  connect, and `/mcp` answers `404 Session not found` on every request →
  requests are not landing on the process that holds the session. Enable
  stateless mode (see [Stateless mode](#stateless-mode-load-balanced-deployments))
  or configure session affinity on the load balancer.
- `400 Bad Request: Mcp-Session-Id header is required` → the client sent
  a non-`initialize` request without a session id; it never completed
  (or lost) the handshake.
- `405 Method Not Allowed` on `GET /mcp` → three different causes, all
  reported by clients the same way. The `McpGateway` log line for the
  rejection carries `hadSessionHeader`, `userAgent` and `accept`, which
  tells them apart:
  - **Benign.** A Streamable HTTP client probing for the optional
    server-initiated SSE stream. The MCP SDK reads `405` as "this server
    has no push channel" and carries on, so tools still list and run.
    Sign-in works, tools work, and a `405` shows up once per connection —
    nothing to fix.
  - **Wrong transport.** A client configured for the *legacy SSE*
    transport but pointed at `/mcp`. It needs a GET stream and cannot
    recover from the `405`. Point it at `/mcp/sse`, or reconfigure it as
    a Streamable HTTP (`http`) client on `/mcp`.
  - **Header stripped in transit.** A reverse proxy dropping the
    `Mcp-Session-Id` request header. The give-away is `405` with
    `hadSessionHeader: false` *after* a successful `initialize`, usually
    together with `400 … header is required` on the following POSTs.
    Allow `Mcp-Session-Id` and `MCP-Protocol-Version` through the proxy.

Every rejection the transport makes is logged under the `McpGateway`
component, so `npm run logs` shows the reason a client was turned away.

## Agent-to-Agent (A2A) endpoint — experimental

Set `platform.mcpServer.a2a.enabled: true` (Admin → MCP gateway → A2A
toggle) to mount `/a2a` alongside `/mcp`. It uses the **same OAuth
Bearer + `mcp:*` scope gate** as the MCP gateway — no separate
credential or scope.

A2A is JSON-RPC 2.0 over HTTP, task-oriented. iHub today implements
the well-defined subset of the v0.x draft:

| Method | Behaviour |
|--------|-----------|
| `agent/info` | Returns capability + auth metadata |
| `agent/skills` | Enumerates iHub tools / apps / workflows as A2A skills |
| `tasks/send` | Synchronous send-and-wait — dispatches to the underlying tool/app/workflow and returns the output in one response |

Stateful methods (`tasks/get`, `tasks/cancel`, streaming
`tasks/sendSubscribe`) return JSON-RPC `method not found`. The spec is
still moving and a persistent task store is out of scope for this
landing.

Discovery: `/mcp/.well-known` advertises `a2a_endpoint` when enabled.

## Out of scope (follow-up)

- **Streaming task subscriptions** (`tasks/sendSubscribe`,
  `tasks/get`, `tasks/cancel`) over A2A — needs a persistent task store.
- **In-app tool calling over MCP** — apps invoked via `tools/call`
  currently run the LLM call synchronously without iHub's tool
  executor; an MCP-side tool loop is a follow-up.
- **mTLS** for service-to-service — additive layer; optional.
