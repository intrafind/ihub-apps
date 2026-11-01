# Jira 1.0.0 — breaking changes

Config migration V196 moved the settings into the installation:

- `platform.jira` leaves `platform.json`; the values are in `config/integrations.json` under the installation `jira`.
- A hand-written tool file for `tools/jira.js` is retired; an app that listed `jira` or `jira_*` in `tools` binds the installation (`integrations.jira`) instead.
