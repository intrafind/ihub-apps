# Agent Protocol Strategy for iHub Apps and iFinder

**Date:** 2026-05-06
**Author:** Daniel Manzke (with research synthesis)
**Status:** Draft for team review
**Supersedes:** `concepts/2025-07-22 Model Context Protocol Server.md`

---

## 1. Goals

Customers, partners, and individual employees keep asking "can I use my LLM (Claude Desktop, Claude Code, ChatGPT, Cursor, our own internal chatbot) to talk to iHub Apps / iFinder?" Today there is no single answer — we have an OpenAI-compatible chat API, an admin REST API, an OAuth client_credentials flow for service-to-service use, and ad-hoc integrations. None of these are recognized by the LLM hosts as a connector contract.

This document defines:

1. The protocol(s) iHub Apps and iFinder should expose so that any modern LLM host or agent framework can call them.
2. The authentication and authorization model so every call runs in the user's context — they only see what they are allowed to see.
3. The phased rollout from "works for one developer using Claude Code" to "available in the Anthropic Connector Directory."

The document also takes a position on the related but not identical questions of skills, plugins, and A2A.

## 2. Protocol landscape (May 2026)

### 2.1 Model Context Protocol (MCP) — the de-facto standard

MCP started life inside Anthropic in late 2024 as an open spec for letting an LLM client discover tools, resources, and prompts on a server, then call them. Eighteen months later it is the closest thing the industry has to a universal LLM-host integration contract. The protocol has moved out of Anthropic and is now governed under the Linux Foundation as a Series of LF Projects. Key facts as of May 2026:

- **Transport.** The current spec defines two transports: STDIO (for local, in-process servers) and **Streamable HTTP** (for remote servers). Streamable HTTP was introduced in spec revision `2025-03-26` and replaced the earlier HTTP+SSE transport. SSE is in deprecation; the timeline puts removal mid-2026. We should not implement SSE.
- **Auth.** MCP authorization is anchored on OAuth 2.1. A protected MCP server is treated as an OAuth 2.1 resource server; the MCP client is the OAuth 2.1 client. The spec mandates that protected servers publish OAuth 2.0 Protected Resource Metadata per RFC 9728, which tells clients which authorization servers issue tokens for it.
- **Client registration.** RFC 7591 Dynamic Client Registration is currently the way clients without a pre-existing relationship to the server obtain a `client_id`. The spec working group is actively discussing two complementary improvements — Client ID Metadata Documents (CIMD, SEP-991) and Software Statements (SEP-1032) — but DCR is what real clients use today.
- **Reach.** Native MCP support exists in Claude Desktop, Claude Code, Cowork, Cursor, Continue, Goose, OpenCode, Anthropic's API (`MCP connector` parameter), and ChatGPT (custom connectors). Most agentic frameworks (LangChain, LlamaIndex, CrewAI, Spring AI, Foundry) also speak it. This is the broadest single addressable surface available right now.

### 2.2 Agent2Agent (A2A)

Originally a Google project, A2A was donated to the Linux Foundation on June 23, 2025. By April 2026 the project reported 150+ supporting organizations and production deployments at Google Cloud, Microsoft, AWS, and a long tail of enterprises. A2A and MCP are deliberately complementary:

- **MCP** = how an LLM host talks to a tool or data source (one of which can be another agent).
- **A2A** = how an autonomous agent talks to another autonomous agent as a peer.

A2A's wire format is HTTP + JSON-RPC 2.0 + (optional) SSE. Agents publish an **Agent Card** — a JSON document describing their name, capabilities, supported skills, endpoint URL, and the authentication schemes they accept. The security field maps directly onto OpenAPI security scheme objects, so the supported types are `apiKey`, `http` (Bearer), `oauth2`, `openIdConnect`, and `mtls`. v1.0 added Signed Agent Cards: a cryptographic signature over the card lets a receiving agent verify the card was actually issued by the domain owner, blocking card-forgery attacks.

For iHub the practical implication is that A2A and MCP can sit on the same OAuth substrate. We can build MCP first, then layer A2A on top by publishing an Agent Card that points at the same `/mcp` endpoint and reuses the same scopes.

### 2.3 OpenAI plugins, GPTs, and ChatGPT connectors

OpenAI's original "ChatGPT plugins" (the OpenAPI-spec + `ai-plugin.json` model from 2023) is effectively deprecated. ChatGPT now consumes external integrations via custom connectors, which under the hood are MCP servers. So "ChatGPT plugin support" is achieved by the same MCP work — no separate spec to implement.

### 2.4 Skills and plugins (client-side)

Both terms come from Anthropic's product line and they are sometimes confused with server-side integrations. They are not.

