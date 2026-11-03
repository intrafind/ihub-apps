# Breaking Changes — Unreleased

## Configuration Moved Into Installed Integrations

Every connected system now lives in `contents/config/integrations.json` as an **installed
integration**, managed under **Admin → Integrations**. Migrations V192–V206 move the existing
configuration on the first start; nothing has to be entered again.

| Was | Is now | Migration |
| --- | --- | --- |
| `platform.json` → `iFinder`, `iAssistant` | installations `ifinder`, `iassistant` | V192 |
| `mcpServers.json` | one installation per server, same id and tool ids | V193 |
| `a2aAgents.json` | one `com.intrafind/a2a-agent` installation per agent, same ids | V194 |
| `providers.json` web search entries, tool files `braveSearch.json`, `staanSearch.json`, `qwantSearch.json`, `read_url.json` | one `web-search` installation per engine (`brave`, `staan`, `qwant`) | V195, V204 |
| `platform.json` → `jira` | installation `jira` | V196 |
| `contents/tools/entraPeopleSearch.json` | installation `entra` | V197 |
| `peopleDirectories.json` | one `com.intrafind/ldap-directory` installation per directory, same ids | V198 |
| `platform.json` → `cloudStorage.providers[]` | installations `office365`, `googledrive`, `nextcloud` named like the former provider id | V200, V206 |

What changes for every one of them:

- **Old files and keys are gone.** The files are deleted and nothing reads them. The platform
  schema rejects `iFinder`, `iAssistant`, `jira` and `cloudStorage`, so a `platform.json` restored
  from a backup after the upgrade fails validation until those blocks are removed, and
  `PUT /api/admin/configs/platform` no longer carries them.
- **Admin pages and API.** **Admin → MCP servers**, **A2A agents**, the Jira, Office 365, Google
  Drive, Nextcloud and People directories pages, the iFinder editor on **Admin → Providers** and
  its **Web Search Providers** category are replaced by **Admin → Integrations**. Removed routes:
  `/api/admin/mcp/servers*`, `/api/admin/mcp/{catalog,status,tools,test}`,
  `/api/admin/a2a/agents*`, `/api/admin/a2a/{test,status,skills}`, `GET`/`PUT
  /api/admin/people-directories`, `/api/admin/people-directories/{presets,test}`,
  `POST /api/admin/integrations/{ifinder,iassistant}/_test` and
  `POST /api/admin/providers/{id}/websearch-test`; a provider with `category: "websearch"` can no
  longer be created. Use `/api/admin/integrations/catalog` and `/api/admin/integrations/installed`:
  `POST …/installed/{id}/_test` tests an installation (an unsaved directory with
  `POST …/catalog/com.intrafind%2Fldap-directory/_test`, the sample search as
  `testInput: { "query": "…" }`), `…/installed/{id}/connections` and `…/registration/_reset` manage
  per-user MCP sign-ins. The MCP gateway (`/api/admin/mcp/gateway`, `platform.mcpServer`) and the
  inbound A2A side are unchanged.
- **Apps.** `app.tools` entries that named an integration or one of its tools (`"drawio"`,
  `"drawio__create_diagram"`, `"a2a__langdock__ask"`, `"jira"`, `"jira_searchTickets"`,
  `"entraPeopleSearch"`, `"peopleDirectories"`, `iFinder_*`) select nothing any more. The
  migrations turn them into the binding `integrations.<id>`, narrowed to the action where one was
  named; a remote-agent skill binds the whole agent. `requiredIntegrations` is retired (the schema
  accepts only an empty list): `["ifinder"]` became `integrations.ifinder` and `peopleDirectories`
  became `"integrations": { "com.intrafind/ldap-directory": {} }`. The MCP server and remote agent
  pickers of the app editor are gone; bind the installation instead.
- **Tool files.** `contents/tools/iFinder.json`, the Jira tool file (`"script": "jira.js"`) and
  `entraPeopleSearch.json` are deleted; the installations own the tools. Tool ids are unchanged, and
  group tool grants naming `iFinder` or `iFinder_*` keep working.
