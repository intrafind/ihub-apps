# Breaking Changes — Unreleased

## iFinder and iAssistant Configuration Moved Out of `platform.json`

Migration V192 moves `platform.iFinder` and `platform.iAssistant` into the installed
integrations `ifinder` and `iassistant` (`contents/config/integrations.json`) and removes the
blocks from `platform.json`. The platform schema no longer accepts them, so a `platform.json`
restored from a backup after the upgrade fails validation until the two blocks are removed.

- **Apps:** `requiredIntegrations: ["ifinder"]` is rejected; the migration turns it into the
  binding `integrations.ifinder`. `iFinder_*` entries in `tools` are moved into
  `integrations.ifinder.actions`; a tool list written by hand after the upgrade has to use the
  binding. `requiredIntegrations` still accepts `peopleDirectories`.
- **Tool file:** `contents/tools/iFinder.json` is deleted; the iFinder installation owns the
  seven tools (same ids). Group tool grants that name `iFinder` or `iFinder_*` keep working.
- **Admin API:** `POST /api/admin/integrations/ifinder/_test` and `/iassistant/_test` are gone;
  use `POST /api/admin/integrations/installed/{id}/_test`. The iFinder editor on
  **Admin → Providers** is removed.
- **Deployments that write `platform.json` themselves** (Helm values, templates, scripts) have
  to write the installation instead; the field names are listed in `docs/iFinder-Integration.md`.
- **Environment overrides:** `IHUB_PLATFORM__I_FINDER__*` and `IHUB_PLATFORM__I_ASSISTANT__*`
  (such as `IHUB_PLATFORM__I_FINDER__BASE_URL`, `__ENABLED`, `__DEFAULT_SEARCH_PROFILE`,
  `__TOKEN_EXCHANGE__OIDC_PROVIDER`) no longer apply. Migration V192 reads them once and writes
  their values into the `ifinder` / `iassistant` installations; after the upgrade the server logs
  a warning for each one still set, and the value is edited on the installation. `IFINDER_API_URL`
  and `IFINDER_PRIVATE_KEY` keep working.
- **JWT subject field:** the installation's **User identity sent to iFinder** is free text with
  suggestions (`email`, `username`, `id`, `name`, `domain\username`); a `${user.field}` template
  is typed as is. The signing algorithm choices are RS256/384/512 and ES256/384/512.

## MCP Servers Moved From `mcpServers.json` to Installed Integrations

Migration V193 turns every server of `contents/config/mcpServers.json` into an installed
integration in `contents/config/integrations.json` (same id, same tool ids) and removes the file;
nothing reads it any more. A server whose endpoint is a shipped `mcp/<id>` definition installs
that definition only when its `toolPrefix` is empty or the default `<id>__`; a server with a
custom prefix installs the generic `com.intrafind/mcp-server` definition instead, which keeps the
prefix (the migration log says which servers fell back and why). Endpoint and OAuth URLs are kept
verbatim, trailing slash included, so per-user sign-ins and client registrations stay valid.

- **Admin page and API:** **Admin → MCP servers** and its catalog dialog are gone, replaced by
  **Admin → Integrations**. The routes `/api/admin/mcp/servers*`,
  `/api/admin/mcp/catalog`, `/api/admin/mcp/status`, `/api/admin/mcp/tools` and
  `/api/admin/mcp/test` are removed; use `/api/admin/integrations/catalog` and
  `/api/admin/integrations/installed`. Per-user connections of a server are managed through
  `/api/admin/integrations/installed/{id}/connections` and `.../registration/_reset`. The MCP
  gateway (`/api/admin/mcp/gateway`, `platform.mcpServer`) is unchanged.
- **Apps:** an `app.tools` entry naming a server (`"drawio"`) or one of its tools
  (`"drawio__create_diagram"`) selects nothing any more; the migration turns both into the
  binding `integrations.drawio` (narrowed to the tool where one was named). The MCP servers
  picker in the app editor is gone; bind the installation instead.
