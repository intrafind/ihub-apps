# Example apps and a chat test for integrations

**Date:** 2026-11-02
**Status:** Implemented on `claude/confident-bell-n8g8t4`
**Part of:** [Unified Integrations](README.md)

## The ask

> We should allow to ship as well as configure an example app for an integration, especially for
> integrations like the LDAP browser, CKAN or similar. It would be awesome if with a click of a
> button we get it and can test it. A test mode in the integration with the chat like we have it
> in the apps admin would be the masterpiece.

## Where we are

- An admin installs an integration (Admin → Integrations), fills in the settings and runs
  **Test connection**. That checks the connection, not what users get: a model that picks the
  actions, reads the results and answers.
- To try the integration in a chat, the admin has to leave the page, create an app, find the
  binding (`app.integrations`), write a system prompt and starter prompts, save, open the app,
  and come back to the installation to change a setting. Most first-time admins stop here.
- A few integrations come with a good app, but it lives elsewhere: the **LDAP browser** app ships
  as `server/defaults/apps/ldap-browser.json` (disabled), bound to every LDAP browser. The CKAN
  concept asked for an "Open Data Assistant" app next to the integration in the marketplace,
  which never got built. A definition installed from a registry cannot bring an app at all.
- The app editor already has a **test mode** (#2510, `AppTestPanel`): the real chat of the saved
  app, beside the editor.

## The idea in one sentence

A definition can **ship example apps** as companion files; on the page of an installation the
admin opens **Test in chat**, creates the example app with one click (bound to *this*
installation), and chats with it in a panel beside the installation, the same panel the app
editor uses.

## What the admin sees

### Installation page

- A new header button **Test in chat** (beaker icon) next to **Test connection**. It opens the
  test panel beside the page (full screen below the `lg` breakpoint), exactly like the app editor.
  `?test=chat` opens the page with the panel open, so other pages can link to it.
- The **Apps that use it** card offers **Create example app** when no app uses the installation.

### Test panel

```
┌ Test in chat ──────────────────────────────────── ↻  ↗  ✕ ┐
│ Runs a saved app that uses this installation               │
├────────────────────────────────────────────────────────────┤
│ App: [ Open Data Assistant ▾ ]   Edit app                  │
│ ⚠ The installation is disabled: the app is hidden.         │  (only when it applies)
├────────────────────────────────────────────────────────────┤
│                    the app's real chat                     │
└────────────────────────────────────────────────────────────┘
```

- **App picker:** the chat apps that use the installation (by its id, its definition id or its
  type, the same list as "Apps that use it"). The first one is preselected. **Edit app** links to
  the app editor (which has its own test mode).
- **No app yet:** an empty state that offers the example app:
  - *From the integration*: the definition's example apps (name and description), one radio
    button each.
  - *Generated* when the definition ships none: an assistant built from the definition (below).
  - **App id** (prefilled, editable), **Available to users now** (checked; see "Visibility").
  - **Create and test** writes the app and starts the chat.
- **Hints** above the chat, only when they apply: the installation is disabled (a required
  binding hides the app, an optional one runs without the actions); the admin's own groups do not
  grant the installation (the chat runs without its actions — "Grant it under Admin → Groups");
  the app is disabled (enable it in the app editor to test).
- **Restart** starts a new chat; the panel restarts after every save of the installation, so a
  changed setting (another base DN, another `maxRows`) is tested on the next message without
  leaving the page. Like the app test, it runs the *saved* configuration.

## Shipping an example app

A definition lists its example apps:

```json
"exampleApps": [
  { "file": "apps/open-data-assistant.json" }
]
```

- `file` is a companion JSON file in the definition folder (`apps/<name>.json`, grammar like the
  Markdown companions, `.json` only, at most 512 KB like every served companion). Up to five example apps per definition.
- The file is an ordinary app configuration (`appConfigSchema`). It binds the integration the
  generic way, by **definition id** or **type** (`"org.ckan/open-data-portal": {}`), so it reads
  the same in the marketplace and in a repository.
- The marketplace installer fetches the files `exampleApps[].file` names, like the OpenAPI
  document and the release notes; a registry needs no extra catalog field.
- A server test validates every shipped example app against the app schema.

Shipped in this change:

| Definition | Example app |
| --- | --- |
| `com.intrafind/ldap-browser` | **LDAP browser** (the app of `server/defaults/apps/ldap-browser.json`) |
| `org.ckan/open-data-portal` | **Open Data Assistant** (the app the CKAN concept asked for) |

`server/defaults/apps/ldap-browser.json` stays as it is for now: existing installations already
have it, and removing it from fresh installs is a separate product decision (open point 1).

## Configuring the example app for an installation

Creating the app turns the template into an app for this installation (server side,
`exampleApps.js`):

1. **Binding:** a binding keyed by the definition id or by `type:<the definition's type>` is
   re-keyed to the **installation id**, keeping its settings (`actions`, `required`, scopes). A
   template without such a binding gets `{ "<instanceId>": {} }`. Other bindings (web search,
   another integration) stay as they are.
2. **Id:** the template's id when it is free, else `<templateId>-<instanceId>`, else a numeric
   suffix; the admin may type another (`APP_ID_PATTERN`, must be free).
3. **Name:** when the template's id is taken (a second installation, or the shipped default app),
   the name says which installation it is for: `"Open Data Assistant (GovData)"`.
4. **Enabled:** from the dialog. Everything else stays as the template has it.
5. The result is validated with `appConfigSchema` and written create-only, like
   `POST /api/admin/apps`; audited as `create app` with the summary "from the example app of
   integration <id>".

### The generated example app

For a definition without example apps (any MCP server, a custom OpenAPI integration, Jira, …) the
server builds one from what the definition already says:

- `name`: the installation label; `description`: the definition description.
- `system` (en, de): "You answer with the tools of the integration *<label>*: <description>.
  Use them for questions they can answer; say so when they cannot; never invent results." plus the
  definition's `instructions`.
- `starterPrompts`: the first three action `examples` (localized), else none.
- `integrations`: `{ "<instanceId>": {} }`; `icon` `link`, a neutral color, `category` utility.

It is a starting point the admin edits in the app editor, not a product.

## Visibility

The chat serves only enabled apps (`configCache.getApps()` drops disabled ones in some 50 places),
so a test needs an enabled app. Enabled apps are visible to every group whose `permissions.apps`
holds `*` (the shipped `users` and `authenticated`). The dialog therefore says so next to
**Available to users now**, and an admin who wants to try first unchecks it, then enables the app
in the app editor when they want to test. An admin-only preview of disabled apps would need the
chat routes to accept an admin "test" flag in every app lookup; that is open point 2, not part of
this change.

For the LDAP browser this is less of a concern than it looks: users who are not granted the browser
installation see the app but get no browse tools (the app's system prompt explains it).

## API

Next to the admin integration routes, in `routes/admin/integrationExampleApps.js` (`adminAuth`):

| Route | What it does |
| --- | --- |
| `GET /api/admin/integrations/installed/:id/example-apps` | the templates (`key`, `name`, `description`, `source: definition\|generated`) with the suggested app id of each, `grantedToYou` (whether the calling admin's groups grant the installation) and `enabled`; the apps that already use the installation come from the app list the page loads anyway |
| `POST /api/admin/integrations/installed/:id/example-apps` | body `{ template, appId?, enabled? }` → `201 { app }`; `409` when the id is taken; `400` on an invalid id or app |

## What changes where

Server:

- `validators/integrationDefinitionSchema.js`: `exampleApps` (`[{ file }]`, max 5, JSON companion
  path).
- `services/integrations/definitions/IntegrationRegistry.js`: `readExampleApp(id, file)` (only files
  the definition lists).
- `services/integrations/exampleApps.js` (new, pure): `buildExampleApp`, `bindToInstallation`,
  `suggestAppId`, `generatedExampleApp`, `nameForInstallation`, `templateView`.
- `routes/admin/integrationExampleApps.js` (new): the two routes; the catalog lists
  `exampleAppCount` per definition.
- `services/marketplace/ContentInstaller.js`: fetch `exampleApps[].file` with the definition.
- The two shipped definitions get `apps/*.json` and an `exampleApps` entry, and release 1.1.0
  (no migration; the startup run stamps the installations).

Client:

- `AppTestPanel.jsx`: `TestChat` is exported so both panels run the same chat.
- `components/integrations/IntegrationTestPanel.jsx` (new): app picker, example app form, hints,
  the chat.
- `AdminInstallationPage.jsx`: **Test in chat**, split layout while the panel is open,
  `?test=chat`, **Create example app** in "Apps that use it"; the panel is lazy-loaded, so the chat
  UI is fetched only when it opens.
- `api/integrationsAdminApi.js`: `fetchExampleApps`, `createExampleApp`.
- Translations in `shared/i18n/en.json` and `de.json` under `admin.integrations.testChat.*`.

Docs: `docs/integrations.md` (example apps, the chat test, `exampleApps`, API), a release note in
`docs/releases/next/`.

Tests: `server/tests/integrations/exampleApps.test.js` (pure logic, schema, registry, every shipped
and every generated example app passes the app schema), `server/tests/integrations/exampleAppRoutes.test.js`
(routes), `tests/unit/client/integration-test-panel.test.jsx` (panel).

## Not in this change / open points

1. **Remove `server/defaults/apps/ldap-browser.json`** once the example app is the way admins get
   it (fresh installs would no longer get a disabled LDAP browser app they have to find).
2. **Admin-only preview of disabled apps**, so the example app can be tested before anyone else
   sees it.
3. **Test with unsaved settings**: the chat runs the saved installation, like the app test runs the
   saved app. A draft installation would need a transient installation in the tool loader.
4. **Example apps in the catalog** before installing (a preview of what the integration is for).
5. **Offer the example app right after installing** (the install dialog could end on "Test in
   chat").
