# Agent Framework, Tools, Plugins, RPA — astron-agent vs ihub-apps

**Date:** 2026-05-13
**Focus areas:** Agent loop (planner/ReAct/multi-agent), tool calling, plugin marketplace, RPA, MCP support.
**Status:** Research only — no code changes.

---

## 1. astron-agent (iFLYTEK)

`astron-agent` is a multi-language polyglot platform: Java/Spring (console-backend), Python/FastAPI (core services), Vue/React frontends, Go (tenant). Agent / tool / plugin code lives under `core/agent` and `core/plugin/{aitools,link,rpa}`.

### 1.1 Agent loop and engine

- **Service layout** — `core/agent` is a FastAPI service (`main.py`) on **port 17870** with the layers `api/`, `domain/`, `engine/`, `service/`, `infra/`. The execution engine lives at `core/agent/engine/nodes/` and is organized around three node families: `chat/`, `cot/`, `cot_process/`, plus a `base.py` superclass.
- **Loop semantics** — The `cot/` subtree (`cot_prompt.py`, `cot_runner.py`) and the parallel `cot_process/` subdirectory strongly indicate a **Chain-of-Thought / ReAct-style loop** (think → act → observe) implemented as a runner that drives the LLM through reasoning + tool steps. There is no explicit `react_node.py` or `planner_node.py`, so the framework appears to be a single-loop ReAct executor rather than a strict plan-and-execute split.
- **Workflow vs. agent split** — Multi-step orchestration with branching, loops, parallel execution, human-in-the-loop checkpoints, and nested sub-workflows is provided by the separate `core-workflow` service (port 7880) using a visual DSL (ReactFlow). The agent engine drives the LLM step; the workflow engine drives node-graph execution.
- **Multi-agent / supervisor** — Reviews ([kingy.ai](https://kingy.ai/uncategorized/astron-agent-review-iflyteks-open-source-enterprise-ai-workflow-platform-is-the-real-deal/), [jimmysong.io](https://jimmysong.io/ai/astron-agent/)) describe "orchestrated multi-agent workflows: define, schedule, and monitor coordinated agent tasks" and "shared context with task passing between agents," but multi-agent coordination is realised by chaining agents inside workflows rather than by a dedicated supervisor agent class.
- **Knowledge** — A separate `core-knowledge` service provides RAG for grounding.
- **Persistence** — MySQL + Redis + Kafka. Each LLM step / tool call is observable via Kafka and OpenTelemetry.

### 1.2 Tool calling architecture

- **Schema** — **OpenAPI** is the canonical tool description format. `ToolBoxService` (Java) converts simplified web-form schemas to full OpenAPI specs and validates via `OpenapiSchemaValidator`. Per [DeepWiki §6](https://deepwiki.com/iflytek/astron-agent/6-tool-and-plugin-integration).
- **Tool execution bridge** — Tools are not run in-process. The agent calls **`core-link` (port 18888)** which handles "HTTP tool execution, MCP client." Two types are supported: **HTTP tools** (custom REST APIs, with parameter validation + auth injection + SSRF guards) and **MCP tools** (Server-Sent Events to remote MCP servers).
- **Lifecycle** — Tools exist in a **Draft → Formal** dual-state; `tool_box_operate_history` tables track audit.
- **Visibility filter** — `x-display` OpenAPI extension hides response fields from the LLM (e.g. internal IDs, secrets).
- **AI tools service** — `core-aitools` (port 18668) is a dedicated service that exposes iFLYTEK Open Platform capabilities (translation, TTS, ASR, OCR, etc.) to agents.

### 1.3 Plugin marketplace ("Plugin Square") & SkillHub

- **Plugin Square** — In-platform marketplace UI with usage tracking ("heat" stored in Redis), favourites (`UserFavoriteToolMapper`), shared publishing across the platform. Plugins = tools published from Draft to Formal.
- **SkillHub** ([github.com/iflytek/skillhub](https://github.com/iflytek/skillhub)) — Companion self-hosted **skill registry** with: semantic versioning, custom tags (`beta`, `stable`), automatic `latest` tracking, full-text search, team namespaces, RBAC (Owner/Admin/Member + Super Admin), starring/ratings/download counters. Storage is pluggable (filesystem / S3 / MinIO). CLI:
  ```
  skillhub login --token sk_xxx --registry [URL]
  skillhub search [skill-name]
  skillhub install [skill-name] --agent [agent-type]
  skillhub list
  ```
- **Packaging format** — SkillHub readme references `SkillPackagePolicy.java` validator but does not nail down the exact schema; "skill package" is the unit, distributed via the registry, installable by CLI.

### 1.4 MCP support

- **Bidirectional** — Per [kingy.ai](https://kingy.ai/uncategorized/astron-agent-review-iflyteks-open-source-enterprise-ai-workflow-platform-is-the-real-deal/): "Astron's support for the Model Context Protocol (MCP) standard works bidirectionally — the platform can consume external MCP tools and serve as an MCP server."
- **Client side** ([DeepWiki §6.3](https://deepwiki.com/iflytek/astron-agent/6.3-mcp-protocol-integration)):
  - `core-link` is the SSE MCP client using the official `mcp` Python library.
  - Registration via `register_mcp()` persists server metadata to MySQL (`tool_base` table).
  - Discovery: `tool_list()` → MCP `list_tools()` per server; tools get IDs `mcp@{type}{id}`.
  - SSRF protection: blocks `localhost`, `127.0.0.1`, private IP ranges; IP/domain/CIDR blacklists via env vars; HTTPS-only.
- **Server side** — Exposing Astron workflows as an MCP server lets Claude / Cursor / other MCP-aware clients call them.

### 1.5 RPA integration

- **Sister project** — Astron-Agent's RPA bridge is `core/plugin/rpa` (FastAPI shim, no RPA libs in `pyproject.toml`), which talks to the standalone [iflytek/astron-rpa](https://github.com/iflytek/astron-rpa) suite.
- **Astron-RPA stack**:
  - Frontend: Vue 3 + TypeScript + Electron desktop client
  - Backend: Java Spring Boot + Python FastAPI microservices
  - Engine: Python, 20+ `astronverse.*` packages
  - **Components**: `astronverse.system`, `.browser`, `.gui`, `.excel`, `.vision`, `.ai`, `.network`, `.email`, `.docx`, `.pdf`, `.encrypt`
  - **Framework**: `astronverse.actionlib` (atomic ops), `.executor` (workflow engine), `.picker` (element picker), `.scheduler`, `.trigger`
- **Coverage** — 300+ pre-built atomic capabilities; Windows desktop apps (Office, WPS, ERP/finance), web automation (IE/Edge/Chrome), document processing, computer vision.
- **Integration** — Bi-directional: agents call RPA workflow nodes, RPA can call agent workflows.
- **Enterprise** — Built-in "excellence centre" team marketplace, scheduling, robot team sharing.

---

## 2. ihub-apps (local repo)

### 2.1 Agent loop and engine

ihub-apps does **not** have a separate agent service. The "agent" is the chat completion loop running inside `server/services/chat/`.

- **`ChatService.processChat`** (`server/services/chat/ChatService.js:138`) dispatches: non-streaming, streaming, or streaming-with-tools.
- **`ToolExecutor.processChatWithTools`** (`server/services/chat/ToolExecutor.js:775`) is the first turn; tool calls collected from streamed deltas; tools executed; assistant turn pushed to message history.
- **`ToolExecutor.continueWithToolExecution`** (`server/services/chat/ToolExecutor.js:1171`) implements the **multi-step loop** — `while (iteration < 10)`, hard cap `maxIterations = 10` (`ToolExecutor.js:1189`). Effectively a **vanilla function-calling loop**, not ReAct, not plan-execute, and no explicit "thought" channel. The LLM decides whether to keep calling tools or stop.
- **No planner / supervisor / sub-agents** — There is no agent-of-agents, no dedicated planner step, no parallel branch evaluator. The closest thing is `workflowRunner.js` (workflows callable as tools) and `WorkflowEngine` (separate service for visual workflows with start/agent/condition/loop nodes).
- **Ask-user clarification** — A first-party `ask_user` tool (`server/tools/askUser.js`) lets the model pause the loop to ask the user for input; tightly integrated into the executor (`ToolExecutor.js:143` `executeClarificationTool`) with rate limiting (10 clarifications / conversation).
- **Passthrough / streaming tools** — Tools can opt-in to streaming their own output as the assistant message (`ToolExecutor.js:605` `executePassthroughTool`). Workflows use this.
- **Skills as on-demand instructions** — `activate_skill` / `read_skill_resource` internal tools (`toolLoader.js:437-475`) let the model lazy-load skill markdown. This is the equivalent of Anthropic's Agent Skills spec.

### 2.2 Tool calling architecture

- **Schema** — **JSON Schema parameters** (OpenAI function-calling style). Tools are pure JavaScript modules under `server/tools/`. Definitions live in `server/defaults/config/tools.json` and the user's `contents/config/tools.json`.
- **Tool loader** (`server/toolLoader.js`):
  - `loadConfiguredTools` reads from cache → localizes multilingual fields
  - `discoverMcpTools` (`toolLoader.js:203`) — **MCP CLIENT IS STUBBED**: GETs `{MCP_SERVER_URL}/tools` and merges into the tool list. Not a real MCP protocol client. No `list_tools`, no SSE, no auth, no multi-server registration, no schema validation.
  - `getToolsForApp` builds the per-app tool set with: app.tools filter, source-generated tools (e.g. `source_<id>`), workflow-as-tool entries (`workflow:<id>`), websearch resolver, skill activation tools.
  - `runTool` is the dispatcher; performs id validation, special-cases `activate_skill`, `read_skill_resource`, `workflow_*`, `source_*`, then dynamic-imports `./tools/<scriptName>.js`.
- **Cross-provider** — `server/adapters/toolFormatter.js` + `server/adapters/toolCalling/` provide a unified "generic" tool format with bidirectional converters for OpenAI, Anthropic, Google, Mistral, Bedrock, VLLM, OpenAI Responses (`server/adapters/toolCalling/README.md`).
- **Tool catalogue** (built-in): `askUser`, `braveSearch`, `tavilySearch`, `entraPeopleSearch`, `iFinder` (search/getContent/getMetadata), `jira` (searchTickets/getTicket and full CRUD via `JiraService`), `playwrightScreenshot` (chromium), `seleniumScreenshot` (selenium-webdriver), `webContentExtractor` (jsdom + pdfjs, with SSRF guard), `workflowRunner` (workflow-as-tool bridge).
- **Integration services** (`server/services/integrations/`): Entra, GoogleDrive, Jira, Nextcloud, Office365, iFinder, iAssistant, ConversationApi — but only Jira, Entra, iFinder are exposed as agent-callable tools today.

### 2.3 Marketplace / registry

ihub-apps already has a **marketplace subsystem** (an under-publicised strength).

- **`server/services/marketplace/RegistryService.js`** — Multi-registry catalog manager:
  - Supports formats: native `catalog.json` (apps/models/prompts/skills/workflows), Claude Code `marketplace.json` (plugins/skills arrays), Anthropic plugin trees (auto-discovers `*/skills/*/SKILL.md` via GitHub Trees API)
  - Authenticated registries: bearer / basic / custom header — encrypted at rest (AES-256-GCM via `TokenStorageService`)
  - SSRF protection: HTTPS-only, host validation; GitHub blob→raw URL rewriting
  - Caches catalogs to `contents/.registry-cache/{registryId}.json`
- **`server/services/marketplace/ContentInstaller.js`** — Install/update/uninstall/detach. Dispatch table maps `{app|model|prompt|skill|workflow}` to dir/ext/cacheRefresh/validate. Skills are directory-based with companion files (`references/`, `scripts/`, `assets/`).
- **Admin UI** — `client/src/features/admin/pages/AdminMarketplacePage.jsx` and `AdminMarketplaceRegistriesPage.jsx`. End-user marketplace UI not present.
- **No versioning / tags / ratings / downloads / search ranking** — Items are identified by `{type}:{name}`; "version" is captured but not used for resolution. Installation manifest at `contents/config/installations.json`.

### 2.4 MCP support

- **One-line URL stub** (`toolLoader.js:203-221`): fetches `{MCP_SERVER_URL}/tools` once at load. Not the real MCP protocol; no JSON-RPC, no SSE/stdio transport, no tool invocation.
- **No tool execution** — discovered tools land in the catalogue but `runTool` has no MCP code path, so they cannot be called.
- **No MCP server side** — ihub-apps does not expose its tools/apps over MCP.

### 2.5 RPA

- **None.** The closest analogues:
  - `playwrightScreenshot.js` (76 lines) — single-shot URL → PNG/PDF via Playwright `chromium.launch`.
  - `seleniumScreenshot.js` (74 lines) — same but Selenium.
  - Both lack multi-step UI scripting, recorders, element pickers, scheduling, OS-level (desktop) automation, or document/Office automation.
- No `RpaService`, no script DSL, no robot scheduler, no triggers.

---

## 3. Gap matrix

| # | Capability | astron-agent | ihub-apps | Gap severity | Notes |
|---|---|---|---|---|---|
| 1 | Agent loop type | ReAct-style CoT runner with explicit prompt+runner classes | Vanilla OpenAI-style function-call loop, cap 10 iters (`ToolExecutor.js:1189`) | **Medium** | Works today, but no thought trace, no plan, no replan-on-failure |
| 2 | Planner / executor split | Implicit via cot_process subtree + workflow service | Not implemented | **Medium** | Could be added as a "planning" mode on apps |
| 3 | Multi-agent / supervisor | Via workflow chaining, agent-to-agent task passing | Workflow agent nodes only; no agent → agent tool | **High** | Big gap for complex tasks |
| 4 | Tool schema | OpenAPI (standardized, validatable) + JSON Schema | JSON Schema only | Low | OpenAPI nice-to-have; not blocking |
| 5 | Tool execution sandbox | Out-of-process `core-link` HTTP service | In-process `import('./tools/<id>.js')` | **High** | Untrusted 3rd-party tools would run with full server privilege |
| 6 | Tool catalogue breadth | Plugin Square (in-platform sharing + Plugin Marketplace) + iFLYTEK Open Platform | ~10 built-in tools + workflows + sources + skills | **High** | We're missing user-shareable plugin catalogue UX |
| 7 | Tool ecosystem (3rd-party HTTP/REST) | Generic OpenAPI HTTP-tool runner with auth injection | None — every new HTTP tool needs a hand-rolled JS file | **High** | A `genericHttpTool` driven by OpenAPI would unlock dozens of integrations zero-code |
| 8 | MCP client | Full SSE MCP client via official lib, multi-server registration, SSRF guards, persistent | URL stub (`toolLoader.js:203`); no invocation, no protocol | **CRITICAL** | We claim MCP support but it's a placeholder |
| 9 | MCP server (expose own tools to other MCP clients) | Yes | No | **High** | Enables Claude/Cursor/etc. to call ihub-apps tools |
| 10 | Plugin packaging | Skill packages via SkillHub CLI + semver + tags | Catalog items: JSON/MD files; no semver, no signing | **Medium** | Marketplace exists but is feature-light |
| 11 | Marketplace UI (admin) | Plugin Square in-platform + SkillHub external | `AdminMarketplacePage.jsx`, `AdminMarketplaceRegistriesPage.jsx` | Low | We have it for admin; just needs end-user surface |
| 12 | Marketplace UI (end-user) | Plugin Square (browse, install, favourite, rate, "heat") | None | **Medium** | Discovery surface for non-admins |
| 13 | Versioning / updates of installed items | semver + `latest` tag + update-available checks | Single `version` field captured, no `update available` check | Medium | Already half-there in `ContentInstaller.update` |
| 14 | RPA — browser automation | Full multi-step browser DSL with element picker, 300+ atoms | Single-shot screenshot only | **High** | Big differentiator — real RPA |
| 15 | RPA — desktop automation | Yes (Win desktop, Office/WPS, ERP/finance) | None | **High** | Differentiator vs us |
| 16 | RPA — OCR / vision | `astronverse.vision` | OCR routes exist (`toolsService/ocrRoutes.js`) standalone, not as agent tool | Medium | Already have OCR; need to expose as tool |
| 17 | RPA — recorder | Picker engine implies recorder/inspector | None | High | Power-user feature; could come later |
| 18 | RPA — scheduler / trigger | Yes (`astronverse.scheduler`, `astronverse.trigger`) | Task scheduling exists in concepts (`concepts/2025-07-20 Task Scheduling and Async Execution.md`) but not built | High | We have the design |
| 19 | Tool usage analytics ("heat") | Redis-backed counters + favourites | `usageTracker.js` exists but tool-level surfacing is light | Low | Half-there |
| 20 | OpenTelemetry / observability | Full OTLP stack | Has `telemetry.js`/`telemetry/` | Low | Comparable |
| 21 | Agent skills lazy-loading | Not first-class | `activate_skill`, `read_skill_resource` (`toolLoader.js:437-475`) | **ihub-apps lead** | Mention as strength |
| 22 | ask_user / clarification turn | Not first-class | First-party tool with rate limits (`tools/askUser.js`) | **ihub-apps lead** | Mention as strength |
| 23 | Cross-provider tool format converters | Not advertised | `adapters/toolCalling/` (OpenAI/Anthropic/Google/Mistral/Bedrock/VLLM/OpenAI Responses) | **ihub-apps lead** | Solid engineering |

---

## 4. What we should reimplement (ranked)

Ranking criteria: user value, strategic positioning (vs. closed competitors and astron), unblocks downstream features, and effort.

| Rank | Feature | Scope | Risk | Dependencies |
|---|---|---|---|---|
| **1** | **Real MCP client (multi-server, SSE/stdio, schema-validated)** | M | Low | None — drop-in replacement of `discoverMcpTools` |
| **2** | **Generic OpenAPI HTTP tool runner** (define a tool by OpenAPI URL + auth profile, no JS code) | M | Low | TokenStorageService (for encrypted creds), validator |
| **3** | **MCP server endpoint** (expose ihub tools/apps over MCP) | M | Med | Needs auth model for clients (API keys); reuses tool registry |
| 4 | Browser-automation tool (Playwright DSL: click/type/screenshot/extract, multi-step) | M | Med | Playwright already a dep; sandbox isolation |
| 5 | Out-of-process tool sandbox (worker pool or container) for untrusted plugins | L | High | Need IPC protocol, resource quotas |
| 6 | Plugin marketplace v2: ratings/favourites/version updates/end-user browse UI | L | Low | Marketplace backbone exists |
| 7 | Planner / executor agent mode (toggle per app) | M | Med | Prompt templates; new app flag |
| 8 | Multi-agent supervisor (delegate to sub-agent tool) | L | High | Needs "agent as tool" wrapper |
| 9 | RPA-lite: scheduler + triggers for workflows-as-cron (uses existing workflow engine) | M | Med | Existing concept doc |
| 10 | OCR-as-tool (expose existing `toolsService/ocrRoutes.js` to agents) | S | Low | None |
| 11 | Tool usage analytics surfacing (heat / favourites) | S | Low | `usageTracker.js` |
| 12 | Desktop RPA via remote agent (later — not worth in v1) | XL | Very high | New runtime |

---

## 5. Implementation outline (top 3)

### 5.1 Real MCP client (rank #1)

**Why first** — We *claim* MCP support but the implementation is a one-line URL stub (`server/toolLoader.js:203-221`). This is the lowest-effort, highest-impact gap to close. MCP is becoming the de-facto standard for tool sharing across Claude, Cursor, VS Code, ChatGPT, etc.

**Module locations**
- New: `server/services/mcp/McpClientManager.js` — top-level singleton, manages multiple connections
- New: `server/services/mcp/McpServerConnection.js` — one per registered server, wraps the official `@modelcontextprotocol/sdk` client
- New: `server/services/mcp/transports/` — `SseTransport.js`, `StdioTransport.js`, `WebSocketTransport.js`
- New: `server/routes/admin/mcpServers.js` — CRUD for MCP server entries
- Modify: `server/toolLoader.js:203-221` — replace `discoverMcpTools` with a call into the manager; add an MCP code path in `runTool` (~`server/toolLoader.js:495`)
- Modify: `configCache.js` to load `config/mcpServers.json` and cache resolved tools

**Config schema delta** — new `contents/config/mcpServers.json`:
```jsonc
{
  "servers": [
    {
      "id": "github-mcp",
      "name": { "en": "GitHub MCP" },
      "enabled": true,
      "transport": "sse",                // sse | stdio | websocket
      "url": "https://mcp.example.com/sse",
      "command": null,                   // for stdio
      "args": [],
      "env": {},
      "auth": { "type": "bearer", "token": "ENC[...]" },
      "toolPrefix": "github_",           // collision avoidance
      "allowedTools": ["*"],             // or specific names
      "timeoutMs": 30000
    }
  ],
  "security": {
    "blockPrivateIps": true,
    "allowedHosts": [],
    "blockedHosts": ["localhost", "127.0.0.1", "169.254.0.0/16"]
  }
}
```

**Packaging / distribution** — MCP servers are NOT packaged by us; they are run by their authors. We register *connections*, not packages. Admin pastes a URL or `stdio` command line, we test connectivity, persist (with encrypted token), and pull `list_tools` on startup + every hour. Cache invalidates automatically.

**Security sandbox**
- SSRF guards mirroring `RegistryService.sanitizeRegistrySourceUrl` and `webContentExtractor.assertNotPrivateIp`
- Bearer/OAuth tokens encrypted at rest (use existing `TokenStorageService`)
- Per-tool group ACL: which user groups can see which MCP tool (extend existing `enhanceUserWithPermissions`)
- Hard timeout + cancellation token wired to existing `requestThrottler.js`
- Stdio transport: spawned as a child process with `uid:gid` drop if running as root, no shell, restricted PATH

**Tests** — `server/tests/mcp/`:
- Mock SSE server with two tools, one with optional params; verify discovery, invocation, error mapping
- Mock disconnection + reconnect path
- SSRF: refuse `http://localhost:8000/sse`
- Encrypted token round-trip
- Tool name collision: prefix applied

### 5.2 Generic OpenAPI HTTP tool runner (rank #2)

**Why second** — Today every new HTTP integration (Jira, iFinder, Entra, …) costs hundreds of lines of JS. astron-agent's `core-link` lets admins paste an OpenAPI document and immediately get a callable tool. We can match this without their microservice architecture.

**Module locations**
- New: `server/services/tools/OpenApiToolRunner.js` — takes a parsed OpenAPI doc + operationId + params → builds and sends an HTTP request → returns JSON
- New: `server/tools/openApiTool.js` — generic tool whose `runTool` path resolves the runner
- New: `server/validators/openApiToolDefSchema.js` — Zod schema for tool definitions of `type: "openapi"`
- Modify: `server/toolLoader.js` — when a tool entry has `type: "openapi"`, look up by operationId and dispatch through the runner
- Modify: `client/src/features/admin/pages/AdminToolEditPage.jsx` — new editor pane: paste OpenAPI URL → preview operations → pick one → set auth profile

**Config schema delta** — extend each tool entry in `contents/config/tools.json`:
```jsonc
{
  "id": "github_listRepos",
  "type": "openapi",
  "openapi": {
    "source": "https://api.github.com/openapi.json",   // url | inline | file
    "operationId": "repos/list-for-authenticated-user",
    "auth": {
      "type": "oauth2",          // bearer | basic | apiKeyHeader | apiKeyQuery | oauth2
      "credentialRef": "githubOAuth"   // → contents/config/credentials.json (encrypted)
    },
    "headers": { "Accept": "application/vnd.github+json" },
    "xDisplay": { "hideFields": ["node_id", "url"] }   // mirror astron's x-display
  },
  "name": { "en": "List my GitHub repos" },
  "description": { "en": "..." },
  "parameters": { /* auto-derived from OpenAPI but overridable */ }
}
```

**Packaging format** — A "tool plugin package" is a folder containing `tool.json` (the tool entry), optionally an `openapi.yaml` (inline source), and optional `README.md`. Marketplace `catalog.json` can list these with `type: "tool"`. `ContentInstaller` already has the dispatch table — extend with `tool` type pointing at `contents/tools/<name>.json`.

**Security sandbox**
- All outbound URLs run through SSRF guard (no private IPs, no `file:`, no `gopher:`)
- Credentials never leaked into LLM response: `xDisplay.hideFields` strips before serialisation
- Per-tool rate limit via existing `requestThrottler.js`
- Response size cap (e.g. 256 KB before truncation)
- Schema validation: every response validated against `responses.<status>.content` schema; oversized arrays auto-paginated

**Tests**
- Round-trip: OpenAPI doc → parameters JSON Schema → LLM call → HTTP request → response sanitisation
- Auth: bearer, basic, OAuth refresh token rotation
- Edge cases: required param missing → meaningful error to LLM; rate-limit 429 → retry-after
- `xDisplay` field stripping

### 5.3 MCP server endpoint (rank #3)

**Why third** — Once we have a strong tool catalogue (via 5.1 + 5.2), exposing those tools over MCP is a small wrapper that turns ihub-apps into an **MCP gateway**. Users of Claude Desktop / Cursor / Continue.dev / VS Code can plug in our tools.

**Module locations**
- New: `server/routes/mcpServer.js` — exposes `/mcp/sse` (SSE transport) and `/mcp/v1/*` JSON-RPC endpoints
- New: `server/services/mcp/McpServer.js` — wraps `@modelcontextprotocol/sdk/server`
- New: `server/middleware/mcpAuth.js` — API-key-based auth (since OAuth in MCP is still maturing)
- New admin page: `client/src/features/admin/pages/AdminMcpServerPage.jsx` to create API keys, set per-key tool ACLs, view usage
- Modify: `server/toolLoader.js:loadTools` already returns the catalogue; reuse for `list_tools` handler
- Reuse: `runTool` for `call_tool` handler

**Config schema delta** — new `contents/config/mcpServer.json`:
```jsonc
{
  "enabled": true,
  "path": "/mcp",            // mounted as /<base>/mcp
  "apiKeys": [
    {
      "id": "claude-desktop-andy",
      "keyHash": "$2b$12$...",      // bcrypt
      "userGroups": ["users"],      // ACL via existing groups
      "allowedTools": ["braveSearch", "iFinder_search"],
      "createdAt": "...",
      "lastUsed": "..."
    }
  ],
  "rateLimit": { "perMinute": 60 }
}
```

**Packaging format** — N/A. This is a server-side endpoint, not a packageable item.

**Security sandbox**
- All `call_tool` requests dispatch through `runTool` which already enforces tool name validation, isolated `import()`, and adapter-level auth checks
- Per-API-key rate limit via existing `requestThrottler.js`
- Audit log: every `call_tool` invocation logged with API key id + tool id + status (uses existing `usageTracker.js`)
- API keys hashed at rest (bcrypt) and shown plaintext exactly once at creation time
- Optional client allowlist (IP CIDR / DNS name)

**Tests**
- Connect via `@modelcontextprotocol/sdk/client` — discover tools — invoke a tool — verify result shape matches MCP spec
- Authn: bad API key → 401; expired key → 401; throttled key → 429
- ACL: API key with `allowedTools: ['x']` cannot call `y`
- SSE keepalive + reconnection

---

## 6. Open questions

1. **astron-agent loop semantics** — The `cot_runner.py` source body was not accessible via the methods used here. We inferred CoT/ReAct from naming + file structure ([github.com/iflytek/astron-agent/tree/main/core/agent/engine/nodes](https://github.com/iflytek/astron-agent/tree/main/core/agent/engine/nodes)). Could be ChainOfThought-only with no act step, in which case real multi-step tool use lives in the **workflow** service. Worth a follow-up read of the actual Python.
2. **astron Plugin Square packaging format** — DeepWiki describes OpenAPI as the schema and dual-state (Draft/Formal) lifecycle, but the actual artifact format (single OpenAPI yaml? zip? OCI image?) is undocumented in what was reachable. A peek at the `core/plugin/aitools` source would clarify.
3. **SkillHub package spec** — Hinted at by `SkillPackagePolicy.java` but the actual SKILL spec (frontmatter? layout?) was not visible. Likely compatible with Anthropic Agent Skills, which is what ihub-apps already supports.
4. **astron-rpa runtime requirement on the host** — Whether the desktop UI automation works headless inside Docker, or requires an Electron client + visible Windows session. If the latter, a server-side reimplementation in ihub-apps is unrealistic and we should partner / federate.
5. **astron's multi-agent collaboration mechanics** — Marketing mentions "supervisor agent" but the OSS repo organises this as workflow chains; whether there is a first-class agent-as-tool wrapper remains unclear.
6. **Should our marketplace go remote (SkillHub-style hosted registry) or stay GitHub-backed?** Trade-off: features (ratings/heat/RBAC namespaces) vs. infra burden. Worth a design doc before #6 above.
7. **MCP authentication standard** — Where to land between API-key (today's pragma), OAuth 2.1 client (emerging MCP spec), and mTLS. Pick one for v1.
8. **Out-of-process tool sandbox** (rank #5) — Worker threads vs. child processes vs. containers vs. WASM. Each has very different developer ergonomics and threat models.

---

## References (cited URLs)

- [iflytek/astron-agent repo](https://github.com/iflytek/astron-agent) — root README
- [iflytek/astron-agent/tree/main/core/agent](https://github.com/iflytek/astron-agent/tree/main/core/agent)
- [iflytek/astron-agent/tree/main/core/agent/engine/nodes](https://github.com/iflytek/astron-agent/tree/main/core/agent/engine/nodes)
- [iflytek/astron-agent/tree/main/core/plugin](https://github.com/iflytek/astron-agent/tree/main/core/plugin)
- [iflytek/astron-agent/tree/main/core/plugin/rpa](https://github.com/iflytek/astron-agent/tree/main/core/plugin/rpa)
- [iflytek/astron-rpa](https://github.com/iflytek/astron-rpa)
- [iflytek/skillhub](https://github.com/iflytek/skillhub)
- [DeepWiki: MCP Protocol Integration](https://deepwiki.com/iflytek/astron-agent/6.3-mcp-protocol-integration)
- [DeepWiki: Tool and Plugin Integration](https://deepwiki.com/iflytek/astron-agent/6-tool-and-plugin-integration)
- [DeepWiki: MCP Protocol and Plugin System](https://deepwiki.com/iflytek/astron-agent/9.4-mcp-protocol-and-plugin-system)
- [kingy.ai review of Astron Agent](https://kingy.ai/uncategorized/astron-agent-review-iflyteks-open-source-enterprise-ai-workflow-platform-is-the-real-deal/)
- [jimmysong.io on Astron Agent](https://jimmysong.io/ai/astron-agent/)
- Local files cited inline above (`server/toolLoader.js`, `server/services/chat/ToolExecutor.js`, `server/services/marketplace/RegistryService.js`, etc.)