- **Deployments that write `mcpServers.json`** (Helm values, templates, scripts) have to write
  installations; the field names are listed in `docs/mcp-integration.md`. The `security` block
  (`blockPrivateIps`, `allowedHosts`) lives in `integrations.json`.
- **A server whose id another, non-MCP installation already holds** (an integration installed from
  the catalog) is not moved: it is kept in `contents/config/mcpServers.unmigrated.json` with a
  warning in the log. Install it under a free id and bind it to its apps.
- Remote A2A agents keep their own page for now; the id-clash rules name installed integrations
  where they named MCP servers.

## Remote A2A Agents Moved From `a2aAgents.json` to Installed Integrations

Migration V194 turns every agent of `contents/config/a2aAgents.json` into an installed integration
of `com.intrafind/a2a-agent` (same id, same tool ids) and removes the file.

- **Admin page and API:** **Admin → A2A agents** is gone, replaced by **Admin → Integrations**; the routes `/api/admin/a2a/agents*`, `/api/admin/a2a/test`, `/api/admin/a2a/status`
  and `/api/admin/a2a/skills` are removed. The inbound side (iHub as an A2A agent) is unchanged.
- **Apps:** an `app.tools` entry naming an agent (`"langdock"`, `"a2a__langdock"`) or one of its
  skills (`"a2a__langdock__ask"`) selects nothing any more; the migration turns each into the
  binding `integrations.langdock` (a skill reference binds the whole agent, because the skill ids
  behind the slugs are only known from the card). The remote agents picker in the app editor is
  gone.
- **Deployments that write `a2aAgents.json`** have to write installations; the field names are
  listed in `docs/a2a-agents.md`. The `security` block lives in `integrations.json`.
- **An agent whose id another installation already holds** (an MCP server, a catalog integration)
  is not moved: it is kept in `contents/config/a2aAgents.unmigrated.json` with a warning in the
  log. Install it under a free id and bind it to its apps.

## Web Search Engines Moved From `providers.json` to Installed Integrations

Migration V195 moves the `websearch` entries of `contents/config/providers.json` (Brave, Staan,
Qwant) into one installed integration, `websearch`, and deletes the tool files `braveSearch.json`,
`staanSearch.json`, `qwantSearch.json` and `read_url.json` from `contents/tools/`. Migration V204
then replaces `websearch` with one installed integration per engine that worked, of type
`web-search`. An upgrade from 5.6.4 or earlier runs both; an installation on 5.6.5-RC1 already has
`websearch` and runs V204 only.

- **What gets installed:** `brave` where a Brave key was configured (its key moves to the
  credential `integration-websearch-brave`, or `BRAVE_SEARCH_API_KEY` was set), `staan` likewise,
  and `qwant` where Qwant was reachable (no key at all, or an app or the default engine named
  Qwant). A fresh install ships no engine. The server log names each engine V204 installed or
  left out, and why.
- **Admin page and API:** the **Web Search Providers** category on **Admin → Providers** and
  `POST /api/admin/providers/{id}/websearch-test` are gone; use the engines under **Admin →
  Integrations → Web search** and `POST /api/admin/integrations/installed/<engine>/_test`. A
  provider with `category: "websearch"` can no longer be created.
- **Apps:** `websearch.provider` is `auto` or an engine's installation id. `auto` now takes the
  first engine the user may use (Brave, Staan, Qwant, then any other) instead of picking by API
  key; a named engine that is missing, disabled or not granted means no web search on models
  without native search, never another engine. Apps with web search on stay available without
  any engine and search natively on Google, OpenAI and Anthropic models;
  `websearch.required: true` hides the app while its engine is not available.
- **Tools:** the search tools are not listed under **Admin → Tools**; switch an engine (or its
  **Search the web** action) off instead. A `tools` entry naming `braveSearch`, `staanSearch` or
  `qwantSearch` (an app's, a workflow node's — the shipped `claude-style-agent` and
  `research-assistant` workflows name `braveSearch`) selects the tool only while that engine is
  installed, enabled and granted. V195 removes these ids from apps' `tools`; an app that had web
  search only through such an entry gets `websearch: { enabled: true, enabledByDefault: true,
  provider }` with the engine it named (logged per app). `read_url` entries stay: the page reader
  is a platform tool of web search now, switched off with a `contents/tools/read_url.json` that
  says `"enabled": false`.