- **An id another installation already holds.** An MCP server, A2A agent or people directory whose
  id is taken is not moved: it is kept in `contents/config/mcpServers.unmigrated.json`,
  `a2aAgents.unmigrated.json` or `peopleDirectories.unmigrated.json` with a warning in the log.
  Install it under a free id and bind it to its apps.
- **Deployments that write the old files** (Helm values, templates, scripts) have to write
  installations instead. The field names are listed in `docs/iFinder-Integration.md`,
  `docs/mcp-integration.md`, `docs/a2a-agents.md`, `docs/JIRA_INTEGRATION.md`,
  `docs/people-directory-search.md`, `docs/office365-integration.md`,
  `docs/google-drive-integration.md` and `docs/nextcloud-integration.md`. The `security` block of
  MCP servers and A2A agents (`blockPrivateIps`, `allowedHosts`) lives in `integrations.json`.

### iFinder and iAssistant

`IHUB_PLATFORM__I_FINDER__*` and `IHUB_PLATFORM__I_ASSISTANT__*` environment overrides (such as
`__BASE_URL`, `__ENABLED`, `__DEFAULT_SEARCH_PROFILE`, `__TOKEN_EXCHANGE__OIDC_PROVIDER`) no longer
apply. V192 reads them once and writes their values into the installations; the server logs a
warning for each one still set, and the value is edited on the installation afterwards.
`IFINDER_API_URL` and `IFINDER_PRIVATE_KEY` keep working.

### MCP servers

A server whose endpoint is a shipped `mcp/<id>` definition installs that definition only when its
`toolPrefix` is empty or the default `<id>__`; a server with a custom prefix installs the generic
`com.intrafind/mcp-server` definition, which keeps the prefix (the log names the servers that fell
back). Endpoint and OAuth URLs are kept verbatim, trailing slash included, so per-user sign-ins and
client registrations stay valid.

### Web search engines

- **What gets installed:** `brave` where a Brave key was configured (its key moves to the
  credential `integration-websearch-brave`, or `BRAVE_SEARCH_API_KEY` was set), `staan` likewise,
  and `qwant` where Qwant was reachable (no key at all, or an app or the default engine named
  Qwant). A fresh install ships no engine. The log names each engine V204 installed or left out,
  and why.
- **Apps:** `websearch.provider` is `auto` or an engine's installation id. `auto` takes the first
  engine the user may use (Brave, Staan, Qwant, then any other) instead of picking by API key; a
  named engine that is missing, disabled or not granted means no web search on models without
  native search, never another engine. Apps with web search on stay available without any engine
  and search natively on Google, OpenAI and Anthropic models; `websearch.required: true` hides the
  app while its engine is not available.
- **Tools:** the search tools are no longer tool files; switch an engine or its **Search the web**
  action off instead. A `tools` entry naming `braveSearch`, `staanSearch` or `qwantSearch` (an
  app's, a workflow node's — the shipped `claude-style-agent` and `research-assistant` workflows
  name `braveSearch`) selects the tool only while that engine is installed, enabled and granted.
  V195 removes these ids from apps' `tools`; an app that had web search only through such an entry
  gets `websearch: { enabled: true, enabledByDefault: true, provider }` with the engine it named.
  `read_url` entries stay: the page reader is a platform tool of web search, switched off with a
  `contents/tools/read_url.json` that says `"enabled": false`.
- **Access:** an engine is granted on the groups (`permissions.integrations`: its id or
  `type:web-search`); native search on the model needs no grant. `BRAVE_SEARCH_API_KEY` and
  `STAAN_API_KEY` still work for an installed engine.

### Entra ID

Environment-only deployments keep working: the `entra` installation is created enabled when
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are set, and the variables stay the
fallback for empty fields. Without them it exists disabled until an admin fills it in. The example
app `examples/apps/people-search.json` binds the installation, and `examples/config/tools.json` no
longer lists the tool; copy the example anew if you installed it by hand.

