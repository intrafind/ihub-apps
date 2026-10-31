# Web search 1.0.0 — breaking changes

Config migration V195 moved the settings into the installation:

- The `websearch` entries of `config/providers.json` are removed; their API keys are in the credential store, referenced by the installation.
- The shipped tool files `braveSearch.json`, `staanSearch.json`, `qwantSearch.json` and `read_url.json` are removed; the installation owns these tools.
- An app that listed a search tool in `tools` (such as `braveSearch`) gets `websearch: { enabled, enabledByDefault, provider }` with that engine instead; a `read_url` reference stays in `tools`.
