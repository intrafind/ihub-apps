# Integrations

An **integration** connects iHub to an external system and gives the model a set of **actions** (tools) to use it. Integrations are installed from a catalog, configured per installation, and bound to apps. This page covers the installable integrations under **Admin → Integrations → Installed**; the MCP servers, A2A agents and the built-in connectors (iFinder, Jira, cloud storage) keep their own pages until they move onto the same model (see the [concept](../concepts/2026-10-20%20Unified%20Integrations/README.md)).

The first catalog integration is the **CKAN Open Data Portal** (GovData, the German state and city portals, data.gov, internal data catalogs). It ships with iHub and is also published in the [iHub Marketplace](marketplace.md).

## Three records

| Record | Where | What |
| --- | --- | --- |
| **Definition** | `server/defaults/integration-definitions/<folder>/` (shipped) or `contents/integration-definitions/<folder>/` (installed from a registry; wins over a shipped one with the same id) | The catalog entry: id, version, protocol, auth modes, install fields, actions, scopes, sources. Never carries a secret or an installation's values. |
| **Installed integration** | `contents/config/integrations.json` | The admin's instance: endpoint and other install values, sign-in mode, groups, which actions are on. One definition can be installed several times (two portals, two labels). |
| **App binding** | `app.integrations[<instanceId>]` | Which installations an app offers, optionally narrowed to some actions, with the scope settings users start with. |

A definition's folder name is its id with the one `/` replaced by `__`: `org.ckan/open-data-portal` lives in `org.ckan__open-data-portal/`.

## Installing

1. **Admin → Integrations → Installed → Catalog** lists every definition: shipped ones and those installed from the [Marketplace](marketplace.md) (type **Integrations**).
2. **Install** opens a wizard generated from the definition's install fields:
   - **Name**: the instance id apps refer to, and a label users see in the chat.
   - **Settings**: the definition's fields (URL, numbers, switches, choices). Advanced fields are folded away.
   - **Sign-in**: the modes the definition offers. *No sign-in* for public APIs; *Shared service account* stores one secret for everyone in the credential store (`integration-<instanceId>-<field>`), never in a config file. Per-user sign-in modes come in a later release.
   - **Who may use it**: groups, or everyone who may use an app that binds the integration.
   - **Actions**: which of the definition's actions the model may call. Each shows its side effect (read, write, destructive). Actions that need a token are off while sign-in is *none*; actions with a requirement (for example SQL on a DataStore) appear once the setting is on.
3. **Test connection** runs the definition's health action with the values as entered and lists the actions the model would get. Nothing is saved until **Install**.

Installed instances can be tested, edited, disabled and removed from the **Installed** tab. Removing an instance deletes its managed secret. Removing a *definition* (uninstalling it from the marketplace) is refused while instances of it exist.

## Binding to an app

**Admin → Apps → Edit → Installed integrations** lists the installations. Tick one to bind it; untick actions the app should not offer; set a **default** scope, a **pinned** scope (users cannot change it) and where the scope picker appears. The app's JSON holds:

```jsonc
"integrations": {
  "open-data-portal": { "actions": ["search_datasets", "get_dataset"], "defaultScope": "stadt-norderstedt" }
}
```

The same object carries the scope settings of the built-in `ifinder` and `iassistant` integrations (`scopePicker`, `defaultScope`, `pinnedScope`).

In the chat, every bound action appears as a tool `<instanceId>__<action>` named *Label: Action*; the usual per-chat tool switches apply. When the definition declares **scopes** (for CKAN: the publishers), the chat offers them in the scope picker like iFinder search profiles, and the pick is applied to the actions after the model's arguments, so the model cannot override it.

## How an action runs

Only the `openapi` protocol has an adapter in this release. For it, the definition names an OpenAPI document (a companion file) and each action names an `operationId`. At call time the adapter:

1. builds the base URL and static headers from the install values (`{baseUrl}{apiPath}`), and adds the shared secret as a header when the sign-in mode is *service account*;
2. applies the action's **enforced defaults**: `fixed` (the install value is sent, the model's dropped), `cap` (the smaller number wins), `append` (install value and model value are joined, Solr `fq` style), `default` (only fills a gap); then the chat's scope;
3. serializes array parameters as the document says (`style`/`explode`), or as a JSON list for RPC-style APIs such as CKAN;
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
      "guidance": { "en": "When to use it." }, "examples": [{ "en": "Example question" }] }
  ],
  "scopes": { "action": "list_groups", "label": { "en": "Group" }, "map": { "id": "name", "name": "title" },
              "applyAs": { "search.fq": { "value": "group:{id}", "mode": "append" } } },
  "sources": { "search": { "list": "items", "fields": { "id": "id", "title": "title", "snippet": "summary" },
                           "urlTemplate": "{baseUrl}/items/{id}" } },
  "health": { "action": "search", "args": { "rows": 0 } }
}
```

Field types: `string` (with optional `suggestions` and `pattern`), `number` (`min`, `max`), `boolean`, `enum` (`choices` with localized labels), `url`, `secret` (always sensitive, stored in the credential store), `file`, `directory`. `scope: "user"` fields are reserved for per-user connections. The schema is `server/validators/integrationDefinitionSchema.js`; the sources mapping is the [declared-sources format](answer-sources.md) with `urlTemplate` on top.

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

Every write is audited with resource `integration`.

## Code map

| File | Responsibility |
| --- | --- |
| `server/validators/integrationDefinitionSchema.js`, `integrationsConfigSchema.js` | definition, `ConfigField`, installed-instance schemas; `checkInstallValues` |
| `server/services/integrations/definitions/IntegrationRegistry.js` | loads shipped and installed definition folders and their OpenAPI documents |
| `server/services/integrations/InstalledIntegrationService.js` | `integrations.json` CRUD, managed secrets, tests |
| `server/services/integrations/protocols/openapi/OpenApiAdapter.js`, `protocols/enforcement.js` | the `openapi` adapter: actions, run, test, scopes |
| `server/services/integrations/integrationTools.js` | integration tools for `loadTools`, app binding, `runTool` dispatch, scope providers |
| `server/routes/admin/integrations.js` | the admin API |
| `server/services/marketplace/ContentInstaller.js` | marketplace type `integration` |
| `client/src/features/admin/pages/AdminInstalledIntegrationsPage.jsx`, `components/integrations/*` | Installed and Catalog page, install wizard |
| `client/src/features/admin/components/app-form/IntegrationsConfigSection.jsx` | app editor binding |
| `server/defaults/integration-definitions/org.ckan__open-data-portal/` | the shipped CKAN definition |
