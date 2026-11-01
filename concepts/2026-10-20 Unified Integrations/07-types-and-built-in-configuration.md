# 07 · Integration types, built-in configuration and one admin page

**Date:** 2026-11-01 · **Status:** decided 2026-11-01 (Daniel Manzke) · Part of [Unified Integrations](README.md)

Feedback from testing the merged stack (#3065 to #3089) on 2026-11-01, and what it changes. Everything below is decided; it supersedes the parts of the 2026-10-31 revision named in each section.

## 1 · What testing showed

1. Two admin entries, **Integrations** (the hub cards) and **Installed integrations**, and the hub cards link to the second one.
2. Web search is one installation holding every engine. It must be one installation per engine, and with no engine installed the model's native search still works.
3. Cloud storage is "one for all" in apps (one **Cloud Storage Upload** switch). Each provider must stand on its own and be of a type others can implement.
4. Two ways to configure the same thing in the app editor: the dedicated **Web search** and **iAssistant** sections (good UX, the crucial settings) and the generic **Installed integrations** list, which offers `websearch` and `iassistant` again.
5. The built-ins (iFinder, iAssistant, web search, storage providers) lost their dedicated configuration to the generic install dialog, which looks generic and misses the important information. iFinder needs its configuration tile back.
6. The grouping of the LDAP directories (one binding for all of them) is good and should exist for every kind of integration: people directories, web search, storage providers.
7. "LDAP directory" should be **people directory**: Entra is a people directory as well. The LDAP browser is a different topic and should be its own integration that reuses the directory's connection and credential.
8. The **iHub** integration lists every internal tool. Only asking the user and the scheduled-task tools are used in chats; project knowledge must be there whenever projects are on, without activating an integration.

## 2 · Integration types

A definition declares the contract it fulfils in `type`. Integrations of one type are interchangeable to an app, are grouped together in the admin and the app editor, and a third party can ship its own (as a `script` or `openapi` definition of that type).

| Type | Contract | Shipped definitions |
| --- | --- | --- |
| `people-directory` | search people, get a person, list units (model-facing actions) | People directory (LDAP), Microsoft Entra ID directory |
| `web-search` | one `search` action the web search feature calls with the app's settings | Brave Search, Staan, Qwant |
| `storage` | `files` capability: browse and pick files for chat and projects, per-user sign-in | Microsoft Office 365, Google Drive, Nextcloud |

A definition without a type stands alone (iFinder, iAssistant, Jira, iHub, CKAN, MCP servers, A2A agents). The list of types is closed in iHub (`server/services/integrations/integrationTypes.js`): a type only means something when iHub consumes its contract.

**Binding a type.** `app.integrations` accepts a third kind of key, `type:<type>`, next to installation ids and definition ids: it binds every installation of every definition of that type, including later ones. Resolution order for one installation: its own key, its definition's key, its type's key. A required type binding is satisfied while one installation of the type is enabled. The definition binding stays (two CKAN portals); the shipped People search app moves from `com.intrafind/ldap-directory` to `type:people-directory`, so it follows Entra too.

## 3 · One admin page, rich tiles, dedicated editors

- **One page** `/admin/integrations` with the tabs **Installed**, **Catalog** and **Inbound** (Outlook add-in, browser extension, Microsoft 365 Copilot, Nextcloud embed, MCP gateway). The route `/admin/integrations/installed` is removed without a redirect (clean break); in-product links move.
- **Grouped** Installed and Catalog tabs: People directories, Web search, Storage providers, MCP servers, Agents, Built-in, From the catalog.
- **Rich tiles**: each installation shows its status and the two to four facts that matter for it (iFinder base URL and sign-in mode, the directory URL, the Nextcloud server, the keys that are set), never a secret.
- **A page per installation** `/admin/integrations/:id` with Overview, Settings and Releases. Settings renders a **dedicated editor** where one exists and the generic form otherwise. Dedicated editors: iFinder and iAssistant (the editor they had before #3070, restored), web search engines, storage providers, people directories, the LDAP browser, Jira. The generic form stays for catalog and custom integrations.

## 4 · Web search: one integration per engine

Supersedes "web search as the built-in installed integration" (#3077, V195) and the 2026-10-31 decision that web search is one row.

- Definitions `com.intrafind/brave-search`, `com.intrafind/staan-search`, `com.intrafind/qwant-search`, each `type: web-search`, each a singleton whose installation id is the engine's former provider value (`brave`, `staan`, `qwant`), so `app.websearch.provider` values and the tool ids `braveSearch`, `staanSearch`, `qwantSearch` stay.
- With no engine installed, an app with web search uses the model's native search where the provider runs one; on other models the web search toggle is not offered.
- `app.websearch.provider: auto` takes the first enabled engine available to the user, in the order Brave, Staan, Qwant, then any third-party engine.
- The page reader `read_url` belongs to the web search feature, not to an engine: it is offered with any engine and with native search where the provider accepts function tools.
- **Upgrade** (config migration): the `websearch` installation becomes one installation per engine that worked: Brave and Staan where a key was set (the credential reference moves along), Qwant where it was reachable (the default `auto` without keys, or an app that chose it). Groups move along. **Fresh install**: no engine.

## 5 · Storage providers

Answers #3094's open question: several installations per provider.

- The three definitions are `type: storage` and lose `singleton`; the installation id is the provider id used in the OAuth callback and the stored tokens, so existing connections keep working.
- Apps bind storage providers like integrations: one, several, or `type:storage`. The binding replaces `upload.cloudStorageUpload` (config migration: an app with it enabled binds `type:storage` as optional).
- The callback URL becomes base-path aware like Jira's; the `tenantIdRef` leftovers are cleaned up (#3094).
- The `files` contract (browse, pick, download, per-user sign-in) is written down for third-party storage providers.

## 6 · People directories and the LDAP browser

- **People directory (LDAP)** is the new name of the LDAP people directory (definition id unchanged); both it and the Entra directory are `type: people-directory`.
- The admin LDAP browser becomes `com.intrafind/ldap-browser`: an installation names a directory installation (`instance` field) whose connection, TLS settings and bind credential it reuses, plus its own browse settings (groups, base, result cap, denied attributes, an optional separate bind). A config migration moves every directory with the browser switched on into a browser installation and rewrites the LDAP browser app's binding.

## 7 · The iHub integration

The always-installed `com.intrafind/ihub` keeps `ask_user` and the scheduled-task tools only. The project knowledge tools belong to projects, as [03 §6.9](03-product-concept.md) said: they are offered whenever the projects feature is on and a request reaches a project, whatever the integrations say. The agent workspace tools (artifacts, memory, inbox, tasks) and the evidence tools belong to workflows and agents. A config migration drops the moved actions from the `ihub` installation.

## 8 · The app editor

One **Integrations** section, grouped like the admin page. Web search, iAssistant, iFinder and storage providers keep their dedicated panels inside it, shown only while their integration is installed; the generic rows never repeat an integration that has a panel. A type group offers "All …" (the type binding) and single installations.

## 9 · Group access (#3093)

Option **B**: groups get `permissions.integrations` (`*`, installation ids, definition ids, `type:<type>`), resolved with inheritance like `apps`, and edited on the group page; `allowedGroups` is removed from installations by a config migration that grants each group what it could use before.

## 10 · Delivery

| PR | Content | Config migration |
| --- | --- | --- |
| Types | `type`, type bindings, one admin page, tiles, installation page, iFinder and iAssistant editors, this document | — |
| iHub | §7 | V201 |
| Web search | §4, web search editor | V202 |
| People directories | §6, directory and browser editors, People search app on `type:people-directory` | V203 |
| Storage | §5, storage editor, app binding, #3094 | V204 |
| Group access | §9, #3093 | V205 |

Numbers are assigned in merge order; the baseline stamp of versioning phase 2 (#3090) takes the next free number after these.
