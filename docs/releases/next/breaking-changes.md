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

