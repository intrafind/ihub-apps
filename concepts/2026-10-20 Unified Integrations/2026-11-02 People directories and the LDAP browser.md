# People directories and the LDAP browser (implementation notes)

**Date:** 2026-11-02
**Status:** Implemented on `claude/exciting-feynman-2aju98-people-directories`
**Decision:** [07 · Types and built-in configuration, sections 3 and 6](07-types-and-built-in-configuration.md)
**User docs:** [docs/people-directory-search.md](../../docs/people-directory-search.md), [docs/integrations.md](../../docs/integrations.md)
**Migration:** `server/migrations/V204__ldap_browser_installations.js`

These notes are for whoever continues the work: what was asked, what exists now, where it lives,
how the pieces talk to each other, and what is still open.

## What the product owner asked for (2026-11-01)

1. "We should change from LDAP directory to **people directory**; Entra is also a people
   directory search." → the definition `com.intrafind/ldap-directory` is named **People
   directory (LDAP)** (de: **Personenverzeichnis (LDAP)**); its id did not change. Entra keeps
   its name and is listed in the People directories group (both are `type: people-directory`).
2. "The LDAP browser, independent from people, should be **its own integration**, which can reuse
   the same connection/credential." → new built-in `com.intrafind/ldap-browser`.
3. "The built-ins need proper, dedicated configuration" → dedicated editors for People directory
   (LDAP), LDAP browser and Microsoft Entra ID directory.
4. The shipped **People search** app binds `type:people-directory`, so it follows Entra too.

## The model in one picture

```
 com.intrafind/ldap-directory  (People directory (LDAP), type people-directory, many installations)
   └─ installation "corp": url / authProvider, baseDn, bind…, mapping…, limits
        tools: corp__search_people, corp__get_person, corp__list_units      (_peopleDirectory marker)
                 ▲
                 │ values.directory = "corp"   (install field of type "instance")
                 │
 com.intrafind/ldap-browser   (LDAP browser, no type, many installations)
   └─ installation "corp-browser": baseDn, maxResults, bindMode/bindDn/bindPasswordRef, denyAttributes
        tools: corp-browser__browse_search, __browse_read, __browse_children (_ldapBrowser marker)

 com.intrafind/entra-directory (Microsoft Entra ID directory, type people-directory, singleton "entra")
```

A browser **reuses** the directory's connection: URL, StartTLS, TLS versions, trusted
certificates (`tlsCa`), allowed hosts, the reused sign-in provider, the base DN and — unless the
browser has its own account — the bind. Its calls go through the directory's throttle queue
(`peopleDirectory:<directoryId>`).

## Who may use what

| Thing | Rule | Where it is checked |
| --- | --- | --- |
| A directory's tools | the group grant (`permissions.integrations`: `*`, the id, the definition, `type:people-directory`) | `PeopleDirectoryService.mayUseDirectory` (listing, app tools, direct runs, MCP gateway, runner) |
| A browser's tools | the browser installation's grant (`*`, its id, `com.intrafind/ldap-browser`) **and** signed-in, non-delegated user (`isAdminEligiblePrincipal`) **and** its directory installed and enabled | `LdapBrowserService.mayUseBrowser` (+ `filterBrowserToolsForUser`), `toolRoutes.mayRunTool`, `ldapBrowserRunner` |
| Browser over MCP | never | `McpServerService.isToolAllowed` (`_ldapBrowser`), and only `_peopleDirectory` tools are added there |

`browse.groups` is **gone**. Migration V204 granted each browser to the groups that were in
`browseGroups` (the definition default `admins` when empty). Important: groups holding `*` in
`permissions.integrations` (the shipped `users` and `authenticated`) may use every installation,
the browsers included. V204 logs a warning naming those groups; the docs tell admins to replace
`*` with explicit grants or to keep the browser out of their apps. See "Open points".

## Binding

