# Langdock Cookbook Gap Analysis — MCP, A2A and Agent API

## Goal

The [Langdock Cookbook](https://github.com/Langdock/langdock-cookbook) collects small, runnable
recipes that show what a Langdock workspace can connect to: MCP servers with per-user sign-in,
interactive MCP App views, file inputs for MCP tools, remote A2A agents, and an embeddable agent
widget. Each recipe is effectively a statement of what the host platform supports.

This document checks every recipe against iHub (`main` at `03114d0`, v5.5.21), records where
iHub is on par, and specifies what is missing. Each gap has its own GitHub issue (see
[Issues](#issues)).

## What the cookbook contains

| Area               | Recipe                                          | What the host must support                                                                                                                                                                              |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP authentication | `okta-dcr`, `entra-dcr`, `keycloak-dcr`         | The MCP server is an OAuth 2.0 authorization server that brokers login to an IdP. The **host** discovers its metadata, registers itself (DCR, RFC 7591), runs authorization code + PKCE **per user**. |
| MCP Apps & UI      | `google-maps`, `arcgis`, `drawio`, `servicenow` | `ui://` HTML views rendered in chat, view → server `tools/call`, `ui/open-link`, app-only tools (`visibility: ["app"]`). All but draw.io also need per-user OAuth + DCR.                               |
| MCP file uploads   | `file-uploads`                                  | A tool input marked `format: "file"` receives `{ fileName, mimeType, base64, size }` resolved by the host from the LLM's file reference.                                                              |
| A2A                | `langdock-a2a-demo`                             | The host is an **A2A client**: it fetches `/.well-known/agent-card.json`, calls the agent over A2A 0.3.0 (`@a2a-js/sdk`), and forwards an `X-API-Key` declared in the card's `securitySchemes`.        |
| Agent API          | `embed-widget`                                  | A streaming chat-completions endpoint for an agent, an attachment upload endpoint, and a server-side proxy that embeds the agent as an iframe or chat bubble on any site.                              |

## Where iHub is on par or ahead

| Capability                                   | iHub                                                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP client transports                        | Streamable HTTP, SSE, stdio, WebSocket (`server/services/mcp/McpServerConnection.js`), SSRF-safe `safeFetch` with DNS pinning, secrets in the central credential store.                                                                                        |
| MCP Apps host                                | Spec 2026-01-26 (`io.modelcontextprotocol/ui`): opaque-origin double-iframe sandbox, CSP built from `_meta.ui.csp`, `tools/call` + `resources/read` proxying, app-only tool visibility, fullscreen, model-context updates, persistence in chat history. |
| MCP App examples                             | draw.io and Excalidraw ship pre-configured (disabled), migration `V132`.                                                                                                                                                                                       |
| iHub as an MCP server (the DCR recipes, inverted) | OAuth authorization server, RFC 8414 / RFC 9728 discovery, DCR with de-duplication, Client ID Metadata Documents, per-client governance, Claude connector guide. Login is delegated to iHub's own OIDC — the same broker pattern the Okta/Entra/Keycloak recipes build by hand. |
| Model API                                    | OpenAI-compatible inference API (`/api/inference/v1`) with OAuth client credentials and personal API keys.                                                                                                                                                      |

## Gaps

### 1. Per-user OAuth for outbound MCP servers

**Today.** `docs/mcp-integration.md` → _Authentication_: "There is no per-user sign-in yet: every
user of a server shares the one credential configured for it. Servers that only accept an
interactive OAuth login for each user cannot be connected today." The `auth` block supports
`none`, `bearer`, `header`, `basic` and `oauth` (client credentials only). One
`McpServerConnection` exists per server, shared by all users.

**Impact.** Five of the eight cookbook MCP recipes (Okta, Entra, Keycloak, ServiceNow, ArcGIS)
cannot be connected. The [MCP Server Catalog concept](2026-09-24%20Preconfigured%20MCP%20Server%20Catalog.md)
reached the same conclusion from the other side: 27 of the 35 hosted servers it had to leave out
(Notion, Asana, HubSpot, Miro, Canva, ClickUp, Vercel, …) need a per-user login. This is the
single largest capability gap against Langdock.

**Proposal.**

- New auth type `{ "type": "oauthUser" }` on a server entry, with optional overrides
  (`scopes`, `clientId` + `clientSecretRef` for servers that do not support registration,
  `authorizationServer` when discovery is not available).
- Discovery per the MCP authorization spec: on `401` read `WWW-Authenticate` → RFC 9728
  protected-resource metadata → RFC 8414 authorization-server metadata.
- Client registration, in order of preference: pre-registered client from config → Client ID
  Metadata Document (iHub serves its own client metadata JSON at a stable URL; the inbound
  gateway already validates CIMD documents from clients such as Claude, so the format handling
  exists) → DCR (RFC 7591), cached per authorization server.
- Authorization code + PKCE (S256) with a `resource` indicator (RFC 8707). Redirect URI
  `/api/mcp/oauth/callback`, `state` bound to the user session.
- Tokens per `(userId, serverId)`, encrypted with the existing `TokenStorageService` (already
  used for Jira, Office 365 and cloud storage), refreshed before expiry, revoked on disconnect.
- Connection model: a per-user connection pool keyed `(serverId, userId)` with idle eviction, or
  one connection with a per-request `authProvider`. Stateless Streamable HTTP servers make the
  second option viable; stateful sessions need the first. Decide in implementation.
- UX: when a tool of an unconnected server is needed, the chat shows a **Connect <server>**
  card (the tool call returns a structured `auth_required` result instead of failing). Users see
  and revoke their connections under **Settings → Integrations**. Admins see which users are
  connected per server.
- Catalog: the 27 per-user-login servers become eligible for the catalog once this lands.

**Open questions.**

- Tool list per user: `tools/list` can differ per user. Is the tool catalog cached per user, or
  is the unauthenticated (or first user's) list used for app configuration?
- Headless contexts (workflows, agents, A2A/MCP gateway callers) have no browser for consent.
  Proposal: use the invoking user's stored token when present, otherwise fail with
  `auth_required` — never fall back to another user's token.
- Optional identity propagation for servers that trust iHub: forward `X-User-*` headers or do an
  Entra on-behalf-of token exchange. Out of scope for the first version, but the config shape
  should leave room for it.

### 2. MCP Apps: compatibility with views that skip the `ui/initialize` handshake

**Today.** iHub follows the spec strictly: `tool-input` and `tool-result` are delivered only after
the view sends `ui/notifications/initialized`
(`client/src/features/chat/mcpApps/McpAppView.jsx`, `flushToolData` and the
`ui/notifications/initialized` handler). `tools/call` and `ui/open-link` are not gated.

**Impact.** All four cookbook App views use a hand-written client that never sends
`ui/initialize` / `initialized`. They post a legacy mcp-ui `{ type: "appReady" }` message and read
their data from `params._meta["mcpui.dev/ui-initial-render-data"]` of the tool-result
notification — or from HTML embedded as a `resource` content item in the tool result. In iHub
these views load, but never receive data: an empty map, an empty ticket panel, a blank diagram.
Langdock's host is lenient here, so servers written against it will keep appearing.

**Proposal.**

- Treat a view as initialized when it posts `{ type: "appReady" }` (mcp-ui legacy) and has not
  started the `ui/initialize` handshake. Then flush tool input and result as usual. The full
  `CallToolResult` including `_meta` is already forwarded, so the cookbook views then render.
- Optionally, as a second step: when a tool has **no** `_meta.ui.resourceUri` but its result
  contains an embedded `resource` item with `text/html;profile=mcp-app` (or `text/html` with the
  `mcpui.dev` meta), render that HTML through the same sandbox. That covers pure mcp-ui servers.
- Log the fallback (`component: McpApps`, `handshake: legacy`) so admins can see which servers
  depend on it.

**Also check** for each cookbook view: Google Maps and ArcGIS load external scripts. They render
in iHub only if their resource declares the domains in `_meta.ui.csp`; iHub's sandbox (correctly)
blocks undeclared origins. Document this in `docs/mcp-integration.md` → _Sandbox_ as a
troubleshooting note.

### 3. File inputs for MCP tools

**Today.** A user's attachment reaches only `workflow_*` tools (`params._fileData` in
`server/services/chat/chatSeams.js`). MCP tools receive only the model's arguments
(`toMcpArguments` in `server/services/mcp/McpClientManager.js`), so a tool cannot be handed a
document or image from the conversation.

**Proposal.**

- When an MCP tool's input schema marks a property with `format: "file"` (object or string
  schema), iHub tells the model to pass a file reference (the attachment's file name or id as
  listed in the conversation), resolves that reference server-side, and sends
  `{ fileName, mimeType, base64, size }` — the same `FileData` shape Langdock uses, so servers
  work on both hosts.
- Resolution only against files of the current chat and the calling user; unknown references
  fail the call with a clear error; a size limit (default 20 MB, per server overridable).
- Arrays of files (`type: "array"`, `items.format: "file"`) are supported the same way.
- Admin tool preview marks file inputs.

**Open question.** Files produced by tools (images, generated documents) in the same turn —
include them as resolvable references? Proposed: yes, once iHub has a turn-level file registry;
not required for the first version.

### 4. A2A: upgrade the inbound endpoint to A2A 0.3 and add an outbound client

**Today.** `/a2a` (`server/services/mcp/a2aHandler.js`) implements an early draft:
`agent/info`, `agent/skills`, `tasks/send`, `protocolVersion: "0.1-draft"`. There is no
`/.well-known/agent-card.json`, no `message/send` / `message/stream`, no `tasks/get` /
`tasks/cancel`, and the only auth is the MCP gateway's OAuth bearer. There is **no A2A client** —
iHub cannot call a remote agent.

**Impact.** Neither direction works with A2A 0.3 implementations (`@a2a-js/sdk`, the A2A
Inspector, Langdock, Google ADK, …). Langdock's "Connect Remote Agent (A2A)" has no iHub
counterpart.

**Proposal — inbound (4a).**

- Serve an Agent Card at `/.well-known/agent-card.json` (and the gateway-scoped path): name,
  description, `protocolVersion: "0.3.0"`, `url`, `skills` (iHub apps/workflows the caller may
  use, as today in `agent/skills`), `capabilities.streaming`, `securitySchemes` (OAuth2 with the
  existing authorization server, plus personal API keys).
- Implement `message/send` (maps to today's synchronous app/workflow dispatch) and
  `message/stream` (SSE, driven by the existing streaming chat pipeline).
- `tasks/get` and `tasks/cancel` backed by a task store; workflow executions already have
  persistent state (`contents/data/workflow-state/`) and can back tasks directly.
- Keep `agent/info`, `agent/skills` and `tasks/send` for one release behind the existing toggle,
  or drop them — **decision needed** (breaking change; the endpoint is marked experimental).

**Proposal — outbound (4b).**

- New config `contents/config/a2aAgents.json` (Zod-validated, admin page next to MCP servers):
  card URL, auth (`none` | `apiKey` header via credential store | `bearer` | OAuth client
  credentials; per-user OAuth reuses gap 1), timeouts, allowed skills.
- Fetch the Agent Card through `safeFetch`; each skill becomes a tool
  (`a2a__<agentId>__<skillId>`) that apps and workflows can reference like MCP tools, with the
  same group permissions.
- Calls use `message/send`; when the card declares streaming, use `message/stream` and surface
  progress as tool status. Long-running tasks: poll `tasks/get` until a final state, bounded by
  the tool timeout.
- Multi-turn: keep the A2A `contextId` per chat so follow-up questions reach the same remote
  conversation.
- Admin "Test connection" shows the card and its skills.

### 5. App API and embeddable chat widget

**Today.** The OpenAI-compatible API reaches raw models only. An iHub app (system prompt,
sources, tools, variables) can be called from outside only via MCP `tools/call`, which is
non-streaming and runs without iHub's tool loop (see _Out of scope_ in
`docs/mcp-integration.md`). There is no public attachment upload endpoint. Embedding exists for
Nextcloud, Teams, Office and the browser extension, but not for arbitrary websites — tracked in
[#1510](https://github.com/intrafind/ihub-apps/issues/1510).

**Proposal — App API (5a).**

- `POST /api/v1/apps/{appId}/chat/completions`: OpenAI-shaped request and response (streaming and
  non-streaming), running the full app pipeline (prompt, variables, sources, tools, skills).
  Authenticated with personal API keys or OAuth client credentials; the caller's groups decide
  app access, exactly as in the UI.
- `POST /api/v1/attachments`: upload a file, get an id; reference it on a user message
  (`attachments: [id]`). Same limits and processing as chat uploads.
- Optional `chat_id` to continue a stored conversation.
- An `app:<appId>` model alias on `/api/inference/v1` could give OpenAI SDKs the same access with
  zero client changes — evaluate against the dedicated endpoint.

**Proposal — widget (5b).** Build #1510 on top of the App API: a `widget.js` loader plus a small
iframe panel, the API key or an anonymous session held server-side (never in the browser),
paste/drop attachments via the upload endpoint, admin-managed allowed origins
(`frame-ancestors`) per widget. See #1510 for the full scope.

## Roadmap

| Order | Gap                                  | Size   | Why this order                                                         |
| ----- | ------------------------------------ | ------ | ---------------------------------------------------------------------- |
| 1     | 2 — MCP Apps legacy handshake        | Small  | Client-only change; makes all four cookbook views work immediately.    |
| 2     | 3 — File inputs for MCP tools        | Medium | Self-contained; unlocks document- and image-processing MCP servers.    |
| 3     | 4a — A2A 0.3 inbound                 | Medium | Makes iHub reachable from the A2A ecosystem; reuses existing dispatch. |
| 4     | 1 — Per-user outbound MCP OAuth      | Large  | Largest customer-visible gap; needs design decisions above.            |
| 5     | 4b — A2A outbound client             | Medium | Reuses the MCP client structure; per-user auth reuses gap 1.           |
| 6     | 5a/5b — App API and widget           | Large  | Widget depends on the App API.                                         |

## Issues

- Tracking: [#2541](https://github.com/intrafind/ihub-apps/issues/2541)
- Gap 1 — Per-user OAuth for outbound MCP servers: [#2545](https://github.com/intrafind/ihub-apps/issues/2545)
- Gap 2 — MCP Apps legacy handshake: [#2542](https://github.com/intrafind/ihub-apps/issues/2542)
- Gap 3 — File inputs for MCP tools: [#2543](https://github.com/intrafind/ihub-apps/issues/2543)
- Gap 4a — A2A 0.3 inbound: [#2544](https://github.com/intrafind/ihub-apps/issues/2544)
- Gap 4b — A2A outbound client: [#2546](https://github.com/intrafind/ihub-apps/issues/2546)
- Gap 5a — App API: [#2547](https://github.com/intrafind/ihub-apps/issues/2547)
- Gap 5b — Website widget: [#1510](https://github.com/intrafind/ihub-apps/issues/1510) (existing)
