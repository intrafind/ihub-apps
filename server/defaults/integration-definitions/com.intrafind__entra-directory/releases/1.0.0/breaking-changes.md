# Entra directory 1.0.0 — breaking changes

Config migration V197 moved the settings into the installation:

- The tool file `tools/entraPeopleSearch.json` is retired; the installation owns the tools.
- `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` are copied into the installation once; `AZURE_CLIENT_SECRET` is read from the environment only until an admin points the installation at a credential. The installation is enabled only when all three variables were present.
- An app that listed `entraPeopleSearch` or `entraPeopleSearch_*` in `tools` binds the installation (`integrations.entra`) instead.
