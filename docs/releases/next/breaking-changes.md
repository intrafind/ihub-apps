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
nothing reads it any more.

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
  there; switch the installation's actions off instead. A `tools` entry naming one of them selects
  nothing (the migration removes such entries).
- **Apps with web search on** are hidden while the `websearch` installation is disabled or
  missing, and the installation's groups apply to them.
- **Deployments that write `providers.json` or the tool files themselves** have to write the
  installation and credentials instead; `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` still work.
