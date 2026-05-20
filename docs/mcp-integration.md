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

- Admin saves go through `encryptIfNeeded()` before disk write.
- Admin reads return `***REDACTED***` so secrets never leave the server.
- `configCache` decrypts when loading into memory, so connection code
  always sees plaintext.

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

Set `platform.mcpServer.enabled: true` (Admin → MCP gateway) and the
endpoint goes live at:

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
  derived from the app's `variables` array. App invocation runs in
  non-streaming mode: the LLM request fires through `RequestBuilder`
  (so prompt templating, system prompt, variables, model selection,
  API-key resolution, and token budgeting match the web UI exactly),
  the response is fetched synchronously via `throttledFetch`, and the
  assistant text is returned as a single content block. Tool calling
  inside an app, structured-output post-processing, and multi-modal
  generation still need the streaming pipeline — those are not yet
  surfaced over `/mcp`.
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

### Session model

The gateway is stateful: an `initialize` request receives a session id,
echoed by the client on subsequent requests as `Mcp-Session-Id`. A
session is bound to the authenticating user; subsequent requests on the
same session with a token belonging to a *different* user are rejected
with 403 to prevent resource leakage between concurrent OAuth clients.

`DELETE /mcp` (with `Mcp-Session-Id` header) tears down a session
cleanly. SSE keepalive + reconnect is handled by the SDK.

### Discovery

Unauthenticated metadata endpoints help MCP-aware clients auto-configure:

```bash
curl https://ihub.example.com/.well-known/openid-configuration
# advertises mcp_endpoint + mcp:* scopes when gateway is enabled

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

## Connecting Claude Desktop / Cursor

(Worked example follows once gateway is enabled and an OAuth client with
`grant_types: ["authorization_code"]` plus the appropriate `mcp:*` scopes
is registered.)

1. Register an OAuth client at `/admin/oauth/clients`:
   - `grant_types`: `["authorization_code", "refresh_token"]`
   - `redirectUris`: include the client's redirect URI
   - `scopes`: include the desired `mcp:*` scopes
2. In the client, add iHub as an MCP server with auto-discovery URL
   `https://your-ihub/.well-known/openid-configuration`.
3. The client redirects the user through iHub's authorization endpoint,
   the user signs in via whichever mode is configured, reviews the
   requested `mcp:*` scopes, and consents.
4. Subsequent MCP calls run as that user with full group permissions.

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
