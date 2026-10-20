# 04 · Architecture: data model, adapters, auth, APIs, migration

**Date:** 2026-10-20 · **Status:** Proposal · Part of [Unified Integrations](README.md)

This document turns [03 · Product concept](03-product-concept.md) into files, schemas, services and routes. It builds on what exists: `CredentialService`, `TokenStorageService`, the MCP `oauthUser` client, `OpenApiToolRunner`, `A2aClientManager`, the marketplace `RegistryService` / `ContentInstaller`, Answer Sources, and the connection-framework draft in `concepts/third-party-integrations/01-framework.md`.

## 1. Three records

```
IntegrationDefinition   (catalog, immutable per version)   contents/integrations/<id>.json
        │ 1..n
InstalledIntegration    (admin instance)                    contents/config/integrations.json
        │ 1..n
Connection              (principal credential)              storage namespace `integration-connections`
                                                            + TokenStorageService for the secret material
```

### 1.1 IntegrationDefinition

```jsonc
{
  "$schema": "https://ihub.intrafind.com/schemas/integration/v1.json",
  "id": "com.atlassian/jira-confluence",          // reverse-DNS, registry-compatible
  "version": "2.1.0",
  "name": { "en": "Atlassian Jira & Confluence", "de": "Atlassian Jira & Confluence" },
  "description": { "en": "…", "de": "…" },
  "publisher": { "name": "Atlassian", "url": "https://atlassian.com", "verification": "partner" },
  "icon": "icons/atlassian.svg",                   // relative to the definition, or https URL
  "categories": ["productivity", "ticketing"],
  "docsUrl": "…", "privacyPolicyUrl": "…", "license": "…",

  "protocol": {                                    // exactly one adapter
    "type": "mcp-remote",                          // mcp-remote | mcp-stdio | openapi | native | a2a | storage | websearch
    "endpoint": { "url": "https://mcp.atlassian.com/v2/mcp" },
    "transport": "streamable-http",
    "protocolVersions": ["2026-07-28", "2025-11-25"]
  },

  "auth": {
    "modes": ["oauth-user", "service-account"],    // what the admin may choose at install time
    "default": "oauth-user",
    "oauthUser": {                                 // hints; live discovery (RFC 9728/8414) wins
      "clientModes": ["cimd", "dcr", "own-client"],
      "scopesDefault": ["read:jira-work", "write:jira-work", "read:confluence-content.all"],
      "enterpriseManaged": true                    // server advertises the ID-JAG grant profile
    },
    "serviceAccount": { "kind": "basic", "fields": ["email", "apiToken"] }
  },

  "install": [                                     // ConfigField[] shown in the install wizard
    { "key": "region", "type": "enum", "title": {"en":"Region"}, "choices": [
        { "value": "eu", "label": {"en":"Cloud (EU)"}, "set": { "protocol.endpoint.url": "https://mcp.atlassian.com/v2/mcp" } },
        { "value": "dc", "label": {"en":"Data Center"}, "requires": ["baseUrl"] } ],
      "required": true, "default": "eu", "scope": "admin" },
    { "key": "baseUrl", "type": "url", "title": {"en":"Server URL"}, "scope": "admin", "injectAs": "urlVariable" }
  ],

  "capabilities": ["tools", "views"],
  "actions": [                                     // optional static list; MCP/OpenAPI adapters refresh it live
    { "name": "search", "title": {"en":"Search issues"}, "effect": "read" },
    { "name": "add_comment", "title": {"en":"Add comment"}, "effect": "write" },
    { "name": "delete_issue", "effect": "destructive" }
  ],
  "trusted": false,                                // honour the server's own tool annotations?
  "runs": "cloud",                                 // cloud | on-prem | local
  "dataResidency": ["eu"],
  "_meta": { "io.modelcontextprotocol.registry/official": { … } }   // passthrough from server.json
}
```

**Adapters** map protocol specifics into the shared model:

| `protocol.type` | Backed by today | Actions come from | Connection means |
| --- | --- | --- | --- |
| `mcp-remote` | `McpServerConnection`, `McpClientManager` | live `tools/list` (cached with `ttlMs`, refreshed on `list_changed`) with annotations → effect | per-user OAuth 2.1 (`oauthUser` stack) or shared secret |
| `mcp-stdio` | same | same | env vars from install fields marked `sensitive` → credential store |
| `openapi` | `OpenApiToolRunner` | operations; effect from HTTP method (GET/HEAD → read, POST/PUT/PATCH → write, DELETE → destructive) with per-operation override | per-user OAuth (generic authorization-code client, new), per-user API key, shared `credentialRef` |
| `native` | `server/services/integrations/connectors/<id>/` (Jira, Microsoft 365, iFinder, Entra, SAP, DMS…) | the module's declared actions | whatever the module declares (OAuth user, JWT SSO, service account) |
| `a2a` | `A2aAgentConnection` | agent card skills → actions, effect `write` by default (an agent may act) | shared secret; per-user later |
| `storage` | `OAuthIntegrationBase` providers | capability `files` (browse, pick); optional actions `search`, `read`, `save` from `08-cloud-files.md` | per-user OAuth |
| `websearch` | Brave, Staan, Qwant scripts | one action `search`, effect `read` | shared API key |

A definition can be imported from **`server.json`** (MCP registry) and from an **MCPB manifest**; the importer maps `packages[]`/`remotes[]`, input objects and `user_config` into `protocol`, `install` and `auth`. Our fields beyond the standards live under `_meta["com.intrafind/ihub"]` when exported.

### 1.2 ConfigField (one type, four uses)

```jsonc
{ "key": "apiToken", "type": "string|number|boolean|enum|url|secret|file|directory",
  "title": {…}, "description": {…}, "required": true, "default": null, "sensitive": true,
  "choices": [...], "min": 0, "max": 100, "multiple": false, "pattern": "…",
  "scope": "admin|user",                   // who fills it: install wizard or the user's Connect dialog
  "injectAs": "env|arg|header|urlVariable|body|credentialRef" }
```

Used by the install wizard (admin fields), the user Connect dialog (user fields: a PAT, a Nextcloud server), MCPB `user_config` import, registry input objects, and MCP elicitation forms. `sensitive` values never land in `integrations.json`; the wizard writes them to the credential store (admin) or `TokenStorageService` (user) and keeps a ref.

### 1.3 InstalledIntegration

```jsonc
// contents/config/integrations.json
{
  "installed": [
    {
      "id": "jira-eu",                              // instance id, referenced by apps and groups
      "definition": "com.atlassian/jira-confluence", "definitionVersion": "2.1.0",
      "label": { "en": "Jira (EU)" },
      "enabled": true,
      "values": { "region": "eu" },                 // install field values (non-sensitive)
      "auth": { "mode": "oauth-user", "clientMode": "cimd" },          // or own-client + clientId + clientSecretRef
      // "auth": { "mode": "service-account", "credentialRef": "jira-svc" }
      // "auth": { "mode": "enterprise-managed", "idpIssuer": "https://login.example.com" }
      "actions": { "enabled": ["*"], "disabled": ["delete_issue"],
                   "policy": { "write": "ask", "destructive": "ask", "overrides": { "add_comment": "allow" } },
                   "newActions": "ask" },           // what happens when the server adds a write tool
      "rollout": { "stage": "all" },                // or { "stage": "pilot", "groups": ["it-pilot"] }
      "toolPrefix": "jira__",                       // MCP only; default <id>__
      "views": true,                                // render MCP Apps
      "timeoutMs": 30000,
      "health": { "status": "ok", "checkedAt": "…", "actionCount": 21, "message": null }   // written by the health loop, not by admins
    }
  ],
  "policy": {                                       // platform-wide ceiling (LibreChat-style globs)
    "rules": [ { "match": "*:delete_*", "policy": "block" }, { "match": "*", "effect": "destructive", "policy": "ask" } ],
    "allowAlways": false                            // may users choose "always allow" in the confirmation card?
  },
  "security": { "blockPrivateIps": true, "allowedHosts": [] }
}
```

`groups.json` gains `permissions.integrations: ["jira-eu", "*"]`, resolved with inheritance in `server/utils/authorization.js` like `apps` and `skills`.

