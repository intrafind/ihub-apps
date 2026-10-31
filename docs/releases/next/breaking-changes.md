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
  **Admin → Integrations → Installed**. The routes `/api/admin/mcp/servers*`,
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

- **Admin page and API:** **Admin → A2A agents** is gone, replaced by **Admin → Integrations →
  Installed**; the routes `/api/admin/a2a/agents*`, `/api/admin/a2a/test`, `/api/admin/a2a/status`
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

## Web Search Keys Moved From `providers.json` to the `websearch` Installation

Migration V195 moves the `websearch` entries of `contents/config/providers.json` (Brave, Staan,
Qwant) into the installed integration `websearch` and the credentials
`integration-websearch-brave` / `integration-websearch-staan`, and deletes the tool files
`braveSearch.json`, `staanSearch.json`, `qwantSearch.json` and `read_url.json` from
`contents/tools/`.

- **Admin page and API:** the **Web Search Providers** category on **Admin → Providers** and
  `POST /api/admin/providers/{id}/websearch-test` are gone; use the installation and
  `POST /api/admin/integrations/installed/websearch/_test`. A provider with
  `category: "websearch"` can no longer be created.
- **Tools:** the four tools are no longer listed under **Admin → Tools** and cannot be disabled
  there; switch the installation's actions off instead. A `tools` entry naming one of them (an
  app's, a workflow node's) still selects it, now from the installation and only while the
  installation is enabled and its groups include the user. The migration removes `braveSearch`,
  `staanSearch` and `qwantSearch` from apps' `tools`; an app that had web search only through such
  an entry gets `websearch: { enabled: true, enabledByDefault: true, provider }` with the engine it
  named instead (logged per app). `read_url` entries stay.
- **Apps with web search on** stay available while the `websearch` installation is disabled or
  missing, without the search toggle and without native search; `websearch.required: true` hides
  the app instead, like a required integration binding. The installation's groups apply to them
  — to native search on Google, OpenAI and Anthropic models as well, not only to the
  script-backed search tools.
- **Deployments that write `providers.json` or the tool files themselves** have to write the
  installation and credentials instead; `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` still work.

## Jira Configuration Moved Out of `platform.json`

Migration V196 moves `platform.jira` into the installed integration `jira`
(`contents/config/integrations.json`) and removes the block; `PUT /api/admin/configs/platform`
no longer carries a `jira` key.

- **Admin page:** **Admin → Integrations → Jira** (`/admin/integrations/jira`) is gone; use
  **Admin → Integrations → Installed → Atlassian Jira**. The user-facing routes
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
  **Admin → Integrations → Installed**; the routes `GET`/`PUT /api/admin/people-directories`,
  `GET /api/admin/people-directories/presets` and `POST /api/admin/people-directories/test` are
  removed. Test a directory with `POST /api/admin/integrations/installed/<id>/_test` (an unsaved
  one with `POST /api/admin/integrations/catalog/com.intrafind%2Fldap-directory/_test`); the
  sample search travels as `testInput: { "query": "…" }`.
- **Apps:** `requiredIntegrations` is retired — the schema accepts only an empty list — and
  `tools: ["peopleDirectories"]` selects nothing any more. The migration turns both into the
  definition binding `"integrations": { "com.intrafind/ldap-directory": {} }`; a directory id or
  `<id>__search_people` in `tools` becomes a binding of that installation (narrowed to the action
  where one was named). `ldapBrowse` and `<id>__browse_*` entries stay and keep working. The
  shipped `ldap-browser` app binds the browse actions of every directory instead of
  `requiredIntegrations`.
- **Groups:** a directory's `groups` became the installation's `allowedGroups`; `["*"]` became
  "everyone" (an empty list). A browse-only directory (empty `groups`) keeps its people search
  closed because the migration switches its search actions off; switch them on in the wizard to
  open it.
- **Deployments that write `peopleDirectories.json`** (Helm values, templates, scripts) have to
  write installations; the field names are listed in `docs/people-directory-search.md`. The
  shipped `x500bund` entry is now a disabled installation in the default `integrations.json`;
  `examples/config/peopleDirectories.json` is gone.