- `type:people-directory` — every people directory (LDAP and Entra). The shipped People search
  app (`server/defaults/apps/people-directory.json`).
- `com.intrafind/ldap-directory` — every LDAP directory.
- `com.intrafind/ldap-browser` — every LDAP browser. The shipped LDAP browser app
  (`server/defaults/apps/ldap-browser.json`, ships disabled).
- A **browser binding without `actions` binds all three browse actions** (no `bindExplicitly`
  any more; the generic `bindExplicitly` mechanism stays for third-party definitions).
- The `ldapBrowse` tool reference is retired: `isToolSelected` no longer knows it, and V204
  rewrote `tools: ["ldapBrowse"]` into a binding.

## File map

Server:

| File | What it does |
| --- | --- |
| `server/defaults/integration-definitions/com.intrafind__ldap-directory/` | the renamed definition, no `browse*` fields or actions; release 1.0.0 with notes (V198, V204) |
| `server/defaults/integration-definitions/com.intrafind__ldap-browser/` | the new definition, release 1.0.0 with notes |
| `server/services/integrations/ldapDirectoryConfig.js` | installations → directory shape (`directoryFromInstance`) and browser shape (`browserFromInstance`) |
| `server/validators/peopleDirectorySchema.js` | `peopleDirectorySchema` (no `browse` any more) and `ldapBrowserSchema` |
| `server/services/peopleDirectory/PeopleDirectoryService.js` | directory resolution, access, tools (browser parts removed) |
| `server/services/peopleDirectory/LdapBrowserService.js` | **new**: `resolveBrowser`, `mayUseBrowser`, `filterBrowserToolsForUser`, `browserToolOfId`, `buildBrowseTools`, `summarizeBrowser` |
| `server/services/peopleDirectory/ldapBrowserRunner.js` | **new**: `runLdapBrowserTool` (audit: resource `ldapBrowse`, resourceId = browser id), `testBrowser` |
| `server/services/peopleDirectory/LdapBrowser.js` | the LDAP operations, now on a resolved browser |
| `server/services/integrations/protocols/native/connectors/ldapBrowser/index.js` | **new** connector (registered in `register.js`) |
| `server/routes/admin/peopleDirectoryEditor.js` | **new** `GET /api/admin/integrations/people-directories/editor-context` |
| `server/migrations/V204__ldap_browser_installations.js` | the migration (below) |
| `server/tests/integration-definition-releases.test.js` | #3092: every shipped definition a migration names has a release entry |

Client (all under `client/src/features/admin/components/integrations/editors/`):

| File | What it does |
| --- | --- |
| `PeopleDirectoryEditor.jsx` + `peopleDirectory/*.jsx` | the restored directory editor (sections below) |
| `LdapBrowserEditor.jsx` | directory picker with what it reuses, browse settings |
| `EntraDirectoryEditor.jsx` | app registration with the `AZURE_*` fallback state per field |
| `peopleDirectoryEditorModel.js` | **pure** form model: values ↔ form, validation, transport, preset, tool ids |
| `index.js` | the registry: the three editors are registered under their definition ids |

Also touched: `useInstallationEditor.js` and `installationPayload.js` (`labelMap` /
`descriptionMap` / `testInput`), `InstallationEditorParts.jsx` (`EditorFooter` takes `testInput`),
`integrationFacts.js` (browser facts, directory preset fact), `AdminAppsPage.jsx` (i18n names).

## The restored directory editor: kept, changed, dropped

The source was `AdminPeopleDirectoryEditPage.jsx` and `components/people-directories/*` before
commit e53c041 (`git show e53c041^:<path>`).

- **Kept:** Source (reuse a sign-in provider with overrides, or connect directly), Access
  (provider account / anonymous / service account + credential), Network (transport badge,
  plain-text switch and warnings, allowed hosts, trusted certificates), Model-facing name and
  description (English and German, preview, tool ids), Limits (+ units), Search and mapping
  (preset values next to every field), client-side checks with an error summary, the status
  callout ("As saved, this directory has issues"), the test with a sample search.
