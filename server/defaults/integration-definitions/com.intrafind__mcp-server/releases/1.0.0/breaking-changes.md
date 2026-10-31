# MCP server 1.0.0 — breaking changes

Config migration V193 moved the servers into installations:

- `config/mcpServers.json` is removed; every server is an installation in `config/integrations.json` under the same id, so tool ids, group grants, per-user tokens and OAuth client registrations stay valid. `allowedTools` became `actions.enabled`; `security` merged into the integrations file.
- An app that listed a server in `tools` (`"drawio"`) binds the installation (`integrations.drawio`); a prefixed tool reference (`drawio__create_diagram`) became a binding narrowed to that action.
- A server whose id another installation already held was not moved: it is in `config/mcpServers.unmigrated.json` for the admin to install under a free id.