- **A directory whose id another installation already holds** is not moved: it is kept in
  `contents/config/peopleDirectories.unmigrated.json` with a warning in the log. Install it as an
  LDAP people directory under a free id and bind it to its apps.

## iHub's Own Tool Files Retired

Migration V199 deletes `contents/tools/ask_user.json`, `knowledge.json`, `evidence.json`,
`write_artifact.json`, `read_memory.json`, `write_memory.json`, `read_inbox.json`,
`write_inbox.json`, `create_task.json`, `list_tasks.json`, `mark_task_done.json`,
`schedule_task.json`, `list_scheduled_tasks.json`, `update_scheduled_task.json`,
`delete_scheduled_task.json`, `run_scheduled_task_now.json`, `list_task_runs.json` and
`get_task_run.json` when they are the shipped files; the always-installed integration `ihub`
(`com.intrafind/ihub`) owns these tools under the same ids.

- **Admin → Tools** no longer lists them and they cannot be switched off there; switch the
  action off on the `ihub` installation instead (a file that was `enabled: false` is migrated
  into `actions.disabled`). A tool file an admin edited is left in `contents/tools/` with a
  warning in the log and keeps serving its tool in place of the installation's action until it
  is deleted; move the change over first.
- **Apps and groups** need no change: `tools: ["ask_user"]` and friends and `permissions.tools`
  grants keep selecting the tools. `tools: ["ihub"]` selects nothing.
- **The `ihub` installation** cannot be removed or disabled: `DELETE
  /api/admin/integrations/installed/ihub` and `POST …/ihub/_disable` answer 400
  (`ALWAYS_INSTALLED`). The instance id `ihub` is reserved.
- **Deployments that ship these tool files themselves** (templates, scripts) can drop them; a
  shipped copy is deleted on the next start.

## Cloud Storage Providers Moved Out of `platform.json`

Migration V200 moves `platform.cloudStorage.providers[]` into the installed integrations
`office365` (`com.intrafind/office365`), `googledrive` (`com.intrafind/google-drive`) and
`nextcloud` (`com.intrafind/nextcloud`) in `contents/config/integrations.json` and removes the
block. The platform schema rejects a `cloudStorage` key afterwards, so a `platform.json`
restored from a backup after the upgrade fails validation until the block is removed, and
`PUT /api/admin/configs/platform` no longer carries `cloudStorage`.

- **Admin pages:** **Admin → Integrations → Office 365 / Google Drive / Nextcloud**
  (`/admin/integrations/office365`, `/admin/integrations/google-drive`,
  `/admin/integrations/nextcloud`) and the shared provider editor are gone; use
  **Admin → Integrations → Installed**. The user-facing routes
  `/api/integrations/{office365,googledrive,nextcloud}/*` and `/api/auth/status` (its
  `cloudStorage` payload is filled from the installations) are unchanged.
- **One installation per provider type.** Each definition is a singleton; the first enabled
  provider of a type (else the first) becomes the installation, further providers of the same type
  are kept in `contents/config/cloudStorage.unmigrated.json` with a warning in the log. The
  provider's `id` becomes the installation's **Provider id** value when it differs from the
  installation id, so callback URLs, stored user tokens and the Nextcloud embed plugin's
  `ihub_provider_id` keep working.
- **Office 365 tenant id:** the tenant id is an identifier, not a secret; the migration decrypts
  the former `tenantIdRef` credential into the plain `tenantId` value (the credential entry is
  left in the store). A plain `clientSecret` in a hand-edited file goes into the credential store
  as `integration-<id>-clientSecretRef`.
- **Deployments that write `platform.json` themselves** (Helm values, templates, scripts) have
  to write the installations instead; the field names are listed in
  `docs/office365-integration.md`, `docs/google-drive-integration.md` and
  `docs/nextcloud-integration.md`. There were no `IHUB_PLATFORM__CLOUD_STORAGE__*` environment
  overrides in use by the shipped configuration; an override of that path no longer applies.
- **Validator:** `server/validators/cloudStorageSchema.js` is removed.
