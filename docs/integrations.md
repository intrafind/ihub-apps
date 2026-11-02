# Integrations

An **integration** connects iHub to an external system and gives the model a set of **actions** (tools) to use it. Integrations are installed from a catalog, configured per installation, and bound to apps. This page covers the installable integrations under **Admin → Integrations**, including the built-in iFinder, iAssistant, web search engines (Brave Search, Staan, Qwant), Jira, Entra ID directory, People directory (LDAP), LDAP browser, iHub and cloud storage (Office 365, Google Drive, Nextcloud) integrations; the MCP servers and A2A agents are installations too (see the [Unified Integrations concept](https://github.com/intrafind/ihub-apps/tree/main/concepts/2026-10-20%20Unified%20Integrations) in the repository).

The catalog ships with the **CKAN Open Data Portal** (GovData, the German state and city portals, data.gov, internal data catalogs), which is also published in the [iHub Marketplace](marketplace.md), and with the [built-in integrations](#built-in-integrations) **iFinder**, **iAssistant**, the web search engines **Brave Search**, **Staan** and **Qwant**, **Atlassian Jira**, **Microsoft Entra ID directory**, **People directory (LDAP)**, **LDAP browser**, **iHub** (asking the user a question and scheduled tasks), **Microsoft Office 365**, **Google Drive** and **Nextcloud**.

## Three records

| Record                    | Where                                                                                                                                                                               | What                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Definition**            | `server/defaults/integration-definitions/<folder>/` (shipped) or `contents/integration-definitions/<folder>/` (installed from a registry; wins over a shipped one with the same id) | The catalog entry: id, version, protocol, auth modes, install fields, actions, scopes, sources. Never carries a secret or an installation's values.                           |
| **Installed integration** | `contents/config/integrations.json`                                                                                                                                                 | The admin's instance: endpoint and other install values, sign-in mode, which actions are on. One definition can be installed several times (two portals, two labels).         |
| **App binding**           | `app.integrations[<instanceId>]`                                                                                                                                                    | Which installations an app offers, optionally narrowed to some actions, with the scope settings users start with.                                                             |
| **Group grant**           | `contents/config/groups.json` → `permissions.integrations`                                                                                                                          | Which installations the members of a group may use (see [Who may use an integration](#who-may-use-an-integration)).                                                           |

A definition's folder name is its id with the one `/` replaced by `__`: `org.ckan/open-data-portal` lives in `org.ckan__open-data-portal/`.

## Built-in integrations

**iFinder** (`com.intrafind/ifinder`) and **iAssistant** (`com.intrafind/iassistant`) are shipped definitions marked `builtIn: true`. They differ from a catalog integration in four ways:

- Each is installed once, under a fixed id (`singleton`): the iFinder installation is always `ifinder`, the iAssistant installation always `iassistant`. Apps, group tool grants and the chat refer to these ids.
- They are implemented by the `native` protocol: a server connector module (`server/services/integrations/protocols/native/connectors/`) instead of an OpenAPI document. The install fields, the **Test** button and the app binding work as for any other installation.
- They are always in the catalog and are never uninstalled from a registry; the marketplace cannot replace them.
- Their actions keep their historical tool ids: the iFinder actions are the tools `iFinder_search`, `iFinder_getContent`, `iFinder_getMetadata`, `iFinder_discover`, `iFinder_getFields`, `iFinder_getFacetValues` and `iFinder_listProfiles`, not `ifinder__search`. Group tool grants (`permissions.tools` in `groups.json`) that name `iFinder` or `iFinder_*` keep working.

The iAssistant installation has no base URL of its own: its `connection` field names the iFinder installation it runs on. The fields of both installations are described in [iFinder Integration](iFinder-Integration.md#configuration) and [iFinder & iAssistant Admin Guide](ifinder-iassistant-admin-guide.md).

**Web search engines** are one integration per engine, all of `type: "web-search"`: **Brave Search** (`com.intrafind/brave-search`, installation `brave`), **Staan** (`com.intrafind/staan-search`, `staan`) and **Qwant** (`com.intrafind/qwant-search`, `qwant`), each a singleton installed only when wanted (a fresh install ships none). Brave and Staan hold their API key as a credential reference (`apiKeyRef`, falling back to `BRAVE_SEARCH_API_KEY` / `STAAN_API_KEY`); Qwant has no settings. Each has one action, `search`, under its historical tool id (`braveSearch`, `staanSearch`, `qwantSearch`). Apps do not bind engines: they switch web search on in their own `websearch` settings and name an engine (`websearch.provider`: an installation id, or `auto` for the first engine the user may use, Brave, Staan, Qwant, then any other). Native search on Google, OpenAI and Anthropic models needs no engine; the page reader `read_url` belongs to the web search feature (a platform tool). A third party ships its own engine as a `script` or `openapi` definition of type `web-search` (see [Building an Integration → Web search engines](integration-development.md#web-search-engines)). Migration V204 replaced the former single installation `websearch` (`com.intrafind/web-search`) with the engines that worked. See [Web Tools](web-tools.md).

**Atlassian Jira** (`com.intrafind/jira`, installation `jira`) is the first built-in that signs every user in (`auth.modes: ["oauth-user"]`): the installation holds the OAuth app's client id, client secret (credential reference) and redirect URI; each user connects their Atlassian account once through `/api/integrations/jira/auth` (from the chat prompt or **Settings → Integrations**), and the six actions (`jira_searchTickets`, `jira_getTicket`, `jira_addComment`, `jira_getTransitions`, `jira_transitionTicket`, `jira_getAttachment`, ids unchanged) run as that user. **Connections** on the installed list shows who connected and disconnects a user. See [Jira Integration](JIRA_INTEGRATION.md).

**Microsoft Entra ID directory** (`com.intrafind/entra-directory`, installation `entra`) runs with an app registration's client credentials: tenant id, client id and the client secret as a credential reference, each falling back to the `AZURE_*` environment variables when empty (its editor says per field whether the server has the variable). Its six actions are the former `entraPeopleSearch_*` tools under the same ids. It is a people directory (`type: "people-directory"`): the shipped People search app uses it next to the LDAP directories. See [Tool Calling → entraPeopleSearch](tool-calling.md#entrapeoplesearch).

**iHub** (`com.intrafind/ihub`, installation `ihub`) holds the iHub tools users call in chats — asking the user a question (`ask_user`) and the scheduled-task tools (`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`, `list_task_runs`, `get_task_run`) — under the ids they always had. It is `alwaysInstalled`: the installation exists and is enabled at all times (created when missing, never removed or disabled; the installed list shows **Always installed** and hides the switches), and an admin edits only its actions and groups. Apps keep listing the tools in `tools` by id; `"ihub"` itself selects nothing. Tools generated by another iHub feature are not its actions and are not on the Integrations page: the project knowledge tools (`knowledge_search`, `knowledge_read`, `knowledge_list`) come with every request that reaches a project while the projects feature is on, and the agent workspace and evidence tools (`write_artifact`, `read_memory`, `write_memory`, `read_inbox`, `write_inbox`, `create_task`, `list_tasks`, `mark_task_done`, `evidence_*`) are plain tools of workflows and agents, offered to whatever names them in `tools`. Migration V199 retired the tool files; V202 removed the knowledge, agent and evidence tools from the installation's action lists (a switched-off agent or evidence tool stays off through a `contents/tools/<id>.json` with `enabled: false`). See [Tool Calling → iHub's own tools](tool-calling.md#ihubs-own-tools-ask_user-knowledge_-write_artifact-).

**Microsoft Office 365**, **Google Drive** and **Nextcloud** (`com.intrafind/office365`, `com.intrafind/google-drive`, `com.intrafind/nextcloud`) are the storage providers (`type: storage`) of the chat's file picker and the project cloud documents. Each can be installed **several times** — one installation per Azure app registration or tenant, per Google OAuth client, per Nextcloud server. An installation holds the provider's OAuth app (client id, client secret as a credential reference, optional redirect URI, the tenant, sources or server URL) and signs every user in (`auth.modes: ["oauth-user"]`); they have no model-facing actions.

- **The installation id is the provider id.** It names the provider in the routes (`/api/integrations/<service>/auth?providerId=<installation id>`, every browse and download route requires it), in the callback URL `/api/integrations/<service>/<installation id>/callback`, in the users' stored connections (`<userId>__<installation id>.json`), in project cloud documents and in the Nextcloud embed plugin. It never changes after the installation is created. Migration V206 renamed every upgraded installation to the provider id it had before (the retired **Provider id** value), so nothing an admin registered or a user connected changed.
- **Redirect URI**: empty means derived from each request like Jira's — scheme and host as the browser sees them (`X-Forwarded-Proto` / `X-Forwarded-Host` of a trusted proxy), the base path (`X-Forwarded-Prefix`), then the callback path. The installation's **Settings** tab shows the URI to register with a **Copy** button.
- **Apps bind them** like integrations: one installation, a provider's definition id (all its installations) or `type:storage` (all storage providers); the chat's file picker offers the bound providers the user's groups grant. See [Apps → Files from storage providers](apps.md#files-from-storage-providers).
- Users connect under **Settings → Integrations** or from the picker; **Connected users** on the installation shows who connected. The client reads the providers the user's groups grant from `/api/auth/status` (`cloudStorage.providers`, each with its installation `id` and `definition`).

See [Office 365](office365-integration.md), [Google Drive](google-drive-integration.md), [Nextcloud](nextcloud-integration.md).

**People directory (LDAP)** (`com.intrafind/ldap-directory`) is the first built-in that is installed **many times**: one installation per directory (the company directory reusing an LDAP sign-in provider, an external one such as x500.bund.de), each under the id the directory had, with the directory's fields as install values and the bind password as a credential reference; who may search a directory is granted on the groups (`permissions.integrations`, by the directory's id, `com.intrafind/ldap-directory` or `type:people-directory`). Its actions are the directory's tools `<id>__search_people`, `<id>__get_person` and `<id>__list_units` (ids unchanged). The shipped `x500bund` installation ships disabled. Apps bind one directory by its id, every LDAP directory by binding the definition, or every people directory, Entra ID included, by binding `type:people-directory` (see [Binding to an app](#binding-to-an-app)). See [People Directory Search](people-directory-search.md).

**LDAP browser** (`com.intrafind/ldap-browser`) is the admin tool that shows raw LDAP entries, installed once per directory it should read (it has no type). An installation names a People directory (LDAP) installation (`directory`, an `instance` field) and reuses its connection — URL, TLS settings, trusted certificates, allowed hosts, base DN and, unless it has an account of its own, the bind — with its own browse base, result limit, withheld attributes and optional service account. Its actions are `<id>__browse_search`, `<id>__browse_read` and `<id>__browse_children`; a binding without `actions` binds all three. On top of the group grant only signed-in, non-delegated users browse, and the tools are never offered over the MCP gateway. Migration V205 created one for every directory that had the browser switched on. See [People Directory Search → LDAP browser](people-directory-search.md#ldap-browser-for-admins).

### MCP servers

An MCP server is an installed integration of the `mcp` protocol. iHub ships the generic **MCP server** definition (`com.intrafind/mcp-server`: any Streamable HTTP, SSE or WebSocket endpoint, or a local process over stdio) and one definition per hosted server of the former built-in catalog (`mcp/microsoft-learn`, `mcp/context7`, `mcp/github`, `mcp/drawio`, …), each with its endpoint fixed and its sign-in mode set. All of them are `builtIn` and may be installed several times (two GitHub organisations, two draw.io installations). The server's tools are the installation's actions: they are not written into the definition but listed when iHub connects, so the wizard shows them after **Test connection** and the admin switches single tools off. Tool ids are `<toolPrefix or id__><tool>`, e.g. `drawio__create_diagram`; per-user OAuth, MCP App views and the inbound gateway are as described in [MCP Integration](mcp-integration.md). Migration V193 turned every server of the former `config/mcpServers.json` into an installation under the same id.

### Code-based integrations (`script`)

A definition may bring its own connector module instead of an OpenAPI document: `"protocol": { "type": "script", "module": "connector.js" }`, with `connector.js` as a companion file in the folder. The module has the same contract as a built-in native connector (`export default { id, actions: { <name>: { parameters, run(args, ctx) } }, test(ctx), scopeProvider(resolved), onChanged({ before, after }) }`; `ctx` carries `definition`, `instance`, `values`, `user`, `chatId`, `scope`, `params`) and is run by the same adapter, so a built-in integration is just the case where the module lives inside the server. Because the module runs in the server process:

- a registry may deliver such an integration only when the admin marked it as **trusted for code** (**Admin → Marketplace → Manage Registries → Edit**); the install is refused otherwise (`CODE_NOT_TRUSTED`);
- the catalog item must list a hash for every code file (`source.integrity`, `"connector.js": "sha256-<base64>"`), and the fetched file must match it (`CODE_INTEGRITY_REQUIRED`, `INTEGRITY_MISMATCH`);
- the Catalog tab marks the definition **Runs code on this server**, and the wizard says so before the install;
- the connector is **one file**: the module named in `protocol.module` is the only code file (`.js`, `.mjs`, `.cjs`) the folder may carry, and it imports nothing from the folder (`import … from './lib.js'`, `import('./lib.js')`, `require('./lib.js')`). A connector written as several modules is bundled before it is published (esbuild: `esbuild src/connector.js --bundle --format=esm --platform=node --outfile=connector.js`; rollup works the same way). The install refuses a second code file (`SCRIPT_EXTRA_CODE_FILES`, naming the files) and an entry module with a relative import (`SCRIPT_RELATIVE_IMPORT`); the latter is a text check over the source, so the path must not appear in a comment or a string either. The reason: iHub imports the entry module with a cache-buster in its URL (`?v=<version>-<mtime>`), so an update from the Marketplace runs the new code at once, but a relative import inside it resolves to the plain file URL, which Node's module cache keeps from the previous version — a fix shipped in a helper file would silently not take effect until a restart.

After an update the previous module version is dropped (actions, the test and the installation's scope provider all come from the new one). A connector that declares `scopes` and a `scopeProvider` has its provider registered at startup, on a (re-)install on any worker and when an admin saves the installation: iHub loads the module before it registers the scope providers.

A shipped definition never uses `script` (it is `native`); the shipped IntraFind registry is the place to publish connectors such as Jira or Microsoft 365 that cannot be expressed as an OpenAPI document.

### Remote A2A agents

A remote agent (Agent-to-Agent protocol) is an installed integration of the `a2a` protocol, installed from the shipped **A2A agent** definition (`com.intrafind/a2a-agent`): the Agent Card URL, a sign-in mode (none, a shared token or API key, or an OAuth client) and the call budget are its install values. The card's skills are the installation's actions, listed after **Test connection**; tool ids stay `a2a__<id>__<skill>`. Calling an agent, its conversations and the inbound side are described in [A2A Agents](a2a-agents.md). Migration V194 turned every agent of the former `config/a2aAgents.json` into an installation under the same id.

## The Integrations page

**Admin → Integrations** (`/admin/integrations`) is the one admin page for integrations. It has three tabs (`?tab=` in the URL):

| Tab                       | Contents                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Installed** (default)   | every installation as a tile, grouped                                                                                                                                                                                                          |
| **Catalog** (`catalog`)   | every definition you can install, in the same groups                                                                                                                                                                                           |
| **Inbound** (`inbound`)   | what connects _to_ iHub, each with its status and a link to its page: Outlook add-in, browser extension, Microsoft 365 Copilot, Nextcloud embed, MCP gateway                                                                                    |

**Groups.** Installed and Catalog list their entries under the same headings, in this order; a group with nothing in it is left out, and each heading shows the count and a one-line description:

| Group              | Contains                                                         |
| ------------------ | ---------------------------------------------------------------- |
| People directories | definitions of `type: "people-directory"` (LDAP, Entra ID)       |
| Web search         | `type: "web-search"`                                             |
| Storage providers  | `type: "storage"` (Office 365, Google Drive, Nextcloud)          |
| MCP servers        | protocol `mcp`                                                   |
| Agents             | protocol `a2a`                                                   |
| Built-in           | any other built-in definition (iFinder, iAssistant, Jira, iHub, LDAP browser) |
| From the catalog   | everything else (CKAN, marketplace definitions)                  |

A search box above the groups filters by label, name, id and description.

**Tiles.** An installation's tile shows its label, definition and id; the pills of its state (enabled or disabled, version with the version on disk as tooltip, the migration state — _Migration pending_ and _Needs review_ amber, _Migration failed_ red — with its reason as text below the pills and the buttons of that state (see [Migrations → In the admin](#in-the-admin)), _Incompatible_ with the reason, _Update to vX available_ linking to the marketplace, _Always installed_, _Definition missing_); its sign-in mode; the live status (connected, unreachable, the tool count of an MCP server, the number of connected users of a per-user installation, how a directory's LDAP connection is protected); its groups; and two to four **key facts** from its values, chosen per definition:

| Definition                 | Facts                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| iFinder                    | base URL, authentication (JWT signed by iHub or OIDC token exchange), signing key or OIDC provider, default search profile |
| iAssistant                 | the iFinder installation it runs on, default profile, default search profile               |
| People directory (LDAP)    | directory URL (or the sign-in provider it reuses), base DN, bind password, directory type  |
| LDAP browser               | the directory it reads, browse base, account (or bind password), results per search        |
| Entra ID directory         | tenant ID, client ID, client secret                                                        |
| Brave Search / Staan       | whether the API key is set; while it is not, the environment variable used instead         |
| Qwant                      | no key needed                                                                              |
| Office 365 / Google Drive  | tenant ID (Office 365), client ID, client secret, sources                                  |
| Nextcloud                  | server URL, client ID, client secret                                                       |
| Jira                       | site URL, client ID, client secret                                                         |
| CKAN                       | portal URL, filter, results per search, credential                                         |
| MCP server                 | server URL (or the command of a local process), transport, credential                     |
| A2A agent                  | Agent Card URL, credential                                                                 |
| any other                  | its endpoint (`baseUrl`, `url`, …) and credential                                          |

A secret is never shown: a `secret` or `credential` field, a field marked `sensitive`, a key that names one (`…Ref`, `…Secret`, `password`, `apiKey`, `apiToken`) and the managed service-account secret only show **set** or **not set**.

The tile opens the installation's page. Its quick actions are separate buttons: **Test** (the results open above the groups), **Edit** (the page's Settings tab), **Enable**/**Disable**, **Remove** and, for an installation that signs every user in, **Connected users** (disconnect a user, reset iHub's OAuth client registration). Disabling an installation that apps bind and removing any installation ask first and name the apps that bind it (by its id, by its definition, or by its type, `type:people-directory`). Removing an installation deletes its managed secret. Removing a _definition_ (uninstalling it from the marketplace) is refused while installations of it exist. **Reload catalog** re-reads the definition folders.

### The installation page

`/admin/integrations/<installation id>` shows one installation. The header has its label, definition, id and pills, and the buttons **Test in chat** (see [Example apps and the chat test](#example-apps-and-the-chat-test)), **Test connection**, **Enable**/**Disable**, **Connected users** (per-user sign-in) and **Remove**, with the same confirmations as the tiles. The tabs (`?tab=`):

- **Overview** (default): all key facts of its values, its description and documentation link, protocol, sign-in and groups, its actions with their side effect (read, write, destructive) and whether they are off or unavailable, the apps that bind it (for a web search engine: the apps with web search on that name it or use Auto), each linking to the app editor, and the **Migration log** (the last 10 runs, newest first).
- **Settings** (`settings`): the installation's editor (below); read-only while a migration state refuses the save.
- **Releases** (`releases`): the release history of its definition, when it has one.

An installation whose definition is missing or incompatible cannot be edited or tested; its page says why. An installation with a migration state shows the migration panel above the tabs (see [Migrations → In the admin](#in-the-admin)).

### Example apps and the chat test

**Test connection** checks that iHub reaches the system. **Test in chat** shows what users get: a model that picks the installation's actions, reads the results and answers. It opens a panel beside the page — the same chat as the [app editor's test mode](apps.md) — that runs an app using the installation. `?test=chat` opens the page with the panel open.

- **An app already uses the installation** (by its id, its definition id or its type): the panel runs the first enabled one; the **App** picker offers the others, **Edit app** opens the app editor.
- **No app uses it yet**: the panel (and **Create example app** under _Apps that use it_) offers the **example app**. Pick the app id and whether it is **Available to users now**, then **Create and test**. The app is written to `contents/apps/<id>.json` like any other app, bound to this installation, and the chat starts. Change it in the app editor afterwards.
  - The example comes from the definition when it ships one (the **LDAP browser** app for an LDAP browser, the **Open Data Assistant** for a CKAN portal; see `exampleApps` under [Writing a definition](#writing-a-definition)).
  - Any other integration gets a **generated** assistant: the installation's label as name, the definition's description and instructions in the system prompt, and the first examples of its actions as starter prompts. **New example app** in the panel creates another one at any time.
  - The binding the template has for its integration (by definition id or type) moves to the installation id and keeps its settings; other bindings stay. When the template's id is taken (a second installation, or the shipped app of the same name), the id gets the installation id appended and the name the installation's label, e.g. _Open Data Assistant (GovData)_.

The chat runs the **saved** installation and app and restarts after every save of the settings, so a changed setting is tested with the next message. The chat only serves enabled apps: an example app created without **Available to users now** cannot be tested until it is enabled in the app editor, and an enabled one is visible to every group whose `apps` permission holds `*`. The panel also says when the installation is disabled (an app that requires it is hidden) and when your own groups do not grant it (the chat runs without its actions).

### Editors

**Settings** shows a **dedicated editor** when the definition has one and the **generic form** otherwise. The generic form is the install form (below), built from the definition's install fields.

| Definition                                 | Editor                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iFinder (`com.intrafind/ifinder`)          | The base URL; the token issuer (_iHub signs the token_ or _Shared OIDC provider_); for iHub-signed tokens the OIDC key pair switch with the effective issuer and the lines to configure iFinder with, or the private key, algorithm, lifetime, issuer and audience; the token scope and the user identity sent to iFinder (email, username, id, name, `domain\username` or a template); for token exchange the provider, grant, audience, scope map and extra scopes; the search profiles; under **Advanced** the request timeout, download directory and API paths. |
| iAssistant (`com.intrafind/iassistant`)    | The iFinder installation it runs on, the default conversation profile and search profile, the search profile access check, answering only from documents, and the profile cache.                                                                                                                                 |
| Storage providers (`com.intrafind/office365`, `com.intrafind/google-drive`, `com.intrafind/nextcloud`) | **Register iHub with the provider**: the redirect URI to register with a **Copy** button (derived from the browser's address, the base path and the installation id, or the configured one) and where the provider wants it, plus the optional override; **OAuth app**: the tenant (Office 365) or server URL (Nextcloud), the client id and the client secret credential; **Sources users may browse** (Office 365, Google Drive) and Office 365's site and drive restrictions; **Connection and users**: enabled or not, how many users connected, the **Connected users** dialog. |
| People directory (LDAP) (`com.intrafind/ldap-directory`) | The model-facing name and description in English and German with a preview and the tool ids; the source (reuse an LDAP sign-in provider with overrides, or connect directly); the access (the provider's bind account, anonymous, or a service account whose password is a credential); the network (transport, plain text, allowed hosts, trusted certificates, TLS versions and ciphers); the visibility (the granting groups, data flow); the limits and units; the search and mapping with the preset's value next to every field; a sample search next to **Test connection**. See [People Directory Search → Admin page](people-directory-search.md#admin-page). |
| LDAP browser (`com.intrafind/ldap-browser`) | The directory it reuses, with what it takes over and a link to it; the browse base, the result limit, the account for browsing and the attributes to withhold. |
| Microsoft Entra ID directory (`com.intrafind/entra-directory`) | The tenant id, the application (client) id and the client secret credential, each saying whether the `AZURE_*` variable it falls back to is set on the server. |
| Web search engines (`com.intrafind/brave-search`, `staan-search`, `qwant-search`) | The API key as a credential (Brave, Staan) with the environment variable the server falls back to without one, or that no key is needed (Qwant, with the hint that its egress IP decides), and any further install field of the definition. **Test connection** checks the key of the values as entered and runs one live search. |

The editors also edit the actions and show the groups that grant the installation, check their own cross-field rules before saving (the iFinder base URL, the OIDC provider for token exchange, an issuer URL for the OIDC key pair, a directory's URL and base DN or sign-in provider, a service account's DN and credential, a browser's directory), and **Test connection** tests the values as entered, unsaved, as the signed-in admin.

For developers: an editor is a React component registered under its definition id in `client/src/features/admin/components/integrations/editors/index.js`. It receives `instance` (the installation with its effective `values` and `liveActions`), `definition`, `onSaved` and `onCancel`, and builds on `useInstallationEditor` (label, groups, actions, test, save) and `InstallationEditorParts` (the shared sections).

## Installing

1. **Admin → Integrations → Catalog** lists every definition: shipped ones and those installed from the [Marketplace](marketplace.md) (type **Integrations**). The marketplace's **Set up integration** and other pages link here with `?install=<definition folder name>`, optionally prefilling values (`v.<field>=<value>`) and the label (`label=`).
2. **Install** opens a form generated from the definition's install fields:
   - **Name**: the instance id apps refer to, and a label users see in the chat.
   - **Settings**: the definition's fields (URL, numbers, switches, choices). Advanced fields are folded away.
   - **Sign-in**: the modes the definition offers and the protocol can run. _No sign-in_ for public APIs; _Shared service account_ stores one secret for everyone in the credential store (`integration-<instanceId>-<field>`), never in a config file; _OAuth client_ (client credentials) and _Each user signs in_ (per-user OAuth) are available for MCP servers, the other protocols get them in a later release. A field that applies to one mode or one transport only (its `when` clause) is shown only then.
   - **Who may use it**: the groups that grant the installation, read-only, with a link to **Admin → Groups**, where grants are edited (see [Who may use an integration](#who-may-use-an-integration)). The tiles and the installation page show the same list; an installation no group grants shows **No group grants it yet**.
   - **Actions**: which of the definition's actions the model may call. Each shows its side effect (read, write, destructive). Actions that need a token are off while sign-in is _none_; actions with a requirement (for example SQL on a DataStore) appear once the setting is on. For an MCP server the list is what the server reports after a test (or on edit); a tool the server adds later is on by default.
3. **Test connection** runs the definition's health action with the values as entered and lists the actions the model would get (for an MCP server: connects and lists its tools). A definition may ask for one free-text input next to the button (`test.input`; People directory (LDAP) takes a sample name to search for). Nothing is saved until **Install**.

## Who may use an integration

The groups decide, like for apps (#3093). `groups.json` → `permissions.integrations` lists what the members of a group may use, edited under **Admin → Groups → a group → Integrations**:

| Entry | Grants |
| --- | --- |
| `*` | every installation, including ones installed later |
| an installation id (`x500bund`, `brave`) | that installation |
| a definition id (`com.intrafind/ldap-directory`) | every installation of that definition, including later ones |
| a type key (`type:people-directory`, `type:web-search`, `type:storage`) | every installation of every definition of that type, including later ones |

```jsonc
"users": {
  "inherits": ["authenticated"],
  "permissions": { "apps": ["*"], "integrations": ["type:web-search", "x500bund"] }
}
```

The list is resolved with inheritance exactly like `apps`: a group gets what the groups it `inherits` grant, and a user gets the union of their groups. The grant holds on top of every app binding and tool grant: an app that binds an installation offers its actions, scopes and sources only to users whose groups grant it, and a direct tool run, the MCP and A2A gateways, scheduled tasks and workflow nodes check the same grant. It also decides

- which web search engines a user's apps search with (native search on Google, OpenAI and Anthropic models needs no grant);
- which cloud storage providers `/api/auth/status` lists in `cloudStorage.providers` and the project picker offers; a user whose groups do not grant a provider cannot connect it, browse it or import from it (the connection's status and **Disconnect** stay available);
- whether a user may connect a per-user MCP server (admins always may).

An LDAP browser is used by the groups that grant it, too — its id or `com.intrafind/ldap-browser`; `*` includes it — and only by signed-in, non-delegated users (never personal API keys, OAuth clients or agents). Its former `browse.groups` list is gone (migration V205 granted the browser to those groups).

Delegated tokens (an OAuth client acting for a user, a personal API key) keep their owner's grant: clients have no integration allow-list. A machine OAuth client (client credentials, static API key) is in no group: it may use what the apps in its **allowed apps** bind. Anonymous users get what the groups in `anonymousAuth.defaultGroups` grant. The shipped groups grant `*` to `admins`, `users` and `authenticated`, and `ihub` and `type:web-search` to `anonymous`.

Installations carry no groups of their own: the admin API refuses an install or update payload that still sends `allowedGroups` (400 `ALLOWED_GROUPS_REMOVED`, naming the group page) and no longer returns the field. Migration V203 moved every installation's former `allowedGroups` onto the groups: a group that could use every installation got `*`, any other group the ids of the installations it could use.

## Binding to an app

**Admin → Apps → Edit → Installed integrations** lists the installations. Tick one to bind it; untick actions the app should not offer; set a **default** scope, a **pinned** scope (users cannot change it) and where the scope picker appears. The app's JSON holds:

```jsonc
"integrations": {
  "open-data-portal": { "actions": ["search_datasets", "get_dataset"], "defaultScope": "stadt-norderstedt" }
}
```

The built-in `ifinder` and `iassistant` installations are bound the same way, and the same object carries their scope settings (`scopePicker`, `defaultScope`, `pinnedScope`). For iFinder the `actions` are the tool names without the `iFinder_` prefix: `"integrations": { "ifinder": { "actions": ["search", "getContent"] } }`; leave `actions` out for all seven, or set `"actions": []` to bind the installation for the scope picker only. An app on the iAssistant model (`preferredModel: "iassistant-conversation"`) binds `"integrations": { "iassistant": { "actions": [] } }`. See [Apps → Integrations](apps.md#integrations-binding-an-installed-integration).

**Storage providers** have their own card, **Storage providers**: **All storage providers** (`type:storage`), **All … installations** of a provider with several, and each installation. They bring no actions, so the rows have no action list; a new storage binding is optional (`"required": false`). The chat's cloud file picker offers the providers an app binds this way, and only those the user's groups grant. This binding replaced the upload switch `upload.cloudStorageUpload` (migration V206).

**Binding a definition.** A key of `integrations` may also be a definition id, with its one `/`: `"integrations": { "com.intrafind/ldap-directory": {} }` binds **every installation of that definition, including ones installed later**, with the same `actions` and `required` settings for each (`"com.intrafind/ldap-browser": {}`, the shipped LDAP browser app, binds every LDAP browser). A type key, `"type:people-directory": {}`, binds every installation of every definition of that type — this is how the shipped People search app follows every LDAP directory and the Entra ID directory. An installation's own binding wins over the binding of its definition, so one directory can be narrowed or widened on top of "all directories". The app editor offers such a row — **All … installations** — for every definition with two or more installations and for a definition the app already binds; the people directories get **All people directories** (the type binding) in their own card. A definition binding is satisfied while at least one installation of the definition is enabled. An action a definition marks `bindExplicitly` is never part of a binding without `actions`; it has to be named (no shipped definition uses it any more: the LDAP browser is its own integration).

An app is offered to users only while every installation it **requires** exists and is enabled (for `iassistant`, the iFinder installation too). Otherwise it is hidden like an app whose required feature is off, and **Admin → Apps** names the missing installation. Uninstalling or disabling an integration therefore takes its apps offline instead of leaving them without tools. A binding is required unless it says `"required": false`: an optional binding keeps the app available, and its actions, scopes and sources are simply not there while the installation is disabled or missing (**Required** switch per binding in the app editor). Web search works the other way round, since most apps work without it and native search needs no engine: `websearch.enabled` leaves the app available while no engine is, and only `websearch.required: true` hides it — on `auto` while no engine installation is enabled (missing: `type:web-search`), on a named engine while that one is missing or disabled.

In the chat, every bound action appears as a tool `<instanceId>__<action>` named _Label: Action_ (the built-in integrations keep their `iFinder_*` ids, see above; an MCP installation's tools keep `<toolPrefix or id__><tool>`). The tools menu shows one switch per installation (the instance id is the tool reference), on by default. An `app.tools` entry naming an installation or one of its tools selects nothing: the binding is the only way in. When the definition declares **scopes** (for CKAN: the publishers), the chat offers them in the scope picker like iFinder search profiles, and the pick is applied to the actions after the model's arguments, so the model cannot override it. A scope narrows the actions it is declared for (for CKAN: the dataset search); it is not an access boundary. Actions that take an id, such as reading one dataset, still reach records outside the scope, and a pinned scope must not be relied on for isolation. Use the system's own permissions and a token per audience for that.

## How an action runs

Five protocols have an adapter: `native`, for the built-in connectors (iFinder, iAssistant, the web search engines, Jira, Entra ID, the LDAP people directories and LDAP browsers), and `script`, the same adapter with the connector module loaded from the definition folder; `mcp`, which hands the installation to the MCP client manager (connections, per-user OAuth, MCP Apps and the shared tool catalog as before; the installation's `actions.disabled` becomes the server's denied tools); `a2a`, which hands it to the A2A client manager the same way (`actions.disabled` becomes the agent's denied skills); and `openapi`, for every other catalog integration. For `openapi`, the definition names an OpenAPI document (a companion file) and each action names an `operationId`. At call time the adapter:

1. builds the base URL and static headers from the install values (`{baseUrl}{apiPath}`), and adds the shared secret as a header when the sign-in mode is _service account_;
2. applies the action's **enforced defaults**: `fixed` (the install value is sent, the model's dropped), `cap` (the smaller number wins), `append` (install value and model value are joined, Solr `fq` style), `default` (only fills a gap); then the chat's scope;
3. serializes array parameters as the document says (`form` style: repeated, or comma-joined for `explode: false`; `spaceDelimited` and `pipeDelimited` are not supported), or as a JSON list for RPC-style APIs such as CKAN;
4. performs the request through the SSRF guard with the usual size caps and `hideFields`;
5. unwraps the **response envelope** (`{ success, result, error }`) so the model sees `result`, or a structured `{ error, type, message }`;
6. adds a `portalUrl` to every hit the definition's **sources** mapping lists, so each answer cites the records it used.

Outbound hosts follow `security` in `integrations.json` (`blockPrivateIps`, `allowedHosts`) and the platform's SSRF settings.

## Writing a definition

```jsonc
{
  "id": "org.example/service", // reverse-DNS, optionally one "/"
  "version": "1.1.0",
  "compatibility": { "ihub": ">=5.7.0 <7" }, // semver range the server version must satisfy
  "releases": [
    // newest first; releases[0].version is version
    {
      "version": "1.1.0",
      "date": "2026-11-12",
      "summary": { "en": "Search returns totals.", "de": "Suche liefert Trefferzahlen." },
      "notes": { "features": "releases/1.1.0/features.md", "fixes": "releases/1.1.0/fixes.md" }
    },
    { "version": "1.0.0", "date": "2026-10-31", "summary": { "en": "First version." } }
  ],
  "name": { "en": "…", "de": "…" },
  "protocol": {
    "type": "openapi",
    "document": "openapi.json", // companion file in the folder
    "baseUrl": "{baseUrl}", // install fields as {placeholders}
    "responseEnvelope": { "success": "success", "result": "result", "error": "error.message" },
    "arrayParameterStyle": "json-list" // openapi | repeat | comma | json-list
  },
  "auth": {
    "modes": ["none", "service-account"],
    "serviceAccount": {
      "kind": "header",
      "header": "Authorization",
      "valuePrefix": "Bearer ",
      "field": "apiToken"
    }
  },
  "install": [
    { "key": "baseUrl", "type": "url", "title": { "en": "Service URL" }, "required": true },
    { "key": "apiToken", "type": "secret", "title": { "en": "API token" } },
    {
      "key": "maxRows",
      "type": "number",
      "title": { "en": "Rows" },
      "default": 10,
      "min": 1,
      "max": 50,
      "advanced": true
    }
  ],
  "actions": [
    {
      "name": "search",
      "operationId": "search",
      "sideEffect": "read",
      "dataFlow": "external",
      "title": { "en": "Search" },
      "description": { "en": "…as the model should read it…" },
      "defaults": { "rows": { "value": "{maxRows}", "mode": "cap" } },
      "hideFields": ["help", "result.items[].internalId"],
      "guidance": { "en": "When to use it." },
      "examples": [{ "en": "Example question" }]
    },
    {
      "name": "list_groups",
      "operationId": "listGroups",
      "sideEffect": "read",
      "dataFlow": "external",
      "title": { "en": "List groups" },
      "description": { "en": "…" }
    }
  ],
  "scopes": {
    "action": "list_groups",
    "label": { "en": "Group" },
    "map": { "id": "name", "name": "title" },
    "paging": { "offset": "offset", "limit": "limit", "size": 25 },
    "applyAs": { "search.fq": { "value": "group:{id}", "mode": "append" } }
  },
  "sources": {
    "search": {
      "list": "items",
      "fields": { "id": "id", "title": "title", "snippet": "summary" },
      "urlTemplate": "{baseUrl}/items/{id}"
    }
  },
  "health": { "action": "search", "args": { "rows": 0 } },
  "exampleApps": [{ "file": "apps/service-assistant.json" }] // companion app configs, at most 5
}
```

`exampleApps` lists **example apps**: companion JSON files in the definition folder (`.json`, at most 512 KB each), each an ordinary app configuration (`server/validators/appConfigSchema.js`) that binds the integration by its **definition id** or **type**, e.g. `"integrations": { "org.example/service": {} }`. The installation page creates one for an installation with a click and binds it there (see [Example apps and the chat test](#example-apps-and-the-chat-test)); `id` and `enabled` of the file are replaced. The marketplace fetches the files with the definition, like its OpenAPI document and release notes.

An `mcp` definition has no actions and no document; its `protocol` fixes what the definition knows and leaves the rest to install fields of the same name: `{ "type": "mcp", "transport": { "type": "streamableHttp", "url": "https://mcp.example.com/mcp", "headers": { "X-Scope": "read" } }, "toolPrefix": "ex_", "timeoutMs": 60000, "apps": { "enabled": true } }`. A registry may publish MCP definitions with a fixed remote transport only; a local process (`stdio`) is installed from the shipped generic definition. The sign-in modes are `none`, `service-account`, `oauth-client` (`auth.oauthClient.field` names the client-secret field) and `oauth-user` (`auth.oauthUser.field` optionally names the secret of a pre-registered client); the adapter decides which of the declared modes it can run.

An `a2a` definition is the same idea for a remote agent: `{ "type": "a2a", "cardUrl": "https://agent.example/.well-known/agent-card.json", "timeoutMs": 60000 }`, every setting optional and otherwise read from the install fields `cardUrl`, `timeoutMs`, `streaming`, `pollIntervalMs`; sign-in modes `none`, `service-account` (`authKind` bearer or apiKey) and `oauth-client`.

A field may carry a `when` clause so it applies only in some cases: `{ "field": "transport", "in": ["streamableHttp", "sse"] }`, `{ "field": "authKind", "equals": "basic" }` or `{ "authMode": ["oauth-user"] }`. A field that does not apply is hidden in the wizard, never required, and its stored value is ignored.

`scopes.paging` makes the adapter call the scope action page by page (`offset` and `limit` name its parameters, `size` is the portal's cap per call) until a page comes back short, at most 1000 scopes. A service account's secret goes into a header (`kind: header` with `header` and `valuePrefix`, `bearer`, or `basic`); a secret in a query parameter is not supported. Field types: `string` (with optional `suggestions` and `pattern`), `number` (`min`, `max`), `boolean`, `enum` (`choices` with localized labels), `url` (a trailing slash is stripped, since the value is joined with paths in templates; `"keepTrailingSlash": true` keeps the URL verbatim for an endpoint whose exact string matters, such as the MCP server URL and the OAuth issuer of the generic MCP definition, to which per-user tokens and client registrations are bound), `secret` (always sensitive, stored in the credential store), `credential` (a reference to an entry of the credential store, picked in the wizard; the iFinder private key uses it), `instance` (another installation, whose definition `definition` names; the iAssistant `connection` field uses it), `list` (a list of strings), `file`, `directory`. `scope: "user"` fields are reserved for per-user connections. The schema is `server/validators/integrationDefinitionSchema.js`; the sources mapping is the [declared-sources format](answer-sources.md) with `urlTemplate` on top.

### Version, compatibility and release notes

`version` is the definition's semantic version; every installation records the `definitionVersion` it was written for, and **Admin → Integrations** shows it on the installation's tile and page. `compatibility.ihub` is a semver range (`">=5.7.0"`, `">=5.7.0 <7"`) the server version (the root `package.json`) must satisfy; prereleases compare with `includePrerelease`, so `5.7.0-rc.1` satisfies `>=5.7.0`. A definition without it runs on every version. A definition the server does not satisfy still loads, with status **incompatible**: its installations are listed with the reason, but they offer no tools and no scopes, cannot be edited or tested, and nothing is written for them; the catalog greys the definition and the marketplace refuses to install or update it (`INCOMPATIBLE_IHUB_VERSION`). `compatibility.schema` (integer, default 1) is the revision of the definition format the file is written in; it is read from the raw file before anything else, and a revision this server does not know is refused whole (the registry skips the folder with a warning, the marketplace rejects the item with `UNSUPPORTED_DEFINITION_SCHEMA`) instead of being loaded with its unknown fields dropped.

`releases` is the release history, newest first, and `releases[0].version` must equal `version`. Each entry carries the `date` (`YYYY-MM-DD`), a one-line localized `summary` for lists and the update dialog, and under `notes` the Markdown files with the full notes per category, named like iHub's own `docs/releases/<version>/` files: `features` (`releases/<version>/features.md`), `fixes` (`fixes.md`), `breaking` (`breaking-changes.md`). A category without changes has no file. The files are companion files of the folder, fetched and served one by one (`GET …/catalog/:definitionId/_file?path=…`), so the marketplace renders a release's notes without downloading the package; a note file missing from the folder is logged and left out. `migration` names the definition migration the release needs: its own version, listed in `migrations` (see [Migrations](#migrations)). The shipped definitions (iFinder, iAssistant, the web search engines, Jira, Entra, iHub, the MCP server and A2A agent definitions, CKAN) carry a `1.0.0` release whose notes describe what the config migrations V192–V197, V199, V202 and V204 did.

### Migrations

A release that changes what an installation stores — an install field renamed, an action renamed or removed, a new value that needs a default — ships a **definition migration**. iHub runs it for every installation of the definition, so an installation-only change needs no numbered config migration (`server/migrations/V*.js`).

```jsonc
"releases": [
  { "version": "1.4.0", "date": "2026-11-12", "summary": { "en": "…" }, "migration": "1.4.0" },
  { "version": "1.3.1", "date": "2026-11-02", "summary": { "en": "…" } },
  { "version": "1.3.0", "date": "2026-10-28", "summary": { "en": "…" }, "migration": "1.3.0" }
],
"migrations": [
  { "id": "1.3.0", "steps": [
      { "renameValue": { "from": "fq", "to": "defaultFilter" } },
      { "renameAction": { "from": "search", "to": "dataset_search" } } ] },
  { "id": "1.4.0", "steps": [ { "setValue": { "key": "rows", "value": 20, "when": "missing" } } ] }
]
```

A migration's `id` is the version it brings an installation **up to**; the release of that version names it (`"migration": "1.4.0"`), and every migration is named by its release. An installation at `from` runs every migration with `id > from` and `id ≤ version`, in version order, so 1.2.0 → 1.4.0 runs 1.3.0 and 1.4.0. A release without `migration` changes nothing an installation stores.

Each step is an object with exactly one key:

| Step | Shape | What it does |
| --- | --- | --- |
| `renameValue` | `{ "from": "<key>", "to": "<key>" }` | moves an install value; a destination that holds a value is a collision |
| `setValue` | `{ "key": "<key>", "value": <value>, "when": "missing" \| "always" }` | writes an install value; `missing` (default) only where the key holds none |
| `removeValue` | `{ "key": "<key>" }` | drops an install value |
| `mapValue` | `{ "key": "<key>", "map": { "<old>": <new> } }` | rewrites a value, or each entry of a list value (`null` drops a list entry); two entries landing on one value is a collision |
| `renameAction` | `{ "from": "<name>", "to": "<name>" }` | renames the action in `actions.enabled`, `actions.disabled`, `actions.overrides` and in the app bindings' `actions`; a destination already named there is a collision |
| `removeAction` | `{ "name": "<name>" }` | drops the action from the policy and the app bindings; each app that named it gets a warning |
| `renameScope` | `{ "from": "<scope>", "to": "<scope>" }` | rewrites `defaultScope` and `pinnedScope` of the app bindings |

Nothing else is reachable: never `auth`, never a credential. A `module` step (a code migration) is refused by the schema in this release.

**App bindings.** An app binds an installation by its id, by its definition id or by its type (`type:people-directory`). The installation's own binding is rewritten. The definition binding is shared by every installation of the definition and names the definition's actions, so it is rewritten too; every installation of the definition runs the same migrations, and a step is a no-op on a binding a sibling installation already rewrote. A type binding is shared by definitions that name their actions differently (the app editor offers no action list there): it is never rewritten, and a type binding that names a renamed or removed action or scope gets a warning.

**Collisions and validation.** A step whose destination already holds something is a collision; the plan collects every one and fails with the colliding keys (and apps) in the reason, before anything is written. Nothing is ever overwritten or merged silently: an author who means to merge removes the destination first. After the last step the result is validated against the definition: the install values with the definition's defaults filled in as the runtime reads them (`checkInstallValues`; a field that became required but has a `default` passes, the default is not stored), every action name of the policy and of the own and definition bindings against the definition's actions (not for MCP and A2A, whose actions come from the server), a `defaultScope`/`pinnedScope` against a definition that declares no scopes at all, the sign-in mode against the offered modes, and `auth` against the one before. An unknown reference fails the migration.

**When it runs.**

1. **Server start**, for built-in definitions an iHub release updated: after the numbered config migrations, in the cluster primary (or the single process) before any worker loads the installations, so no worker serves unmigrated values. The same run rolls back an interrupted commit and restores the matching backup of an installation whose built-in definition went back (an iHub downgrade).
2. **Marketplace update** of the definition (see [Marketplace](marketplace.md#installing-updating-and-removing)): the new folder moves in in the same commit as the migrated installations, their apps and the manifest entry.
3. **Manually**, `POST /api/admin/integrations/installed/:id/_migrate`: an installation left behind (a definition copied in by hand, a failed run).

Installations migrate independently; one failing never blocks the others. An incompatible definition never migrates.

**States.** `status` on the installation, with `statusReason`:

| State | When | Tools | Ordinary save (`PUT`) | Actions |
| --- | --- | --- | --- | --- |
| `migrationPending` | the loaded definition is newer than `definitionVersion` | none while a migration lies between the versions; the old values otherwise (only the version changes) | `409 MIGRATION_PENDING` while a migration lies between; otherwise saves and stamps the version | `_migrate` |
| `migrationFailed` | a migration failed; values and `definitionVersion` are as before it | none | `409 MIGRATION_FAILED` | `_migrate` (re-run), `_restore`, uninstall |
| `needsReview` | `definitionVersion` missing or not a version, or the definition is older (a downgrade without a matching backup) | none | `409 NEEDS_REVIEW` | `_restore` (when a backup of the loaded version exists), `_adopt`, uninstall |

A stored `definitionVersion` that is not a semantic version does not make `integrations.json` fail to load: the installation loads as `needsReview` with the value in the reason. Config migration V207 stamped every existing installation without a valid version with the version of its definition at the time, the baseline for later migrations.

**Backups.** Before a run the runner copies `config/integrations.json`, the app files that bind the installation, the marketplace manifest `config/installations.json` and, for a marketplace definition whose folder still is the installation's version, the definition folder to `contents/backups/integrations/<id>-<version>-<timestamp>/`, with `manifest.json` `{ representedVersion, instanceId, definitionId, createdAt, kind, createdBy, trigger, files }`. A run over several migrations also keeps the state at every boundary it passed (`kind: "boundary"`), so a later revert to that version has something to restore; a restore first backs up what it replaces (`pre-restore`). Backups are not removed automatically. A **restore** writes back what a migration may have changed, from the backup: the installation's entry (its migration log is kept and gets an entry), the binding keys of its apps (the rest of each app stays), the manifest entry, and the definition folder when the backup holds one of another version than the loaded one. Without a named backup it takes, for `needsReview`, the newest backup of the loaded definition's version and, for `migrationFailed`, the newest backup taken before a migration (for a marketplace update: the pre-update package and values).

**Commit and lock.** A run holds the cluster-wide lock `integration-migration:<instanceId>` (`LockManager`; the lease is renewed while it works). The results are written to `staging/` in the backup, a commit marker `commit.json` with the lock's fencing token is written, the token is checked again (a holder whose lease was taken over gives up and discards its staging, `409 MIGRATION_LOCK_LOST`), the files move into place and the marker is finalised. A failure while moving rolls everything back from the backup and marks the installation `migrationFailed`; a crash leaves an unfinished marker, rolled back at the next start (and before the next run on the installation). Each run appends `{ from, to, at, by, trigger, result, migrations, steps, warnings, changes, reason, backup }` to `migrationLog` (the last 10; `result` is `migrated`, `stamped`, `failed`, `rolledBack`, `restored` or `adopted`).

**Downgrade.** Migrations run forward only. When the loaded definition is older than an installation's version, the matching backup is restored (at the server start, and after a restore brought an older marketplace package back); without one the installation needs a review.

**Uninstall** is the ordinary `DELETE /api/admin/integrations/installed/:id`: it removes the installation and its managed credential. App bindings stay in the apps (an app that requires the installation is hidden until it is installed again under the same id).

To publish a definition, put the folder in a marketplace registry as an item of type `integration` whose `name` is the folder name and whose `source.companions` lists the other files (the OpenAPI document, the icon and the release-note files are fetched even when not listed). The catalog item copies `version`, `compatibility` and `releases`, so the marketplace decides compatibility and shows the history without a download. See [Marketplace → Publishing your own registry](marketplace.md#publishing-your-own-registry).

#### In the admin

**Admin → Integrations → Installed** marks an installation with a migration state on its tile: a red _Migration failed_ or an amber _Migration pending_ / _Needs review_ pill, the reason as text, and the actions of that state as buttons (**Uninstall** is the tile's Remove button). The installation's page shows the **migration panel** above the tabs:

| State | The panel says | Buttons |
| --- | --- | --- |
| `migrationPending` | which version is loaded and which one the installation records; what the migrations change (install values, actions, app bindings), the apps that lose an action, collisions and validation problems that will make it fail — all planned on the server, nothing written | **Migrate now** |
| `migrationFailed` | the reason, the backup **Restore backup** takes | **Re-run migration**, **Restore backup**, **Uninstall** |
| `needsReview` | the reason (no version, or a downgrade), the backup of the loaded version if one exists | **Restore backup** (only with that backup), **Adopt current version**, **Uninstall** |

**Restore backup**, **Adopt current version** and **Uninstall** ask first: the restore dialog names the backup, its version and date (and whether it holds a definition folder); adopt says that the values are checked like a migration result and nothing else changes; uninstall is the ordinary remove dialog with the apps that bind the installation. After each action the page shows the log entry the server wrote (from → to, result, changes, warnings, steps) or the error with its reason and the problems it lists (collisions, values that do not fit), and reloads. While the installation is pending with a migration between the versions, failed or needs a review, **Settings** shows the editor read-only (a disabled fieldset around every editor, dedicated or generic) with the reason, since the server refuses the save. The **Migration log** on Overview lists each run with from → to, when, by whom, how it started, the result, the changes, the reason, the warnings, the backup and the steps.

**Admin → Apps** shows, in an app's status, the warnings a migration left on it: an action it was bound to was removed (`ACTION_REMOVED_FROM_APP`), or a type binding still names a renamed or removed action or scope (`TYPE_BINDING_NOT_REWRITTEN`). The app editor's Integrations section shows the same warning next to the binding it concerns, with a link to the installation's migration log. A warning counts from the installation's `migrated` runs since its last restore, and goes away once the app no longer has what it is about (the binding is removed, or the type binding no longer names the action or scope).

The marketplace's update dialog shows the same plan per installation before the update and each installation's result after it ([Marketplace](marketplace.md#installing-updating-and-removing)).

## API

| Route                                                                                                                 | Purpose                                                               |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/admin/integrations/catalog`                                                                                 | definitions with install state                                        |
| `GET /api/admin/integrations/catalog/:definitionId`                                                                   | one definition (install fields, auth, actions, releases, compatibility); the id is URL-encoded |
| `GET /api/admin/integrations/catalog/:definitionId/_file?path=…`                                                      | one Markdown companion file of the definition (a release's notes), from its folder |
| `GET /api/admin/integrations/updates`                                                                                 | installations whose definition has a newer compatible version in the marketplace catalog it came from |
| `POST /api/admin/integrations/catalog/:definitionId/_test`                                                            | test an unsaved instance (`values`, `auth`, `secrets`, `testInput`)   |
| `POST /api/admin/integrations/catalog/_reload`                                                                        | re-read the definition folders                                        |
| `GET` / `POST /api/admin/integrations/installed`                                                                      | list (with `definitionVersion`, `currentVersion`, `updateAvailable`, `incompatible`, the migration fields below), install |
| `GET` / `PUT` / `DELETE /api/admin/integrations/installed/:id`                                                        | read with live actions, update (`409 MIGRATION_PENDING`, `MIGRATION_FAILED`, `NEEDS_REVIEW`, see [Migrations](#migrations)), uninstall |
| `POST /api/admin/integrations/installed/:id/_test`, `_enable`, `_disable`                                             | lifecycle                                                             |
| `POST /api/admin/integrations/installed/:id/_migrate`                                                                 | run (or re-run) the definition migration                              |
| `POST /api/admin/integrations/installed/:id/_restore`                                                                 | restore a backup, body `{ "backup"?: "<id>" }`                        |
| `POST /api/admin/integrations/installed/:id/_adopt`                                                                   | adopt the loaded definition version for an installation that needs a review |
| `GET /api/admin/integrations/installed/:id/example-apps`                                                              | the example apps it offers (`templates[]`: `key`, `source` `definition` or `generated`, `name`, `description`, `suggestedId`), `grantedToYou` (the calling admin's groups grant it), `enabled` |
| `POST /api/admin/integrations/installed/:id/example-apps`                                                             | create one, body `{ "template"?: "<key>", "appId"?: "…", "enabled"?: true }` → `201 { app }`; `409` when the id is taken, `400` for an invalid id or an unknown template; audited as `create app` |
| `GET /api/admin/integrations/installed/:id/connections`, `DELETE …/connections/:userId`, `POST …/registration/_reset` | per-user connections of an installation that signs every user in      |
| `GET /api/integrations/{office365,googledrive,nextcloud}/auth?providerId=<installation id>`, `GET …/<installation id>/callback`, `GET …/status?providerId=`, `POST …/disconnect` (`providerId` in query or body) | a user connects one storage provider installation, sees and removes the connection |
| `GET /api/integrations/{office365,googledrive,nextcloud}/sources`, `/drives/:source`, `/items`, `/download` (each `?providerId=<installation id>`) | browse and download; `400 STORAGE_PROVIDER_REQUIRED` without an installation, `404 STORAGE_PROVIDER_NOT_FOUND` for an unknown one, `403 INTEGRATION_NOT_GRANTED` when the groups do not grant it |

Every write is audited with resource `integration`.

**Migration fields** of every installation in `GET …/installed` and `GET …/installed/:id` (`instance`):

```jsonc
{
  "definitionVersion": "1.2.0",          // null when missing
  "status": "migrationPending",          // migrationPending | migrationFailed | needsReview | null
  "statusReason": "…",                   // null when status is null
  "migrationLog": [ /* last 10 runs, oldest first */ ],
  "migration": {                         // null when there is no state and no backup
    "pending": true,                     // the loaded definition is newer
    "blocked": true,                     // offers no tools
    "downgrade": false,
    "from": "1.2.0", "to": "1.4.0",
    "migrations": ["1.3.0", "1.4.0"],
    "summary": { "values": 2, "actions": 1, "apps": 1 },   // planned, nothing written; null when nothing to plan
    "warnings": [ { "code": "ACTION_REMOVED_FROM_APP", "message": "…", "appId": "…", "action": "…" } ],
    "collisions": [ { "migration": "1.3.0", "step": "renameValue", "kind": "value", "key": "defaultFilter", "message": "…" } ],
    "errors": [ { "kind": "action", "key": "…", "message": "…" } ],   // final validation of the plan
    "backups": [ { "id": "govdata-1.2.0-20261102T100000000Z", "representedVersion": "1.2.0", "createdAt": "…", "kind": "pre-migration", "hasDefinition": false } ],
    "defaultBackup": "govdata-1.2.0-20261102T100000000Z"   // what _restore takes without a body, or null
  },
  "liveStatus": { "connected": true, "toolCount": 3 }       // the adapter's live connection status (MCP, directories, storage), or null
}
```

The three actions answer `{ success, logEntry, instance }` (the installation as above; `_migrate` adds `result`: `migrated`, `stamped` or `current`; `_restore` adds `backup`). Errors carry `code` and `reason`:

| Status | `code` | When |
| --- | --- | --- |
| 404 | `NOT_FOUND`, `BACKUP_NOT_FOUND` | unknown installation; no backup for the state, or the named one is not this installation's |
| 409 | `MIGRATION_LOCKED` | another migration of the installation holds the lock |
| 409 | `MIGRATION_NOT_APPLICABLE` | `_migrate` on an installation that needs a review, or whose definition is older |
| 409 | `RESTORE_NOT_APPLICABLE`, `ADOPT_NOT_APPLICABLE` | the installation is not in a state the action repairs |
| 409 | `MIGRATION_LOCK_LOST`, `MIGRATION_CONFLICT` | the lock was taken over, or the installation changed meanwhile; nothing was written, run it again |
| 422 | `MIGRATION_FAILED` | the migration failed; the body adds `logEntry`, `details` (`collisions`, `errors`, `backup`) and the installation, now `migrationFailed` |
| 422 | `ADOPT_INVALID` | the stored values do not fit the loaded definition; `details` lists the problems |
| 422 | `DEFINITION_MISSING`, `INCOMPATIBLE_DEFINITION`, `BACKUP_INVALID` | no definition to migrate to; an incompatible definition never migrates; a damaged backup |

## Code map

| File                                                                                                                                                                                                                                                                                                   | Responsibility                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/validators/integrationDefinitionSchema.js`, `integrationsConfigSchema.js`                                                                                                                                                                                                                      | definition, `ConfigField`, installed-instance schemas; `checkInstallValues`                                                                                                                         |
| `server/services/integrations/definitions/IntegrationRegistry.js`                                                                                                                                                                                                                                      | loads shipped and installed definition folders and their OpenAPI documents; the `incompatible` status, release-note checks, companion files                                                                                                                          |
| `server/services/integrations/definitions/compatibility.js`, `definitionUpdates.js` | the compatibility check against the server version; newer catalog versions of installed definitions |
| `server/services/integrations/definitions/migrationPlanner.js` | definition migrations, pure: which migrations run, the steps, collisions, the final validation, an installation's migration state |
| `server/services/integrations/definitions/DefinitionMigrationRunner.js`, `migrationBackups.js` | runs migrations under the lock: backups, the staged commit with its marker and fencing token, recovery, restore, adopt, the startup run and the marketplace update |
| `server/services/integrations/definitions/migrationPreview.js` | the update preview of a marketplace item, planned from the catalog |
| `server/migrations/V207__integration_definition_version_baseline.js` | stamps the definition version baseline on installations without one |
| `server/services/integrations/InstalledIntegrationService.js`                                                                                                                                                                                                                                          | `integrations.json` CRUD, managed secrets, tests                                                                                                                                                    |
| `server/services/integrations/protocols/openapi/OpenApiAdapter.js`, `protocols/enforcement.js`                                                                                                                                                                                                         | the `openapi` adapter: actions, run, test, scopes                                                                                                                                                   |
| `server/services/integrations/protocols/native/`, `server/services/integrations/ifinderConfig.js`                                                                                                                                                                                                      | the `native` adapter (also serving `script` definitions from their folder) and the iFinder and iAssistant connectors; the installations' values as the connectors read them                         |
| `server/services/integrations/protocols/mcp/`                                                                                                                                                                                                                                                          | the `mcp` adapter; `serverConfig.js` projects an installation onto the MCP client manager's server config, `manager.js` feeds the manager from the installations                                    |
| `server/services/integrations/protocols/a2a/`                                                                                                                                                                                                                                                          | the `a2a` adapter; `agentConfig.js` and `manager.js` do the same for the A2A client manager                                                                                                         |
| `server/services/integrations/integrationTools.js`                                                                                                                                                                                                                                                     | integration tools for `loadTools`, app binding, `runTool` dispatch, scope providers                                                                                                                 |
| `server/routes/admin/integrations.js`                                                                                                                                                                                                                                                                  | the admin API                                                                                                                                                                                       |
| `server/routes/admin/integrationExampleApps.js`, `server/services/integrations/exampleApps.js` | example apps of an installation: the templates (shipped or generated), the binding moved to the installation, the free app id |
| `client/src/features/admin/components/integrations/IntegrationTestPanel.jsx` | **Test in chat** on the installation page: app picker, example app form, the chat of `AppTestPanel` |
| `server/services/marketplace/ContentInstaller.js`                                                                                                                                                                                                                                                      | marketplace type `integration`                                                                                                                                                                      |
| `client/src/features/admin/pages/AdminIntegrationsPage.jsx`, `AdminInstallationPage.jsx`, `components/integrations/*`                                                                                                                                                                                  | the Installed, Catalog and Inbound tabs (`integrationGroups.js`, `integrationFacts.js`, `InstallationTile.jsx`), the installation page, the install form (`IntegrationInstallForm.jsx`)                |
| `client/src/features/admin/components/integrations/migrationState.js`, `useMigrationActions.js`, `MigrationParts.jsx`, `InstallationMigrationPanel.jsx`, `appMigrationWarningRules.js`, `AppMigrationWarnings.jsx`; `components/marketplace/updateMigrationRows.js`, `IntegrationUpdateMigrations.jsx` | the admin UI of definition migrations: which actions a state offers and when Settings is read-only (pure), the actions with their confirmations, the panel, the log, the outcome; the Apps warnings; the marketplace update preview and report |
| `client/src/features/admin/components/integrations/editors/` | the dedicated editors and their registry (iFinder, iAssistant, the storage providers: `StorageProviderEditor.jsx`, `storageEditorModel.js`; the web search engines: `WebSearchEngineEditor.jsx`) |
| `client/src/features/admin/components/app-form/IntegrationsConfigSection.jsx`, `storageBindingRows.js`, `WebSearchSection.jsx`, `webSearchEngines.js` | app editor binding: the Storage providers card; the web search panel with its engine list (Auto and the installed engines) |
| `shared/storageBindings.js`, `client/src/shared/hooks/useFileUploadHandler.js` | which storage providers an app binds; the chat's picker offers those among the granted ones |
| `server/defaults/integration-definitions/org.ckan__open-data-portal/`                                                                                                                                                                                                                                  | the shipped CKAN definition                                                                                                                                                                         |
| `server/defaults/integration-definitions/com.intrafind__mcp-server/`, `mcp__*/`                                                                                                                                                                                                                        | the generic MCP server definition and the shipped hosted MCP servers                                                                                                                                |
| `server/migrations/V193__mcp_servers_installed_integrations.js`, `V194__a2a_agents_installed_integrations.js`                                                                                                                                                                                          | `mcpServers.json` and `a2aAgents.json` → installations                                                                                                                                              |
| `server/defaults/integration-definitions/com.intrafind__ifinder/`, `com.intrafind__iassistant/`                                                                                                                                                                                                        | the built-in iFinder and iAssistant definitions                                                                                                                                                     |
| `server/defaults/integration-definitions/com.intrafind__ldap-directory/`, `server/services/integrations/ldapDirectoryConfig.js`, `protocols/native/connectors/ldapDirectory/` | the People directory (LDAP) definition, the installation read in the directory shape, and the connector over `services/peopleDirectory/` |
| `server/defaults/integration-definitions/com.intrafind__ldap-browser/`, `protocols/native/connectors/ldapBrowser/`, `services/peopleDirectory/LdapBrowserService.js`, `ldapBrowserRunner.js`, `LdapBrowser.js` | the LDAP browser definition and connector, its resolution over the directory it reuses and its access rules, running and testing its tools, and the LDAP operations |
| `server/routes/admin/peopleDirectoryEditor.js` | `GET /api/admin/integrations/people-directories/editor-context`: presets, limits, LDAP sign-in providers and `AZURE_*` flags for the dedicated editors |
| `client/src/features/admin/components/integrations/editors/PeopleDirectoryEditor.jsx`, `peopleDirectory/`, `LdapBrowserEditor.jsx`, `EntraDirectoryEditor.jsx`, `peopleDirectoryEditorModel.js` | the dedicated editors of the people directories and the LDAP browser, and their pure form model |
| `server/migrations/V198__people_directories_installed_integrations.js`                                                                                                                                                                                                                                 | `peopleDirectories.json` → installations                                                                                                                                                            |
| `server/migrations/V205__ldap_browser_installations.js` | a directory's LDAP browser → an LDAP browser installation, its grant, and the app bindings; People search → `type:people-directory` |
| `server/defaults/integration-definitions/com.intrafind__office365/`, `com.intrafind__google-drive/`, `com.intrafind__nextcloud/`, `server/services/integrations/cloudStorageConfig.js`, `protocols/native/connectors/cloudStorage/`, `server/routes/integrations/cloudStorageAccess.js` | the storage provider definitions, every installation read in the provider shape the services and routes use (with the redirect URI derivation), the connectors (test, status, connections per installation), the route check (installation required, granted) |
| `server/migrations/V200__cloud_storage_installed_integrations.js`, `V206__storage_provider_installations.js` | `platform.cloudStorage` → installations; installation id = provider id, the parked providers installed, tenant id credentials cleaned up, `upload.cloudStorageUpload` → `type:storage` binding |
| `server/defaults/integration-definitions/com.intrafind__ihub/`, `protocols/native/connectors/ihub/`, `server/services/tools/shippedToolDefinitions.js` (reading the shipped tool files in `server/defaults/tools/`), `server/migrations/V199__ihub_tools_installed_integration.js`, `V202__ihub_integration_chat_tools_only.js`| the always-installed iHub integration (`ask_user`, the scheduled-task tools), their definitions, and the migrations that retire the tool files and narrow the installation to these actions         |
| `server/services/tools/platformTools.js`, `server/services/knowledge/knowledgeTools.js`                                                                                                                                                                                                                | the tools of other iHub features, which are no integration actions: the workflow and agent tools and the web search page reader `read_url` (`loadTools` as plain tools) and the project knowledge tools (with the request's projects) |
| `server/defaults/integration-definitions/com.intrafind__brave-search/`, `com.intrafind__staan-search/`, `com.intrafind__qwant-search/`, `protocols/native/connectors/websearch/`                                                                                                                       | the web search engine definitions and their connectors (one `search` action each, the installation test)                                                                                             |
| `server/services/search/webSearchEngines.js`, `websearchConfig.js`, `server/toolLoader.js` (`resolveWebSearchEngine`)                                                                                                                                                                                  | which installations are engines and in which order `auto` tries them; the installed engines and their API keys; which engine (or native search) a request gets                                     |
| `server/migrations/V195__web_search_installed_integration.js`, `V204__web_search_engines.js`                                                                                                                                                                                                            | providers' web search keys → the `websearch` installation (V195) → one installation per engine that worked (V204)                                                                                   |
