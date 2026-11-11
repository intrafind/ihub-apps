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
  `entraPeopleSearch.json` are deleted; the installations own the tools. Tool ids are unchanged. Group tool grants were removed later
  (see "Tools Are Integrations Everywhere").
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
  `read_url` entries stay: the page reader is a platform tool of web search (a workflow node or
  agent profile names it in `systemTools`).
- **Access:** an engine is granted on the groups (`permissions.integrations`: its id or
  `type:web-search`); native search on the model needs no grant. `BRAVE_SEARCH_API_KEY` and
  `STAAN_API_KEY` still work for an installed engine.

### Entra ID

Environment-only deployments keep working: the `entra` installation is created enabled when
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are set, and the variables stay the
fallback for empty fields. Without them it exists disabled until an admin fills it in. The
`people-search` app of the official marketplace binds the installation, and the example tool file
no longer lists the tool; install the app anew if you copied the old example by hand.

### People directories

A browse-only directory (empty `groups`) keeps its people search closed, because the migration
switches its search actions off; switch them on in the wizard to open it. The shipped `x500bund`
entry is a disabled installation in the default `integrations.json`, and
the example `peopleDirectories.json` is gone.

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
  is no longer read (the tool-file loader is retired, see "Tools Are Integrations Everywhere"); move
  the change over first.
- **The knowledge tools can no longer be switched off.** A disabled or edited `knowledge.json` is
  not read any more (V202 warns); every request that reaches a project gets them while the projects
  feature is on.
- **Workspace and evidence tools** are no longer listed under the iHub integration. One that was
  switched off stays off: V202 writes its tool file with `enabled: false`. A single evidence
  function cannot be switched off on its own; V202 names one in a warning.
- **Apps bind the installation:** an app's `tools: ["ask_user"]` becomes
  `integrations.ihub` (see "Tools Are Integrations Everywhere"); `tools: ["knowledge"]` selects nothing.
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
| `GET /api/integrations/jira/auth` | `POST /api/integrations/jira/_connect` `{ "returnUrl" }` → `{ "url" }` |
| `GET /api/integrations/jira/status` | `GET /api/integrations/jira` (`connection.status`) |
| `POST /api/integrations/jira/refresh` | none: tokens refresh on use |
| `GET /api/integrations/{office365,googledrive,nextcloud}/auth?providerId=<id>` | `POST /api/integrations/<id>/_connect` |
| `GET /api/integrations/{office365,googledrive,nextcloud}/status?providerId=<id>` | `GET /api/integrations/<id>` |
| `POST /api/integrations/{office365,googledrive,nextcloud}/disconnect` | `POST /api/integrations/<id>/_disconnect` |
| `GET /api/mcp/oauth/authorize?serverId=<id>&scope=` | `POST /api/integrations/<id>/_connect`, or `…/_reconnect` `{ "scopes" }` |
| `GET /api/mcp/oauth/connections` | `GET /api/integrations` (per-user servers: `connection.mode: "personal"`) |
| `POST /api/mcp/oauth/disconnect` `{ "serverId" }` | `POST /api/integrations/<id>/_disconnect` |

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
  `POST /api/integrations/<integration>/_connect`. Connect cards stored with older answers are not
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
  the MCP and A2A gateways and app approval overrides keep working. `enabled`,
  `approval`, `sideEffect` and `dataFlow` move onto the installation and its actions; apps that
  listed a tool bind its integration instead (`app.integrations`); groups with an explicit
  integrations list get the new installations. The tool file is deleted.
- **Not carried over:** `passthrough`, `concurrency` and `requestDelayMs` (named in the log). A tool
  whose id cannot be kept, or whose functions collide as action names, stays in `contents/tools/`
  with a warning. Shipped and platform tools are not touched.
