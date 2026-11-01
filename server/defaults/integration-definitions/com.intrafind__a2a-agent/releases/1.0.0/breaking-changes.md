# A2A agent 1.0.0 — breaking changes

Config migration V194 moved the agents into installations:

- `config/a2aAgents.json` is removed; every agent is an installation in `config/integrations.json` under the same id, so tool ids and group grants stay valid. `allowedSkills` became `actions.enabled`; `security` merged into the integrations file.
- An app that listed an agent in `tools` (`"langdock"`, `"a2a__langdock"` or a skill `a2a__langdock__ask`) binds the installation (`integrations.langdock`) instead.
- An agent whose id another installation already held was not moved: it is in `config/a2aAgents.unmigrated.json` for the admin to install under a free id.