- **Changed:** Visibility shows the **groups that grant** the installation (`GrantedGroups`)
  instead of a group picker; the data flow stays there. Strings live under
  `admin.integrations.editors.peopleDirectory.*`.
- **New:** TLS versions and cipher suites (they are install fields; the old page only kept them),
  the Actions section.
- **Moved:** the Browse section → `LdapBrowserEditor`.
- **Dropped:** the id field and the enable checkbox (the page header owns them), the "changed
  elsewhere" check (the installation page reloads after a save), the unsaved-changes dialog, the
  dedicated person results table (the generic test results show the mapped people as details).

Field mapping (form → install value) is documented at the top of `peopleDirectoryEditorModel.js`.

## Migration V204 in short

For every `com.intrafind/ldap-directory` installation with `values.browse === true`:

1. create `<dirId>-browser` (`-browser-2`, … on collision), `enabled` like the directory, label
   "<label> – LDAP browser" / "… – LDAP-Browser", values mapped (`browseBase` → `baseDn`,
   `browseMaxResults` → `maxResults`, `browseBind*` → `bind*`, `browseDenyAttributes` →
   `denyAttributes`), the browse entries of the directory's action policy moved over;
2. grant it to `browseGroups` (`admins` when empty) in `groups.json`; unknown groups → warning;
   warning naming the `*` holders that could not browse before;
3. remove every `browse*` value from every directory (browser off → its kept settings are logged
   and dropped);
4. apps: browse actions in a directory binding → the browser's binding; in a
   `com.intrafind/ldap-directory` binding → `com.intrafind/ldap-browser`; `ldapBrowse` and
   `<dirId>__browse_*` in `tools` → bindings; the V198 leftover `{ actions: [] }` next to
   `ldapBrowse` is removed; People search: `com.intrafind/ldap-directory: {}` →
   `type:people-directory` (or removed when the type binding is already there — fresh installs);
5. group tool grants: `ldapBrowse` → the browser ids, `<dirId>__browse_x` → `<browserId>__browse_x`.

`integrations.json` is written last, so an interrupted run repeats everything. Only bindings
of **directory** ids are touched: an MCP server with a `browse_search` tool is left alone.

Example: `corp` with `{ browse: true, browseGroups: ["it-ops"], browseBase: "ou=people,dc=corp" }`
→ `corp-browser` `{ directory: "corp", baseDn: "ou=people,dc=corp" }`, `it-ops` gets
`"corp-browser"`, the LDAP browser app binds `{ "com.intrafind/ldap-browser": {} }`.

## How to test

```bash
npm run test:people-directory      # browse.test.js covers the browser end to end
npm run test:migrations            # migration-v198, -v204
npm run test:integrations          # includes integration-definition-releases.test.js
npx jest --config tests/config/jest.config.js tests/unit/client/admin-people-directory-editors.test.jsx
```

## Open points

- **`*` grants the browser.** The decision was "group access is the installation's grant". With
  the shipped groups (`users`, `authenticated` hold `*`), every signed-in user may use a browser
  that an app they can open binds. Before V204 only `browseGroups` could browse. Mitigations in
  place: the LDAP browser app ships disabled, delegated principals never browse, V204 warns, the
  docs say so. If that is not enough, an "explicit grant only" flag on the definition (a grant
  by `*` or a type key does not count) would restore the old default; it needs a decision.
- Entra's `tenantId` and `clientId` are no longer `required` in the definition, so the
  documented `AZURE_*` fallback can be used from the editor (the server always fell back).
- The storage definitions (Office 365, Google Drive, Nextcloud) and `com.intrafind/ihub` are on
  the allow-list of `integration-definition-releases.test.js`; their PRs add the release entries
  and empty the list.
- Workflow nodes or agent profiles that name a `<dirId>__browse_*` tool id are not rewritten (no
  shipped one does).