### People directories

A browse-only directory (empty `groups`) keeps its people search closed, because the migration
switches its search actions off; switch them on in the wizard to open it. The shipped `x500bund`
entry is a disabled installation in the default `integrations.json`, and
`examples/config/peopleDirectories.json` is gone.

### Cloud storage providers

Each provider becomes an installation named like its former `id`, so callback URLs, stored user
tokens and the Nextcloud embed plugin's `ihub_provider_id` keep working. V206 installs the further
providers of a type that V200 kept in `contents/config/cloudStorage.unmigrated.json` and deletes
the file. When a provider id cannot be an installation id (another installation holds it, or it is
reserved such as `jira`), the log warns: those users connect again and the redirect URI of the
installation id has to be registered with the provider. The Office 365 tenant id is stored on the
installation, not as a credential.

**Before upgrading:** deployments that write `platform.json`, the old config files or tool files,
or set the `IHUB_PLATFORM__I_FINDER__*` / `I_ASSISTANT__*` variables, have to switch to
installations as described above. After the upgrade, check the server log for warnings and
`*.unmigrated.json` files, and **Admin → Integrations → Web search** for the engines V204
installed; install one if apps should search on models without native search.

## iHub's Own Tool Files Retired

Migration V199 deletes the shipped copies of `ask_user.json`, `knowledge.json`, `evidence.json`,
`write_artifact.json`, `read_memory.json`, `write_memory.json`, `read_inbox.json`,
`write_inbox.json` and the task tools (`create_task`, `list_tasks`, `mark_task_done`,
`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`,
`run_scheduled_task_now`, `list_task_runs`, `get_task_run`) from `contents/tools/`, and iHub no
longer copies them back. The tools keep their ids: `ask_user` and the scheduled-task tools are
actions of the always-installed integration `ihub` (`com.intrafind/ihub`), the knowledge tools
belong to projects, the agent workspace and evidence tools to workflows and agents.

- **Switch them off on the `ihub` installation.** A file that was `enabled: false` is migrated into
  `actions.disabled`. A tool file an admin edited stays in `contents/tools/` with a warning and
  keeps serving its tool until it is deleted; move the change over first.
- **The knowledge tools can no longer be switched off.** A disabled or edited `knowledge.json` is
  not read any more (V202 warns); every request that reaches a project gets them while the projects
  feature is on.
- **Workspace and evidence tools** are no longer listed under the iHub integration. One that was
  switched off stays off: V202 writes its tool file with `enabled: false`. A single evidence
  function cannot be switched off on its own; V202 names one in a warning.
- **Apps and groups need no change:** `tools: ["ask_user"]` and `permissions.tools` grants keep
  working. `tools: ["ihub"]` and `tools: ["knowledge"]` select nothing.
- **The `ihub` installation cannot be removed or disabled:** `DELETE
  /api/admin/integrations/installed/ihub` and `POST …/ihub/_disable` answer 400
  (`ALWAYS_INSTALLED`). The instance id `ihub` is reserved.

**Before upgrading:** deployments that ship these tool files themselves (templates, scripts) have to
drop them: a copy written after the upgrade takes the place of the built-in tool again, out of
reach of the `ihub` installation's switches.

## LDAP Browser Moved Into Its Own Integration

The admin LDAP browser is no longer a switch of a people directory but an installation of the
integration **LDAP browser** (`com.intrafind/ldap-browser`) that reuses the directory's connection.
Migration V205 moves it for you.

- **Tool ids change:** a directory's `<directory id>__browse_search`, `__browse_read` and
  `__browse_children` become `<browser id>__browse_*`. V205 names each browser
  `<directory id>-browser` (numbered when the id is taken) and rewrites app bindings, `tools`
  entries and group tool grants that named the old ids or `ldapBrowse`, which selects nothing any
  more. The shipped `ldap-browser` app binds the browsers.
