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

