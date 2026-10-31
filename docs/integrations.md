# Integrations

An **integration** connects iHub to an external system and gives the model a set of **actions** (tools) to use it. Integrations are installed from a catalog, configured per installation, and bound to apps. This page covers the installable integrations under **Admin → Integrations → Installed**, including the built-in iFinder, iAssistant, web search and Jira integrations; the MCP servers, A2A agents and the remaining built-in connectors (cloud storage) keep their own pages until they move onto the same model (see the [Unified Integrations concept](https://github.com/intrafind/ihub-apps/tree/main/concepts/2026-10-20%20Unified%20Integrations) in the repository).

The catalog ships with the **CKAN Open Data Portal** (GovData, the German state and city portals, data.gov, internal data catalogs), which is also published in the [iHub Marketplace](marketplace.md), and with the [built-in integrations](#built-in-integrations) **iFinder**, **iAssistant**, **Web search** and **Atlassian Jira**.

## Three records

| Record | Where | What |
| --- | --- | --- |
| **Definition** | `server/defaults/integration-definitions/<folder>/` (shipped) or `contents/integration-definitions/<folder>/` (installed from a registry; wins over a shipped one with the same id) | The catalog entry: id, version, protocol, auth modes, install fields, actions, scopes, sources. Never carries a secret or an installation's values. |
| **Installed integration** | `contents/config/integrations.json` | The admin's instance: endpoint and other install values, sign-in mode, groups, which actions are on. One definition can be installed several times (two portals, two labels). |
| **App binding** | `app.integrations[<instanceId>]` | Which installations an app offers, optionally narrowed to some actions, with the scope settings users start with. |

A definition's folder name is its id with the one `/` replaced by `__`: `org.ckan/open-data-portal` lives in `org.ckan__open-data-portal/`.

## Built-in integrations

**iFinder** (`com.intrafind/ifinder`) and **iAssistant** (`com.intrafind/iassistant`) are shipped definitions marked `builtIn: true`. They differ from a catalog integration in four ways:

- Each is installed once, under a fixed id (`singleton`): the iFinder installation is always `ifinder`, the iAssistant installation always `iassistant`. Apps, group tool grants and the chat refer to these ids.
- They are implemented by the `native` protocol: a server connector module (`server/services/integrations/protocols/native/connectors/`) instead of an OpenAPI document. The install fields, the **Test** button and the app binding work as for any other installation.
- They are always in the catalog and are never uninstalled from a registry; the marketplace cannot replace them.
- Their actions keep their historical tool ids: the iFinder actions are the tools `iFinder_search`, `iFinder_getContent`, `iFinder_getMetadata`, `iFinder_discover`, `iFinder_getFields`, `iFinder_getFacetValues` and `iFinder_listProfiles`, not `ifinder__search`. Group tool grants (`permissions.tools` in `groups.json`) that name `iFinder` or `iFinder_*` keep working.

The iAssistant installation has no base URL of its own: its `connection` field names the iFinder installation it runs on. The fields of both installations are described in [iFinder Integration](iFinder-Integration.md#configuration) and [iFinder & iAssistant Admin Guide](ifinder-iassistant-admin-guide.md).

**Web search** (`com.intrafind/web-search`, installation `websearch`) is the third built-in: it holds the Brave and Staan API keys as credential references, the default search engine and the groups that may search, and its actions are the search tools `braveSearch`, `staanSearch`, `qwantSearch` and the page reader `read_url` (same ids as before). Apps do not bind it; they switch web search on in their own `websearch` settings, and an app with web search on requires the installation like a bound one. See [Web Tools](web-tools.md).

**Atlassian Jira** (`com.intrafind/jira`, installation `jira`) is the first built-in that signs every user in (`auth.modes: ["oauth-user"]`): the installation holds the OAuth app's client id, client secret (credential reference) and redirect URI; each user connects their Atlassian account once through `/api/integrations/jira/auth` (from the chat prompt or **Settings → Integrations**), and the six actions (`jira_searchTickets`, `jira_getTicket`, `jira_addComment`, `jira_getTransitions`, `jira_transitionTicket`, `jira_getAttachment`, ids unchanged) run as that user. **Connections** on the installed list shows who connected and disconnects a user. See [Jira Integration](JIRA_INTEGRATION.md).

### MCP servers

An MCP server is an installed integration of the `mcp` protocol. iHub ships the generic **MCP server** definition (`com.intrafind/mcp-server`: any Streamable HTTP, SSE or WebSocket endpoint, or a local process over stdio) and one definition per hosted server of the former built-in catalog (`mcp/microsoft-learn`, `mcp/context7`, `mcp/github`, `mcp/drawio`, …), each with its endpoint fixed and its sign-in mode set. All of them are `builtIn` and may be installed several times (two GitHub organisations, two draw.io installations). The server's tools are the installation's actions: they are not written into the definition but listed when iHub connects, so the wizard shows them after **Test connection** and the admin switches single tools off. Tool ids are `<toolPrefix or id__><tool>`, e.g. `drawio__create_diagram`; per-user OAuth, MCP App views and the inbound gateway are as described in [MCP Integration](mcp-integration.md). Migration V193 turned every server of the former `config/mcpServers.json` into an installation under the same id.

### Code-based integrations (`script`)

A definition may bring its own connector module instead of an OpenAPI document: `"protocol": { "type": "script", "module": "connector.js" }`, with `connector.js` as a companion file in the folder. The module has the same contract as a built-in native connector (`export default { id, actions: { <name>: { parameters, run(args, ctx) } }, test(ctx), scopeProvider(resolved), onChanged({ before, after }) }`; `ctx` carries `definition`, `instance`, `values`, `user`, `chatId`, `scope`, `params`) and is run by the same adapter, so a built-in integration is just the case where the module lives inside the server. Because the module runs in the server process:

- a registry may deliver such an integration only when the admin marked it as **trusted for code** (**Admin → Marketplace → Manage Registries → Edit**); the install is refused otherwise (`CODE_NOT_TRUSTED`);
- the catalog item must list a hash for every code file (`source.integrity`, `"connector.js": "sha256-<base64>"`), and the fetched file must match it (`CODE_INTEGRITY_REQUIRED`, `INTEGRITY_MISMATCH`);
- the Catalog tab marks the definition **Runs code on this server**, and the wizard says so before the install;
- the connector is **one file**: the module named in `protocol.module` is the only code file (`.js`, `.mjs`, `.cjs`) the folder may carry, and it imports nothing from the folder (`import … from './lib.js'`, `import('./lib.js')`, `require('./lib.js')`). A connector written as several modules is bundled before it is published (esbuild: `esbuild src/connector.js --bundle --format=esm --platform=node --outfile=connector.js`; rollup works the same way). The install refuses a second code file (`SCRIPT_EXTRA_CODE_FILES`, naming the files) and an entry module with a relative import (`SCRIPT_RELATIVE_IMPORT`); the latter is a text check over the source, so the path must not appear in a comment or a string either. The reason: iHub imports the entry module with a cache-buster in its URL (`?v=<version>-<mtime>`), so an update from the Marketplace runs the new code at once, but a relative import inside it resolves to the plain file URL, which Node's module cache keeps from the previous version — a fix shipped in a helper file would silently not take effect until a restart.

After an update the previous module version is dropped (actions, the test and the installation's scope provider all come from the new one). A connector that declares `scopes` and a `scopeProvider` has its provider registered at startup, on a (re-)install on any worker and when an admin saves the installation: iHub loads the module before it registers the scope providers.

A shipped definition never uses `script` (it is `native`); the shipped IntraFind registry is the place to publish connectors such as Jira or Microsoft 365 that cannot be expressed as an OpenAPI document.

### Remote A2A agents

A remote agent (Agent-to-Agent protocol) is an installed integration of the `a2a` protocol, installed from the shipped **A2A agent** definition (`com.intrafind/a2a-agent`): the Agent Card URL, a sign-in mode (none, a shared token or API key, or an OAuth client) and the call budget are its install values. The card's skills are the installation's actions, listed after **Test connection**; tool ids stay `a2a__<id>__<skill>`. Calling an agent, its conversations and the inbound side are described in [A2A Agents](a2a-agents.md). Migration V194 turned every agent of the former `config/a2aAgents.json` into an installation under the same id.

## Installing

1. **Admin → Integrations → Installed → Catalog** lists every definition: shipped ones and those installed from the [Marketplace](marketplace.md) (type **Integrations**).
2. **Install** opens a wizard generated from the definition's install fields:
   - **Name**: the instance id apps refer to, and a label users see in the chat.
   - **Settings**: the definition's fields (URL, numbers, switches, choices). Advanced fields are folded away.
   - **Sign-in**: the modes the definition offers and the protocol can run. *No sign-in* for public APIs; *Shared service account* stores one secret for everyone in the credential store (`integration-<instanceId>-<field>`), never in a config file; *OAuth client* (client credentials) and *Each user signs in* (per-user OAuth) are available for MCP servers, the other protocols get them in a later release. A field that applies to one mode or one transport only (its `when` clause) is shown only then.
   - **Who may use it**: groups, or everyone who may use an app that binds the integration.
   - **Actions**: which of the definition's actions the model may call. Each shows its side effect (read, write, destructive). Actions that need a token are off while sign-in is *none*; actions with a requirement (for example SQL on a DataStore) appear once the setting is on. For an MCP server the list is what the server reports after a test (or on edit); a tool the server adds later is on by default.
3. **Test connection** runs the definition's health action with the values as entered and lists the actions the model would get (for an MCP server: connects and lists its tools). Nothing is saved until **Install**.

Installed instances can be tested, edited, disabled and removed from the **Installed** tab, which also shows the connection health of an MCP installation (connected, unreachable, the number of connected users of a per-user server) and, for a per-user server, the **Connected users** dialog (disconnect a user, reset iHub's OAuth client registration). Removing an instance deletes its managed secret. Removing a *definition* (uninstalling it from the marketplace) is refused while instances of it exist.

## Binding to an app

**Admin → Apps → Edit → Installed integrations** lists the installations. Tick one to bind it; untick actions the app should not offer; set a **default** scope, a **pinned** scope (users cannot change it) and where the scope picker appears. The app's JSON holds:

```jsonc
"integrations": {
  "open-data-portal": { "actions": ["search_datasets", "get_dataset"], "defaultScope": "stadt-norderstedt" }
}
```

The built-in `ifinder` and `iassistant` installations are bound the same way, and the same object carries their scope settings (`scopePicker`, `defaultScope`, `pinnedScope`). For iFinder the `actions` are the tool names without the `iFinder_` prefix: `"integrations": { "ifinder": { "actions": ["search", "getContent"] } }`; leave `actions` out for all seven, or set `"actions": []` to bind the installation for the scope picker only. An app on the iAssistant model (`preferredModel: "iassistant-conversation"`) binds `"integrations": { "iassistant": { "actions": [] } }`. See [Apps → Integrations](apps.md#integrations-binding-an-installed-integration).

An app is offered to users only while every installation it binds exists and is enabled (for `iassistant`, the iFinder installation too). Otherwise it is hidden like an app whose required feature is off, and **Admin → Apps** names the missing installation. Uninstalling or disabling an integration therefore takes its apps offline instead of leaving them without tools.

In the chat, every bound action appears as a tool `<instanceId>__<action>` named *Label: Action* (the built-in integrations keep their `iFinder_*` ids, see above; an MCP installation's tools keep `<toolPrefix or id__><tool>`). The tools menu shows one switch per installation (the instance id is the tool reference), on by default. An `app.tools` entry naming an installation or one of its tools selects nothing: the binding is the only way in. When the definition declares **scopes** (for CKAN: the publishers), the chat offers them in the scope picker like iFinder search profiles, and the pick is applied to the actions after the model's arguments, so the model cannot override it. A scope narrows the actions it is declared for (for CKAN: the dataset search); it is not an access boundary. Actions that take an id, such as reading one dataset, still reach records outside the scope, and a pinned scope must not be relied on for isolation. Use the system's own permissions and a token per audience for that.

## How an action runs

Five protocols have an adapter: `native`, for the built-in iFinder and iAssistant connectors, and `script`, the same adapter with the connector module loaded from the definition folder; `mcp`, which hands the installation to the MCP client manager (connections, per-user OAuth, MCP Apps and the shared tool catalog as before; the installation's `actions.disabled` becomes the server's denied tools); `a2a`, which hands it to the A2A client manager the same way (`actions.disabled` becomes the agent's denied skills); and `openapi`, for every other catalog integration. For `openapi`, the definition names an OpenAPI document (a companion file) and each action names an `operationId`. At call time the adapter:

1. builds the base URL and static headers from the install values (`{baseUrl}{apiPath}`), and adds the shared secret as a header when the sign-in mode is *service account*;
2. applies the action's **enforced defaults**: `fixed` (the install value is sent, the model's dropped), `cap` (the smaller number wins), `append` (install value and model value are joined, Solr `fq` style), `default` (only fills a gap); then the chat's scope;
3. serializes array parameters as the document says (`form` style: repeated, or comma-joined for `explode: false`; `spaceDelimited` and `pipeDelimited` are not supported), or as a JSON list for RPC-style APIs such as CKAN;
4. performs the request through the SSRF guard with the usual size caps and `hideFields`;
5. unwraps the **response envelope** (`{ success, result, error }`) so the model sees `result`, or a structured `{ error, type, message }`;
6. adds a `portalUrl` to every hit the definition's **sources** mapping lists, so each answer cites the records it used.

Outbound hosts follow `security` in `integrations.json` (`blockPrivateIps`, `allowedHosts`) and the platform's SSRF settings.

## Writing a definition

```jsonc
{
  "id": "org.example/service",            // reverse-DNS, optionally one "/"
  "version": "1.0.0",
  "name": { "en": "…", "de": "…" },
  "protocol": {
    "type": "openapi",
    "document": "openapi.json",            // companion file in the folder
    "baseUrl": "{baseUrl}",                // install fields as {placeholders}
    "responseEnvelope": { "success": "success", "result": "result", "error": "error.message" },
    "arrayParameterStyle": "json-list"     // openapi | repeat | comma | json-list
  },
  "auth": { "modes": ["none", "service-account"],
            "serviceAccount": { "kind": "header", "header": "Authorization", "valuePrefix": "Bearer ", "field": "apiToken" } },
  "install": [
    { "key": "baseUrl", "type": "url", "title": { "en": "Service URL" }, "required": true },
    { "key": "apiToken", "type": "secret", "title": { "en": "API token" } },
    { "key": "maxRows", "type": "number", "title": { "en": "Rows" }, "default": 10, "min": 1, "max": 50, "advanced": true }
  ],
  "actions": [
    { "name": "search", "operationId": "search", "sideEffect": "read", "dataFlow": "external",
      "title": { "en": "Search" }, "description": { "en": "…as the model should read it…" },
      "defaults": { "rows": { "value": "{maxRows}", "mode": "cap" } },
      "hideFields": ["help", "result.items[].internalId"],
      "guidance": { "en": "When to use it." }, "examples": [{ "en": "Example question" }] },
    { "name": "list_groups", "operationId": "listGroups", "sideEffect": "read", "dataFlow": "external",
      "title": { "en": "List groups" }, "description": { "en": "…" } }
  ],
  "scopes": { "action": "list_groups", "label": { "en": "Group" }, "map": { "id": "name", "name": "title" },
              "paging": { "offset": "offset", "limit": "limit", "size": 25 },
              "applyAs": { "search.fq": { "value": "group:{id}", "mode": "append" } } },
  "sources": { "search": { "list": "items", "fields": { "id": "id", "title": "title", "snippet": "summary" },
                           "urlTemplate": "{baseUrl}/items/{id}" } },
  "health": { "action": "search", "args": { "rows": 0 } }
}
```

An `mcp` definition has no actions and no document; its `protocol` fixes what the definition knows and leaves the rest to install fields of the same name: `{ "type": "mcp", "transport": { "type": "streamableHttp", "url": "https://mcp.example.com/mcp", "headers": { "X-Scope": "read" } }, "toolPrefix": "ex_", "timeoutMs": 60000, "apps": { "enabled": true } }`. A registry may publish MCP definitions with a fixed remote transport only; a local process (`stdio`) is installed from the shipped generic definition. The sign-in modes are `none`, `service-account`, `oauth-client` (`auth.oauthClient.field` names the client-secret field) and `oauth-user` (`auth.oauthUser.field` optionally names the secret of a pre-registered client); the adapter decides which of the declared modes it can run.

An `a2a` definition is the same idea for a remote agent: `{ "type": "a2a", "cardUrl": "https://agent.example/.well-known/agent-card.json", "timeoutMs": 60000 }`, every setting optional and otherwise read from the install fields `cardUrl`, `timeoutMs`, `streaming`, `pollIntervalMs`; sign-in modes `none`, `service-account` (`authKind` bearer or apiKey) and `oauth-client`.

A field may carry a `when` clause so it applies only in some cases: `{ "field": "transport", "in": ["streamableHttp", "sse"] }`, `{ "field": "authKind", "equals": "basic" }` or `{ "authMode": ["oauth-user"] }`. A field that does not apply is hidden in the wizard, never required, and its stored value is ignored.

`scopes.paging` makes the adapter call the scope action page by page (`offset` and `limit` name its parameters, `size` is the portal's cap per call) until a page comes back short, at most 1000 scopes. A service account's secret goes into a header (`kind: header` with `header` and `valuePrefix`, `bearer`, or `basic`); a secret in a query parameter is not supported. Field types: `string` (with optional `suggestions` and `pattern`), `number` (`min`, `max`), `boolean`, `enum` (`choices` with localized labels), `url` (a trailing slash is stripped, since the value is joined with paths in templates; `"keepTrailingSlash": true` keeps the URL verbatim for an endpoint whose exact string matters, such as the MCP server URL and the OAuth issuer of the generic MCP definition, to which per-user tokens and client registrations are bound), `secret` (always sensitive, stored in the credential store), `credential` (a reference to an entry of the credential store, picked in the wizard; the iFinder private key uses it), `instance` (another installation, whose definition `definition` names; the iAssistant `connection` field uses it), `list` (a list of strings), `file`, `directory`. `scope: "user"` fields are reserved for per-user connections. The schema is `server/validators/integrationDefinitionSchema.js`; the sources mapping is the [declared-sources format](answer-sources.md) with `urlTemplate` on top.

To publish a definition, put the folder in a marketplace registry as an item of type `integration` whose `name` is the folder name and whose `source.companions` lists the other files (the OpenAPI document and the icon are fetched even when not listed). See [Marketplace → Publishing your own registry](marketplace.md#publishing-your-own-registry).

## API

| Route | Purpose |
| --- | --- |
| `GET /api/admin/integrations/catalog` | definitions with install state |
| `GET /api/admin/integrations/catalog/:definitionId` | one definition (install fields, auth, actions); the id is URL-encoded |
| `POST /api/admin/integrations/catalog/:definitionId/_test` | test an unsaved instance (`values`, `auth`, `secrets`) |
| `POST /api/admin/integrations/catalog/_reload` | re-read the definition folders |
| `GET` / `POST /api/admin/integrations/installed` | list, install |
| `GET` / `PUT` / `DELETE /api/admin/integrations/installed/:id` | read with live actions, update, uninstall |
| `POST /api/admin/integrations/installed/:id/_test`, `_enable`, `_disable` | lifecycle |
| `GET /api/admin/integrations/installed/:id/connections`, `DELETE …/connections/:userId`, `POST …/registration/_reset` | per-user connections of an installation that signs every user in |

Every write is audited with resource `integration`.

## Code map

| File | Responsibility |
| --- | --- |
| `server/validators/integrationDefinitionSchema.js`, `integrationsConfigSchema.js` | definition, `ConfigField`, installed-instance schemas; `checkInstallValues` |
| `server/services/integrations/definitions/IntegrationRegistry.js` | loads shipped and installed definition folders and their OpenAPI documents |
| `server/services/integrations/InstalledIntegrationService.js` | `integrations.json` CRUD, managed secrets, tests |
| `server/services/integrations/protocols/openapi/OpenApiAdapter.js`, `protocols/enforcement.js` | the `openapi` adapter: actions, run, test, scopes |
| `server/services/integrations/protocols/native/`, `server/services/integrations/ifinderConfig.js` | the `native` adapter (also serving `script` definitions from their folder) and the iFinder and iAssistant connectors; the installations' values as the connectors read them |
| `server/services/integrations/protocols/mcp/` | the `mcp` adapter; `serverConfig.js` projects an installation onto the MCP client manager's server config, `manager.js` feeds the manager from the installations |
| `server/services/integrations/protocols/a2a/` | the `a2a` adapter; `agentConfig.js` and `manager.js` do the same for the A2A client manager |
| `server/services/integrations/integrationTools.js` | integration tools for `loadTools`, app binding, `runTool` dispatch, scope providers |
| `server/routes/admin/integrations.js` | the admin API |
| `server/services/marketplace/ContentInstaller.js` | marketplace type `integration` |
| `client/src/features/admin/pages/AdminInstalledIntegrationsPage.jsx`, `components/integrations/*` | Installed and Catalog page, install wizard |
| `client/src/features/admin/components/app-form/IntegrationsConfigSection.jsx` | app editor binding |
| `server/defaults/integration-definitions/org.ckan__open-data-portal/` | the shipped CKAN definition |
| `server/defaults/integration-definitions/com.intrafind__mcp-server/`, `mcp__*/` | the generic MCP server definition and the shipped hosted MCP servers |
| `server/migrations/V193__mcp_servers_installed_integrations.js`, `V194__a2a_agents_installed_integrations.js` | `mcpServers.json` and `a2aAgents.json` → installations |
| `server/defaults/integration-definitions/com.intrafind__ifinder/`, `com.intrafind__iassistant/` | the built-in iFinder and iAssistant definitions |