- **`browse.groups` is gone:** who may browse is the browser installation's grant on the groups.
  V205 grants it to the groups that were in the directory's browser groups (`admins` when none)
  and warns about groups it cannot find. **Groups that hold `*` may use every installation, the
  browser included:** with the shipped groups that is every signed-in user, wherever an app they can
  open binds the browser. V205 logs the groups this opens it to.
- **Directory fields removed:** `browse`, `browseGroups`, `browseBase`, `browseMaxResults`,
  `browseBindMode`, `browseBindDn`, `browseBindPasswordRef`, `browseDenyAttributes` and the actions
  `browse_*` are no longer part of People directory (LDAP); V205 removes them (the settings of a
  switched-off browser are dropped and listed in the log). Deployments that write
  `integrations.json` write an LDAP browser installation instead (fields `directory`, `baseDn`,
  `maxResults`, `bindMode`, `bindDn`, `bindPasswordRef`, `denyAttributes`).
- **Audit records** of browser calls carry the browser installation id as resource id.

**Before upgrading:** nothing is required. Afterwards, check the V205 warnings in the log and, under
**Admin → Groups**, which groups may use the LDAP browser installations: replace a `*` grant with
explicit integrations for groups that should not browse, or keep the LDAP browser app limited to
admin groups.

## Who May Use an Integration Is Granted on the Groups

A people directory carried `groups` and a cloud storage provider `allowedGroups`. Access to every
integration is now granted on the groups (`groups.json` → `permissions.integrations`,
**Admin → Groups → a group → Integrations**).

- **Migrated for you:** V203 grants every group what it could use before. A group that could use
  every installation (each one open to everyone, or naming the group or a group it inherits) gets
  `*`, so it also gets the ones installed later; any other group gets the ids of the installations
  it could use. Groups that already have `permissions.integrations` are left alone.
- **Groups that exist only outside `groups.json`:** an old group entry naming a group that
  `groups.json` does not define has nowhere to go; the log warns per group. Create the group and
  grant it the integrations, or its members lose them.
- **New groups grant nothing** until an admin ticks integrations; members still get what their
  other groups grant (`authenticated` grants every integration in the shipped configuration).
- **Storage providers:** `/api/auth/status` lists only the providers the user's groups grant, and
  connecting, browsing or importing from another one is refused with 403.
- **Machine OAuth clients** (client credentials, static API keys) are in no group: they may use
  every integration an app in their **allowed apps** binds.

**Before upgrading:** nothing is required. Afterwards, check **Admin → Groups** for the grants V203
wrote and the log for groups it could not find.

## Connecting an Integration: One Error Code, One Set of Connect Routes

Jira, Office 365, Google Drive, Nextcloud and MCP servers with per-user sign-in are connected,
checked and disconnected through one API, and a missing connection is reported with one code,
`INTEGRATION_AUTH_REQUIRED`. The OAuth callback URLs registered in vendor apps keep working.

| Removed | Use instead |
| --- | --- |
| `GET /api/integrations/jira/auth` | `POST /api/integrations/jira/connect` `{ "returnUrl" }` → `{ "url" }` |
| `GET /api/integrations/jira/status` | `GET /api/integrations/jira` (`connection.status`) |
| `POST /api/integrations/jira/refresh` | none: tokens refresh on use |
| `GET /api/integrations/{office365,googledrive,nextcloud}/auth?providerId=<id>` | `POST /api/integrations/<id>/connect` |
| `GET /api/integrations/{office365,googledrive,nextcloud}/status?providerId=<id>` | `GET /api/integrations/<id>` |
| `POST /api/integrations/{office365,googledrive,nextcloud}/disconnect` | `POST /api/integrations/<id>/disconnect` |
| `GET /api/mcp/oauth/authorize?serverId=<id>&scope=` | `POST /api/integrations/<id>/connect`, or `…/reconnect` `{ "scopes" }` |
| `GET /api/mcp/oauth/connections` | `GET /api/integrations` (per-user servers: `connection.mode: "personal"`) |
| `POST /api/mcp/oauth/disconnect` `{ "serverId" }` | `POST /api/integrations/<id>/disconnect` |