- **Tool files in `contents/tools/`** are not read at all any more ("Tools Are Integrations
  Everywhere").
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

## The Storage Provider Is Mandatory

The server no longer starts without a working storage provider. The filesystem provider is the
default and needs no configuration; a `storage` block in `platform.json` that names an unknown
provider, or a provider that cannot initialize, now ends startup with a clear error instead of
running without persistence. Chats, workflows, run history and integration connections no longer
fall back to memory or to older file layouts.

- **Check before upgrading:** if `platform.json` has a `storage` block, or `IHUB_STORAGE_PROVIDER`
  is set, make sure it starts. Remove the block to use the default filesystem provider.
- **Older runtime files are imported once.** Installations that last ran a release before 5.5.2
  have workflow checkpoints, the run index, run event files and pending interactions under
  `contents/data/`. Migration V219 carries them into the storage provider on the first start. The
  old files stay where they are but are no longer read.
- **Token files.** Migration V218 renames single-slot cloud-storage token files
  (`<userId>.json`) to the per-provider name once, instead of on every start. Jira's single token
  slot is unchanged.
  
## Legacy Config Shapes Are No Longer Read

Four old shapes that the server still tolerated are gone. Migrations V220-V222 convert existing
data on the first start.

- **Resource arrays.** `config/apps.json`, `models.json`, `prompts.json`, `workflows.json` and
  `agents.json` (one JSON array per resource) are no longer loaded. V220 moves every entry that has
  no file yet into `apps/`, `models/`, `prompts/`, `workflows/` or `agents/profiles/` and deletes the
  array; an array with an entry that has no usable `id` is kept and named in the log.
- **Feedback counters.** The thumbs-style `good` and `bad` counters in `data/usage.json` are gone.
  V221 folds counts that predate star ratings into the ratings and removes the counters. The
  **Usage** CSV export has **Feedback Ratings** and **Average Rating** rows instead of **Feedback
  Good** and **Feedback Bad**. Rating strings other than numbers (`"positive"`) are ignored.
- **IP anonymization.** `logging.anonymizeIp` and `audit.anonymizeIp` accept `"off"`, `"mask"` and
  `"drop"` only; V222 turns `false` into `"off"` and `true` into `"mask"`. An
  `IHUB_PLATFORM__AUDIT__ANONYMIZE_IP=true` (or `LOGGING`) environment variable must become
  `mask`.
- **iFinder subject templates** accept `${user.field}` only; a bare `${username}` is rejected when
  a token is minted instead of being resolved. The `token_usage_total` metric is removed; use
  `gen_ai_client_token_usage`. Setting an `IHUB_PLATFORM__I_FINDER__*` or
  `IHUB_PLATFORM__I_ASSISTANT__*` variable no longer logs a warning (it has had no effect since
  V192).
  
## Sign-in Tokens Leave the URL; Legacy Integration Token Files Are Deleted

- **OIDC sign-in no longer puts the session token in the redirect URL.** After the provider callback
  the browser is sent back with `?oidc=success&provider=<name>` and the session is the `authToken`
  httpOnly cookie that was already set. Nothing changes for users. Custom code that read
  `?token=` from the OIDC return URL has to use the cookie (or `redirect=false` for the JSON form).
- **Old integration token files are deleted on the first start (migration V217).** Per-user
  Office 365, Google Drive, Nextcloud, Jira and iFinder login tokens in
  `contents/integrations/<service>/` that were written in the unauthenticated AES-256-CBC format
  (installations from before 5.4.16) are removed without being decrypted; the server no longer
  reads that format. The affected users connect the service again under **Settings →
  Integrations**. AES-256-GCM files are not touched.
  
## Unused API Endpoints Removed

Endpoints that nothing in iHub itself (web client, browser extension, Office add-in, Nextcloud app,
Teams tab, scheduler, MCP/A2A/OAuth integrations) called are gone. Scripts of your own that call
one of them get `404`.

| Area | Removed |
| --- | --- |
| Authentication | `POST /api/auth/users` (use `POST /api/admin/auth/users`), `GET /api/auth/oidc/providers`, `GET /api/auth/ldap/providers`, `GET /api/auth/ntlm/status` (the providers are in `GET /api/auth/status`), `POST /api/auth/teams/config` |
| iFinder, Jira | `GET /api/integrations/ifinder/document`, `.../document/content`, `.../document/metadata` (use `GET /api/integrations/ifinder/files/:id/content` and `/files/:id`), `GET /api/integrations/jira/test` |
| Workflows | `POST /api/workflows/executions/:id/resume` (answer checkpoints through `/api/runs/:id/interactions/:id/answer`, restart with `.../restart`), `GET /api/workflows/:id/versions`, `PUT /api/workflows/:id/activate/:version`, `GET /api/workflows/triggers`, `POST /api/workflows/:id/trigger`. The webhook route `POST /api/workflows/:workflowId/webhooks/:triggerId` stays |
| Agents | `GET /api/agents/profiles`, `GET /api/agents/profiles/:profileId`, `GET /api/agents/profiles/:profileId/artifacts` |
| Admin | `GET /api/admin/auth/test`, `GET /api/admin/oauth/cimd-clients` (`GET /api/admin/oauth/clients` carries them), `POST /api/admin/oauth/clients/:id/introspect-token`, `GET`/`PUT /api/admin/logging/level` (use `/api/admin/logging/config`), `POST /api/admin/skills/validate`, `GET /api/admin/update/check` (use `GET /api/admin/version/check-update`) |
| Conversations | `GET /api/apps/:appId/conversations/:conversationId/messages`, `DELETE .../messages/:messageId` |

`/api/docs` now also documents the routes in the files it did not scan before (workflows, prompts,
user skills, projects, runs, OAuth, well-known metadata, integrations).

## iFinder Search Hits Lose Duplicate Alias Fields

The iFinder `search` tool no longer repeats values under old names: `source` (use `sourceName`),
`breadcrumbs` (use `navigationTree`) and `extension` (use `file.extension`). `mimeType` and
`lastModified` stay, because the project item picker reads them. Prompts or workflow nodes of your
own that read one of the removed names have to switch.

## MCP Gateway: The Legacy SSE Transport Is Gone

`GET /mcp/sse` and `POST /mcp/messages` (the 2024-11-05 HTTP+SSE transport) are removed; the
gateway speaks Streamable HTTP on `/mcp` only. Both old paths answer `410 Gone` with a JSON-RPC
error that names Streamable HTTP and a bridge, so a client still configured for them says what to
change. The **SSE (legacy)** toggle on **Admin → MCP
gateway**, the `mcp_sse_endpoint` and `sse` entry in `/mcp/.well-known`, and the "MCP endpoint
(SSE)" row of the personal API keys page are gone. V223 deletes `mcpServer.transports.sse` from
`platform.json`.

**Before upgrading:** an MCP client configured for the SSE transport has to be switched to
Streamable HTTP (`http`) on `/mcp`, or connected through a bridge such as `mcp-remote`. Outbound SSE
to third-party MCP servers is unchanged.

## Installations Older Than Release 5.3.0 Cannot Be Upgraded Directly

The configuration migrations up to V030 (release 5.3.0) have been removed. The server now refuses
to start an installation whose migration history ends below V030, or whose `contents/` folder has a
configuration but no migration history, and exits with this error:

> This installation is older than the oldest supported version and cannot be migrated directly

- Installations that ran release 5.3.0 or newer start as before; their history of the removed
  migrations is kept and ignored.
- New installations start from the shipped defaults and are recorded at V030.
- Nothing is changed or written when the server stops with this error.

**Before upgrading:** an installation older than 5.3.0 has to be upgraded to release 5.3.x first and
started once, so that it migrates to V030 or higher. Then upgrade to this release.

## iHub Examples Marketplace Registry Removed

The **iHub Examples** registry under **Admin → Marketplace** is gone. It served the `examples/`
folder of the iHub Apps repository, which no longer exists; its apps, models and prompts are now in
the **iHub Official Marketplace**, together with the AWS Bedrock, text-to-speech and Qwen3 vLLM
models that only the examples had. Migration V224 removes the registry from `registries.json`; a
registry you added yourself, or one with that id that you pointed elsewhere, is not touched.

- Apps, models and prompts you installed from it stay installed and keep working. They are no
  longer checked for updates, because their registry is gone.
- The official marketplace now carries the newer model configurations of the examples (the
  three-state `supportsTools`) and the `{{content}}` placeholder in its prompts.
- The reference material that was in `examples/` (locale overrides, OAuth client sample, agent
  profiles, logging demo, LDAP mapping example) is removed along with it.

**Before upgrading:** to get updates for an item installed from the examples registry, install it
again from the official marketplace (the same id replaces the local copy) or detach it. Automation
that fetched `examples/catalog.json` from GitHub must use the marketplace catalog instead.

## Tools Are Integrations Everywhere

Every tool is an action of an installed integration, so nothing in iHub lists tools by id any more
(#3275). What changes:

- **Apps** have no `tools` list. An app gets tools only through `integrations` (the group's grant of
  the installation plus the binding's action list) and its `websearch` configuration. The field is
  gone from the app schema, the app editor (the **Tools** card keeps **Tool use** and **Approval
  before tool calls**), the creation wizard, the app generator prompt and the built-in apps.
- **Workflow nodes, planner task templates and agent profiles** have no `tools` list either. They
  bind `integrations` like an app, set `webSearch: true` for web search, and name the platform tools
  of workflows and agents (`write_artifact`, `read_memory`, `evidence`, `read_url`, …) in
  `systemTools`; those are plain tools, not integrations. The workflow and agent editors offer the
  three fields. A `tool` step still names one action by its tool id.
- **The MCP gateway exposes the integrations.** It lists the actions of every enabled installation
  the caller's groups are granted (`permissions.integrations`), under the tool ids they have in a
  chat, and checks the grant again at call time. The shipped groups hold `integrations: ["*"]`,
  so a user-delegated token now reaches every integration its user may use: narrow the groups'
  `integrations` lists if the gateway should offer less. A machine client (client credentials, static
  key) reaches an integration only through the binding of an app in its `allowedApps`; so does a
  user-delegated token or personal API key whose client names `allowedApps`. Outbound MCP servers,
  remote A2A agents and the LDAP browser are still not re-exposed; neither are project, skill and
  platform tools.
- **`permissions.tools` is gone** from groups (schema, group editor, `/api/admin/groups`, content
  access). A group's access to an integration is its `permissions.integrations` grant.
- **`GET /api/tools` and `/api/tools/:toolId` are removed.** There is no direct tool API: use an
  integration's action tester in Admin, or the MCP gateway.

Migrations V229 (apps) and V230 (workflows, agent profiles, groups) rewrite the existing files on the
first start:

| Entry in `tools` | Becomes |
| --- | --- |
| `ask_user`, `schedule_task`, `list_scheduled_tasks`, … | `"integrations": { "ihub": { "actions": [...] } }` |
| `iFinder`, `jira` | the binding of that installation with every action |
| `iFinder_search`, `jira_getTicket`, `braveSearch`, `<installationId>__<action>` | the binding of that installation with those actions |
| an installation id (an MCP server, a people directory, `a2a__<agentId>`) | the binding of that installation with every action |
| `webSearch` (workflow nodes, agent profiles) | `webSearch: true` |
| `write_artifact`, `read_memory`, `evidence`, `read_url`, … (workflow nodes, agent profiles) | `systemTools` |
| anything else (an app naming a platform tool, an id nobody installed) | removed, **logged as a warning with the file name** |

A group's `permissions.tools` is removed and **not** turned into an integration grant: a tool grant
never gave a group an installation (the gateway offered tool files and platform tools, and an
installation's tools only through `permissions.integrations`), so converting it would widen the
group. V230 logs every dropped entry with the installation it named; add that installation to the
group's `integrations` if the group should use it. A binding V229 adds to an app is `required: false`,
so an app whose installation is switched off stays visible (without the tool), as before; an
existing binding keeps its settings. A binding still needs the group grant of the installation
(`permissions.integrations`), so check **Admin → Groups** for the installations an app or workflow
now binds. V230 also rewrites loop bodies kept inline in a workflow, and the Entra tool ids
(`entraPeopleSearch`, `entraPeopleSearch_<function>`) map to the `entra` installation.

**Before upgrading:** check the startup log of both migrations for removed entries. An app, node or
profile that still has `tools` after the upgrade (a restored backup, a hand-edited file) logs a
validation warning and offers nothing for the entries. API clients that read or write `tools` on
`/api/admin/apps`, `/api/admin/workflows` or agent profiles, that call `/api/tools`, or that rely on
`permissions.tools` must use the bindings and group grants instead. A model must support tool calling
when an app or node binds an integration (as it did for an app with `tools`). Tool files left in
`contents/tools/` are reported by V230 and left in place; **iHub no longer loads `contents/tools/`**
at all, so a hand-written script tool file has no effect: build the tool as a custom integration.
The page reader stays off where `contents/tools/read_url.json` said `"enabled": false`: V230 sets
`platform.webSearch.pageReader: false`, which keeps `read_url` out of every app, node and agent
(remove the setting or set it to `true` to switch it back on). Other platform tools are switched off
by not naming them in `systemTools`. The app generator no longer offers or writes `tools` (V231
updates its prompt), lists the installed integrations in its brief, and the wizard asks the model
for plain JSON and turns the answer's `integrations` into the app's bindings, keeping only
installed integrations and the actions they declare.

## Error Responses Are `application/problem+json`: `error` Is Now `detail`

Every error response of the API now has the standard problem format of RFC 9457, with the media type
`application/problem+json`. The English text of an error moved from the `error` member to `detail`,
and the members that used to sit next to it moved into `details`:

```json
{
  "type": "urn:ihub:problem:NOT_FOUND",
  "title": "The requested resource was not found.",
  "status": 404,
  "detail": "Scheduled task t1 not found",
  "code": "NOT_FOUND",
  "details": { "taskId": "t1" }
}
```

- `error` no longer exists in error bodies of `/api/*`; read `detail`. `message` and the `success:
  false` flag are gone as well.
- `code` is the member to branch on. Codes that were kebab-case or missing in some routes are now
  upper-case registry codes (for example `NOT_TTS_MODEL`, `INVALID_AUDIO`, `PROVIDER_IN_USE`).
- Lists of field problems are in `errors` (`[{ pointer, code, message }]`) instead of `details.issues`
  or a bare list in `details`.
- Routes that carried their specific code in `details.code` (projects, uploads, iFinder collections,
  the Copilot agent, the delete-project refusal) now answer it as `code`; `details` never holds a code.
- Extras that were at the top level moved into `details`: `currentVersion`, `linkedModels`,
  `runningRuns`, `integrationId`, `summary`, and the `integration` and `connectUrl` of an
  integration that needs a sign-in.
- Not affected: the OAuth and well-known endpoints, bearer-token errors (`error` with
  `error_description`), and the OpenAI-compatible `/v1/*` endpoints, which keep the formats of their
  specifications.

**Before upgrading:** Scripts, integrations and API-key clients that read `error` (or `message`) from
a failed call must read `detail`, and should branch on `code`. A client that checks the response
content type for exactly `application/json` must also accept `application/problem+json`. The web
app, the Office add-ins and the browser extension ship with the server and need no change.

## Operations Are `_action` Segments

An operation that is not create, read, update or delete is now an `_action` segment, as
`docs/api-guidelines.md` has required for new endpoints. The web app ships with the server and
needs no change; scripts that call these endpoints must use the new path.

| Was | Is now |
| --- | --- |
| `PATCH /api/tools-service/jobs/:jobId/cancel` → `{ "success": true }` | `POST /api/tools-service/jobs/:jobId/_cancel` → `{ "id", "status": "cancelled" }` |
| `POST /api/scheduled-tasks/:taskId/run` · `/pause` · `/resume` · `/duplicate` | `POST …/_run` · `/_pause` · `/_resume` · `/_duplicate` |
| `POST /api/scheduled-tasks/:taskId/runs/:runId/cancel` | `POST …/runs/:runId/_cancel` |
| `POST /api/scheduled-tasks/_notifications/seen` | `POST /api/scheduled-tasks/_notifications/_mark-seen` |
| `POST /api/scheduled-tasks/:taskId/runs/delete` `{ "runIds", "all", "deleteChats" }` and the same under `/api/admin/scheduled-tasks` | `DELETE …/runs/:runId` for one run, `DELETE …/runs` for all finished runs (`?deleteChats=0` keeps the chats) |
| `POST /api/integrations/:id/connect` · `/reconnect` · `/disconnect` | `POST …/_connect` · `/_reconnect` · `/_disconnect` |
| `POST /api/integrations/api-keys/:keyId/rotate` | `POST …/api-keys/:keyId/_rotate` |

`POST /api/integrations/:id/_disconnect` answers `{ "removed", "revoked" }`; the `success` member is
gone. The `connectUrl` that an integration sign-in error carries points at `_connect`.

## Lists Page by `limit` and `cursor`

Every list that the server pages answers `{ "items": [...], "nextCursor": "…" }` and takes `limit`
and `cursor`, as `docs/api-guidelines.md` requires. The cursor is opaque: pass back what
`nextCursor` gave you; `nextCursor` is `null` on the last page. `page`, `pageSize` and `offset` are
gone, and an unknown cursor is answered `400` with the code `INVALID_CURSOR`. A `limit` above the
maximum is capped, not refused. The web app ships with the server and needs no change; its admin
tables now step with **Previous** and **Next** instead of jumping to a page number.

| Endpoint | Was | Now |
| --- | --- | --- |
| `GET /api/admin/audit-log` | `offset` → `{ entries, total, facets }` | `limit`, `cursor` → `{ items, nextCursor, total, facets }` |
| `GET /api/admin/usage/limits/users` | `page`, `pageSize` → `{ items, total, page, pageSize }` | `limit`, `cursor` → `{ items, nextCursor, total }` |
| `GET /api/admin/usage/feedback` | `offset` → `{ feedbackEntries, total, limit, offset }` | `cursor` → `{ items, nextCursor, total }` |
| `GET /api/admin/oauth/connections` | `page`, `pageSize` → `{ success, connections, total, page, pageSize, cimdClients }` | `limit`, `cursor` → `{ items, nextCursor, total, cimdClients }` |
| `GET /api/admin/translations/:lang` | `offset` → `entries`, `offset`, `limit` | `cursor` → `items`, `nextCursor` |
| `GET /api/admin/marketplace` | `page` → `{ items, total, page, limit, totalPages }` | `cursor` → `{ items, nextCursor, total }` |
| `GET /api/user-skills/marketplace` | `page` → `{ …, page, limit, totalPages }` | `cursor` → `{ items, nextCursor, total, registries, categories }` |
| `GET /api/workflows/my-executions` | `offset` → a bare array | `cursor` → `{ items, nextCursor }` |
| `GET /api/admin/workflows/executions` | `offset` → `{ executions, total, stats, offset, limit }` | `cursor` → `{ items, nextCursor, total, stats }` |
| `GET /api/runs/:runId/events` | `after` → `{ runId, after, nextAfter, events }` | `cursor` → `{ runId, items, nextCursor }` |

The run ledger cursor stands for the last raw sequence a page read. A page that read nothing has no
`nextCursor`, and a client keeps following the cursor, not the number of items, because a page of
raw events can project to none.

## More Operations Are `_action` Segments, and Integration Calls Drop `{ success }`

The operations below move to an `_action` segment, like the ones in "Operations Are `_action`
Segments". The web app ships with the server and needs no change; scripts must use the new path.

| Was | Is now |
| --- | --- |
| `POST …/toggle` on `/api/admin/workflows/:id` and `/agents/profiles/:id` | `POST …/_toggle` |
| `POST /api/admin/{apps,models,prompts}/:id/toggle` (flips the state) | gone: `POST /api/admin/{apps,models,prompts}/:ids/_toggle` with `{ "enabled": true\|false }` sets it, for one id, a comma-separated list or `*` |
| `POST /api/admin/{browser-extension,copilot-agent,nextcloud-embed,office-integration}/{enable,disable}` | `…/_enable` and `…/_disable` |
| `POST /api/admin/models/:id/test`, `/proxy/test`, `/voice/azure/test`, `/office-integration/office-js/test`, `/projects/:id/test`, `/api/setup/test` | `…/_test` |
| `POST /api/setup/disable` | `POST /api/setup/_disable` |
| `POST /api/admin/backup/import`, `/api/admin/skills/import` | `…/_import` |
| `POST /api/admin/{audit-log,chat-history}/retention/run` | `…/retention/_run` |
| `POST /api/admin/usage/limits/users/:userKey/reset` | `…/_reset` |
| `POST /api/agents/runs/:runId/cancel` and `/resume`, `POST /api/workflows/executions/:id/cancel` and `/restart` | `…/_cancel`, `…/_resume`, `…/_restart` |
| `POST /api/prompts/:id/duplicate`, `/api/skills/:name/duplicate`, `/api/user-skills/:id/duplicate` | `…/_duplicate` |
| `POST /api/projects/:id/items/:itemId/refresh`, `/api/admin/projects/:id/items/:itemId/refresh`, `POST /api/projects/pickers/url/preview` | `…/_refresh`, `…/_preview` |

The calls under `/api/admin/integrations` and `/api/admin/marketplace` that answered `{ "success":
true, … }` answer the resource without the `success` member; the ones that had nothing to say
answer `204`. That covers the catalog, installed integrations, migrations, example apps, the
builder and integration requests, the registry edits and the personal API key revocation. A
connection test keeps its outcome in the body (`success: false` with a `message`), because the
outcome is its result.

## Admin, Sign-In and Run Calls Drop `{ success }` and `{ message: '… successfully' }`

The status code carries success. The calls below no longer answer `success: true` or a
`message: '… successfully'` text; the web app ships with the server and shows its own messages.
Scripts that read those members must read the status (and the resource) instead.

- **Nothing to say → `204`:** deleting an app, model, prompt, provider, page, group, user, OAuth client
  or UI asset; saving the UI configuration; `POST /api/admin/{cache/_clear,cache/_refresh,client/_refresh}`;
  `…/_disable` of the browser extension, Copilot agent, Nextcloud embed and Office integration;
  `POST /api/session/start`; `POST /api/feedback`.
- **A created resource → `201` and the resource:** apps, models, prompts (and promoting one), providers,
  pages, UI assets, OAuth clients' static API keys.
- **Everything else answers the resource or what it computed**, without the envelope: configuration
  saves (`/api/admin/{cors,ssl,ssrf,proxy,logging,features,platform}`), the OAuth client calls, the
  usage tracking mode and rollup, the workflow calls.
- **Sign-in:** `POST /api/auth/{local,ldap,ntlm}/login`, the OIDC JSON callback, `POST
  /api/auth/teams/exchange` and `GET /api/auth/user` answer `{ "user", … }`; a client that checked
  `success` checks `user`. `POST /api/auth/logout` answers `{ "oidcLogoutRequired" }`.
- **`POST /api/admin/update/download`** with nothing newer answers `409` `CONFLICT` ("No update
  available") instead of `200` with `success: false`.
- **A test keeps its report in the body:** the directory (LDAP) tests and the registry test answer `200`
  with `success`, `message` and the steps, as `docs/api-guidelines.md` now says. A model test that ran
  answers the model's reply; one that failed is `502`, as before.

## Calls Drop the `{ ok }`, `{ deleted: true }` and Message-Only Bodies

Same rule, last shapes: the status code carries success, so a call with nothing to report answers
`204` with no body instead of `{ "ok": true }`, `{ "deleted": true }`, `{ "revoked": true }` or a
bare `{ "message": … }`. This covers the admin agent, agent-inbox, audit-log, chat-history,
scheduled-task, change-log, configuration and Copilot-agent calls, the agent run calls, chat stop
and history deletion, project item calls, prompt calls, and workflow trigger calls. Calls that
return something (a run, a count, a resource) keep that body. Scripts that read `ok`, `deleted`
or `revoked` must read the status instead.

## Project Picker URL Calls Are `_action` Segments

`POST /api/projects/pickers/url/check` is now `…/url/_check` and `…/url/crawl` is `…/url/_crawl`, like
`…/url/_preview` already was. The bodies are unchanged. The API guidelines check now reads routes
registered through a file-local `route('…')` helper and rejects `check` and `crawl` as bare verbs.

## Every `201` Carries a `Location`

A call that creates a resource answers `201` with the resource in the body and the URL of the new
resource in the `Location` header (a path, including a configured base path), as
`docs/api-guidelines.md` has always required. Until now none did. Bodies are unchanged, so a client
that ignored the header keeps working; one that wants the URL reads it. The calls covered are the
admin create calls (apps, models, prompts, providers, pages, credentials, OAuth clients, agents,
projects, integrations, marketplace registries and installs, document templates, UI assets), the
user create calls (prompts, skills, projects, scheduled tasks and their files, chat shares, chat
files, integration requests, personal API keys, workflows). The API guidelines check now rejects a
bare `status(201).json(…)`; use `sendCreated` from `server/utils/created.js`.

## A Resource Is Answered As Itself, Not Wrapped in `{ app }` or `{ model }`

The body of a call that returns one resource is that resource, not an object with one member named
after it. This covers the create and update answers of apps, models, prompts (and promoting one),
providers, pages, groups, projects, agent profiles, OAuth clients, integration installations and
example apps, document templates and chat shares, a chat rename (`PATCH /api/chats/{chatId}`), the
text and discard answers of chat and scheduled-task files, the UI asset upload, and the CIMD client
read. Read `body.id` where you read `body.app.id`.

Bodies that carry more than the resource keep their members: `{ instance, reviewed }`,
`{ template, files }`, `{ client, revoked }`, `{ instance, definitionId }`, the migration result, and
`GET /api/chats/{chatId}`.

## Admin Lists Are `{ items }`, Not a Bare Array

A top-level JSON value is an object, and a list is `{ "items": [...] }`. These admin lists answered a
bare array and now answer `{ "items": [...] }`: `GET /api/admin/{apps,apps/templates,models,prompts,
providers,pages,agents/profiles,agents/inboxes,marketplace/registries,marketplace/updates,
integrations/tools}` and the unpaged `GET /api/admin/projects`. The shared user prompts
(`GET /api/admin/prompts?scope=user`) answer `items` instead of `prompts`. The web app is updated; a
script that reads these lists reads `body.items`. The public lists (`/api/apps`, `/api/models`,
`/api/prompts`) and the named-list answers (`{ credentials }`, `{ assets }`, `{ templates }`, …) follow
in a later change.

## The Public Lists Are `{ items }`, Not a Bare Array

A list is an object, `{ "items": [...] }`, never a bare array. These calls answered an array and now
answer `{ items }`: `GET /api/apps`, `GET /api/models` (with `?type=` too), `GET /api/prompts`,
`GET /api/shortlinks`, `GET /api/agents/runs` and `GET /api/workflows`. The web app is updated.
**Scripts and integrations that call these with an OAuth token or API key must read `body.items`**,
for example `curl … /api/models | jq '.items[].id'` instead of `jq '.[].id'`. The conditional-request
behaviour (`ETag` / `If-None-Match`) is unchanged.

## Lists Named After What They Hold Are `{ items }` Too

A list answer is `{ "items": [...] }` whatever it holds. These answered a list under its own name and
now answer `items` (siblings such as `persisted`, `pinned` or `categories` keep their names):

- Admin: `GET /api/admin/{credentials, ui/assets, document-templates, docs/search, features}`,
  `…/integrations/installed/{id}/connections`, `…/integrations/ifinder/assistants` and
  `…/models/{id}/tts/voices`, plus the answer of `POST …/office-integration/office-js/_test`.
- User: `GET /api/document-templates`, `GET /api/integrations`, `GET /api/integrations/scopes`,
  `GET /api/interactions/pending`, `GET /api/runs`, the jobs an OCR upload starts, and the cloud storage lists
  (`…/sources`, `…/drives/{source}` of Google Drive, Office 365 and Nextcloud).
- Project pickers: `GET /api/projects/pickers/{pages, ifinder/search, cloud}`.

The web app is updated. A script that reads one of these reads `body.items`. The id-keyed key-status
maps follow below.

## More Resources Are Answered As Themselves

The same rule, for the entity answers that still wrapped one resource under its own name. They now
answer the resource itself:

- `GET /api/integrations/{id}` (was `{ integration }`), `GET /api/admin/integrations/catalog/{definitionId}`
  (was `{ definition }`), `GET …/installed/{id}/actions/{action}` (was `{ detail }`)
- `POST /api/admin/integrations/requests/{id}/_approve` (was `{ request }`)
- `POST /api/runs/{runId}/interactions/{id}/answer` (was `{ interaction }`)
- `PUT /api/workflows/{id}` (was `{ workflow }`)
- `POST /api/admin/auth/users` and `PUT /api/admin/auth/users/{userId}` (were `{ user }`)

Answers that carry more than the resource keep their members (`_decline` still answers
`{ request, alsoDeclined }`; an action override answers `{ override, detail }`). Singleton settings
answers follow below.

## Project Item Answers Are the Item Itself

Adding, changing, refreshing or rewriting a project item answers the item, not `{ item }`:

- `POST /api/projects/{projectId}/items` (`201` or `202`, with `Location`), including the upload
  variant
- `PATCH /api/projects/{projectId}/items/{itemId}`, `PUT …/items/{itemId}/text`,
  `POST …/items/{itemId}/_refresh`
- The same four routes under `/api/admin/projects/{projectId}/items`

Adding a single iFinder document to a smart collection still answers
`{ item, alreadyMember }`, because it carries a second member.

## Settings and Config Answers Are the Object Itself

The admin config routes answered the object directly on `GET` but wrapped it on `PUT`, and a few
`GET`s wrapped it too. They now answer the object on both:

- `PUT /api/admin/ssl/config`, `PUT /api/admin/cors/config`, `PUT /api/admin/ssrf/config` and
  `PUT /api/admin/logging/config` (were `{ config }`)
- `PUT /api/admin/audit-log/settings` (was `{ settings }`)
- `GET /api/admin/ui/config` (was `{ config }`)
- `GET /api/projects/pickers/ifinder/metadata` (was `{ metadata }`)

Answers that carry more than the object keep their members (user prompt and skill settings answer
`{ settings, storageAvailable }`; `PUT /api/admin/configs/platform` answers `{ config, reconfiguration }`).
`GET /api/admin/system/storage` keeps `{ storage }`, because the value is `null` when no volume could be read.

## Test Probes and Deletes Answer Plainly

- The `_test` probes of integrations answer their report itself, not `{ result }`:
  `POST /api/admin/integrations/installed/{id}/_test`, `POST …/actions/{action}/_test` and the draft
  probe `POST /api/admin/integrations/catalog/{definitionId}/_test`.
- `POST /api/admin/models/{modelId}/tts/voices` answers `201` with the voice itself and a
  `Location` (was `200 { voice }`); `GET …/tts/voices/{voiceId}` is new.
- Deleting answers `204` with no body, not `{ deleted }` or `{ revoked }`:
  `DELETE /api/admin/models/{modelId}/tts/voices/{voiceId}`,
  `DELETE /api/chats/{chatId}/files/{fileId}` (a file that does not exist now answers `404`) and
  `DELETE /api/integrations/ifinder/authorization`.

## API Key Status Is a List

`GET /api/admin/models/_key-status` and `GET /api/admin/providers/_key-status` answered
`{ statuses: { "<id>": { state, source, envVar } } }`, a map that used the model or provider id as a
member name. They now answer `{ items: [{ id, state, source, envVar }] }` (models also carry
`enabled`), like every other collection. The ids are values, so an id such as `__proto__` is an
ordinary entry. The web app, including the setup wizard, is updated.

## Three Last Wrapped Answers

- `GET /api/shares/{shareId}/files/{fileId}?format=text` answers the file itself (id, name, text, …),
  not `{ file }`, like the same read on chats and scheduled tasks.
- `GET /api/runs/{runId}/interactions` answers `{ items }` (was `{ runId, interactions }`).
- `GET /api/prompts/{promptId}/versions` answers `{ revision, items }` (was `{ revision, versions }`).

## Chat JSON and JSONL Export Leave Out the Contents of Attached Files

The JSON and JSONL export (**Export** in the chat menu) wrote every field of a message. For a message
sent in the current session that included the files attached to it: the extracted text of a
document (`fileData.content`), the data of an image or a sound file (`imageData`, `audioData`) as
base64 and the file's own data. An export of such a chat could therefore be much larger than the
conversation and carry a confidential document in full.

An exported message now has its text and, if it came with files, `attachments`: one entry per file
with `id` (a stored file), `kind` (`document`, `image` or `audio`), `name`, `mimeType` and `bytes`
(left out once only the text is kept). `fileData`, `imageData` and `audioData` are no longer
exported. Nothing else about the export changes, and there is no compatibility option: a script that
read the contents out of an export now reads them from the chat's files (`GET
/api/chats/{chatId}/files/{fileId}?format=text`).

## NTLM: Settings That Never Applied Are Removed

The NTLM settings **Domain Controller User**, **Domain Controller Password**, **Get User Info** and
**Get Groups** never did anything: the NTLM sign-in only checks the password with the domain
controller and returns no groups, display name or email. NTLM users got only their **Default
Groups** unless an **LDAP Group Lookup Provider** was set. The settings are gone from the admin NTLM
page, and migration V235 removes `getUserInfo`, `getGroups`, `domainControllerUser` and
`domainControllerPasswordRef` from `ntlmAuth` in `platform.json`. The environment variables
`NTLM_LDAP_USER` and `NTLM_LDAP_PASSWORD` are no longer read. Nobody's groups change.

- To give NTLM users their directory groups, configure an LDAP provider (with admin credentials and
  group search) and pick it as **LDAP Group Lookup Provider** in the NTLM settings.
- The credential profile the password pointed to stays in **Admin → Credentials**; reuse it for the
  LDAP provider or delete it. The upgrade log names it.

**Before upgrading:** If you set `NTLM_LDAP_USER` / `NTLM_LDAP_PASSWORD` or the domain controller
credentials expecting NTLM users to receive groups, configure an LDAP Group Lookup Provider instead.

## Short Links Use the SSRF Allowlist

Short links had their own list of external hosts, `shortLinks.allowedHosts`, that no admin page
could edit. It is gone: a short link may lead to a path on this server or to a website whose host
is on the SSRF allowlist (**Admin → Security → SSRF Allowlist**, `ssrf.allowedHosts`). Changes there
apply to new and existing links at once.

- Migration V238 adds the entries of `shortLinks.allowedHosts` and the hosts of all stored,
  unexpired short links to `ssrf.allowedHosts`, logs each host it adds, and removes
  `shortLinks.allowedHosts`. `/regex/` entries and IPv6 addresses cannot be expressed there; they
  are logged as skipped.
- Saving a link to a host that is not on the list says so and names where to allow it
  (`SHORT_LINK_HOST_NOT_ALLOWED`).
- The public redirect `/s/<code>` is rate limited (300 requests per minute per address).

**Before upgrading:** after the upgrade, review the SSRF allowlist. An entry there also lets
outbound calls (web tools, MCP servers, OpenAPI tools) reach that host when it resolves to an
internal address, and short links created before 5.5.32 could name any host.

## Users Are Asked to Confirm the Use of AI Once

The AI-use acknowledgement is on and enforced by default. After the upgrade every user, anonymous visitors
included, sees a confirmation dialog before their next chat message, and until they confirm the server answers
`428 AI_ACKNOWLEDGEMENT_REQUIRED` for the chat message, starting a workflow or its chat step, and starting an
agent run. This includes the Outlook add-in, the browser extension and the Nextcloud embed: they sign in with
delegated OAuth tokens that used to be exempt, so their users were neither asked nor recorded, and they are
asked at their next message now. Other OAuth clients, personal API keys, MCP, A2A and the inference API are not
affected.

To roll it out gradually, set `aiAcknowledgement.enabled` to `false` (Admin → Advanced → AI acknowledgement) or
`aiAcknowledgement.enforce` to `false` (the dialog then only asks) before upgrading. Custom clients that call the
chat endpoint themselves with a user session must handle the `428` (confirm through
`POST /api/eu-ai-act/acknowledgements/me`, then retry).

