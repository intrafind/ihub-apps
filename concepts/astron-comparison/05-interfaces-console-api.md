# Interfaces, Console UI, APIs — astron-agent vs ihub-apps

Scope: console UI (workflow builder, bot center, model mgmt, plugin store, space management), public REST/gRPC APIs, OpenAI-compatible proxy, SSE/streaming, webhooks, embedding (iframe/widget), MCP server, external integrations.

---

## 1. astron-agent

iFlytek's astron-agent is a polyglot, microservice‑oriented enterprise platform: React/TS console on top of a Spring Boot "hub" backend and 7 FastAPI/Go "core" services, connected via Nginx + Kafka + Casdoor (OAuth2/OIDC). Confirmed from repo + DeepWiki.

### 1.1 Console frontend (`console/frontend`)

- Stack: React 18 + Vite + TypeScript + **Ant Design 5** + Tailwind, state managed by **Recoil (+recoil-persist)** and **Zustand**, routing via React Router DOM 6/7. (https://github.com/iflytek/astron-agent/blob/main/console/frontend/package.json)
- Visual workflow builder: **`reactflow ^11.11.3`** plus **Monaco editor**, **ECharts**, KaTeX, Lottie. (package.json — confirmed in WebFetch)
- Page surface under `console/frontend/src/pages`:
  - `workflow/` — node-based flow builder with `components/{flow-container, flow-drawer, flow-header, flow-modal, node-list, btn-groups, community-qr-code, multiple-canvases-tip}` + `workflow-analysis/`.
  - `bot-api/` — bind a "bot" to an external application; surfaces App ID, Service URL, **API Key + API Secret**, Flow ID; offers Python/Java demo downloads. (https://github.com/iflytek/astron-agent/blob/main/console/frontend/src/pages/bot-api/api.tsx)
  - `chat-page/`, `home-page/`, `config-page/`, `callback/`.
  - `model-management/{official-model, personal-model, model-detail}` — manage built‑in and user models.
  - `plugin-store/{components, detail}` — browsable catalog with detail pages.
  - `release-management/{agent-list, detail-list-page, detail-overview, released-page, trace-logs}` — agent versioning + monitoring.
  - `resource-management/`, `space/{enterprise, personal, space-detail, team-create, hooks}`.
  - `share-page/` — invitation acceptance/rejection (NOT public-share URLs).
- Multi-tenant: a `useSpaceStore` (Zustand) holds `spaceId/enterpriseId/spaceType` and injects tenant headers on every Axios call.
- Runtime config via `docker-entrypoint.sh` → `/var/www/runtime-config.js` (env-driven base URL).

### 1.2 Backend (`console/backend`)

Spring Boot multi-module (`commons/`, `hub/`, `toolkit/`, `config/`). Hub package: `com.iflytek.astron.console.hub` with `controller/{publish, share, bot, chat, wechat, workflow, user, space, notification, homepage, extra}`.

Key controllers (verified):

- **`PublishApiController`** — `POST /publish-api/create-user-app`, `GET /publish-api/app-list`, `POST /publish-api/create-bot-api`, `GET /publish-api/get-bot-api-info`. Rate-limited 30/60s.
- **`BotPublishController`** — `GET /publish/bots`, `GET /publish/bots/{botId}`, `GET /publish/bots/{botId}/prepare` (channels: market, mcp, feishu, api, wechat), `POST /publish/bots/{botId}` (unified publish/offline via strategy pattern), `/summary`, `/timeseries`, `/versions`, `/trace`.
- **`SparkChatController`** — `POST /api/spark/chat/stream` (`text/event-stream`).
- **`WorkflowChatController`** — `POST /api/v1/workflow/chat/stream` (SSE), `POST /api/v1/workflow/chat/resume`, `POST /api/v1/workflow/chat/stop/{streamId}`, `GET /api/v1/workflow/chat/status`, `GET /api/v1/workflow/health`.
- **`WechatCallbackController`** — webhook endpoint for WeChat Official Accounts.
- `ShareController`, `S3Controller`, `HealthController`, plus bot CRUD/voice/favorites.

### 1.3 Bot publishing — 5 channels (strategy pattern)

| Strategy | Effect |
|---|---|
| `MarketPublishStrategy` | Lists bot in internal Agent Hub marketplace |
| `ApiPublishStrategy` | Generates external REST endpoint + API Key/Secret (Bot API) |
| `WechatPublishStrategy` | OAuth2 binding to WeChat Official Accounts |
| `FeishuPublishStrategy` | Deploy to Feishu collaboration platform |
| **`McpPublishStrategy`** | **Publish the bot/workflow as a Model Context Protocol server** (consumable by any MCP client incl. Claude Desktop) |

### 1.4 SSE / streaming

Bespoke SSE protocol (`SseEmitter` + provider-specific event chunks). **Not OpenAI-compatible**; clients use iFlytek SDKs. gRPC implied between core services only (no public surface confirmed).

### 1.5 MCP

- **Consumer**: `core-link` (FastAPI) registers external MCP servers (`register_mcp()`), discovers (`tool_list()`), invokes (`call_tool()`), with SSRF/blacklist guards. Naming convention `mcp@{type}{id}`.
- **Server**: bots published via `McpPublishStrategy` are exposed as MCP servers — bidirectional support.
- Companion repo `iflytek/ifly-workflow-mcp-server` is a separate Node/Python MCP server.

### 1.6 Webhooks, embedding, OpenAPI

- Webhooks: only `WechatCallbackController` is a true inbound webhook. No generic outbound webhook framework documented.
- Embedding: `share-page` is for invitations, **not** iframe/widget. No JS chat widget located.
- OpenAPI: Swagger/Springdoc annotations on controllers; **HTTP Tool plugins are themselves defined by OpenAPI YAML/JSON** parsed by Jackson.

### 1.7 Auth/Multi-tenant

External Casdoor (OAuth2/OIDC) + JWT refresh; Nginx fronts everything (SSE-aware); `spaceId/enterpriseId` headers establish tenant context throughout.

---

## 2. ihub-apps

Single Node/Express server + React/Vite SPA + small mobile/desktop shells. No microservices. No multi-tenancy (group-permission based access only).

### 2.1 Console frontend (`client/src`)

- Stack: React 18 + Vite + JS (no TS) + Tailwind + custom contexts (`AuthContext`, `PlatformConfigContext`, `UIConfigContext`). No Ant Design, no Recoil/Zustand, no React Router 7. (`client/package.json`)
- **No React Flow / X6 / G6 / antv** — confirmed via `grep` over `client/`. Workflow "editing" is a Monaco JSON textarea: `client/src/features/admin/pages/AdminWorkflowEditPage.jsx:118` (`handleJsonChange`).
- Features (`client/src/features/`): `admin`, `apps`, `auth`, `canvas`, `chat`, `extension`, `nextcloud-embed`, `office`, `prompts`, `settings`, `setup`, `teams`, `tools`, `upload`, `voice`, `workflows`.
- Workflows surface (`features/workflows/`): `WorkflowsPage` (tabs: Available, MyExecutions), `WorkflowExecutionPage`, `ExecutionCard`, `ExecutionProgress`, `HumanCheckpoint`, `StartWorkflowModal`, `WorkflowCard`, `WorkflowPreview`. No DAG canvas.
- Canvas feature (`features/canvas/`): rich text editor (Quill) bound to LLM. Not a node graph.
- Routes (`client/src/App.jsx:230-700`): apps, workflows, canvas, admin (40+ admin pages: users/groups/models/providers/prompts/tools/skills/workflows/sources/pages/ui/auth/oauth/oauth-clients/oauth-server/integrations/{jira,office365,googledrive,nextcloud}/marketplace/marketplace-registries/browser-extension/nextcloud-embed/office-integration/usage/system/logging/telemetry/features/shortlinks), unified-pages, teams tab.
- `iframe` app type exists for embedding *external* sites into iHub (`features/apps/pages/IframeApp.jsx:9`) — not for embedding iHub elsewhere.

### 2.2 Server (Express, `server/`)

Route modules registered in `server/server.js:412-453`. Notable:

| File | Purpose |
|---|---|
| `routes/openaiProxy.js:21-612` | **OpenAI-compatible proxy** at `/api/inference/v1/{models,chat/completions}` with SSE streaming + tool calls + per-user model permission filtering. |
| `routes/swagger.js:1-273` | Swagger UI at `/api/docs` with 3 groups: chat/general, admin, openai-compat. swaggerJSDoc annotations on routes. |
| `sse.js:1-50` | SSE client registry + heartbeat with `actionTracker` event bridge. |
| `routes/chat/sessionRoutes.js:200` | EventSource endpoint `GET /api/apps/:appId/chat/:chatId/status` (single SSE per chat). |
| `routes/chat/dataRoutes.js:569,904` | Send-message + cancel; uses sse.js bus. |
| `routes/auth.js`, `oauth.js`, `oauthAuthorize.js`, `wellKnown.js` | OIDC discovery, JWKS, OAuth2 server (token/introspect/revoke/userinfo), local/LDAP/NTLM/Teams logins. |
| `routes/admin/marketplace.js` | Registry-based marketplace for installable apps/tools/prompts/models/workflows; backed by `services/marketplace/{RegistryService,ContentInstaller}.js`. |
| `routes/integrations/{jira,office365,googledrive,nextcloud,ifinder,officeAddin,browserExtension,nextcloudEmbed}.js` | External system integrations. |
| `routes/workflow/workflowRoutes.js` (1892 lines) | Workflow run, list, status, executions; uses `services/workflow/{WorkflowEngine,DAGScheduler,ExecutionRegistry,StateManager}.js`. |
| `routes/shortLinkRoutes.js` | Generate shareable short URLs to apps with pre-filled params/values. |
| `routes/nextcloudEmbedPages.js` | Serves iHub UI as an iframe inside Nextcloud with `Content-Security-Policy: frame-ancestors` allowlist. |
| `routes/wellKnown.js` | OIDC discovery + JWKS endpoints. |
| `routes/setup.js`, `pwaRoutes.js`, `themeRoutes.js`, `staticRoutes.js`, `office.js`. |

### 2.3 OpenAI compatibility

`POST /api/inference/v1/chat/completions` and `GET /api/inference/v1/models` are full OpenAI-format endpoints (auth via `authRequired` middleware — JWT/session); supports streaming, tools, tool_choice; adapters in `server/adapters/` normalise per-provider responses.

### 2.4 MCP

- **Consumer only.** `server/toolLoader.js:201-218` reads `MCP_SERVER_URL` (single URL via `server/config.js:24`) and `GET /tools` from it, merging into the global tool registry.
- **No MCP server endpoint** — iHub apps/workflows are NOT exposed as MCP. Confirmed by `grep -ri "MCP|model context protocol" server/ client/`.

### 2.5 Webhooks

- **No webhook framework.** `grep -ri "webhook" server/` returns 0 hits in code (only doc strings unrelated).
- No inbound webhook receiver, no outbound webhook on lifecycle events (chat completed, workflow finished, user created…).

### 2.6 Embedding / widgets

- **Iframe**: only inbound (`features/apps/pages/IframeApp.jsx`) and the Nextcloud-embed iframe deployment (`routes/nextcloudEmbedPages.js`, `client/src/features/nextcloud-embed/`).
- **No drop-in JS chat widget** (no `<script src="…widget.js">` snippet generator).
- Public shell apps: `browser-extension/` (Manifest V3, sidepanel + background.js), `electron/` (main+preload), `teams/` (Teams tab manifest), `nextcloud-app/` (Nextcloud PHP app).
- `shortLinkRoutes.js` enables short shareable URLs but still requires auth.

### 2.7 Public REST API surface

Documented in Swagger, organised into 3 specs:

- Chat & General: `/api/apps`, `/api/models`, `/api/tools`, `/api/skills`, `/api/sessions`, `/api/pages`, `/api/translations`, `/api/configs/{ui,platform,mimetypes}`, `/api/styles`, magic prompts, short-links.
- Admin: `/api/admin/...` (everything in `server/routes/admin/`).
- OpenAI: `/api/inference/v1/...`.

No public Bot/Agent CRUD API surfaced for end-users — admin only.

---

## 3. Gap matrix

| Capability | astron-agent | ihub-apps | Gap | Notes |
|---|---|---|---|---|
| Visual node-based workflow builder | Yes — React Flow + 8+ node types, multi-canvas, drawer/header/modal | **No** — JSON-only editor (Monaco textarea) at `AdminWorkflowEditPage.jsx:118` | **CRITICAL** | Workflow engine exists in `server/services/workflow/`; just needs UI |
| Bot/Agent designer (chat-style builder) | Yes — bot-create, personality, talk-agent | Partial — `AdminAppEditPage` form-based | M | iHub has app metadata UI but no chat-driven "design" flow |
| Model management UI | Yes — official + personal sections | Yes — `AdminModelsPage`, `AdminProvidersPage` | Parity | — |
| Plugin / tool store | Yes — `plugin-store` + tool marketplace; OpenAPI YAML tools | Partial — `AdminMarketplacePage` (registries) | S | iHub has registry-based installer; lacks user-facing browse UI |
| Space / team management | Yes — personal/enterprise spaces, invites | **No** — groups but no spaces/tenants | L | iHub is single-tenant by design |
| Release/version mgmt | Yes — versions, trace-logs, released-page | Partial — workflow executions list | M | No bot/app version history |
| Conversation history UI | Yes — chat-list/history/restart | Yes — chat features | Parity | — |
| User management UI | Yes (via space + Casdoor) | Yes — `AdminUsers/Groups/OAuthClients` | Parity | — |
| **OpenAI-compatible REST** | **No** (bespoke iFlytek SDKs) | **Yes** — `routes/openaiProxy.js` | iHub advantage | — |
| Public REST + SDK / OpenAPI | Yes — Swagger on hub, Python/Java demos | Yes — Swagger 3 specs; no published SDKs | M | iHub lacks generated SDKs |
| SSE streaming | Yes — workflow/chat SSE | Yes — `sse.js`, chat status SSE | Parity | — |
| gRPC | Internal only | None | Low | — |
| **MCP server (expose iHub)** | **Yes** — `McpPublishStrategy` publishes bots as MCP | **No** | **CRITICAL** | iHub has tools/apps/workflows that are MCP-shaped but no protocol endpoint |
| MCP client | Yes — `core-link` | Yes — `toolLoader.js:201` single URL | Minor | iHub limited to one MCP server |
| Webhooks (inbound) | Wechat-only | None | M | — |
| Webhooks (outbound, lifecycle) | None | None | M | Common enterprise ask |
| Drop-in chat widget (JS snippet, iframe) | No | No | M | Both missing; iHub closer (iframe-friendly UI) |
| Public share/embed link | No (invite-only) | Partial — `shortLinkRoutes.js` but auth-gated | M | iHub: no anonymous public share |
| External shells | Console only | **Browser extension + Electron + Teams + Nextcloud app** | iHub advantage | — |
| Wechat/Feishu channels | Yes | None | Low | Not core to iHub audience |
| Multi-channel publishing strategy | Yes — pluggable strategies | No | M | Enabler for many gaps above |
| Auth | Casdoor OAuth2/OIDC | Local/OIDC/LDAP/NTLM/Proxy/Teams + own OAuth2 server | Parity | iHub more flexible |

---

## 4. What we should reimplement (ranked)

1. **Visual node-based workflow builder (UI).** Replace JSON-only editor with React Flow canvas. Backend (`services/workflow/`, `routes/workflow/workflowRoutes.js`) already supports DAG execution; missing piece is purely UI. **Scope: L–XL. Risk: M.** Dependencies: add `reactflow`, node-component library, persistence to existing workflow JSON schema. Highest user-facing value.
2. **MCP server (expose iHub apps/workflows/tools as MCP).** Lets Claude Desktop, Cursor, etc. consume iHub agents. **Scope: M. Risk: L.** Dependencies: `@modelcontextprotocol/sdk`, mount over HTTP/SSE at `/api/mcp`, map existing tool registry. Symmetric to `McpPublishStrategy`.
3. **Outbound webhook framework + inbound webhook receivers.** Lifecycle events (workflow.finished, chat.completed, user.created) → user-defined URLs with HMAC signing. Inbound: signed webhook endpoints to trigger workflows from external systems (e.g., Jira/GitHub/Slack). **Scope: M. Risk: L–M.**
4. **Drop-in JS chat widget + public share links.** Snippet that mounts iHub chat into any site (`<script src="…/widget.js" data-app-id="…">`). Optional anonymous-token mode for marketing pages. **Scope: M. Risk: M** (security: anonymous quota, allowlist origins). Builds on existing iframe-embed support.
5. **Bot/Agent public REST API publishing.** Per-app issued API keys + scoped Bot API endpoint (separate path from admin), like `PublishApiController`. Today iHub has OpenAI-proxy (model-level); missing is *app-level* keyed API. **Scope: M. Risk: L.** Mostly reusing OAuth client store + permissions.
6. **Plugin / tool marketplace UI for end-users.** Existing admin registry → user-browse page ("Plugin Store") with detail, ratings, install. **Scope: S–M. Risk: L.** Backend exists.
7. **Workflow versioning + trace logs UI.** Persist versions, surface `executions/trace` view. **Scope: M. Risk: M.**
8. **Generated client SDKs (Python / TS / Java).** From existing OpenAPI specs via `openapi-generator`. **Scope: S. Risk: L.**
9. **Spaces / multi-tenancy.** Spaces, enterprise admin, per-space resource isolation. **Scope: XL. Risk: H.** Probably skip unless commercial need.
10. **External chat channel adapters (Slack/Teams bot/WeChat).** Slack first (Teams already exists as tab, not bot). **Scope: M per channel. Risk: M.**

---

## 5. Implementation outline — top 3

### 5.1 Visual workflow builder (React Flow)

Files to add/modify in `ihub-apps`:

- `client/package.json` — add `reactflow` (or `@xyflow/react`), `dagre` for auto-layout.
- New: `client/src/features/workflows/builder/WorkflowBuilder.jsx` — main canvas wrapper.
- New: `client/src/features/workflows/builder/nodes/` — one component per node type the engine supports: `StartNode.jsx`, `LLMNode.jsx`, `ToolNode.jsx`, `BranchNode.jsx`, `LoopNode.jsx`, `EndNode.jsx`, `HumanCheckpointNode.jsx` (matches `server/services/workflow/executors/`).
- New: `client/src/features/workflows/builder/edges/{ConditionalEdge.jsx,DefaultEdge.jsx}`.
- New: `client/src/features/workflows/builder/NodePalette.jsx` (drag-and-drop sidebar) and `NodeInspector.jsx` (right-panel config form).
- Modify: `client/src/features/admin/pages/AdminWorkflowEditPage.jsx:118` — replace `handleJsonChange` Monaco textarea with `<WorkflowBuilder/>` that emits the same JSON. Keep "Raw JSON" tab as fallback.
- New: `client/src/features/workflows/builder/serialization.js` — map between React Flow `{nodes,edges}` and iHub's workflow JSON (preserves `inputVariables`, `config`, ports).
- Auto-layout via `dagre`; minimap; node search; copy/paste; validation badge from existing Zod schema.
- Test: load existing workflows under `contents/workflows/`; ensure round-trip JSON equality.

Effort: ~3–4 weeks single dev. Dependencies: none server-side. Risk: aligning node port semantics with executors.

### 5.2 MCP server exposing iHub apps/workflows/tools

Files to add/modify:

- `server/package.json` — add `@modelcontextprotocol/sdk`.
- New: `server/routes/mcpServer.js` — register `GET/POST /api/mcp` (HTTP+SSE transport per MCP spec). Auth via existing `authRequired` (JWT in `Authorization: Bearer`) or new dedicated API keys.
- New: `server/services/mcp/McpServerService.js`:
  - Map iHub tools (from `toolLoader.js`) → MCP `tools/list` + `tools/call`.
  - Map iHub apps → MCP tools whose `inputSchema` derives from app variables (reuse `appConfigSchema.js`).
  - Map iHub workflows → MCP tools whose `inputSchema` derives from start-node `inputVariables` (reuse `buildWorkflowToolParams()` in `toolLoader.js:14`).
- New: `server/services/mcp/transports/{httpStream.js,sse.js}` — HTTP-stream + SSE transport (using existing `server/sse.js` pattern).
- Modify: `server/server.js:425` — register new route.
- Modify: `contents/config/platform.json` schema — add `mcpServer: { enabled, publicMcpUrl, requireApiKey }`.
- New admin page: `client/src/features/admin/pages/AdminMcpServerPage.jsx` — toggle, copy public URL, list exposed apps/workflows (per-resource toggle).
- New: `docs/mcp-server.md` — connection example for Claude Desktop config.

Effort: ~1–2 weeks. Risk: protocol version drift; mitigated by using official SDK.

### 5.3 Webhook framework (in + out)

Files to add/modify:

- New: `server/services/webhooks/WebhookManager.js` — registry, retry queue (in-memory + persist to `contents/webhooks/*.json`), exponential backoff, HMAC-SHA256 signing.
- New: `server/services/webhooks/events.js` — event bus with `actionTracker` integration. Event names: `chat.completed`, `chat.message.sent`, `workflow.execution.started/completed/failed`, `app.created`, `user.login`.
- Hook emit points:
  - `server/routes/chat/dataRoutes.js:904` (cancel) and end of streaming handler → fire `chat.completed`.
  - `server/services/workflow/WorkflowEngine.js` → fire `workflow.execution.*`.
  - `server/routes/auth.js:431` → `user.login`.
- New: `server/routes/admin/webhooks.js` — CRUD admin endpoints `/api/admin/webhooks`; rotate secret.
- New: `server/routes/webhooks.js` — **inbound** `POST /api/webhooks/:token` to trigger workflow runs (signed payload → workflow input mapping configurable per token).
- New: `client/src/features/admin/pages/AdminWebhooksPage.jsx` + edit page; show delivery history, test-fire button.
- New: `contents/config/webhooks.json` schema; new Zod validator `server/validators/webhookSchema.js`.
- New migration: `server/migrations/Vxxx__add_webhooks_config.js` to seed defaults (per CLAUDE.md migration system).

Effort: ~2 weeks. Risk: at-least-once delivery semantics; mitigation: idempotency keys in signed payload.

---

## 6. Open questions

- Does astron's MCP server publish channel expose only the bot's chat as one MCP tool, or expand each workflow node? (DeepWiki summary says "as MCP server" but does not detail tool surface area.)
- Is astron's gRPC actually public? "Implied" in DeepWiki; could not confirm a proto file.
- Webhook framework in astron — is it only Wechat callback, or does the publish system emit lifecycle webhooks elsewhere (e.g., MaaS event bus on Kafka)? DeepWiki mentions Kafka but not a user-facing webhook.
- Plugin store: does astron support user-published (third-party) plugins or only iFlytek-curated? `personal-model` exists; `personal-plugin` was not visible.
- Has astron a JS embeddable widget? Searches surface no `<script>` snippet generator; only `share-page` (invites) was found.
- ihub-apps marketplace registries: are they peer-to-peer (multiple iHub instances syndicate) or central? Visible code suggests static configured registries — confirm with `services/marketplace/RegistryService.js` deeper read.
- For "Bot API" parity, do we use iHub's existing `routes/oauth.js` (Client Credentials) or introduce app-scoped API keys? Both viable; OAuth route already returns JWTs scoped via `oauthClientManager`.
- Should the visual builder author the existing iHub workflow schema, or do we introduce a richer DAG that diverges from `workflowsLoader.js`? Recommend: keep current schema for compatibility, layer presentation metadata (`position`, `notes`) under a `viewport` field.
- Should the MCP server require its own API tokens (separate from OAuth) similar to OpenAI key style? Likely yes for tooling clients that lack OAuth flows.