- **Error code:** Jira tools returned `JIRA_AUTH_REQUIRED` with `authUrl`, per-user MCP tools
  `MCP_AUTH_REQUIRED`; both now return `{ "error": "INTEGRATION_AUTH_REQUIRED", "integration":
  "<installation id>", "reason": "not_connected" | "expired" | "insufficient_scope", "message": …,
  "connectUrl": … }`. `connectUrl` is the connect route (`/reconnect` with `scopes` for a missing
  permission); `authUrl` and the MCP `authRequired` marker are gone. The MCP App routes answer 409
  with this `code` (was `MCP_AUTH_REQUIRED`), file browsers answer 409 (was 401 or 500), and a
  scheduled run that fails for a missing connection ends with the reason code
  `INTEGRATION_AUTH_REQUIRED` (was `INTEGRATION_RECONNECT_REQUIRED`).
- **Run events:** `tool/completed` carries `authRequired` as `{ "integration", "name", "reason",
  "action"?, "scopes"? }` for any integration (was `{ "serverId", "serverName", "connectUrl" }`,
  MCP only), without a URL. A client rendering a Connect card starts the sign-in with
  `POST /api/integrations/<integration>/connect`. Connect cards stored with older answers are not
  shown again.
- **Return parameters:** after a sign-in the browser comes back with
  `integration_connected=<installation id>` or `integration_error=<code>&integration=<id>`, instead
  of `jira_connected`, `office365_error`, `mcp_connected`, `mcp_error`, `mcp_server` and the like.
  The codes are the same everywhere; `session_expired` is now `state_expired`, `server_not_found` is
  `integration_not_found`, a refused token exchange is `exchange_failed`, a declined consent
  `access_denied`.
- **JSON body required:** `connect`, `reconnect` and `disconnect` take `Content-Type:
  application/json` (`{}` when there is nothing to send); anything else gets `415 JSON_REQUIRED`.
  A `returnUrl` that is not a path or an http(s) URL on this host gets `400 INVALID_RETURN_URL`.
- **Sign-in state:** the `state` of a sign-in is an opaque handle of a single-use record kept
  server-side (storage namespace `integration-oauth-flows`), no longer a signed ticket. A sign-in
  started before the upgrade and finished after it fails with `invalid_state`; the user starts it
  again.
- **Several instances need shared storage for sign-ins:** every instance (pod, host) has to use the
  same storage provider — the shared `contents/` volume a multi-server deployment already requires.
  Matching `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` are no longer enough. Without shared storage,
  sign-ins stay in one worker's memory and the log warns in cluster mode.

**Before upgrading:** browser extensions, add-ins, portals or scripts that call a removed route,
read the old return parameters, match on `JIRA_AUTH_REQUIRED`, `MCP_AUTH_REQUIRED`,
`INTEGRATION_RECONNECT_REQUIRED` or `authUrl`, or follow `connectUrl` with a `GET` have to use the
routes, codes and parameters above. Admins and users need not reconnect.

## The Tools Page Is Gone: Admin Tools Became Custom Integrations

**Admin → Tools** (the list, the tool editor, the OpenAPI tool editor and the script editor) is
removed without a redirect, and so are its routes. Migration V211 turns every tool file an admin
created in `contents/tools/` into a custom integration, which **Admin → Integrations → Add
manually** builds and **Edit in builder** edits.

- **Removed endpoints** (no aliases): `GET`/`POST /api/admin/tools`,
  `GET`/`PUT`/`DELETE /api/admin/tools/:toolId`, `POST /api/admin/tools/:toolId/toggle`,
  `GET`/`PUT /api/admin/tools/:toolId/script` and `POST /api/admin/tools/openapi/parse`. Use
  `/api/admin/integrations/builder*` (create, read, save, `_import`, `_export`) and
  `GET /api/admin/integrations/tools` (every tool id an app, workflow or agent can name).