### 1.4 Connection

```jsonc
{ "id": "conn_…", "integration": "jira-eu",
  "principal": { "type": "user", "id": "u123" },            // or { "type": "shared", "groups": ["legal"] }
  "kind": "oauth-user|api-key|service-account|sso",
  "status": "active|expired|revoked|failed|needs-reconnect",
  "issuer": "https://auth.atlassian.com",                   // OAuth: credentials are keyed by issuer (MCP spec)
  "scopesGranted": ["read:jira-work"], "externalAccount": { "id": "…", "label": "daniel@…" },
  "expiresAt": "…", "lastRefreshedAt": "…", "lastUsedAt": "…", "error": null,
  "secretRef": "tokenstore:integrations/jira-eu/u123" }    // never the token itself
```

The index lives in the pluggable storage namespace `integration-connections` (like `mcp-oauth-clients` today); the secret material stays in `TokenStorageService` so existing Jira, cloud storage and MCP tokens keep working after a one-time re-index. Shared connections reference `credentials.json` profiles.

## 2. Services

```
server/services/integrations/
  IntegrationRegistry.js        load definitions (shipped + contents/integrations + registries), validate, version
  IntegrationCatalogService.js  merge built-in catalog, marketplace registries (type integration), optional MCP sub-registry
  IntegrationInstaller.js       wizard backend: validate ConfigFields, write instance, store secrets, run test, migrate on update
  InstalledIntegrationService.js CRUD, enable/disable, action policy, rollout, health loop (reuses MCP health + OpenAPI probe)
  ConnectionService.js          index + status; connect/reconnect/disconnect; resolve(principal, integration) for tool runs
  auth/
    OAuthUserClient.js          generic authorization-code + PKCE client (generalized from mcpOAuthService: discovery, CIMD, DCR, own client, step-up scopes)
    EnterpriseManagedAuth.js    ID-JAG token exchange with the IdP, jwt-bearer at the resource AS (phase 3)
    ServiceAccountAuth.js       credentialRef resolution (bearer, basic, header, client credentials)
  adapters/
    McpAdapter.js  OpenApiAdapter.js  NativeAdapter.js  A2aAdapter.js  StorageAdapter.js  WebsearchAdapter.js
    index.js                    adapter contract: discoverActions(instance, connection), run(action, params, ctx), test(instance), files?(…)
  connectors/                   native modules: jira/, microsoft365/, ifinder/, entra/, … each exporting a definition + adapter impl
  policy/ApprovalGate.js        effect × policy × platform rules → run | ask | block; wired into AgentLoop preTool
  importers/serverJson.js  mcpb.js
```