- **Skills** are bundles of prompt-time guidance loaded into the LLM's context. A skill teaches Claude *how* to do something well (e.g. "how to write a great PowerPoint deck"). Skills do not bring new tools or data — they shape how the LLM uses what it already has. iHub itself does not get exposed via a skill.
- **Plugins** in Claude Code and Cowork are installable bundles of MCP servers, skills, and tool definitions. A plugin's value is convenience: instead of asking a user to manually configure an MCP endpoint, install a CLI tool, and import a skill, the plugin packages all three. iHub *can* publish a plugin once the MCP server is stable, but the plugin is wrapping the MCP server, not replacing it.

Therefore: **server-side, the work is MCP. Client-side, plugins and a Connector Directory listing are distribution channels we can add later.**

### 2.5 OpenAPI / REST and the existing OpenAI-compatible API

iHub already exposes an admin REST API and a `POST /v1/chat/completions` OpenAI-compatible gateway (concept doc 2025-07-12). These are useful for clients that send work *to* iHub (e.g. a Slack bot calling iHub for a chat completion). They do not solve the inverse problem we are tackling here — letting a user-driven LLM host *call* iHub's apps, tools, and data on the user's behalf. We keep them; MCP fills the gap.

## 3. iHub's existing foundation

The strategic insight that shapes the rest of this document is that **iHub already has most of the pieces an MCP server needs**. They just need to be wired together and exposed at the right paths.

### 3.1 OAuth infrastructure (mostly already built)

| MCP requirement | iHub status (as of May 2026) | Source |
|-----------------|------------------------------|--------|
| OAuth 2.1 Authorization Server | ✅ In progress (V007 migration, 12-task implementation in `concepts/oauth-authorization-code-flow/`) | Tasks 1–12 |
| Authorization endpoint | ✅ `/api/oauth/authorize` (Task 5) | `server/routes/oauthAuthorize.js` |
| Token endpoint, multiple grant types | ✅ `/api/oauth/token` supporting `client_credentials`, `authorization_code`, `refresh_token` | `server/routes/oauth.js` |
| Userinfo endpoint | ✅ `/api/oauth/userinfo` (Task 7) | Same |
| Revocation endpoint | ✅ `/api/oauth/revoke` (RFC 7009) | Same |
| JWKS | ✅ `/.well-known/jwks.json` | `server/routes/wellKnown.js` |
| OIDC discovery | ✅ `/.well-known/openid-configuration` | Same |
| PKCE S256 | ✅ Required for public clients | Task 2 |
| Refresh token rotation | ✅ Configurable, default on | Task 6 |
| Confidential + public client types | ✅ | Task 1, 4 |
| Trusted clients (skip consent) | ✅ | Task 5 |
| Group-based permission resolution with inheritance | ✅ Already in production (`server/utils/authorization.js`) | — |
| Per-client `allowedApps` / `allowedModels` permission intersection | ✅ Already in production for client_credentials, extended for authz code in Task 8 | `server/middleware/jwtAuth.js` |
| Static API keys (PAT-equivalent) | ✅ Admin can issue via `POST /api/admin/oauth/clients/:clientId/generate-token` | `concepts/2026-01-19 OAuth2 Client Credentials External API Authentication.md` |

What's missing for MCP:

| MCP requirement | Status | Effort |
|-----------------|--------|--------|
| RFC 9728 Protected Resource Metadata | ❌ | Small — single new well-known endpoint |
| RFC 7591 Dynamic Client Registration | ❌ | Medium — new `/api/oauth/register` endpoint, policy hooks |
| MCP Streamable HTTP transport endpoint | ❌ | Medium — new route + JSON-RPC framing + tool dispatch |
| `WWW-Authenticate: Bearer resource_metadata=...` on 401s | ❌ | Trivial — middleware tweak |

### 3.2 Tool surface (already exists, just needs adapting)

iHub's existing surfaces map cleanly onto MCP primitives:

| iHub concept | MCP concept | Notes |
|--------------|-------------|-------|
| App (`contents/apps/*.json`) | Tool (one per app) | Tool name `app__<id>`, parameters derived from the app's `variables` schema, system prompt + LLM call happens server-side |
| Tool (`contents/config/tools.json` + `server/tools/*.js`) | Tool (one per tool) | Existing `iFinder_search`, `braveSearch`, `jira`, etc. — already have parameter schemas |
| Workflow (`contents/workflows/*.json`) | Tool (one per workflow) | Already exposed as `workflowRunner` for chat; same registration pattern works for MCP |
| Source (`contents/config/sources.json`) | Resource (read-only) | Maps to MCP's resource model — let the LLM pull document content with a URI |
| Chat completion via apps | Tool (`chat__complete`) | Optional — stream a full conversation as a tool call. Useful when the host LLM wants iHub to act as a delegate model |
| Prompts library | Prompt (MCP prompts feature) | Optional — let the host browse iHub's prompt library |

