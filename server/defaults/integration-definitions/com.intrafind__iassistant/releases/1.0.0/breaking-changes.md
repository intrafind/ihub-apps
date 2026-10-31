# iAssistant 1.0.0 — breaking changes

Config migration V192 moved the settings into the installation:

- `platform.iAssistant` leaves `platform.json`; the values are in `config/integrations.json` under the installation `iassistant`.
- `IHUB_PLATFORM__I_ASSISTANT__*` environment variables are folded into the installation once and have no effect afterwards.
- An app on the iAssistant model (`preferredModel`) or with `iassistant.enabled` binds the installation (`integrations.iassistant`) instead.