- **Groups:** who may use an engine is granted on the groups (`permissions.integrations`: the
  engine's id or `type:web-search`); native search on the model needs no grant.
- **Installs that ran 5.6.5-RC1** have the single installation `websearch`
  (`com.intrafind/web-search`); V204 replaces it with the engines that worked (credential
  references, the enabled state and switched-off actions carried over; apps on Auto set to its
  default engine when that was an explicit one), turns group grants of `websearch` into
  `type:web-search` and removes app bindings and `tools` entries of `websearch`. The definition
  `com.intrafind/web-search` and `POST …/installed/websearch/_test` are gone.
- **Deployments that write `providers.json`, the tool files or the `websearch` installation
  themselves** have to write engine installations (`brave`, `staan`, `qwant` with `apiKeyRef`)
  instead; `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` still work for an installed engine.

**Before upgrading:** nothing is required. After the upgrade, check **Admin → Integrations → Web
search** for the engines V204 installed, and install one if apps should search on models without
native search.

## Jira Configuration Moved Out of `platform.json`

Migration V196 moves `platform.jira` into the installed integration `jira`
(`contents/config/integrations.json`) and removes the block; `PUT /api/admin/configs/platform`
no longer carries a `jira` key.

- **Admin page:** **Admin → Integrations → Jira** (`/admin/integrations/jira`) is gone; use
  **Admin → Integrations → Atlassian Jira**. The user-facing routes
  `/api/integrations/jira/*` (auth, callback, status, refresh, disconnect, attachment, test) are
  unchanged.
- **Apps:** `tools: ["jira"]` or `["jira_searchTickets", …]` selects nothing any more; the
  migration turns such entries into the binding `integrations.jira`. A tool file with
  `"script": "jira.js"` is deleted.
- **Deployments that write `platform.json` themselves** have to write the installation instead
  (`values.clientId`, `values.clientSecretRef`, `values.redirectUri`, `values.siteUrl`).

## Entra People Search Tool File Retired

Migration V197 deletes `contents/tools/entraPeopleSearch.json`; the tools belong to the installed
integration `entra` and are no longer listed under **Admin → Tools**.

- **Apps:** `tools: ["entraPeopleSearch"]` or `["entraPeopleSearch_findUser", …]` selects nothing
  any more; the migration turns such entries into the binding `integrations.entra`. The example
  app `examples/apps/people-search.json` binds the installation now, and `examples/config/tools.json`
  no longer lists the tool; copy the example anew if you installed it by hand.
- **Environment-only deployments** keep working: the installation is created enabled when
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are set, and the variables stay
  the fallback for empty fields. Without them the installation exists disabled until an admin
  fills it in.

## People Directories Moved From `peopleDirectories.json` to Installed Integrations

Migration V198 turns every directory of `contents/config/peopleDirectories.json` into an installed
integration of `com.intrafind/ldap-directory` (same id, same tool ids) in
`contents/config/integrations.json` and removes the file; nothing reads it any more.

- **Admin page and API:** **Admin → Integrations → People directories**
  (`/admin/integrations/people-directories`, `.../new`, `.../<id>`) is gone, replaced by
  **Admin → Integrations**; the routes `GET`/`PUT /api/admin/people-directories`,
  `GET /api/admin/people-directories/presets` and `POST /api/admin/people-directories/test` are
  removed. Test a directory with `POST /api/admin/integrations/installed/<id>/_test` (an unsaved
  one with `POST /api/admin/integrations/catalog/com.intrafind%2Fldap-directory/_test`); the
  sample search travels as `testInput: { "query": "…" }`.
- **Apps:** `requiredIntegrations` is retired — the schema accepts only an empty list — and
  `tools: ["peopleDirectories"]` selects nothing any more. The migration turns both into the
  definition binding `"integrations": { "com.intrafind/ldap-directory": {} }`; a directory id or
  `<id>__search_people` in `tools` becomes a binding of that installation (narrowed to the action
  where one was named). `ldapBrowse` and `<id>__browse_*` entries were kept by V198; migration
  V205 turns them into bindings of the new LDAP browser installations (see
  [LDAP Browser Moved Into Its Own Integration](#ldap-browser-moved-into-its-own-integration)).
  The shipped `ldap-browser` app binds the LDAP browsers instead of `requiredIntegrations`.
- **Groups:** a directory's `groups` became the installation's `allowedGroups`; `["*"]` became
  "everyone" (an empty list). Migration V203 then moves them onto the groups (see
  [Installed Integrations No Longer Carry Groups](#installed-integrations-no-longer-carry-groups)). A browse-only directory (empty `groups`) keeps its people search
  closed because the migration switches its search actions off; switch them on in the wizard to
  open it.
- **Deployments that write `peopleDirectories.json`** (Helm values, templates, scripts) have to
  write installations; the field names are listed in `docs/people-directory-search.md`. The
  shipped `x500bund` entry is now a disabled installation in the default `integrations.json`;
  `examples/config/peopleDirectories.json` is gone.
- **A directory whose id another installation already holds** is not moved: it is kept in
  `contents/config/peopleDirectories.unmigrated.json` with a warning in the log. Install it as a
  People directory (LDAP) under a free id and bind it to its apps.

## iHub's Own Tool Files Retired

Migration V199 deletes `contents/tools/ask_user.json`, `knowledge.json`, `evidence.json`,
`write_artifact.json`, `read_memory.json`, `write_memory.json`, `read_inbox.json`,
`write_inbox.json`, `create_task.json`, `list_tasks.json`, `mark_task_done.json`,
`schedule_task.json`, `list_scheduled_tasks.json`, `update_scheduled_task.json`,
`delete_scheduled_task.json`, `run_scheduled_task_now.json`, `list_task_runs.json` and
`get_task_run.json` when they are the shipped files, and iHub no longer copies them back on
start. The tools keep their ids: `ask_user` and the scheduled-task tools are actions of the
always-installed integration `ihub` (`com.intrafind/ihub`), the knowledge tools belong to
projects, and the agent workspace and evidence tools to workflows and agents.

- **Admin → Tools** no longer lists them. Switch `ask_user` or a scheduled-task tool off on the
  `ihub` installation instead (a file that was `enabled: false` is migrated into
  `actions.disabled`). A tool file an admin edited is left in `contents/tools/` with a warning in
  the log and keeps serving its tool until it is deleted; move the change over first.
- **The knowledge tools can no longer be switched off:** a disabled `knowledge.json`, or a
  knowledge action switched off on the `ihub` installation, no longer applies — every request that
  reaches a project gets them while the projects feature is on. An edited `knowledge.json` is not
  read any more (migration V202 warns about it); delete it.
- **The agent workspace and evidence tools are no longer listed under the iHub integration**
  (migration V202 removes them from the installation's actions). One that was switched off there
  stays off: V202 writes its tool file to `contents/tools/` with `enabled: false`. A single
  evidence function cannot be switched off on its own; V202 names one in a warning.
- **Apps and groups** need no change: `tools: ["ask_user"]` and friends and `permissions.tools`
  grants keep selecting the tools. `tools: ["ihub"]` selects nothing, and neither does
  `tools: ["knowledge"]`: the knowledge tools come with the request's projects.
- **The `ihub` installation** cannot be removed or disabled: `DELETE
  /api/admin/integrations/installed/ihub` and `POST …/ihub/_disable` answer 400
  (`ALWAYS_INSTALLED`). The instance id `ihub` is reserved.
- **Deployments that ship these tool files themselves** (templates, scripts) have to drop them:
  the migrations remove a shipped copy once, and a copy written later takes the place of the
  built-in tool again, out of reach of the `ihub` installation's switches.

## Cloud Storage Providers Moved Out of `platform.json`

Migration V200 moves `platform.cloudStorage.providers[]` into the installed integrations
`office365` (`com.intrafind/office365`), `googledrive` (`com.intrafind/google-drive`) and
`nextcloud` (`com.intrafind/nextcloud`) in `contents/config/integrations.json` and removes the
block. The platform schema rejects a `cloudStorage` key afterwards, so a `platform.json`
restored from a backup after the upgrade fails validation until the block is removed, and
`PUT /api/admin/configs/platform` no longer carries `cloudStorage`.

- **Admin pages:** **Admin → Integrations → Office 365 / Google Drive / Nextcloud**
  (`/admin/integrations/office365`, `/admin/integrations/google-drive`,
  `/admin/integrations/nextcloud`) and the shared provider editor are gone; each installation has
  its page under **Admin → Integrations** with the provider's editor. The user-facing routes
  `/api/integrations/{office365,googledrive,nextcloud}/*` stay; see
  [Storage Providers](#storage-providers-apps-bind-them-requests-name-the-installation) for what
  they require now.
- **Installation id = provider id.** Each provider becomes an installation whose id is the
  provider's former `id` (migration V206 renames what V200 created and installs the further
  providers of a type V200 kept in `contents/config/cloudStorage.unmigrated.json`, then deletes the
  file), so callback URLs, stored user tokens and the Nextcloud embed plugin's `ihub_provider_id`
  keep working. Group grants (`permissions.integrations`) and app bindings naming the old
  installation id follow the rename. When a provider id cannot be an installation id (another
  installation holds it, or it is reserved such as `jira`), the log warns: those users connect
  again and the redirect URI of the installation id has to be registered.
- **Office 365 tenant id:** the tenant id is an identifier, not a secret; it is stored in the
  clear on the installation (restored from the former `tenantIdRef` credential where V200 could not
  read it), and the tenant id credentials no configuration names any more are deleted from the
  credential store. A plain `clientSecret` in a hand-edited file goes into the credential store as
  `integration-<id>-clientSecretRef`.
- **Deployments that write `platform.json` themselves** (Helm values, templates, scripts) have
  to write the installations instead; the field names are listed in
  `docs/office365-integration.md`, `docs/google-drive-integration.md` and
  `docs/nextcloud-integration.md`. There were no `IHUB_PLATFORM__CLOUD_STORAGE__*` environment
  overrides in use by the shipped configuration; an override of that path no longer applies.
- **Validator:** `server/validators/cloudStorageSchema.js` is removed.

## One Error Code When an Integration Needs Connecting

Tools, the MCP App routes and scheduled runs report a missing or unusable integration connection
with one code, `INTEGRATION_AUTH_REQUIRED`, instead of one per integration.

- **Tool results:** Jira tools returned `{ "error": "JIRA_AUTH_REQUIRED", "authUrl": … }` and
  per-user MCP tools `{ "error": "MCP_AUTH_REQUIRED", "authRequired": … }`. Both now return
  `{ "error": "INTEGRATION_AUTH_REQUIRED", "integration": "<installation id>", "reason":
  "not_connected" | "expired" | "insufficient_scope", "message": …, "connectUrl": … }`; MCP results
  keep their `authRequired` marker for the chat's Connect card. `authUrl` is gone.
- **MCP App routes:** the 409 answer's `code` is `INTEGRATION_AUTH_REQUIRED` (was
  `MCP_AUTH_REQUIRED`) and carries `integration`.
- **Scheduled runs:** a run that fails for a missing connection ends with the reason code
  `INTEGRATION_AUTH_REQUIRED` (was `INTEGRATION_RECONNECT_REQUIRED`), with `integration` and
  `reason`; it now fails before the model call when the owner is not connected to an integration
  whose tools the run may call.
- **Sign-in state:** the `state` of an integration sign-in is an opaque handle of a single-use
  record kept server-side (storage namespace `integration-oauth-flows`), no longer a signed ticket.
  A sign-in started before the upgrade and finished after it fails with `invalid_state`; the user
  starts it again. Installations that run several instances already share `contents/`, where
  these records live.

**Before upgrading:** scripts, workflows or clients that match on `JIRA_AUTH_REQUIRED`,
`MCP_AUTH_REQUIRED`, `INTEGRATION_RECONNECT_REQUIRED` or the `authUrl` field have to match on
`INTEGRATION_AUTH_REQUIRED` and read `connectUrl` instead.

## One Connect Flow Replaces the Per-Integration Connect Routes

Connecting, checking and disconnecting an integration that signs users in (Jira, Office 365,
Google Drive, Nextcloud, MCP servers with per-user sign-in) now goes through one API for every
protocol. The per-integration routes are removed; the OAuth callback URLs registered in vendor
apps keep working unchanged.

| Removed | Use instead |
| --- | --- |
| `GET /api/integrations/jira/auth` | `POST /api/integrations/jira/connect` `{ "returnUrl" }` → `{ "url" }` |
| `GET /api/integrations/jira/status` | `GET /api/integrations/jira` (`connection.status`) |
| `POST /api/integrations/jira/disconnect` | `POST /api/integrations/jira/disconnect` is now the generic route (same path, no body) |
| `POST /api/integrations/jira/refresh` | none: tokens refresh on use; `GET /api/integrations/jira` shows the state |
| `GET /api/integrations/{office365,googledrive,nextcloud}/auth?providerId=<id>` | `POST /api/integrations/<id>/connect` |
| `GET /api/integrations/{office365,googledrive,nextcloud}/status?providerId=<id>` | `GET /api/integrations/<id>` |
| `POST /api/integrations/{office365,googledrive,nextcloud}/disconnect` (`providerId` in query or body) | `POST /api/integrations/<id>/disconnect` |
| `GET /api/mcp/oauth/authorize?serverId=<id>&scope=` | `POST /api/integrations/<id>/connect`, or `…/reconnect` `{ "scopes" }` |
| `GET /api/mcp/oauth/connections` | `GET /api/integrations` (per-user servers have `connection.mode: "personal"`) |
| `POST /api/mcp/oauth/disconnect` `{ "serverId" }` | `POST /api/integrations/<id>/disconnect` |

- **Return parameters:** after a sign-in the browser comes back with
  `integration_connected=<installation id>`, or `integration_error=<code>&integration=<installation
  id>`, instead of `jira_connected`, `office365_error`, `mcp_connected`, `mcp_error`, `mcp_server`
  and the like. The codes are the same for every integration; `session_expired` is now
  `state_expired`, `server_not_found` is `integration_not_found`, a refused token exchange is
  `exchange_failed`, a declined consent is `access_denied`.
- **Return URL:** a `returnUrl` that is not a path or an http(s) URL on this host is refused with
  `400 INVALID_RETURN_URL` instead of being replaced by the settings page.
- **`INTEGRATION_AUTH_REQUIRED` results:** `connectUrl` is the connect route
  (`/api/integrations/<id>/connect`, or `/reconnect` with `scopes` for a missing permission). MCP
  results no longer carry the `authRequired` marker or the URL in `message`.
- **File browsers:** browsing a storage provider without a usable connection answers `409` with
  `INTEGRATION_AUTH_REQUIRED` (was `401` or `500`).
- **Stored chats:** Connect cards stored with answers before the upgrade (MCP servers only) are
  not shown again; the next request that needs the connection shows the new card.

**Before upgrading:** browser extensions, add-ins, portals or scripts that call any of the removed
routes, read the old return parameters or follow `connectUrl` with a `GET` have to use the routes
and parameters above. Admins and users need not reconnect.

## Installed Integrations No Longer Carry Groups

Who may use an installed integration is now granted on the groups (`groups.json` →
`permissions.integrations`, **Admin → Groups → a group → Integrations**). The `allowedGroups`
field of an installation in `contents/config/integrations.json` is gone.

- **Migrated for you:** migration V203 grants every group what it could use before. A group that
  could use every installation (each one open to everyone, or naming the group or a group it
  inherits) gets `*`, so it also gets the ones installed later; any other group gets the ids of
  the installations it could use. Then `allowedGroups` is removed from every installation. Groups
  that already have `permissions.integrations` are left alone.
- **Groups that exist only outside `groups.json`:** an `allowedGroups` entry naming a group that
  `groups.json` does not define has nowhere to go; the migration logs a warning per group. Create
  the group and grant it the integrations, or its members lose them.
- **New groups grant nothing:** a group created after the upgrade lists no integrations until an
  admin ticks them; its members still get what their other groups grant (`authenticated` grants
  every integration in the shipped configuration).
- **Admin API:** `POST` and `PUT /api/admin/integrations/installed` and the connection tests
  refuse a payload with `allowedGroups` (400, code `ALLOWED_GROUPS_REMOVED`, naming the group
  page), and `GET` no longer returns the field. Scripts that installed integrations with groups
  have to grant them on the groups instead (`PUT /api/admin/groups/:id`, `permissions.integrations`).
- **Storage providers:** `/api/auth/status` lists in `cloudStorage.providers` only the providers
  the user's groups grant, and connecting, browsing or importing from another one is refused
  (403).
- **Machine OAuth clients** (client credentials, static API keys) are in no group: they may use
  every integration an app in their **allowed apps** binds, where an installation limited to some
  groups refused them before.

**Before upgrading:** nothing is required. After the upgrade, check **Admin → Groups** for the
grants V203 wrote, and the server log for warnings about groups it could not find.

## Admin → Integrations → Installed Merged Into Admin → Integrations

The separate page **Installed integrations** (`/admin/integrations/installed`) and its sidebar
item are removed; its tabs are now part of **Admin → Integrations**. There is no redirect: the old
address opens an installation page that does not exist.

- The links inside iHub (marketplace **Set up integration**, the LDAP sign-in providers' **Use
  for people search**, the admin start page) point to the new page. Install links keep their
  parameters: `/admin/integrations?install=<definition folder>&v.<field>=<value>&label=<label>`.
- The cloud storage and people directory cards of the former Integrations hub are gone; those
  are installations on the **Installed** tab.

**Before upgrading:** update bookmarks, runbooks and wiki links that point to
`/admin/integrations/installed` to `/admin/integrations` (or `/admin/integrations/<installation id>`
for one installation).

## LDAP Browser Moved Into Its Own Integration

The admin LDAP browser is no longer a switch of a people directory but an installation of the new
integration **LDAP browser** (`com.intrafind/ldap-browser`) that reuses the directory's
connection. Migration V205 moves it for you.

- **Tool ids change:** a directory's `<directory id>__browse_search`, `__browse_read` and
  `__browse_children` become `<browser id>__browse_*`. V205 names each browser
  `<directory id>-browser` (with a number when the id is taken) and rewrites app bindings,
  `tools` entries and group tool grants that named the old ids or `ldapBrowse`. The `ldapBrowse`
  reference selects nothing any more.
- **`browse.groups` is gone:** who may browse is the browser installation's grant on the groups
  (`permissions.integrations`). V205 grants the browser to the groups that were in the
  directory's browser groups (`admins` when none were set) and warns about groups it cannot find.
  **Groups that hold `*` may use every installation, the browser included**: with the shipped
  groups that is every signed-in user, wherever an app they can open binds the browser. V205 logs
  the groups this opens the browser to.
- **The directory definition lost its browser fields:** `browse`, `browseGroups`, `browseBase`,
  `browseMaxResults`, `browseBindMode`, `browseBindDn`, `browseBindPasswordRef` and
  `browseDenyAttributes` and the actions `browse_*` are no longer part of People directory
  (LDAP). V205 removes them from every directory; the settings of a browser that was switched off
  are dropped (the log lists them). Deployments that write `integrations.json` have to write an
  LDAP browser installation instead (fields: `directory`, `baseDn`, `maxResults`, `bindMode`,
  `bindDn`, `bindPasswordRef`, `denyAttributes`).
- **Audit records** of new browser calls carry the browser installation id as resource id (the
  directory is in the summary).

**Before upgrading:** nothing is required. After the upgrade, check the server log for the V205
warnings and, under **Admin → Groups**, which groups may use the new LDAP browser installations:
replace a `*` grant with explicit integrations for groups that should not browse, or keep the
LDAP browser app limited to admin groups.

## Storage Providers: Apps Bind Them, Requests Name the Installation

An app offers storage providers (Office 365, Google Drive, Nextcloud) by binding them, and every
request to a storage provider names the installation it means, since a provider can be installed
several times.

- **`upload.cloudStorageUpload` is removed.** Migration V206 turned every
  `upload.cloudStorageUpload.enabled: true` into the binding
  `"integrations": { "type:storage": { "required": false } }` (all storage providers, optional) and
  removed the key from every app. The app schema refuses it from now on: saving such an app under
  **Admin → Apps** or installing it from the marketplace fails with a message naming the binding,
  and an app file written by hand that still has it loads with a validation warning and offers no
  cloud file picker. Bind single providers with their installation id or definition id instead.
- **Routes need the installation id.** `/api/integrations/{office365,googledrive,nextcloud}/…`
  require `?providerId=<installation id>` (the OAuth callback carries it in its path, `/disconnect`
  also accepts it in the JSON body): `400 STORAGE_PROVIDER_REQUIRED` without it,
  `404 STORAGE_PROVIDER_NOT_FOUND` for an installation that does not exist (except `/status` and
  `/disconnect`), `403 INTEGRATION_NOT_GRANTED` as before. The shipped client always sends it;
  scripts that called the browse routes without it have to add it.
- **`/api/auth/status`:** `cloudStorage.providers[].id` is the installation id; each provider also
  carries its `definition`.
- **Redirect URI derivation:** an empty redirect URI is derived from the request including the
  base path (`X-Forwarded-Prefix`), and the environment variables `OFFICE365_OAUTH_REDIRECT_URI`,
  `GOOGLEDRIVE_OAUTH_REDIRECT_URI` and `NEXTCLOUD_OAUTH_REDIRECT_URI` and the
  `SERVER_URL`/localhost fallback are no longer read; without a configured value and without a
  request host the sign-in refuses to start.
- **Install field `providerId` is removed** from the three definitions; an installation saved with
  it is refused (unknown value).

**Before upgrading:** if iHub runs under a base path (for example `/ihub`) and an installation
leaves **Redirect URI** empty, register the new URI
`https://<host>/ihub/api/integrations/<provider>/<installation id>/callback` with the provider (the
installation's **Settings** tab shows it) — or set the old, working URI as the installation's
**Redirect URI**. If you set one of the `*_OAUTH_REDIRECT_URI` variables, enter its value as the
installation's **Redirect URI**. After the upgrade, check the server log for V206 warnings
(installations that kept their id, tenant ids to enter).

## Integrations: Migration State in the Admin API and Stricter Definition Versions

Integration definitions now migrate their installations (see the feature entry on versions and
migrations). Three things change for scripts and hand-written files:

- **`status` of an installation is its migration state.** `GET /api/admin/integrations/installed`
  and `GET …/installed/:id` return `status` as `migrationPending`, `migrationFailed`,
  `needsReview` or `null`, with `statusReason`, `migrationLog` and `migration`. The live
  connection status of MCP servers, directories and storage providers, which was `status`, is now
  `liveStatus`.
- **An installation needs a valid `definitionVersion`.** One without it (or with a value that is
  not a version like `1.2.0`) needs a review and offers no actions until an admin adopts the
  current version or restores a backup. Migration V207 stamps every existing installation with the
  version of its definition, so only installations written by hand after the upgrade are
  affected. Saving an installation (`PUT …/installed/:id`) is refused with `409` and
  `MIGRATION_PENDING`, `MIGRATION_FAILED` or `NEEDS_REVIEW` while it is in one of these states.
- **A release's `migration` must exist.** In `integration.json`, `releases[].migration` names the
  release's own version and a migration of that id listed in `migrations`; a definition that
  names a migration it does not list, or that uses a `module` step, is not loaded and is refused by
  the marketplace.

**Before upgrading:** scripts that read the live connection status from `status` read
`liveStatus` instead. Hand-written entries in `contents/config/integrations.json` carry a
`definitionVersion`; after the upgrade, check **Admin → Integrations** for installations that need
a review (definitions that could not be found by V207 are named in the server log).
