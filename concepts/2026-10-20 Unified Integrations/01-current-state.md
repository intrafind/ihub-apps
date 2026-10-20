# 01 · Current state: how iHub connects to external systems today

**Date:** 2026-10-20 · **Status:** Analysis · Part of [Unified Integrations](README.md)

This document is the inventory behind the concept. It lists every way iHub talks to an external system today, how each one is installed, configured, authenticated and used, and where they diverge. Section 5 names the existing pieces the proposal builds on; the proposal itself is in [03 · Product concept](03-product-concept.md).

## 1. The integrations we ship

| # | Integration | Kind | Admin config lives in | Admin page | Auth to the external system | How a user meets it |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Remote MCP servers (streamable HTTP, SSE, WebSocket) | MCP client | `contents/config/mcpServers.json` | Admin → Integrations → MCP servers (+ "Browse catalog", ~40 hosted servers hard-coded in `server/services/mcp/serverCatalog.js`) | shared secret via credential store (`bearer`, `header`, `basic`, `oauth` client credentials) **or** per-user OAuth 2.1 (`oauthUser`, PKCE, CIMD/DCR) | tool rows in the chat "+" menu (one row per server); `McpConnectCard` under an answer when a per-user server is not connected; Settings → Integrations → Your accounts |
| 2 | Local MCP servers (stdio) | MCP client | same file | same page | env vars in plaintext in the JSON | same as above |
| 3 | A2A agents | A2A client | `contents/config/a2aAgents.json` | Admin → Integrations → A2A agents | shared only (`apiKey`, `bearer`, `oauth` client credentials); no per-user auth | each agent skill becomes a tool `a2a__<agent>__<skill>` |
| 4 | OpenAPI tools | declarative tool | `contents/tools/<id>.json` with `type: "openapi"` | Admin → AI Workspace → Tools | shared `credentialRef` only | tool rows in the "+" menu |
| 5 | Script tools (Brave, Qwant, Staan, `read_url`, `evidence`, `ask_user`, scheduler and agent tools) | built-in tool | `contents/tools/*.json` + `server/tools/*.js` | Admin → Tools | varies (see 6–9) | tool rows, or hidden (interactive tools) |
| 6 | Web search providers (Brave, Staan, Qwant, native search of Google / OpenAI / Anthropic) | tool + provider | `providers.json` category `websearch` (API key inline, encrypted) + per-app `websearch` block | Admin → Providers → Web search providers | shared API key inline in `providers.json`, env fallback | "Web Search" switch in the "+" menu |
| 7 | Jira (native) | script tool + `JiraService` | `platform.jira` (not in the platform schema) + env `JIRA_OAUTH_*`; the `jira.json` tool definition is **not shipped** | Admin → Integrations → Atlassian Jira | per-user OAuth 2.0 PKCE, own token code, single slot | Settings → Integrations → Your accounts; in-chat prompt via `useIntegrationAuth.js` (hard-coded to Jira) |
| 8 | Office 365 (OneDrive, SharePoint, Teams files), Google Drive, Nextcloud | cloud storage picker | `platform.cloudStorage.providers[]` | Admin → Integrations → one page per provider | per-user OAuth via `OAuthIntegrationBase` + route factory | "+" menu → provider → file browser modal; Settings → Integrations → Your accounts. **No model-callable tools.** |
| 9 | Entra people search | script tool | env only (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`) | none | app-only client credentials | tool row |
| 10 | iFinder (search, content) and iAssistant | script tool + source type `ifinder` + source provider + model adapter | `platform.iFinder`, `platform.iAssistant`, env fallbacks | Admin → Providers (iFinder block), `_test` endpoints | per-user JWT signed with an admin-held key (no consent) | tool row, app `sources`, or iAssistant as a model. The user never "connects". |
| 11 | Sources (filesystem, url, ifinder, page) | knowledge | `contents/config/sources.json` | Admin → Sources | per source type | attached to apps only; no user picker |
| 12 | Outlook add-in, browser extension, Microsoft 365 Copilot agent, Nextcloud embed, Teams tab | inbound channels | `platform.officeIntegration`, `platform.browserExtension`, `platform.copilotAgent`, `platform.nextcloudEmbed` | Admin → Integrations hub cards (Teams has no card) | iHub's own OAuth clients, auto-created | Settings → Integrations → Access to iHub (Outlook manifest) |
| 13 | iHub as MCP server / A2A server (gateway) | inbound protocol | `platform.mcpServer` | Admin → Integrations → MCP gateway; Admin → OAuth → CIMD clients | iHub OAuth authorization server (DCR, CIMD, governance) | Settings → Integrations → Connected apps (grants to iHub) |
| 14 | OAuth clients, personal API keys | inbound credentials | `contents/config/oauth-clients.json` | Admin → OAuth → Clients / Connections | n/a | Settings → Integrations → Personal API keys |
| 15 | Marketplace registries | content catalog | `contents/config/registries.json` | Admin → Marketplace | registry secret inline, encrypted | admins install apps, models, prompts, skills, workflows. **Tools, MCP servers, sources, A2A agents and connectors cannot be installed from it.** |

Rows 12–14 are **inbound** (something connects *to* iHub). Rows 1–11 are **outbound** (iHub reaches *out*). Both are called "integrations" in the UI today and sit in the same admin section and on the same user page.

## 2. Five ways to do the same thing

### 2.1 Four per-user authentication stacks (three OAuth, one JWT)

| Stack | Used by | Discovery | Token store | Routes | Chat prompt |
| --- | --- | --- | --- | --- | --- |
| `JiraService` (own code) | Jira | fixed Atlassian endpoints | `TokenStorageService` → `contents/integrations/jira/<user>.json` | `/api/integrations/jira/*` via `oauthIntegrationFactory` | `useIntegrationAuth.js` (Jira only) |
| `OAuthIntegrationBase` | Office 365, Google Drive, Nextcloud | fixed per provider | `TokenStorageService` → `<service>/<user>__<providerId>.json` | `/api/integrations/<provider>/*` via the same factory | none (picker only) |
| MCP `oauthUser` | per-user MCP servers | RFC 9728 → RFC 8414, CIMD / DCR / pre-registered client | `TokenStorageService` → `mcp/<storageId>__<serverId>.json`; client registrations and tool catalog in storage namespaces | `/api/mcp/oauth/*` | `McpConnectCard` |
| iFinder JWT | iFinder, iAssistant | n/a | none (signed per request) | n/a | none |

Two chat connect cards exist with different looks (`IntegrationConnectionCard`, no dark mode, and `McpConnectCard`). Cloud storage has none.

### 2.2 Three ways to store a secret

- `credentialRef` into the central credential store (`contents/config/credentials.json`): MCP, A2A, OpenAPI tools, Jira, cloud storage, iFinder. (LDAP and NTLM use the same store for their bind passwords, but they are sign-in providers for iHub itself, not integrations, and are out of scope here.)
- Inline encrypted field: web search API keys in `providers.json`, marketplace registry auth.
- Environment only: Entra; env fallbacks for Brave, Staan, iFinder, Jira.

`cloudStorageSchema.js` still declares `clientSecret` and `tenantId` while the UI and migration V061 write `clientSecretRef` and `tenantIdRef`.

### 2.3 Three admin surfaces for "the catalog"

- The **Integrations hub** (`/admin/integrations`, `AdminIntegrationsPage.jsx`): eight hand-written cards (Outlook, browser extension, Copilot, Office 365, Google Drive, Nextcloud, Nextcloud embed, Jira). Status is guessed from `platform.json` fields, not from a live check.
- The **MCP server catalog** dialog (`McpServerCatalogDialog.jsx`): ~40 hosted servers, only those that work with one shared key.
- The **Marketplace** (`/admin/marketplace`): registries with `catalog.json`, install / update / uninstall / detach, five content types, none of them an integration.

Plus: iFinder and web search keys live under Providers, Entra has no page at all, MCP servers / MCP gateway / A2A / Credentials are separate sidebar entries, OAuth connections sit under Access & Identity.

### 2.4 Two ways a user "has" an integration

- **Connect once in Settings** (Jira, cloud storage, per-user MCP). The page lists only the systems that have per-user auth; iFinder, Entra, A2A and shared-key MCP servers never appear, so a user cannot see what they already have access to.
- **Toggle per chat** in the "+" menu (`enabledTools`, kept in browser `localStorage` and chat settings, never on the server). An app decides which tools exist; the user decides which of them are on for this chat.

There is no "my integrations" view that joins the two: *which systems can I use, which need me to sign in, which are on in this chat*.

### 2.5 One overloaded app field

`app.tools` mixes script tool ids, base ids (`jira` matches `jira_searchTickets`), MCP server ids, individual MCP tool ids and `a2a__<agent>` refs; `isToolSelected()` in `server/utils/toolSelection.js` resolves them. Sources, workflows, apps-as-tools, skills, web search and cloud storage each have their own field (`sources`, `workflows`, `apps`, `skills`, `websearch`, `upload.cloudStorageUpload`). The admin app editor has a separate picker for each.

## 3. Permission model today

| Key in `groups.json` | Exists | Note |
| --- | --- | --- |
| `apps`, `prompts`, `models`, `workflows`, `skills` | yes | resolved with inheritance |
| `tools` | yes (V100, default `[]`) | meant for the gateway, also feeds `GET /api/tools` |
| `scheduledTasks`, `adminAccess`, `contentAdmin` | yes | |
| MCP servers, sources, A2A agents, cloud storage, Jira, connectors | **no** | scoped only indirectly through the apps that reference them; browser extension has `allowedGroups` |

In chat the app's `tools` list is what grants a tool. A per-user MCP server is visible to a user when some app the user can use references it.

## 4. Write actions and safety

- No tool-call approval UI exists in chat. Jira's `requireConfirmation` parameter writes a log line. `requireApprovalFor` in the loop contract and the `preTool` seam exist but nothing enforces them. Durable `approval` interactions exist in `InteractionService` for scheduled and agent runs.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) are not surfaced or used for gating.
- Headless runs (scheduled tasks, workflows) on per-user MCP servers get `MCP_AUTH_REQUIRED` with no path to reconnect.

## 5. What already points in the right direction

- **`TokenStorageService`** (AES-256-GCM per user, service and provider) and **`CredentialService`** (`credentialRef`) are the right two stores: one for personal grants, one for shared secrets.
- **MCP `oauthUser`** is a complete, spec-conformant outbound OAuth 2.1 client with discovery, CIMD, DCR, PKCE and per-user connection pooling. It is the most modern of the four stacks and the one to generalize.
- **Answer Sources** (`docs/answer-sources.md`, `docs/integration-development.md`) already give every integration one contract for results, citations, preview and download. The user-facing *output* side is unified; the *input* side (install, enable, connect, pick) is not.
- **The marketplace** has registries, `catalog.json`, install tracking, update detection, detach, audit, and a user-side "add from marketplace" flow for skills. It needs new item types, not a new engine.
- **The Integrations hub** shell (`AdminIntegrationHubPage.jsx`: search, category sections, status pills) is a usable catalog layout.
- **The connection-framework draft** (`concepts/third-party-integrations/01-framework.md`, 2026-09-24) already proposes connector definitions, personal vs shared connections, an app binding, one connect card, confirmed writes, group permissions and migration of the four OAuth integrations. It deliberately leaves MCP out. This concept folds MCP, A2A, OpenAPI and the channels into the same model.

## 6. Pain points, by role

**Admin.** "Where do I add X?" has five answers. Three of the eight hub cards do nothing but link to a form that writes into `platform.json`. Status pills are guesses. Jira cannot be enabled without hand-writing a tool JSON. There is no way to say "only group Sales may use HubSpot". There is no way to distribute an MCP server or a connector through the marketplace to another iHub installation.

**User.** Settings → Integrations shows some systems, the chat "+" menu shows others, neither shows all. Connecting happens in three different cards. A tool that needs sign-in fails differently depending on which stack it uses. Nothing says what a tool will *do* (read or write) before it does it.

**Product.** Every new system is a project: a service class, a route file, an admin page, a settings card, a chat prompt, translations. The Claude directory lists 842 remote MCP servers; iHub can offer 40 of them, and none through the marketplace. The systems IntraFind customers actually run (SharePoint on-prem, Confluence/Jira Data Center, SAP, d.velop, enaio, nscale, ELO, M-Files, Nextcloud, openDesk) are not in anyone's directory, which is the opportunity, but only if adding one is cheap.

**Engineering.** Four OAuth implementations to keep secure (the 2026-05-11 security-parity concept had to port seven fixes between cloud providers by hand). Two `IntegrationCard` components. Four toggle styles. Two accent colours.
