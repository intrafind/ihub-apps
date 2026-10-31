# iFinder 1.0.0 — breaking changes

Config migration V192 moved the settings into the installation:

- `platform.iFinder` leaves `platform.json`; nothing reads it any more. The values are in `config/integrations.json` under the installation `ifinder`.
- `IHUB_PLATFORM__I_FINDER__*` environment variables are folded into the installation once and have no effect afterwards.
- The shipped `tools/iFinder.json` is removed. An app that listed `iFinder` or `iFinder_*` in `tools` now binds the installation (`integrations.ifinder`, optionally narrowed with `actions`); `requiredIntegrations: ["ifinder"]` became a binding with `actions: []`.
