# Admin integrations page and installation editors (implementation notes)

**Date:** 2026-11-01
**Status:** Implemented on `claude/exciting-feynman-2aju98-admin-ui`
**Decision:** [07 · Types and built-in configuration, section 3](07-types-and-built-in-configuration.md)
**User docs:** [docs/integrations.md → The Integrations page](../../docs/integrations.md#the-integrations-page)

These notes are for whoever continues the work: what exists, where it lives, and how to add the
next dedicated editor (web search, storage providers, people directories, Jira).

## What the product owner asked for

1. One admin page `/admin/integrations` instead of "Integrations" (hub cards) plus
   "Installed integrations". The route `/admin/integrations/installed` is removed without a
   redirect (clean break). The sidebar keeps **Integrations**, **MCP gateway**, **Credentials**.
2. Tabs **Installed** (default), **Catalog**, **Inbound** (`?tab=installed|catalog|inbound`).
3. Installed and Catalog grouped: People directories, Web search, Storage providers, MCP
   servers, Agents, Built-in, From the catalog. Empty groups are hidden.
4. Rich tiles with key facts (never a secret), and a page per installation
   `/admin/integrations/:instanceId` with Overview / Settings / Releases, where Settings shows a
   dedicated editor (iFinder, iAssistant so far) or the generic form.
5. Everything the old installed page did keeps working (test, update badge, incompatible
   reason, enable/disable confirmation naming bound apps, remove confirmation, reload catalog,
   install from catalog, `?install=` deep link with `v.<key>=` and `label` prefill, connected
   users dialog).

## File map

All client paths are under `client/src/features/admin/`.

| File | What it does |
| --- | --- |
| `pages/AdminIntegrationsPage.jsx` | The page: tabs, search, groups, tiles, install dialog, deep link, confirmations |
| `pages/AdminInstallationPage.jsx` | One installation: header actions, Overview / Settings / Releases |
| `components/integrations/integrationGroups.js` | **Pure.** The seven groups and `groupIntegrations(entries)` — used by both tabs |
| `components/integrations/integrationFacts.js` | **Pure.** `installationFacts(item, { installations, definition, limit })` per definition / protocol / generic; secrets only as set / not set |
| `components/integrations/integrationBindings.js` | **Pure.** Which apps bind an installation (id, definition id, `type:<type>`) |
| `components/integrations/installationPayload.js` | **Pure.** The PUT body an editor sends; keeps what it does not edit |
| `components/integrations/inboundChannels.js` | **Pure.** The Inbound cards and their status from `platform.json` |
| `components/integrations/InstallationTile.jsx`, `CatalogTile.jsx`, `IntegrationGroupSection.jsx`, `IntegrationPills.jsx`, `IntegrationFactList.jsx`, `InboundIntegrations.jsx` | The building blocks of the page |
| `components/integrations/IntegrationInstallForm.jsx` | The generic form (was the body of `IntegrationInstallDialog`); `variant="dialog"` or `"page"` |
| `components/integrations/IntegrationInstallDialog.jsx` | Modal around the form, for **new** installations only |
| `components/integrations/ActionToggleList.jsx` | The action checkboxes (shared by the form and the editors) |
| `components/integrations/editors/index.js` | **The editor registry** |
| `components/integrations/editors/useInstallationEditor.js`, `InstallationEditorParts.jsx` | Shared state and sections of every dedicated editor |
| `components/integrations/editors/IFinderEditor.jsx`, `IFinderTokenExchangeSettings.jsx`, `iFinderEditorModel.js` | The iFinder editor (restored from `IFinderConfig.jsx` before commit ee961dc) |
| `components/integrations/editors/IAssistantEditor.jsx` | The iAssistant editor |

Removed: `pages/AdminInstalledIntegrationsPage.jsx`, `components/AdminIntegrationHubPage.jsx`.

Server: `GET /api/admin/integrations/installed[/:id]` additionally returns `labelLocalized`
(the stored `{ en, de }` label) so an editor can change one language and keep the others.

## The editor contract

```js
// editors/index.js
const EDITORS = {
  'com.intrafind/ifinder': IFinderEditor,
  'com.intrafind/iassistant': IAssistantEditor
};
```

An editor receives four props:

- `instance` — the installation from `GET …/installed/:id`, with `values` = the **effective**
  values (defaults applied, sensitive fields left out) and `liveActions` = the listed actions
  (`editorInstance(detail)` builds it).
- `definition` — the definition detail (install fields, actions, `dynamicActions`, `name`).
- `onSaved(saved)` — call after a successful save; the page reloads and remounts the editor.
- `onCancel()` — the page remounts the editor and goes back to Overview.

### Adding an editor (e.g. web search)

1. Create `editors/WebSearchEditor.jsx`. Start with
   `const editor = useInstallationEditor({ instance, definition, onSaved })` and keep only the
   install values in your own state (`useState(() => ({ ...defaults, ...instance.values }))`).
2. Render `<form id="…" onSubmit={…}>` with `NameSection`, your own `EditorSection`s,
   `AccessSection`, `ActionsSection`, and `EditorFooter` outside the form (it submits by
   `formId`). Test: `editor.runTest(values)`; save: `editor.save(values)`; your own validation:
   `editor.reject(fieldKey, message)`.
3. Register it in `EDITORS` under the definition id.
4. Strings under `admin.integrations.editors.<name>.*` in `shared/i18n/en.json` and `de.json`.
5. Add facts for the definition in `integrationFacts.js` if it has none yet, and a test in
   `tests/unit/client/admin-installation-page.test.jsx`.

A PUT **replaces** the installation, so always send every value you loaded (the hook does that
for label, description, groups and actions through `buildInstallationPayload`).

## What the iFinder editor kept and dropped

Kept from the old `IFinderConfig.jsx`: base URL, token issuer (iHub-signed or OIDC token
exchange) with its help texts, OIDC key pair with the effective issuer, the "Configure iFinder
with" block and the missing-issuer warning, private key (credential picker), algorithm, token
lifetime, JWT issuer and audience, token scope, the JWT subject choices plus custom template,
the token exchange settings (provider, grant, audience, scope map, extra scopes, iFinder setup
hint), default and allowed search profiles, "users may change the search profile", and the
save checks (provider required for exchange, issuer URL required for the key pair; new: base URL
required). Added: name, groups, actions, and the definition's advanced fields (timeout,
download directory, endpoint paths).