`toolLoader.getToolsForApp` resolves `app.integrations` → installed integrations the user may use → enabled actions → tool definitions (names stay `<instanceId>__<action>` so `isToolSelected` and Answer Sources' `provider` logic keep working). `runTool` dispatches to the adapter, which asks `ConnectionService.resolve()` for the connection: the user's own, or the binding's shared one. No connection → structured result `{ error: "INTEGRATION_AUTH_REQUIRED", integration, reason, connectUrl }`, which renders the one Connect card.

The MCP `oauthUser` code moves, it is not rewritten: `mcpOAuthService.js` becomes `auth/OAuthUserClient.js` with the MCP-specific discovery kept as a strategy; the OpenAPI and native adapters reuse it with fixed endpoints. `JiraService`, `Office365Service`, `GoogleDriveService`, `NextcloudService` drop their own token code and call `ConnectionService`.

## 3. Approval gate

`ApprovalGate.decide({ instance, action, user, chatPolicy })`:

1. Platform rules (`policy.rules`, first match wins, deny → ask → allow).
2. Instance override for the action, else instance policy for the action's effect.
3. For `read`: run. For `ask`: look up the chat-scoped memory (`once`, `chat`, `always` if `allowAlways`); if none, emit an `approval` interaction through `InteractionService` with the rendered payload; `AgentLoop` pauses the tool call until answered (`approve`, with edited params; `reject`). Headless runs persist the interaction to the owner's inbox.
4. For `block`: the action is not offered to the model at all (removed in `getToolsForApp`).

Effect for MCP actions: `readOnlyHint: true` → read; `destructiveHint: true` (its default) → destructive; else write. If the instance is not `trusted`, missing annotations are treated as *write*, never as read. An action that appears after install (`list_changed`) gets the `newActions` policy (default *ask*) and is flagged "new" in the admin Actions tab, as Microsoft and ChatGPT do.

## 4. API surface

| Route | Purpose |
| --- | --- |
| `GET /api/admin/integrations/catalog?q&category&auth&protocol&registry` | merged catalog with installed / update flags |
| `GET /api/admin/integrations/catalog/:definitionId` | detail, actions, install fields |
| `POST /api/admin/integrations/catalog/:definitionId/_test` | test an unsaved instance |
| `GET/POST /api/admin/integrations` · `GET/PUT/DELETE /api/admin/integrations/:id` | installed instances |
| `POST /api/admin/integrations/:id/_test` · `_enable` · `_disable` · `_update` (from registry) · `_detach` | lifecycle |
| `GET /api/admin/integrations/:id/actions` · `PUT …/actions` | live action list, enable, policy |
| `GET /api/admin/integrations/:id/connections` · `DELETE …/connections/:connId` | connected principals, revoke |
| `GET/POST /api/admin/integrations/connections/shared` | shared connections |
| `GET /api/admin/integrations/requests` · `POST …/:id/_approve|_decline` | member requests (phase 2) |
| `GET /api/integrations` | for the user: allowed instances with capabilities, actions, connection status |
| `POST /api/integrations/:id/connect` → `{ url }` · `GET /api/integrations/oauth/callback` · `POST /api/integrations/:id/disconnect` · `POST …/reconnect` | one connect flow for every protocol; callbacks `/api/integrations/jira/callback` and `/api/mcp/oauth/callback` stay registered as aliases because they are configured in vendor OAuth apps |
| `GET/PUT /api/integrations/preferences?app=` | per-user, per-app enabled set (replaces `localStorage` `enabledTools`) |
| `POST /api/integrations/requests` | member asks for a catalog integration (phase 2) |
| `GET /api/integrations/:id/files?path` (storage adapters) | file browser, replaces the three provider-specific browser routes |

Route ids are validated against the registry (no path building from input), outbound calls go through `safeFetch` and the SSRF guard, response sizes are capped as in `OpenApiToolRunner`. All admin routes write audit entries (`integration.install|update|enable|disable|uninstall`, `connection.create|revoke`, `action.policyChange`, and `action.execute` for write and destructive effects, without payloads).

## 5. Client

| Area | Component | Replaces |
| --- | --- | --- |
| Admin list | `AdminIntegrationsPage` on `DataTable` | `AdminMcpServersPage`, `AdminA2aAgentsPage`, hub cards |
| Catalog | `IntegrationCatalog` (cards, filters, slide-over detail reusing `MarketplaceItemDetail`) | `McpServerCatalogDialog`, marketplace type tabs gain `integration` |
| Install wizard | `IntegrationInstallWizard` (steps from `ConfigField[]`, `CredentialRefSelect`, `GroupMultiSelect`, `IntegrationTestResults`) | per-integration forms (`JiraConfig`, `CloudStorageConfig`, MCP modal) |
| Instance page | `AdminIntegrationDetailPage` with `AdminTabs`: Overview, Actions, Connections, Bindings, Audit, Settings | — |
| App editor | `IntegrationsConfigSection` with one picker (integration → actions → connection mode) | `ToolsConfigSection`, `McpToolsConfigSection`, `A2aAgentsSelector`, `UploadConfigSection.cloudStorageUpload`, `WebSearchSection` (web search becomes an integration row) |
| User settings | `IntegrationsPage` → "Available to you" list with one `IntegrationRow` | the two `IntegrationCard`s |
| Chat | `ChatInputActionsMenu` → `IntegrationPicker`; `IntegrationChips` under the composer; `ConnectCard`; `ApprovalCard`; `ToolActivity` rows with logo + effect | `IntegrationConnectionCard`, `McpConnectCard`, `useIntegrationAuth`, Jira-only prompts |
| Shared | `Switch`, `Badge`, `StatusDot`, `Drawer` in `shared/components` | the seven hand-rolled switches, the two drawers |

Design tokens: indigo accent, `text-2xl font-semibold` headers, `DataTable` lists, shared `Modal`/`ConfirmDialog`, dark mode on every new component, `t('integrations.*')` and `t('admin.integrations.*')` keys in `shared/i18n/{en,de}.json`.

## 6. Marketplace

- `catalogSchema.js`: add `type: "integration"`; content is the definition JSON plus optional `icon` and `README.md` (companions, like skills).
- `ContentInstaller`: write to `contents/integrations/<id>/integration.json`; after install, open the wizard (the instance is created by the wizard, not the installer, so one definition can be installed twice). `_update` re-validates existing instances against the new definition and shows a diff of install fields and actions; `_detach` and `_uninstall` as today (uninstall refuses while instances exist).
- `RegistryService`: a new registry kind `mcp-registry` (read-only) that pages `GET /v0.1/servers` and converts `server.json` on the fly, labelled community. Off by default; `features.integrationsMcpRegistry`.
- Built-in catalog: `server/services/mcp/serverCatalog.js` becomes `server/defaults/integrations/*.json` (one definition each) listed by a shipped registry entry `ihub-builtin`.

## 7. Migration (forward-only, `server/migrations/`)

| Migration | What it does |
| --- | --- |
| `V1xx__integrations_from_mcp_servers` | each `mcpServers.json` server → an ad-hoc definition `local/<id>` (protocol `mcp-remote` or `mcp-stdio`) + an instance with the same id, `auth` mapped (`oauthUser` → `oauth-user`, others → `service-account` with the same refs), `allowedTools` → `actions.enabled`, `apps.enabled` → `views` |
| `V1xx__integrations_from_a2a` | same for `a2aAgents.json` |
| `V1xx__integrations_from_platform` | `platform.jira` → instance `jira` of the shipped `com.intrafind/jira` definition; `platform.cloudStorage.providers[]` → instances of the storage definitions; `platform.iFinder` → instance `ifinder`; web search providers → instances of `websearch/*` with the API key moved into the credential store; Entra from env → instance `entra` (env still read as fallback, like providers) |
| `V1xx__groups_integrations_permission` | `permissions.integrations` on every group: `["*"]` for groups that could use everything before (there was no gating), the browser extension's `allowedGroups` untouched |
| `V1xx__apps_integrations_binding` | `app.tools` (script ids, base ids, MCP server ids, `a2a__` refs), `app.upload.cloudStorageUpload`, `app.websearch` → `app.integrations[]`; pure script tools that are not integrations (`ask_user`, `evidence`, scheduler, agent tools) stay in `app.tools` |
| re-index | on first start after the migration, `ConnectionService` scans `contents/integrations/*/` token files and builds the connection index; no token is moved |

Breaking changes to decide explicitly (CLAUDE.md rule): the admin routes `/api/admin/mcp/servers`, `/api/admin/a2a/agents`, `/api/admin/configs/platform` writes for `jira`/`cloudStorage`, and the three cloud file-browser routes. Recommendation: clean break for admin routes (they are UI-internal) and aliases only for the OAuth callback URLs that customers registered in vendor consoles.

## 8. Non-functional

- **Multi-server**: instances and definitions are files (synced like all `contents/`); connections and health in pluggable storage; the health loop runs on one worker.
- **Performance**: action lists cached per instance with `ttlMs`; per-user MCP tool lists cached per connection; the chat picker reads one `GET /api/integrations` per app open.
- **Security**: secrets only by ref; `trusted` gates annotations and app-only tools; SSRF guard on every URL field; `blockPrivateIps` default on; stdio only from shipped or admin-written definitions, never from registries; community registries show the pre-install warning; audit on all lifecycle and write events; connections revoke upstream when the server supports it.
- **Tests**: unit tests for adapters' effect derivation, `ApprovalGate`, `ConnectionService.resolve`, migrations (fixtures from today's files); e2e: install from catalog → test → enable for group → user connects → tool call → approval → audit; the `known-routes-sync` test for the new routes.