- **Tool files migrated:** a script tool becomes a `script` integration whose generated module runs
  the same script in `server/tools/`, one action per function; an OpenAPI tool becomes an `openapi`
  integration with its document copied (or its URL kept) and its credential sent as before. Every
  action keeps its **tool id** (`myTool`, `myTool_search`), so apps, workflows, agent profiles,
  group tool grants, the MCP and A2A gateways and app approval overrides keep working. `enabled`,
  `approval`, `sideEffect` and `dataFlow` move onto the installation and its actions; apps that
  listed a tool bind its integration instead (`app.integrations`); groups with an explicit
  integrations list get the new installations. The tool file is deleted.
- **Not carried over:** `passthrough`, `concurrency` and `requestDelayMs` (named in the log). A tool
  whose id cannot be kept, or whose functions collide as action names, stays in `contents/tools/`
  with a warning. Shipped and platform tools are not touched.
- **OpenAPI tool files** are no longer read: one put back by hand is skipped with a warning. A
  hand-written script tool file still loads as a plain tool but has no admin page; a platform tool
  such as `read_url` is switched off in its file.
- **Admin pickers** (app and agent tool selectors, workflow tool and prompt nodes, agent memory)
  list every tool, not only tool files.

**Before upgrading:** deployments or scripts that call `/api/admin/tools*` or write OpenAPI tool
files have to use the integration builder routes. Afterwards, review the migrated integrations in
the **Custom** group of **Admin → Integrations** and check the log for tool files V211 left in
place.

## Storage Providers: Apps Bind Them, Requests Name the Installation

An app offers storage providers (Office 365, Google Drive, Nextcloud) by binding them, and every
request to a storage provider names the installation it means, since a provider can be installed
several times.

- **`upload.cloudStorageUpload` is removed.** V206 turned every `enabled: true` into the binding
  `"integrations": { "type:storage": { "required": false } }` (all storage providers, optional) and
  removed the key. The app schema refuses it from now on: saving such an app under **Admin → Apps**
  or installing it from the marketplace fails with a message naming the binding, and a hand-written
  app file that still has it loads with a validation warning and offers no cloud file picker. Bind
  single providers by installation id or definition id.
- **Routes need the installation id.** `/api/integrations/{office365,googledrive,nextcloud}/…`
  require `?providerId=<installation id>` (the OAuth callback carries it in its path, `/disconnect`
  also accepts it in the JSON body): `400 STORAGE_PROVIDER_REQUIRED` without it,
  `404 STORAGE_PROVIDER_NOT_FOUND` for an unknown installation (except `/status` and `/disconnect`),
  `403 INTEGRATION_NOT_GRANTED` when the groups do not grant it. The shipped client always sends it.
- **`/api/auth/status`:** `cloudStorage.providers[].id` is the installation id; each provider also
  carries its `definition`.
- **Redirect URI:** an empty redirect URI is derived from the request including the base path
  (`X-Forwarded-Prefix`). `OFFICE365_OAUTH_REDIRECT_URI`, `GOOGLEDRIVE_OAUTH_REDIRECT_URI`,
  `NEXTCLOUD_OAUTH_REDIRECT_URI` and the `SERVER_URL`/localhost fallback are no longer read; without
  a configured value and without a request host the sign-in refuses to start.

**Before upgrading:** if iHub runs under a base path (for example `/ihub`) and an installation
leaves **Redirect URI** empty, register the new URI
`https://<host>/ihub/api/integrations/<provider>/<installation id>/callback` with the provider (the
installation's **Settings** tab shows it) — or set the old, working URI as the installation's
**Redirect URI**. If you set one of the `*_OAUTH_REDIRECT_URI` variables, enter its value as the
installation's **Redirect URI**. Afterwards, check the log for V206 warnings (installations that
kept their id, tenant ids to enter).
