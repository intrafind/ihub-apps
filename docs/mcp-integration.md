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
or via the admin UI at **Admin → MCP servers**. To start from a known
hosted server, use **Browse catalog** there (see [Server catalog](#server-catalog)).

```jsonc
{
  "servers": [
    {
      "id": "github",
      "name": { "en": "GitHub" },
      "enabled": true,
      "transport": {
        "type": "streamableHttp",
        "url": "https://api.githubcopilot.com/mcp/"
      },
      "auth": {
        "type": "bearer",
        "tokenRef": "github-pat"
      },
      "toolPrefix": "github__",
      "allowedTools": ["*"],
      "timeoutMs": 30000,
      "fileInputs": { "maxFileSizeMB": 20 },
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

`streamableHttp` and `sse` accept an optional `headers` map of non-secret
headers sent with every request — a scope or account id some vendors
expect next to the key:

```json
"transport": {
  "type": "streamableHttp",
  "url": "https://mcp.close.com/mcp",
  "headers": { "Close-Scope": "mcp.read" }
}
```

Values are stored in plaintext, so `Authorization` is refused here —
credentials go in the `auth` block. Header names the transport sets
itself are refused as well.

### Authentication

The `auth` block on a server entry supports:

- `{ "type": "none" }` — no auth header.
- `{ "type": "bearer", "tokenRef": "..." }` — `Authorization: Bearer <token>`.
- `{ "type": "header", "headerName": "X-Goog-Api-Key", "valueRef": "..." }` —
  the key in a vendor-specific header. An optional `valuePrefix` is put in
  front of the key (`"valuePrefix": "Token token="` sends
  `Token token=<key>`). Header names the transport sets itself (`Host`,
  `Content-Type`, `Accept`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, …)
  are refused.
- `{ "type": "basic", "username": "...", "passwordRef": "..." }`.
- `{ "type": "oauth", "tokenUrl": "...", "clientId": "...", "clientSecretRef": "..." }`
  — OAuth client credentials: iHub fetches a token and refreshes it before
  it expires.

Every `*Ref` field names a profile in the central credential store
(**Admin → Credentials**, `contents/config/credentials.json`). The secret
is encrypted at rest there and resolved only when the connection is
opened, so `mcpServers.json` never holds secret material.

There is no per-user sign-in yet: every user of a server shares the one
credential configured for it. Servers that only accept an interactive
OAuth login for each user cannot be connected today.

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
defaulting to `<serverId>__<toolName>` if `toolPrefix` is not set or empty.

`runTool(toolId, params)` detects MCP tools by the `_mcp` marker on the
tool definition and forwards to `McpClientManager.callTool`, which:

- Applies the server's per-call `timeoutMs` via `AbortController`.
- Re-throws on MCP responses with `isError: true` so tool-level failures
  surface as iHub tool errors (not silent success-with-garbage-content).
- Lazy-connects on first use; reconnects with exponential backoff up to
  `reconnect.maxRetries` before marking the server unhealthy.
- Sends only the tool's own arguments. The context iHub adds for its native
  tools (`user`, `chatId`, `appConfig`, workflow plumbing, the message's
  attachments) never leaves iHub; `language` is forwarded only when the
  tool's schema declares it.

#### File inputs

A tool takes a chat attachment when its input schema marks a parameter with
`format: "file"` — on the property itself, whatever its `type` (an object in
the Langdock convention, `z.object({...}).meta({ format: "file" })`), or on
the items of an array. iHub sends such a parameter as

```json
{ "fileName": "report.pdf", "mimeType": "application/pdf", "base64": "...", "size": 1234 }
```

with the base64 of the file's bytes (no data-URL prefix) and `size` in bytes.
An array parameter receives one such object per element.

The model never sees that shape. The tool it is offered has a string in the
parameter's place, its description asks for the file name of an attachment or
`attachment:<n>` (the n-th attachment of the message), and the tool's
description ends with "Attach the file to your message and pass its file name
as `<param>`." When the turn offers such a tool and the message carries
attachments, the user message also lists them as
`attachment:1 — report.pdf (application/pdf, 1.2 MB)`, so images — whose
names the model would otherwise never learn — can be referenced too. The
reference is resolved right before `tools/call`; file names match
case-insensitively.

- **Scope.** A reference resolves only against the attachments of the current
  message of the calling user. That is the only place the bytes exist: a
  stored chat keeps a descriptor of each upload (type, name, size), never its
  contents. A file uploaded in an earlier turn has to be attached again.
- **Size.** `fileInputs.maxFileSizeMB` (per server, default 20, 1–200) caps
  one file; the admin form has the field next to the timeout. The web client
  sends a document's bytes only up to the app's document upload limit
  (`upload.fileUpload.maxFileSizeMB`); a larger document travels as extracted
  text only.
- **Text fallback.** A document without its bytes is delivered as the base64
  of its extracted text when its media type is `text/*`, under that type.
  Anything else fails with `MCP_FILE_UNAVAILABLE` ("re-attach the file").
- **Errors.** An unknown reference fails with `MCP_FILE_NOT_FOUND` and lists
  the attachments available; a file over the limit with `MCP_FILE_TOO_LARGE`.
  The model gets the message as the tool's error and can correct the call.
- **Headless callers.** The inbound gateway (iHub as an MCP server) and the
  A2A endpoint carry no attachments, so a tool with file inputs fails there
  with `MCP_FILE_NOT_FOUND`.
- **Not supported.** Nested file inputs — a `format: "file"` property inside an
  object or below the first level of an array — are sent as the model wrote
  them.

The admin tool preview marks a tool with file inputs and names the
parameters. MCP App views keep the server's own schema as
`hostContext.toolInfo.tool.inputSchema`; a view-initiated `tools/call`
carries the view's arguments as they are, without file resolution.

### MCP Apps — interactive views

iHub is an [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)
host (extension `io.modelcontextprotocol/ui`, specification 2026-01-26). A
server that supports it declares an HTML view as a `ui://` resource and points
a tool at it with `_meta.ui.resourceUri`; when the model calls that tool, the
view renders inline in the chat answer, next to the text reply.

iHub ships two example apps to try it with, both **disabled**:
**draw.io Diagrams** (`drawio-diagrams`) and **Excalidraw Sketches**
(`excalidraw-sketches`). Their MCP servers, `drawio` and `excalidraw`, are
pre-configured and also disabled (migration `V132` adds them to existing
installations unless the ids are taken), so nothing contacts these public
endpoints until an admin opts in. To try one, enable the server under
**Admin → MCP servers**, then the app under **Admin → Apps**.

The server entries look like this:

```jsonc
{
  "servers": [
    {
      "id": "drawio",
      "name": { "en": "draw.io" },
      "transport": { "type": "streamableHttp", "url": "https://mcp.draw.io/mcp" }
    },
    {
      "id": "excalidraw",
      "name": { "en": "Excalidraw" },
      "transport": { "type": "streamableHttp", "url": "https://mcp.excalidraw.com/mcp" }
    }
  ]
}
```

Then give an app the server's tools, either all of them by server id or one
by one:

```jsonc
{ "id": "whiteboard", "tools": ["drawio", "excalidraw__create_view", "excalidraw__read_me"] }
```

Both servers can also be self-hosted (`jgraph/drawio-mcp` on Docker Hub, or
`excalidraw/excalidraw-mcp` from source); list an internal hostname in
`security.allowedHosts`.

#### Enabling and disabling

Per server, `apps.enabled` (admin UI: **Render interactive views (MCP
Apps)**, on by default; migration `V131` seeds it). When on, iHub advertises
the extension in `initialize`:

```json
{ "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } } }
```

When off the extension is not advertised, no view renders, and a
well-behaved server returns text only (draw.io, for example, returns an
"open in draw.io" link instead). Changing the toggle reconnects the server,
because capabilities are negotiated once per connection. The connection test
in the admin dialog marks each tool that renders a view.

#### Tool visibility

`_meta.ui.visibility` decides who may call a tool:

| Visibility | Offered to the model | Callable by the server's views |
|------------|----------------------|--------------------------------|
| omitted / `["model", "app"]` | yes | yes |
| `["model"]` | yes | no |
| `["app"]` | **never** | yes |

App-only tools (Excalidraw's `save_checkpoint`, for example) are hidden from
the model even when MCP Apps are disabled. `allowedTools` restricts what the
model is offered and which model-visible tools a view may call; app-only
tools exist only to serve the server's own views and stay callable by them.
A view can never call a tool of a different server.

#### Sandbox

A view is untrusted HTML. It renders in a double iframe:

1. The chat embeds `GET /api/mcp-apps/sandbox` with
   `sandbox="allow-scripts allow-forms"` — deliberately **without**
   `allow-same-origin`, so the page runs in an opaque origin: it cannot read
   iHub's DOM, cookies or storage, and iHub's session is never exposed. The
   page refuses to run anywhere else, and `frame-ancestors 'self'` stops other
   sites from embedding it.
2. The sandbox page writes the view into an inner frame, which inherits the
   page's `Content-Security-Policy` header. The header is built server-side
   from the domains the resource declares in `_meta.ui.csp` (sanitized: no
   keywords, wildcards-only or directive breaks). Nothing else is reachable:
   no `'self'`, `connect-src 'none'` and `frame-src 'none'` unless declared,
   `object-src 'none'` always.
3. Permissions a resource requests (`camera`, `microphone`, `geolocation`,
   `clipboardWrite`) become the iframes' `allow` attribute.

The specification's reference layout puts the sandbox on a second origin with
`allow-same-origin`. A self-hosted iHub has one origin, so iHub gets the
separation from the opaque origin instead. The one visible difference: views
cannot use `localStorage`/`sessionStorage` (the reference apps handle that).
Views are not rendered where the API is served from a different origin than
the page (an API base override, such as the browser extension).

**Troubleshooting — a view stays blank or a map never appears.** The sandbox
blocks every origin the resource did not declare, so a view that loads an
external script (the Google Maps or ArcGIS JavaScript API, a CDN-hosted
library) renders empty unless its `ui://` resource lists those origins in
`_meta.ui.csp`: `resourceDomains` for scripts, styles, images and fonts,
`connectDomains` for `fetch`/XHR/WebSocket targets, `frameDomains` for nested
iframes (draw.io's `embed.diagrams.net`, for example). The browser console of
the chat page shows the blocked request as a Content-Security-Policy
violation naming the missing origin. This is the server author's declaration
to fix; iHub does not add origins on its own, and hosts that apply no CSP will
happily render a view whose declaration is incomplete.

#### What a view can do

| Method | iHub behaviour |
|--------|----------------|
| `ui/initialize` | Host info, capabilities and context: theme, style variables, locale, time zone, `inline`/`fullscreen` display modes, container size, the tool definition |
| `ui/notifications/tool-input` / `tool-result` / `tool-cancelled` | The call's arguments, then its full `CallToolResult` (`structuredContent` and `_meta` included — the model only ever sees `content`), or a cancellation when the call failed without a result |
| `tools/call` | Proxied to the view's own server, subject to visibility |
| `resources/read` | Proxied to the view's own server |
| `ui/open-link` | Opens `http(s)` links in a new tab (`noopener`) |
| `ui/message` | Posts the text as the user's next chat message; refused while a turn is running |
| `ui/update-model-context` | The latest update per view is added to the next turn's prompt as an `<mcp_app_context>` block (text and structured content; never stored or shown) |
| `ui/request-display-mode` | `inline` or `fullscreen` (a full-window overlay with a close button); `pip` is not offered |
| `ui/notifications/size-changed` | Inline views grow with their content, up to 720 px |
| `ui/notifications/host-context-changed` | Sent on theme, language, width and display-mode changes |
| `ui/resource-teardown` | Sent when the view is removed |

Requests are rate-limited per view, and the server logs every call a view
makes (`component: McpApps`).

**Views without the `ui/initialize` handshake.** The specification delivers
the tool input and result only after the view has sent `ui/initialize` and
`ui/notifications/initialized`. Views written against the older
[mcp-ui](https://mcpui.dev) protocol never do; they post a plain
`{ "type": "appReady" }` message and read their data from the tool result's
`_meta["mcpui.dev/ui-initial-render-data"]`. iHub accepts that message as the
view's "ready" signal when no `ui/initialize` has arrived, and then delivers
the same `tool-input` and `tool-result` notifications (the full result, `_meta`
included) exactly once. A view that started `ui/initialize` is not initialized
early by an `appReady` it also happens to send. Each use of this fallback is
logged on the server (`component: McpApps`, `handshake: legacy`, with the
server and tool), so admins can see which servers still depend on it. Views
that only ship their HTML inside the tool result, without a `ui://` resource
declared on the tool, are not rendered.

#### Host endpoints

All but the sandbox page require the chat's authentication and name the app
and the tool whose call rendered the view. The caller must be able to open
the app, and the app must offer the tool.

- `GET /api/mcp-apps/sandbox?csp=…` — the sandbox page (static, no auth).
- `GET /api/mcp-apps/resource?appId=&toolId=` — the view's HTML and metadata.
  The server derives the `ui://` URI from the tool; the client never names it.
- `POST /api/mcp-apps/tools/call` — `{ appId, toolId, name, arguments }`.
- `POST /api/mcp-apps/resources/read` — `{ appId, toolId, uri }`.
- `POST /api/mcp-apps/handshake` — `{ appId, toolId, handshake: "legacy" }`;
  the chat reports a view that was initialized by the legacy `appReady`
  message, and the server logs it.

#### Persistence

The SSE stream carries the view on `tool/started` (`mcpApp: { serverId,
toolName, resourceUri }`) and its data on `tool/completed` (`mcpApp: { …,
callId, toolId, args, toolResult }`). The same descriptor is stored with the
assistant message (`mcpApps`), so a reopened chat redraws the view. Payloads
above 1 MB per view, or 2 MB per answer, are dropped with `payloadOmitted`;
the chat then says the view is too large to show again. Shared chats show
where a view was without running it.

#### Limitations

- Tool arguments are not streamed to the view while the model is still
  writing them (`ui/notifications/tool-input-partial` is not sent).
- Model-context updates reach the model with the next message only; image
  content in them is not forwarded.
- iHub does not call tools a view exposes to its host
  (`appCapabilities.tools`), and `resources/list` is not proxied.

### Admin operations

- `GET /api/admin/mcp/servers` — list configured servers + per-server
  health (`connected`, `unhealthy`, `consecutiveFailures`, `toolCount`).
- `POST /api/admin/mcp/servers` — create.
- `PUT /api/admin/mcp/servers/:id` — update. Submitting `***REDACTED***`
  in a secret field preserves the existing encrypted value.
- `DELETE /api/admin/mcp/servers/:id`.
- `POST /api/admin/mcp/servers/:id/test` — drop the cached connection,
  reconnect, run `tools/list`, return the resulting status.
- `GET /api/admin/mcp/catalog` — the built-in server catalog (see below),
  each entry flagged `installed` when a configured server already uses its
  id or URL.

### Server catalog

**Admin → MCP servers → Browse catalog** offers hosted MCP servers that
iHub can connect to with one shared credential. Picking one pre-fills the
create form — endpoint, auth type, header name, extra headers — and shows
where to create the key plus region-specific URLs and URL options. The
admin stores the key under **Admin → Credentials**, selects it, tests and
saves; nothing is added until then.

The catalog ships with iHub (`server/services/mcp/serverCatalog.js`), so it
updates with each release and needs no configuration. Servers that only
support an interactive OAuth login for each user are not listed: iHub has
no per-user outbound OAuth yet.

draw.io and Excalidraw are MCP App servers (see [MCP Apps](#mcp-apps--interactive-views)):
their tools return a view that renders in the chat. iHub already ships both
as disabled servers with the same ids, so on most installations the catalog
shows them as **Added** — enable them in the server list instead.

| Server | Category | Endpoint | Authentication |
|--------|----------|----------|----------------|
| Microsoft Learn | Documentation | `https://learn.microsoft.com/api/mcp` | none |
| Context7 | Documentation | `https://mcp.context7.com/mcp` | none |
| DeepWiki | Documentation | `https://mcp.deepwiki.com/mcp` | none |
| Astro Docs | Documentation | `https://mcp.docs.astro.build/mcp` | none |
| GitHub | Development & operations | `https://api.githubcopilot.com/mcp/` | Bearer token |
| Sentry | Development & operations | `https://mcp.sentry.dev/mcp` | `Authorization: Sentry-Bearer <key>` |
| Postman | Development & operations | `https://mcp.postman.com/minimal` | Bearer token |
| Cloudflare | Development & operations | `https://mcp.cloudflare.com/mcp` | Bearer token |
| Supabase | Development & operations | `https://mcp.supabase.com/mcp` | Bearer token |
| Neon | Development & operations | `https://mcp.neon.tech/mcp` | Bearer token |
| Render | Development & operations | `https://mcp.render.com/mcp` | Bearer token |
| Buildkite | Development & operations | `https://mcp.buildkite.com/direct` | Bearer token |
| Honeycomb | Development & operations | `https://mcp.honeycomb.io/mcp` | Bearer token |
| PagerDuty | Development & operations | `https://mcp.pagerduty.com/mcp` | `Authorization: Token token=<key>` |
| Braintrust | Development & operations | `https://api.braintrust.dev/mcp` | Bearer token |
| Atlassian (Jira & Confluence) | Productivity | `https://mcp.atlassian.com/v2/mcp` | Basic (email + API token) |
| Linear | Productivity | `https://mcp.linear.app/mcp` | Bearer token |
| monday.com | Productivity | `https://mcp.monday.com/mcp` | Bearer token |
| Coda | Productivity | `https://coda.io/apis/mcp` | Bearer token |
| draw.io | Design & diagrams | `https://mcp.draw.io/mcp` | none |
| Excalidraw | Design & diagrams | `https://mcp.excalidraw.com/mcp` | none |
| Sanity | Content & media | `https://mcp.sanity.io` | Bearer token |
| Cloudinary | Content & media | `https://asset-management.mcp.cloudinary.com/mcp` | `cloudinary-url: <key>` |
| Wix | Content & media | `https://mcp.wix.com/mcp` | `Authorization: <key>` + `wix-account-id` |
| Zapier | Automation & web | `https://mcp.zapier.com/api/v1/connect` | Bearer token |
| Apify | Automation & web | `https://mcp.apify.com` | Bearer token |
| Browser Use | Automation & web | `https://api.browser-use.com/v3/mcp` | `X-Browser-Use-API-Key: <key>` |
| superglue | Automation & web | `https://api.superglue.cloud/mcp` | Bearer token |
| Close | Sales & support | `https://mcp.close.com/mcp` | `Close-API-Key: <key>` + `Close-Scope` |
| Intercom | Sales & support | `https://mcp.intercom.com/mcp` | Bearer token |
| Fireflies.ai | Sales & support | `https://api.fireflies.ai/mcp` | Bearer token |
| Modjo | Sales & support | `https://api.mcp.modjo.ai/v1/mcp` | Bearer token |
| PostHog | Analytics | `https://mcp.posthog.com/mcp` | Bearer token |
| Hugging Face | Data & research | `https://huggingface.co/mcp` | none |
| Google Maps | Data & research | `https://mapstools.googleapis.com/mcp` | `X-Goog-Api-Key: <key>` |
| Statista | Data & research | `https://api.statista.ai/v1/mcp` | `x-api-key: <key>` |
| PRIMAMCP | Data & research | `https://mcp.planitprima.com/mcp` | Bearer token |
| Stripe | Finance & payments | `https://mcp.stripe.com` | Bearer token |
| Debitura | Finance & payments | `https://mcp.debitura.com/mcp` | Bearer token |

Endpoints and credential requirements are the vendors' and change over
time. **Test connection** in the create dialog shows at once whether a
key is accepted.

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
| `blockedClientHosts` | `[]` | Hosts refused even while allowed above, checked before any network call |
| `approvalMode` | `"approval"` | `approval` — each client waits for an administrator; `auto` — the host allowlist is the whole decision |
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

##### Governing individual clients

One host publishes several different clients. Claude web, Claude Desktop,
Claude Code and Cowork all live under `claude.ai` with *different*
`client_id` URLs, so a host is the wrong unit for "only this group may
use Claude Code". Governance therefore works per `client_id`.

The split that makes this work: **identity from the document, policy from
the record.** `client_name`, `redirect_uris`, `grant_types` and
`token_endpoint_auth_method` are still read from the document on every
authorization and never stored — the "nothing stored" property of CIMD is
about identity and is untouched. What *is* stored, in the existing
`contents/config/oauth-clients.json` and keyed by the exact document URL,
is the set of administrator decisions: whether the client is approved,
whether it is blocked, and the resource policy that applies to it. Such a
record carries `metadata.cimd: true` and never a secret, and
`consentRequired: true` / `trusted: false` are locked on it — approving a
client is **not** trusting it, and every user still signs in and consents.

Effective policy is layered **field by field**:

```
effective(field) = record[field]  when the record sets it
                 = platform.oauth.cimd[field]  otherwise
```

So narrowing one client's `allowedGroups` keeps the global `allowedApps`
list on that client, and leaves every other client on the same host alone.

Whether a client may connect at all is computed on **every request** from
five independently revocable conditions:

```
active = cimd.enabled
      && !hostBlocked(blockedClientHosts)
      && hostAllowed(allowedClientHosts)
      && record.active !== false
      && approvalSatisfied(record, approvalMode)
```

Under **Admin → OAuth → Clients**, metadata-document clients are real
rows — kind badge, document URL, connection count, first seen, last used —
with these actions:

| Action | Effect |
|--------|--------|
| **Approve** | `approvalState: 'approved'`, `active: true`. The next authorization goes through; consent is still required. |
| **Block** / **Unblock** | `active: false` / `true`. Blocking **also revokes every connection the client has**, because a block that leaves live refresh tokens behind is not a block. |
| **Revoke all connections** | Deletes every consent entry and every refresh token for the client, across all users, in one action. Users can reconnect unless the client is blocked. |
| **Edit policy** | Per-client `allowedGroups`, `allowedApps`, `allowedModels`, `allowedPrompts`, grantable `scopes` and `tokenExpirationMinutes`. Identity fields are read-only. |

**The approval gate.** With the shipped default (`approvalMode:
"approval"`), passing the host allowlist makes a client *eligible*, not
allowed. The first authorization by a `client_id` with no record is
refused with a page naming the client and telling the user to ask an
administrator, and the client appears at the top of the Clients page as
**Waiting for approval**. `approvalMode: "auto"` restores the previous
behaviour, where the host allowlist is the whole decision; the first
successful authorization then still writes a record (`approvalState:
'auto'`), so the client is a real, editable row rather than a synthetic
one.

Upgrading disconnects nobody: migration `V113` reads the consent store and
approves exactly the metadata-document clients that already have a
connection, stamping `approvedBy: 'migration'`. Clients nobody has
connected through are deliberately not created — those are the ones that
should have to be approved.

##### When a policy change takes effect

These conditions are enforced on the MCP gateway, on the authorization and
token endpoints, and on the REST API (`/api/*`) — a delegated token issued to a
metadata-document client is resolved through the same policy everywhere, so
there is no surface on which a blocked or unapproved client keeps working.

| Change | Takes effect |
|--------|--------------|
| Client blocked or deleted, CIMD disabled, host removed or blocked, approval withdrawn | Next `/mcp` or `/api/*` request — at most one access-token lifetime |
| `allowedGroups`, `allowedApps`, `allowedModels`, `allowedPrompts` narrowed | Next `/mcp` or `/api/*` request — at most one access-token lifetime |
| Grantable `scopes` narrowed | Next token refresh; the dropped scopes are not re-issued |
| An administrator revokes a connection | Next refresh; an access token already issued lives out its lifetime |
| A **local** user leaves a group | Next refresh — the group snapshot is re-read from the user store |
| An **OIDC / proxy** user leaves a group | Next interactive sign-in, or when an administrator revokes the connection |

That last row is inherent rather than an oversight: iHub does not hold the
identity provider's group graph and cannot poll it. The mitigations are an
administrator revoke and `oauth.refreshTokenExpirationDays` (default 30),
which bounds how long a stale snapshot can survive.

##### Audit

Governance actions are audited under the `oauthCimdClient` and
`oauthConnection` resources: a client discovered or refused while pending,
approved, blocked, unblocked, its policy updated, and connections revoked
in bulk (with the client and the count).

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
  Returns the skill's `SKILL.md` body. The files a skill bundles are
  enumerated as resources of their own at
  `ihub://skill/<skillName>/<relative/path>` — for example
  `ihub://skill/ifinder-search/references/query-cookbook.md` — so a
  "see references/…" link in a SKILL.md is followable. A read resolves
  only paths the skill loader itself enumerated, which is what keeps a
  `../` out of the filesystem. The internal `activate_skill` and
  `read_skill_resource` tools stay out of the gateway: they wrap
  filesystem access, and these resources replace them for external
  callers.

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
# oauth_authorization_server link; a2a_endpoint + a2a_agent_card when A2A is on

curl https://ihub.example.com/.well-known/agent-card.json
# A2A 0.3 Agent Card (when A2A is enabled); with credentials it lists the
# caller's skills
```

### Connections — who is connected to what

A **connection** is a grant: *this user allowed this client these scopes
on this date*. It is the unit that stays meaningful whatever the client
did to identify itself — one client record can serve every user, and a
CIMD client has no record at all.

Connections are derived from the existing consent and refresh-token
stores; nothing new is persisted.

- **Users** see their own under **Settings → Integrations → Connected
  apps**: client name and host, the scopes in plain language, when they
  connected, when it was last used, and **Disconnect**.
- **Admins** see all of them under **Admin → OAuth → Connections**, with
  filters by user and client, and the same revoke action — plus **Revoke
  all connections** for one client, which clears every consent entry and
  every refresh token that client holds across all users in one action.
  **Admin → OAuth → Clients** shows a connection count per client, and
  **Admin → Users → (user)** lists that person's connections.

Disconnecting deletes the consent record *and* revokes every refresh
token for the pair, so the client has to send the user through sign-in
and consent again. An access token it already holds is stateless and
keeps working until it expires — at most `tokenExpirationMinutes`, which
both UIs state.

"Last used" is recorded on refresh-token rotation (throttled to once a
minute): an access token is verified statelessly, so rotation is the only
moment a long-lived connection makes itself known.

### Audit & usage attribution

Every call dispatched through the gateway flows through the existing
`actionTracker` event stream. The bearer-token claims (client id,
subject, scopes, auth mode) are attached to `req._mcpToken` for
downstream audit consumers.

The authorization server records four events of its own through
`logAudit`, visible under **Admin → Audit log**:

| Resource | Action | When |
|----------|--------|------|
| `oauthConnection` | `create` | A user grants a client access on the consent screen |
| `oauthConnection` | `delete` | A user or an admin revokes a connection |
| `oauthClient` | `create` | A dynamic registration, whether new or de-duplicated |
| `oauthCimd` | `delete` (`failure`) | A client metadata document was refused — host not allowed, or the document is invalid |

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
   Trusting the host is not the last word: with **New clients** set to
   *Require approval* (the default), each Claude surface — web, Desktop,
   Claude Code, Cowork — publishes its own `client_id` and is approved
   separately. The first person to try one is told to ask an
   administrator, and the client turns up on **Admin → OAuth → Clients**
   waiting for you.
4. If iHub runs behind a proxy, set the **Public URL** so discovery
   metadata advertises the externally reachable address. iHub must be
   reachable over HTTPS for claude.ai.

Then in Claude: **Settings → Connectors → Add custom connector** and
paste `https://your-ihub/mcp`. Claude walks the discovery chain,
identifies itself with its metadata document on `claude.ai` — whose
name, redirect URIs and grant types are read from that document, never
stored — and sends the user through iHub's
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
- "… needs to be approved", naming the client → `approvalMode` is
  `approval` (the default) and nobody has approved this `client_id` yet.
  It is already listed as **Waiting for approval** on **Admin → OAuth →
  Clients**; approve it there and the same flow goes through. This is
  the expected experience the first time somebody adds the connector in a
  Claude surface the installation has not seen before.
- "… is blocked", naming the client → an administrator blocked it, or its
  host is in `oauth.cimd.blockedClientHosts`. Unblock it on the Clients
  page, or remove the host. Note that `blockedClientHosts` wins over
  `allowedClientHosts`, so leaving a host in both keeps it refused.
- `401` on `/mcp` for every existing connection right after an OAuth
  change → CIMD was switched off, a host was dropped from (or added to)
  the allowlist or block list, or the client was blocked. That is the
  intended kill switch; users reconnect once it is restored.
- `403 access_denied` on `/mcp` for one user while others are fine → that
  client's `allowedGroups` no longer admits them. This is checked on every
  request, so it bites within one access-token lifetime rather than at the
  next consent screen.
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

## Agent-to-Agent (A2A) — iHub as an A2A agent

Set `platform.mcpServer.a2a.enabled: true` (Admin → MCP gateway → **A2A**)
and iHub becomes an [A2A 0.3](https://a2a-protocol.org) agent: its apps and
workflows are the agent's **skills**, callable from any A2A client (the
`@a2a-js/sdk`, the A2A Inspector, Langdock's "Connect Remote Agent", Google
ADK, …). The endpoint uses the **same OAuth Bearer + `mcp:*` scope gate** as
the MCP gateway — no separate credential or scope.

### Agent Card

| URL | Contents |
|-----|----------|
| `/.well-known/agent-card.json` | The agent: `url` (`<base>/a2a`), `protocolVersion: "0.3.0"`, capabilities, security schemes. Public. |
| `/a2a/.well-known/agent-card.json` | The same card, gateway-scoped. |
| `/a2a/skills/<skillId>/.well-known/agent-card.json` | A card bound to one skill: its `url` is `<base>/a2a/skills/<skillId>` and every message sent there runs that skill. |

The public card lists **no skills**: which apps and workflows a caller may use
depends on its token and groups. Fetch the card with credentials (any of the
schemes below), or call `agent/getAuthenticatedExtendedCard`, and `skills`
holds the caller's apps (`app__<appId>`) and workflows (`workflow__<id>`) with
name, description, tags and the apps' starter prompts as `examples`.

`securitySchemes` on the card:

| Scheme | How to call |
|--------|-------------|
| `oauth2` | iHub's authorization server (`/.well-known/oauth-authorization-server`): authorization code + PKCE for users, client credentials for services; scopes `mcp:apps:invoke`, `mcp:workflows:run` |
| `bearer` | `Authorization: Bearer <token>` — an OAuth access token or a personal API key |
| `apiKey` | `X-API-Key: <personal API key>` — for clients built against an API-key scheme; iHub treats it as the bearer token |

### Methods

JSON-RPC 2.0 over `POST /a2a` (or `POST /a2a/skills/<skillId>`):

| Method | Behaviour |
|--------|-----------|
| `message/send` | Runs a skill and returns the finished **Task** (`status.state: completed`, the answer as a text `artifact` and as `status.message`). With `configuration.blocking: false` the submitted task is returned at once and the client polls `tasks/get`. |
| `message/stream` | The same over Server-Sent Events: the Task, a `status-update` (`working`), `artifact-update` events with the answer as it streams (`append: true`, `lastChunk: true` on the last), then a final `status-update`. Each SSE `data:` line is a JSON-RPC response with the request's `id`. |
| `tasks/get` | A task the caller created (`historyLength` trims the history). Works on every worker: tasks are stored on the storage provider (`a2a-tasks`) for 24 hours. |
| `tasks/cancel` | Aborts a running task (`canceled`); a finished task answers `-32002`. |
| `agent/getAuthenticatedExtendedCard` | The caller's Agent Card with skills. |

`tasks/resubscribe` and push notifications (`tasks/pushNotificationConfig/*`)
are not supported and answer `-32004` / `-32003`. Messages carry `text` parts
(and optional `data` parts, whose keys become app variables or workflow input
variables); `file` parts answer `-32005`.

**Which skill runs.** In order: the per-skill endpoint the message was sent
to; `metadata.skillId` on the params or the message; the skill the message's
`contextId` is bound to; the administrator's **A2A default skill**
(`platform.mcpServer.a2a.defaultSkill`, Admin → MCP gateway); and, when the
caller has exactly one skill, that one. Otherwise `message/send` answers
`-32602` naming the options. Generic clients that only know an Agent Card URL
therefore either get a per-skill card URL, or the administrator sets a default.

**Conversations.** A Task's `contextId` identifies the conversation; send the
next message with the same `contextId` (and no `taskId`) and the app receives
the earlier exchange as history. Contexts belong to the caller who created
them and are kept for seven days.

Permissions are those of the caller: the gateway's **Exposed resources**
toggles, the token's scopes and the caller's groups decide which apps and
workflows are skills, exactly as on `/mcp`. A client-credentials token acts as
its OAuth client, whose groups grant apps but no workflows, so workflow skills
appear for user tokens and personal API keys only. Every task is logged
(`component: A2A`) with its skill and caller.

### Deprecated draft methods

`agent/info`, `agent/skills` and `tasks/send` — the pre-0.3 draft iHub
implemented first — are still answered so existing callers keep working, but
are deprecated in favour of the Agent Card, `message/send` and `tasks/get`, and
will be removed in a later release.

Discovery: `/mcp/.well-known` advertises `a2a_endpoint` when enabled.

## Out of scope (follow-up)

- **A2A push notifications and `tasks/resubscribe`** — a client that loses a
  `message/stream` connection starts a new task or polls `tasks/get`.
- **In-app tool calling over MCP** — apps invoked via `tools/call`
  currently run the LLM call synchronously without iHub's tool
  executor; an MCP-side tool loop is a follow-up.
- **mTLS** for service-to-service — additive layer; optional.