Moved: the enable switch is the page header's Enable/Disable; the iAssistant section is the
iAssistant installation's own editor (connection, default profile, default search profile, plus
the new access check, grounded-only and cache fields).

Dropped (no server counterpart; the connector `test()` in
`server/services/integrations/protocols/native/connectors/ifinder/index.js` and `iassistant.js`
ignores them): **test as another user** (email / username / domain), **include the signed JWT
and curl command**, **iAssistant conversation round-trip**, and the old iAssistant **request
timeout** (not an install field since V192). Test runs as the signed-in admin against the
unsaved values (`POST …/installed/:id/_test` with the draft body).

## Open points

- `allowedGroups` is still shown and edited where the old page did; it moves to
  `permissions.integrations` on groups in a parallel change and has to be adapted after both
  merge.
- Dedicated editors for web search, storage providers and Jira follow in later PRs. The people
  directories (People directory (LDAP), Entra ID) and the LDAP browser have theirs since
  2026-11-02: see [People directories and the LDAP browser](2026-11-02%20People%20directories%20and%20the%20LDAP%20browser.md).
- The Command Palette (`AdminCommandPalette.jsx`) lists only "Integrations"; the tabs are not
  separate entries.
- If the diagnostics options (test as user, include token, round-trip) are wanted again, the
  connector `test()` needs to accept them and the installed `_test` route has to pass them on.