Permission filtering reuses what's already there: `filterResourcesByPermissions(user, apps, ...)` is called in every existing route handler. The MCP server calls the same function with `user` populated from the OAuth access token. A user who can't see "App X" in the iHub UI also can't see `app__x` in the MCP tool list.

### 3.3 Existing concept docs to fold in

- `2025-07-22 Model Context Protocol Server.md` — sketches the idea of `apiTokens` and `exposeAsTool: true` on apps. The `exposeAsTool` flag is a useful addition; the rest of the auth story is superseded by what we have today.
- `2025-07-12 OpenAI Compatible API.md` — complementary, not in conflict. Covers the *inbound* chat use case.
- `2026-01-19 OAuth2 Client Credentials External API Authentication.md` — done. Provides the PAT/static-key fallback path.
- `oauth-authorization-code-flow/` — in progress. Hard dependency for OAuth-based MCP auth.

## 4. Recommended architecture

### 4.1 The shape

```
┌────────────────────────────────────────────────────────────────────┐
│                       LLM Host / Agent                             │
│  Claude Desktop · Claude Code · Cowork · Cursor · ChatGPT · ...    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  Streamable HTTP / JSON-RPC 2.0
                              │  Authorization: Bearer <token>
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  iHub Apps                                                          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  /mcp  (MCP Streamable HTTP endpoint)                         │  │
│  │   ├── tools/list           ← apps + tools + workflows         │  │
│  │   ├── tools/call           ← runs in user context             │  │
│  │   ├── resources/list       ← sources                          │  │
│  │   ├── resources/read                                          │  │
│  │   └── prompts/list/get     ← prompts library                  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              │ same auth chain as the rest of iHub  │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  jwtAuth → oauthAuth → enhanceUserWithPermissions             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  configCache · chatService · toolExecutor · workflowEngine          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  /.well-known/oauth-protected-resource   (RFC 9728)           │  │
│  │  /.well-known/openid-configuration        (already there)     │  │
│  │  /.well-known/jwks.json                   (already there)     │  │
│  │  /api/oauth/authorize · /token · /userinfo · /revoke          │  │
│  │  /api/oauth/register                      (RFC 7591 — new)    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

The MCP server is a single new route module (`server/routes/mcpRoutes.js`) plus a tool-list builder that walks `configCache` and emits MCP tool descriptors. The auth chain is unchanged — once a request carries a valid bearer token, `jwtAuth` populates `req.user` exactly like it does for any other route, and the rest of the request handler doesn't care that it came from MCP.

### 4.2 Endpoint inventory

| Path | Method | Purpose | Auth |
|------|--------|---------|------|
| `/mcp` | POST | MCP Streamable HTTP transport — JSON-RPC over HTTP, single endpoint per spec | Bearer required |
| `/mcp` | GET | (Optional) opens a server-to-client stream for unsolicited messages, per Streamable HTTP spec | Bearer required |
| `/.well-known/oauth-protected-resource` | GET | RFC 9728 metadata pointing clients at the AS | Public |
| `/.well-known/oauth-protected-resource/mcp` | GET | (Optional) per-resource metadata if we want to advertise different scopes per endpoint | Public |
| `/api/oauth/register` | POST | RFC 7591 Dynamic Client Registration | Public (with policy: see §5.4) |
| `/api/oauth/authorize` | GET | (existing, V007) | Public |
| `/api/oauth/token` | POST | (existing) | Public per OAuth |
| `/api/oauth/userinfo` | GET | (existing, V007) | Bearer |
| `/api/oauth/revoke` | POST | (existing, V007) | Public per RFC 7009 |
| `/.well-known/openid-configuration` | GET | (existing) advertises authz/token/userinfo/revoke/jwks | Public |
| `/.well-known/jwks.json` | GET | (existing) | Public |

### 4.3 Tool surface — how apps, tools, workflows become MCP tools

For a given authenticated user, the MCP server's `tools/list` response is built dynamically from `configCache` after applying the user's group-based permissions and the calling client's `allowedApps`/`allowedModels` intersection.

**App → MCP tool.** Each enabled app (`enabled: true`, user has access via groups, client allows it, app declares `exposeAsTool: true`) becomes a tool. Tool name `app__<appId>`. Description from `app.description[lang]`. Input schema constructed from `app.variables`:

```jsonc
{
  "name": "app__legal_summarizer",
  "description": "Summarize a legal document into 5 bullets, with citations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "document": { "type": "string", "description": "Document text to summarize" },
      "audience": { "type": "string", "enum": ["lawyer", "executive", "client"] }
    },
    "required": ["document"]
  }
}
```

Calling the tool runs the same code path as posting to `/api/apps/<id>/chat/<chatId>` with the variables as `inputs`, then returns the assistant message as the tool result. Streaming surfaces through MCP's progress notifications.

**Tool → MCP tool.** Existing tools in `server/tools/*.js` already have parameter schemas (Zod) and are already user-aware (the `iFinder` tool, for example, builds a JWT for the calling user). They surface as `tool__<id>`.

**Workflow → MCP tool.** Mirrors `workflowRunner.js` (Phase 2.5 of the agentic-workflows concept) — surfaces as `workflow__<id>`. Long-running workflows stream progress via MCP notifications and return the final result.

**Source → MCP resource.** Each readable source becomes a resource. URI scheme `ihub://source/<sourceId>/<docId>`. `resources/read` proxies to the existing source handler.

**Prompts library → MCP prompts.** Optional but cheap — exposes the existing prompts collection so a host can present them as slash commands or quick actions.

### 4.4 What we explicitly do NOT expose

- **Admin operations.** No app/model/group editing via MCP. Admins use the iHub admin UI; LLMs don't get to edit configuration.
- **Other users' data.** Every call carries the user's identity from the access token. Users see what they would see in the UI — nothing more.
- **Unscoped chat.** A user with `mcp:apps` scope but not `mcp:chat` cannot ask the MCP server for a generic chat completion. They can only invoke apps and tools they're entitled to.

### 4.5 Where iFinder fits

iFinder is a separate product (enterprise search), but the MCP architecture is identical. Two reasonable deployment shapes:

1. **iFinder runs its own MCP server, federates auth with iHub's OAuth AS.** iFinder publishes `/.well-known/oauth-protected-resource` pointing at iHub's authorization server. Users get one consent screen, one identity. Cleanest UX.
2. **iFinder runs its own MCP server with its own AS.** Independent product, independent auth. More complexity for users with both.

Either way, iFinder's tool surface is its existing search/retrieval API:

- `ifinder__search(query, profile?)` → list of document hits
- `ifinder__get_document(docId)` → full document content
- `ifinder__get_metadata(docId)` → title, author, dates, tags
- `ifinder__list_profiles()` → search profiles the user has access to

Note that iHub already wraps these via `server/tools/iFinder.js`. With the iFinder MCP server in place, the iHub MCP server can either:

- Continue to proxy iFinder via its own `iFinder_*` tools (current behavior — works for users who only have an iHub identity), or
- Stop proxying and let MCP clients connect directly to iFinder's MCP server (cleaner, but requires the host to support multiple connectors at once — Claude Desktop and most others do).

Recommendation: keep both. iHub's tool wrapping stays for users in iHub-only environments; iFinder's MCP server gives sophisticated hosts a direct path.

### 4.6 Plugins, skills, and the Connector Directory

Once the MCP server is stable:

- **Anthropic Connectors Directory** — Anthropic operates an official directory of curated connectors (Microsoft 365, Google Drive, GitHub, Slack, Notion, Atlassian, Salesforce, etc.). Submission is manual and reviewed; the listing gives users a one-click install in claude.ai, Claude Desktop, and the mobile apps. The Microsoft 365 connector is a useful template — it's an Anthropic-hosted MCP server that authenticates against the user's Microsoft Entra tenant via OAuth On-Behalf-Of with PKCE, and consents to specific Graph API scopes. iHub follows the same pattern: our MCP server is *hosted by us*, and Anthropic's listing simply describes how to connect to it.
- **Claude Code plugin** — for terminal users, package a plugin that bundles the MCP server config + a "How to use iHub" skill + sensible defaults. Optional convenience layer.
- **Cowork plugin** — same idea for Cowork users (the desktop tool you're using right now). Bundle MCP config + skills.

These are **distribution**, not **architecture**. They wrap the same MCP server — building them adds discoverability but does not change the auth model or the tool surface.

## 5. Authentication and authorization

This is the most important section because it's what determines whether the design is enterprise-credible.

### 5.1 The flow Claude Desktop will actually use

When a user adds iHub as a custom connector in Claude Desktop, what happens:

1. User pastes `https://ihub.example.com/mcp` into Claude Desktop's "add custom connector" dialog.
2. Claude Desktop sends `POST /mcp` with no token.
3. iHub responds `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="https://ihub.example.com/.well-known/oauth-protected-resource"`.
4. Claude Desktop fetches the metadata document, learns the AS is `https://ihub.example.com`.
5. Claude Desktop fetches `/.well-known/openid-configuration`, finds the registration, authorize, and token endpoints.
6. Claude Desktop POSTs to `/api/oauth/register` (DCR) with its metadata (name, redirect URIs, grant types). iHub returns a `client_id` (and optionally `client_secret`).
7. Claude Desktop opens a browser to `/api/oauth/authorize?client_id=...&response_type=code&code_challenge=...&scope=mcp+offline_access&...`.
8. User authenticates against iHub (via whatever auth method is configured — local, OIDC, LDAP, NTLM). User sees the consent screen: "Claude Desktop is requesting access to: invoke apps you can use, read sources you can read."
9. User clicks Approve. iHub redirects to Claude Desktop's redirect URI with the authorization code.
10. Claude Desktop exchanges the code at `/api/oauth/token` with the PKCE verifier. Receives access token + refresh token.
11. Claude Desktop retries `POST /mcp` with `Authorization: Bearer <access_token>`. iHub validates the token, populates `req.user`, returns the tools list.

From the user's perspective: they pasted a URL, clicked Approve once, and now Claude can use iHub's apps. The same access token works for the lifetime of the session; refresh tokens keep it alive.

The full sequence diagram is in [Auth Flow Reference](2026-05-06%20Auth%20Flow%20Reference.md).

### 5.2 The flow Claude Code (and any CLI/headless client) will use

CLI hosts have two acceptable paths:

**Path A — OAuth Authorization Code with browser handoff (recommended for interactive CLI).**

Claude Code supports `/mcp` with browser-based OAuth — it opens the user's default browser to `/api/oauth/authorize?...&redirect_uri=http://127.0.0.1:<port>/callback`, runs a one-shot local HTTP listener, captures the code, and exchanges it. iHub's existing authz code flow already accepts `http://127.0.0.1` and `http://localhost` redirect URIs (Task 4 — public clients with PKCE).

**Path B — Personal Access Token (recommended for non-interactive / scripted use).**

User generates a PAT in the iHub UI under Settings → Personal Access Tokens (new page, mirrors admin's existing token-generation UI). Internally this issues a long-lived JWT via the existing `generateOAuthToken()` machinery in `oauthTokenService.js` — same authMode (`oauth_static_api_key`), but bound to the user's identity rather than a service-account client. User pastes the token into `~/.claude/config.toml` or the equivalent, and Claude Code uses it directly:

```
Authorization: Bearer ihub_pat_eyJhbGc...
```

Tokens are revocable from the same UI. Optional: scope the PAT to specific apps/tools at creation time (existing `allowedApps`/`allowedModels` machinery applies).

This is the same mechanism Atlassian uses for its Rovo MCP server — API token authentication for non-interactive clients, OAuth for interactive ones. It's also what GitHub's MCP server supports.

**A2A peer agents** authenticate the same way: either OAuth (preferred — full agent-to-agent OAuth flow with `client_credentials` for machine identity, or OBO for delegated user context) or a PAT. Their Agent Card declares which schemes are supported.

### 5.3 Scope design

OAuth scopes should be coarse enough to be usable but specific enough that the consent screen tells the user something meaningful. Recommendation:

| Scope | What it grants |
|-------|----------------|
| `openid` | Standard OIDC — user identity |
| `profile` | User name |
| `email` | User email |
| `offline_access` | Refresh tokens |
| `mcp` | Connect to the MCP server (umbrella scope — required) |
| `mcp:apps` | List and invoke apps the user has access to |
| `mcp:tools` | List and invoke tools the user has access to |
| `mcp:workflows` | List and invoke workflows the user has access to |
| `mcp:sources:read` | List and read sources |
| `mcp:chat` | Generic chat completions (delegate-LLM mode) |

Most clients will request `mcp mcp:apps mcp:tools mcp:sources:read offline_access`. The consent screen translates this into human language:

> Claude Desktop is requesting access to:
> - Invoke iHub apps you can use
> - Use iHub tools you can use
> - Read knowledge sources you have access to
> - Stay connected (refresh access automatically)

Fine-grained per-app or per-tool scopes (`mcp:apps:legal_summarizer`) are not part of MVP. The existing per-client `allowedApps`/`allowedModels` mechanism handles that need at the client-config level.

### 5.4 Dynamic Client Registration policy

A bare RFC 7591 endpoint accepts any registration request and writes to the database. That's a denial-of-service liability and a governance headache. iHub should ship DCR with a policy layer:

| Policy mode | Behavior | Use case |
|-------------|----------|----------|
| `open` | Anyone can register. Rate-limited per IP. | Public/community deployments |
| `closed` | DCR endpoint returns 403. Admins manually register via `/api/admin/oauth/clients`. | High-security deployments |
| `with-iat` (default) | DCR requires an Initial Access Token issued by an admin. | Most enterprise deployments |
| `trusted-domains` | DCR accepts requests whose redirect URIs match an allowlist of domains (`claude.ai`, `claude.com`, `cursor.com`, etc.). | Curated connector experience |

`with-iat` is the safe default. Admins generate an IAT in the OAuth client management UI (existing — extend with a "Generate registration token" action), give it to the integrator (or the connector's documentation), and the integrator's MCP host POSTs to `/register` with the IAT in `Authorization: Bearer`. The IAT is single-use or short-lived.

The longer-term direction the MCP working group is pushing — Client ID Metadata Documents (CIMD, SEP-991) — sidesteps the registration database entirely by letting clients use an HTTPS metadata URL as their `client_id`. We watch for adoption; once Claude Desktop and one or two other major hosts implement CIMD, we add it. Same authorization goal, no new endpoint.

### 5.5 Token claims for MCP-issued tokens

The Task 3 / Task 8 design from `oauth-authorization-code-flow/` already covers this. For MCP, an authorization-code-issued access token's JWT payload looks like:

```json
{
  "iss": "https://ihub.example.com",
  "sub": "user_abc123",
  "aud": "https://ihub.example.com/mcp",
  "exp": 1746547200,
  "iat": 1746543600,
  "client_id": "claude_desktop_xyz",
  "authMode": "oauth_authorization_code",
  "scope": "mcp mcp:apps mcp:tools offline_access",
  "name": "Daniel Manzke",
  "email": "daniel.manzke@intrafind.com",
  "groups": ["users", "admins"]
}
```

`aud` set to the MCP endpoint URL is the RFC 8707 Resource Indicators pattern — it prevents a token issued for the MCP server from being replayed against a different resource on the same AS. Recommended.

`enhanceUserWithPermissions()` runs as it does today, intersecting the user's group permissions with the OAuth client's `allowedApps`/`allowedModels`. The MCP tools list and tool-call paths use `req.user` exactly like the rest of iHub.

### 5.6 Per-user audit trail

Every MCP request carries `req.user.id` and `req.user.oauthClientId`. The existing audit logger already emits structured logs for tool calls, app invocations, and admin operations. We add two log fields — `protocol: "mcp"` and `mcpMethod: "tools/call"` (etc.) — and the existing log infrastructure handles the rest. Per-user, per-client, per-tool dashboards become free.

## 6. Public MCP servers as references

The MCP ecosystem has matured enough that we have credible reference implementations to study and steal from:

| Reference | Why look at it |
|-----------|----------------|
| `github/github-mcp-server` | Production MCP server with OAuth, scope filtering, both stdio and HTTP modes, official from GitHub. Good for project/issue/PR API patterns. |
| `NapthaAI/http-oauth-mcp-server` | Reference for the Streamable HTTP + OAuth combination — fork and replace tools. Closest template to what we need. |
| `authzed/mcp-server-reference` | Demonstrates spec-compliant authorization with NextJS + BetterAuth + SpiceDB. Useful for fine-grained authz patterns even if we don't adopt SpiceDB. |
| `mcpauth/mcpauth` | Auth-only library — useful if we want to factor the auth pieces out of `oauth.js`. |
| `QuantGeekDev/mcp-oauth2.1-server` | Minimal reference for the spec's OAuth 2.1 discovery flow. |
| Anthropic's Microsoft 365 connector (closed source, but documented) | The UX bar to clear. PKCE-protected OAuth, On-Behalf-Of with Graph, tenant-wide consent option, per-user search results. |

All operate on roughly the same plan: HTTP server publishes RFC 9728 metadata, JWT validation middleware on `/mcp`, tools list built dynamically, JSON-RPC 2.0 framing.

## 7. Phased rollout

### Phase 0 — This audit

This document. ~0.5 day.

### Phase 1 — MCP MVP with PAT auth

**Goal:** A working MCP server that any client can talk to with a manually-issued token. End-to-end demonstrable with Claude Code.

- New route module `server/routes/mcpRoutes.js` registered in `server.js`.
- `POST /mcp` and `GET /mcp` accepting JSON-RPC 2.0 (Streamable HTTP).
- Tool builder: walk `configCache` → emit MCP tool descriptors for apps with `exposeAsTool: true`, for enabled tools, and for enabled workflows.
- `tools/call` dispatcher: route to the existing chatService / toolExecutor / workflowEngine code paths with `req.user` populated.
- Resources: surface enabled sources (read-only).
- Auth: existing `jwtAuth` middleware. Tokens come from existing `client_credentials` static keys (admins issue them user-scoped via the existing UI — small UI extension to bind a user to a service-account-style token, see §5.2 path B).
- Documentation: short user-facing page in `docs/mcp.md` with copy-paste config snippets for Claude Code, Cursor, Continue.

Deliverable: a customer can install an iHub PAT in Claude Code, run `claude mcp add ihub https://ihub.example.com/mcp --header "Authorization: Bearer <pat>"`, and immediately use any iHub app/tool/workflow.

**Effort:** ~1 week, single engineer.
**Hard dependencies:** none — uses existing `client_credentials` infrastructure.
**Risk:** low. The MCP server is a new route; nothing existing changes shape.

### Phase 2 — MCP with OAuth + DCR

**Goal:** Claude Desktop one-click install. No more manual token pasting for desktop hosts.

- `/.well-known/oauth-protected-resource` endpoint per RFC 9728.
- `WWW-Authenticate: Bearer resource_metadata=...` on 401 responses from `/mcp`.
- `POST /api/oauth/register` per RFC 7591, behind the policy layer from §5.4.
- Add MCP-specific scopes (`mcp`, `mcp:apps`, `mcp:tools`, `mcp:workflows`, `mcp:sources:read`, `mcp:chat`) to the OAuth AS scope catalog.
- Update consent screen (Task 5 of OAuth Authz Code) to render MCP scopes in human language.
- Personal Access Token UI in iHub Settings: user generates a token, optionally scopes to specific apps/tools, copies it once.
- Integration tests: end-to-end flow from `mcp-remote` (the official MCP SDK's reference client) and from `mcp-inspector`.

**Effort:** ~2 weeks.
**Hard dependencies:** OAuth Authz Code Flow (V007) merged. Tasks 1–10.
**Risk:** medium. DCR policy needs review for the deployment models we ship. Consent screen UX needs care — too many scopes overwhelm users.

### Phase 3 — Connector Directory submission

**Goal:** "iHub" appears in Claude Desktop's connector directory, click → done.

- Ensure the deployment is publicly reachable (Anthropic's cloud connects from their infra to ours, not from the user's local machine).
- Polish the consent screen, add iHub branding to the OAuth pages.
- Write the listing copy (use cases, capabilities, screenshots).
- Submit per Anthropic's `Remote MCP Server Submission Guide` in their developer docs.
- Optional: similar submission to OpenAI's connector directory once they accept third-party submissions.

**Effort:** ~1 week, mostly content + review cycles.
**Hard dependency:** Phase 2 stable in a publicly reachable environment.
**Risk:** Anthropic's review process is opaque — could be fast or slow. We can ship as a "custom connector" indefinitely while waiting.

### Phase 4 — iFinder MCP server

**Goal:** Same architecture for iFinder.

- Either a new repo (`ifinder-mcp-server`) standing in front of iFinder's existing API, or new routes on the iFinder server itself if we control its codebase.
- Configure to use iHub's OAuth AS as the federated identity provider, OR run iFinder's own AS.
- Same Streamable HTTP transport, same tool surface (`search`, `get_document`, `get_metadata`).
- Submit a separate Connector Directory listing for iFinder.

**Effort:** ~2 weeks, depending on access to iFinder's codebase.
**Hard dependency:** Phase 2 patterns proven.

### Phase 5 — A2A wrapper

**Goal:** Other autonomous agents can call iHub as a peer.

- Publish an Agent Card at `/.well-known/agent.json` (or wherever A2A v1.0 lands the convention).
- Sign the Agent Card.
- Map MCP tools onto A2A skills (mostly mechanical translation).
- Reuse the same OAuth substrate — A2A's `oauth2` security scheme points at our existing AS.

**Effort:** ~1 week.
**Hard dependency:** Phase 2 stable.
**Risk:** A2A spec is still evolving. Worth holding off until the v1.x line is known to be stable.

## 8. Decision matrix — answering the user's questions

| Question | Answer | Rationale |
|----------|--------|-----------|
| Plugins? | Optional, later | Plugins are a distribution channel for Claude Code / Cowork users. They wrap the MCP server. Build the server first, package optionally. |
| Skills? | Not the right layer | Skills are prompt-time guidance for the LLM. They cannot expose iHub's data or tools. Useful as a *companion* to the connector ("How to get the most out of iHub in Claude") but not a substitute. |
| MCP server? | **Yes — primary deliverable** | Universal contract. Claude Desktop, Claude Code, Cowork, Cursor, Continue, ChatGPT, and every agent framework consume it. Maps naturally onto iHub's existing apps/tools/workflows surface. |
| A2A? | Phase 5 | Fine to add once MCP is stable. Same auth substrate, mostly mechanical translation. |
| Login: OAuth? PAT? Both? | **Both, OAuth-first** | OAuth 2.1 + PKCE for interactive clients (Claude Desktop, Cursor, browser hosts). PAT for headless/CLI/scripts. Existing iHub OAuth infrastructure supports both with minor additions. |
| Per-user permissions? | **Free with the design** | Every MCP request carries the user's identity in the JWT. The existing `enhanceUserWithPermissions` chain runs unchanged. Users see only what they would see in the UI. |

## 9. Risks and open questions

### Spec-level risks

- **CIMD vs DCR.** If CIMD wins, we'll want to add it. Mitigation: ship DCR now, isolate the implementation behind an interface so adding CIMD later is additive.
- **Software statements (SEP-1032).** If Anthropic starts requiring signed software statements for desktop clients to skip warnings, we'll need to verify them. Mitigation: read the SEP, plan a hook in the auth chain, but don't implement until required.
- **A2A v2 breaking changes.** A2A is younger than MCP and could move. Mitigation: don't lead with A2A; let it stabilize.

### Product risks

- **Fragmented MCP ecosystem of "fake" connectors.** Random GitHub MCP servers without auth or with weak auth are everywhere. We need to be visibly more credible — clean docs, PKCE everywhere, signed Agent Cards when we get to A2A, and ideally a Connector Directory listing.
- **User confusion between iHub and iFinder.** If both are listed in the directory and federated, users might not understand which one they're connecting to. Mitigation: clear naming, separate listings, documented when to use each.
- **Per-tool consent fatigue.** If we make scopes too granular, users will click through everything without reading. Coarse scopes + a clear consent screen win here.

### Implementation risks

- **Streaming.** MCP supports progress notifications during long-running tool calls. iHub's existing chat streaming is SSE; we need to bridge it into MCP's notification mechanism. Tractable but worth a spike.
- **Rate limiting.** The existing rate limiter (`concepts/2025-08-08 API Rate Limiting Implementation.md`) needs to recognize MCP traffic and apply per-user quotas. Should be a single middleware addition.
- **Audit log volume.** Every MCP `tools/list` is a hit; cache lists per user/client and refresh on permission change.

### Open organizational questions

- Who owns the iHub ↔ iFinder federation decision? Same team or separate?
- Are we comfortable hosting an MCP server publicly reachable from Anthropic's cloud, or should we ship it only in customer-deployed environments?
- Does the Connector Directory listing reflect the SaaS-hosted version, the on-prem version, or both? Anthropic's directory typically lists SaaS endpoints — on-prem deployments stay as "custom connector" entries.

## 10. References

### MCP spec and ecosystem

- [Authorization — Model Context Protocol](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Evolving OAuth Client Registration in the Model Context Protocol](https://blog.modelcontextprotocol.io/posts/client_registration/) — the SEP-991 (CIMD) and SEP-1032 (Software Statements) proposals
- [Why MCP Deprecated SSE and Went with Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [MCP Streamable HTTP transport spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Anthropic — Building custom connectors via remote MCP servers](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
- [Anthropic — Remote MCP Server Submission Guide](https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide)
- [Anthropic — Microsoft 365 Connector Setup](https://support.claude.com/en/articles/12542951-enable-and-use-the-microsoft-365-connector)
- [Anthropic — Microsoft 365 Connector Security Guide](https://support.claude.com/en/articles/12684923-microsoft-365-connector-security-guide)
- [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [NapthaAI HTTP OAuth MCP Server reference](https://github.com/NapthaAI/http-oauth-mcp-server)
- [authzed/mcp-server-reference](https://github.com/authzed/mcp-server-reference)
- [QuantGeekDev/mcp-oauth2.1-server](https://github.com/QuantGeekDev/mcp-oauth2.1-server)

### OAuth specs

- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 7591 — OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 7009 — OAuth 2.0 Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)
- [RFC 8707 — Resource Indicators for OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc8707)

### A2A

- [A2A Protocol — official site](https://a2a-protocol.org/latest/)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [Linux Foundation announcement (June 2025)](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [A2A Protocol — Enterprise Features](https://a2a-protocol.org/latest/topics/enterprise-ready/)
- [Configuring A2A OAuth User Delegation (ceposta)](https://blog.christianposta.com/setting-up-a2a-oauth-user-delegation/)

### Vendor patterns to study

- [Atlassian Rovo MCP Server — API token authentication](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/)
- [Auth0 — MCP, OAuth 2.1, PKCE primer](https://auth0.com/blog/mcp-streamable-http/)
- [WorkOS — DCR explainer](https://workos.com/blog/dynamic-client-registration-dcr-mcp-oauth)
- [Stytch — OAuth for MCP, real-world example](https://stytch.com/blog/oauth-for-mcp-explained-with-a-real-world-example/)

### Internal docs to read alongside this one

- `concepts/oauth-authorization-code-flow/2026-02-25 Implementation Task Breakdown.md` — Tasks 1–12 of the OAuth AS work
- `concepts/oauth-authorization-code-flow/2026-02-24 OAuth Authorization Code Flow PRD.md` — the underlying PRD
- `concepts/2026-01-19 OAuth2 Client Credentials External API Authentication.md` — existing client_credentials + static API keys
- `concepts/2025-07-12 OpenAI Compatible API.md` — complementary inbound chat API
- `concepts/agentic-workflows/README.md` — workflows that we'll expose as MCP tools
- `concepts/ifinder-integration/2025-08-05 iFinder Integration Code Review.md` — current iFinder integration baseline
- `concepts/2025-07-22 Model Context Protocol Server.md` — the earlier sketch this doc supersedes

---

*-- End of Document --*
